import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { execFile } from "child_process";
import { promisify } from "util";
import { sha256 } from "../common/crypto/hash";
import { redact } from "../common/observability/redaction";
import { StructuredLogger } from "../common/logger";
import { CircuitBreakerRegistry } from "../common/resilience/circuit-breaker.registry";
import {
  CircuitBreaker,
  CircuitOpenError,
  CircuitState,
} from "../common/resilience/circuit-breaker";
import { classifyContractError } from "./contract-error";
import {
  DEFAULT_FEE_POLICY,
  FeePolicy,
  assertValidFeePolicy,
  decideFee,
} from "../config/fee-policy";
import { FeeEstimator, HorizonFeeEstimator } from "../stellar/fee-estimator";
import { SorobanRpcResponseError } from "../common/validation/soroban-rpc.schemas";

const execFileAsync = promisify(execFile);

/** Prefix for per-network, per-operation contract circuit names. */
export const CONTRACT_CIRCUIT_PREFIX = "contract";

/** Contract operation classes tracked as distinct circuits. */
export type ContractOperationClass = "register" | "revoke" | "read";

export type AnchorProofInput = {
  proofId: string;
  commitment: string;
  expiresAt: Date;
};

export type AnchorProofResult =
  | {
      anchored: true;
      transactionHash: string;
    }
  | {
      anchored: false;
      /**
       * `circuit_open` means the dependency circuit refused the call before it
       * ran: the contract was never touched, the intent was not consumed, and
       * the worker should hold it for a later probe rather than count an
       * attempt against it.
       */
      reason: "disabled" | "failed" | "circuit_open" | "fee_refused";
      error?: string;
    };

export type ContractProofStatus =
  | {
      checked: true;
      revoked: boolean;
      valid: boolean;
    }
  | {
      checked: false;
      reason: "disabled" | "failed" | "circuit_open";
      error?: string;
    };

@Injectable()
export class ContractAnchoringService {
  private readonly logger = new StructuredLogger(ContractAnchoringService.name);
  private readonly enabled: boolean;
  private readonly required: boolean;
  private readonly stellarCliPath: string;
  private readonly source: string | undefined;
  private readonly network: string;
  private readonly proofRegistryContractId: string | undefined;
  private readonly issuerAddress: string | undefined;
  private readonly schemaVersion: number;
  private readonly registry?: CircuitBreakerRegistry;
  private readonly feePolicy: FeePolicy;
  private readonly feeEstimator: FeeEstimator;
  private readonly breakerOptions: {
    failureThreshold?: number;
    openDurationMs?: number;
    halfOpenMaxProbes?: number;
    successThreshold?: number;
  };

  constructor(
    private readonly configService: ConfigService,
    /**
     * Optional so the existing unit tests (which construct the service with a
     * config alone) keep working. When present, every contract invocation runs
     * under a per-network, per-operation circuit breaker (issue #203).
     */
    @Optional() registry?: CircuitBreakerRegistry,
    /** Injected by tests; production reads Horizon `/fee_stats`. */
    @Optional() feeEstimator?: FeeEstimator,
  ) {
    this.enabled = configService.get<boolean>("contractAnchoring.enabled") ?? false;
    this.required = configService.get<boolean>("contractAnchoring.required") ?? false;
    this.stellarCliPath =
      configService.get<string>("contractAnchoring.stellarCliPath") ?? "stellar";
    this.source = configService.get<string>("contractAnchoring.source");
    this.network = configService.get<string>("stellar.network") ?? "testnet";
    this.proofRegistryContractId = configService.get<string>(
      "contractAnchoring.proofRegistryContractId",
    );
    this.issuerAddress = configService.get<string>(
      "contractAnchoring.issuerAddress",
    );
    this.schemaVersion =
      configService.get<number>("contractAnchoring.schemaVersion") ?? 1;
    this.registry = registry;
    this.feePolicy = this.loadFeePolicy(configService);
    // Live estimation is opt-in by configuration (on in the production
    // config); without it the policy runs on its base fee, never a hidden call.
    const estimateEnabled =
      configService.get<boolean>("contractAnchoring.fee.estimateEnabled") ?? false;
    this.feeEstimator =
      feeEstimator ??
      (estimateEnabled
        ? new HorizonFeeEstimator(
            configService.get<string>("stellar.horizonUrl") ??
              "https://horizon-testnet.stellar.org",
          )
        : { getEstimate: async () => null });
    this.breakerOptions = {
      failureThreshold: configService.get<number>(
        "contractAnchoring.circuitBreaker.failureThreshold",
      ),
      openDurationMs: configService.get<number>(
        "contractAnchoring.circuitBreaker.openDurationMs",
      ),
      halfOpenMaxProbes: configService.get<number>(
        "contractAnchoring.circuitBreaker.halfOpenMaxProbes",
      ),
      successThreshold: configService.get<number>(
        "contractAnchoring.circuitBreaker.successThreshold",
      ),
    };
  }

  /**
   * Reads the fee policy, falling back to defaults per field, and fails fast on
   * an invalid combination so a bad configuration stops startup rather than the
   * first submission.
   */
  private loadFeePolicy(configService: ConfigService): FeePolicy {
    const read = (key: keyof FeePolicy) =>
      configService.get<number>(`contractAnchoring.fee.${key}`) ??
      DEFAULT_FEE_POLICY[key];
    const policy: FeePolicy = {
      baseFeeStroops: read("baseFeeStroops"),
      maxFeeStroops: read("maxFeeStroops"),
      surgeThresholdStroops: read("surgeThresholdStroops"),
      surgeMultiplier: read("surgeMultiplier"),
      refusalThresholdStroops: read("refusalThresholdStroops"),
      estimateMaxAgeMs: read("estimateMaxAgeMs"),
    };
    assertValidFeePolicy(policy);
    return policy;
  }

  /**
   * Applies the fee policy to one mutation. The decision is logged with a safe
   * reason code only, so each fee is auditable without exposing keys or amounts.
   */
  private async decideSubmissionFee(operation: string) {
    const estimate = await this.feeEstimator.getEstimate();
    const decision = decideFee(this.feePolicy, estimate);
    this.logger.log("Contract fee decision", {
      operation,
      action: decision.action,
      reasonCode: decision.reason,
      ...(decision.action === "submit" ? { feeStroops: decision.feeStroops } : {}),
    });
    return decision;
  }

  /**
   * State of the circuit governing a contract operation on the current network,
   * or `closed` when no breaker is wired. Read by the anchoring worker to decide
   * how many intents it may claim — see its backpressure logic.
   */
  circuitState(operation: ContractOperationClass): CircuitState {
    return this.breakerFor(operation)?.snapshot().state ?? "closed";
  }

  /** The breaker for a given network operation, created on first use. */
  private breakerFor(
    operation: ContractOperationClass,
  ): CircuitBreaker | undefined {
    return this.registry?.getOrCreate({
      name: `${CONTRACT_CIRCUIT_PREFIX}:${this.network}:${operation}`,
      ...this.breakerOptions,
    });
  }

  /**
   * Runs a CLI invocation under the operation's circuit breaker.
   *
   * When the circuit is open the breaker throws {@link CircuitOpenError} before
   * `run` executes, so the contract is never touched — the backpressure the
   * worker relies on. A permanent contract error is classified as `ignore` by
   * {@link classifyContractError} so it never opens the circuit; a transient
   * RPC/CLI failure is a `trip`.
   */
  private guarded<T>(
    operation: ContractOperationClass,
    run: () => Promise<T>,
  ): Promise<T> {
    const breaker = this.breakerFor(operation);
    if (!breaker) return run();
    return breaker.execute(run, classifyContractError);
  }

  async anchorProof(input: AnchorProofInput): Promise<AnchorProofResult> {
    if (!this.enabled || !this.hasRequiredConfig()) {
      return {
        anchored: false,
        reason: "disabled",
      };
    }

    const fee = await this.decideSubmissionFee("register");
    if (fee.action === "refuse") return this.feeRefusedResult(fee.reason);

    const args = [
      "contract",
      "invoke",
      "--source",
      this.source!,
      "--network",
      this.network,
      "--fee",
      String(fee.feeStroops),
      "--id",
      this.proofRegistryContractId!,
      "--",
      "register_proof",
      "--proof_id_hash",
      sha256(input.proofId),
      "--commitment_hash",
      this.hexFromSha256(input.commitment),
      "--issuer_address",
      this.issuerAddress!,
      "--schema_version",
      String(this.schemaVersion),
      "--expires_at",
      String(Math.floor(input.expiresAt.getTime() / 1000)),
    ];

    try {
      const { stdout } = await this.guarded("register", () =>
        execFileAsync(this.stellarCliPath, args, {
          windowsHide: true,
          timeout: 120_000,
        }),
      );
      return {
        anchored: true,
        transactionHash: this.lastOutputLine(stdout),
      };
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        return this.circuitOpenResult("Contract anchoring");
      }

      const message = safeCliError(error);
      if (this.required) {
        throw new Error(message);
      }

      this.logger.warn(`Contract anchoring failed: ${message}`);
      return {
        anchored: false,
        reason: "failed",
        error: message,
      };
    }
  }

  /**
   * Shared handling for an open-circuit refusal.
   *
   * In `required` mode the caller (synchronous proof issuance) cannot proceed
   * without a successful anchor, so an open circuit is surfaced as an error. In
   * the default asynchronous mode the worker holds the intent for a later probe,
   * so `circuit_open` is returned without consuming an attempt.
   */
  private circuitOpenResult(
    context: string,
  ): { anchored: false; reason: "circuit_open" } {
    if (this.required) {
      throw new Error(`${context} unavailable: dependency circuit is open`);
    }
    this.logger.warn(`${context} skipped: dependency circuit is open`);
    return { anchored: false, reason: "circuit_open" };
  }

  async revokeProof(proofId: string): Promise<AnchorProofResult> {
    if (!this.enabled || !this.hasRequiredConfig()) {
      return {
        anchored: false,
        reason: "disabled",
      };
    }

    const fee = await this.decideSubmissionFee("revoke");
    if (fee.action === "refuse") return this.feeRefusedResult(fee.reason);

    return this.invokeMutation(fee.feeStroops, "revoke_proof", [
      "--proof_id_hash",
      sha256(proofId),
    ]);
  }

  async getProofStatus(proofId: string): Promise<ContractProofStatus> {
    if (!this.enabled || !this.hasRequiredConfig()) {
      return {
        checked: false,
        reason: "disabled",
      };
    }

    try {
      const [revoked, valid] = await Promise.all([
        this.invokeRead("is_revoked", ["--proof_id_hash", sha256(proofId)]),
        this.invokeRead("is_valid_proof", ["--proof_id_hash", sha256(proofId)]),
      ]);

      return {
        checked: true,
        revoked: this.parseBoolean(revoked),
        valid: this.parseBoolean(valid),
      };
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        if (this.required) {
          throw new Error("Contract status check unavailable: circuit is open");
        }
        this.logger.warn("Contract status check skipped: circuit is open");
        return { checked: false, reason: "circuit_open" };
      }

      const message = safeCliError(error);
      if (this.required) {
        throw new Error(message);
      }

      this.logger.warn(`Contract status check failed: ${message}`);
      return {
        checked: false,
        reason: "failed",
        error: message,
      };
    }
  }

  /**
   * A refused fee never touches the contract and is not a failure of the
   * intent: the worker holds it and tries again once the network calms.
   */
  private feeRefusedResult(
    reasonCode: string,
  ): { anchored: false; reason: "fee_refused"; error: string } {
    const message = `Contract submission refused by fee policy: ${reasonCode}`;
    if (this.required) throw new Error(message);
    this.logger.warn(message);
    return { anchored: false, reason: "fee_refused", error: message };
  }

  private async invokeMutation(
    feeStroops: number,
    functionName: string,
    functionArgs: string[],
  ) {
    try {
      const { stdout } = await this.guarded("revoke", () =>
        execFileAsync(
          this.stellarCliPath,
          this.contractInvokeArgs(functionName, functionArgs, true, feeStroops),
          {
            windowsHide: true,
            timeout: 120_000,
          },
        ),
      );
      return {
        anchored: true as const,
        transactionHash: this.lastOutputLine(stdout),
      };
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        return this.circuitOpenResult("Contract mutation");
      }

      const message = safeCliError(error);
      if (this.required) {
        throw new Error(message);
      }

      this.logger.warn(`Contract mutation failed: ${message}`);
      return {
        anchored: false as const,
        reason: "failed" as const,
        error: message,
      };
    }
  }

  private async invokeRead(functionName: string, functionArgs: string[]) {
    const { stdout } = await this.guarded("read", () =>
      execFileAsync(
        this.stellarCliPath,
        this.contractInvokeArgs(functionName, functionArgs, false),
        {
          windowsHide: true,
          timeout: 60_000,
        },
      ),
    );
    return this.lastOutputLine(stdout);
  }

  private contractInvokeArgs(
    functionName: string,
    functionArgs: string[],
    includeSource: boolean,
    feeStroops?: number,
  ) {
    const args = ["contract", "invoke"];
    if (includeSource) {
      args.push("--source", this.source!);
    }
    if (feeStroops !== undefined) {
      args.push("--fee", String(feeStroops));
    }

    args.push(
      "--network",
      this.network,
      "--id",
      this.proofRegistryContractId!,
      "--",
      functionName,
      ...functionArgs,
    );

    return args;
  }

  private hasRequiredConfig() {
    return Boolean(
      this.source && this.proofRegistryContractId && this.issuerAddress,
    );
  }

  private hexFromSha256(value: string) {
    const normalized = value.startsWith("sha256:") ? value.slice(7) : value;
    if (!/^[a-fA-F0-9]{64}$/.test(normalized)) {
      return sha256(value);
    }

    return normalized.toLowerCase();
  }

  private lastOutputLine(stdout: string) {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.at(-1) ?? "";
  }

  /**
   * Strict boolean read. Anything other than a literal `true`/`false` is a
   * malformed response and fails closed: silently reading garbage as `false`
   * would report a revoked proof as not revoked.
   */
  private parseBoolean(value: string) {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    throw new SorobanRpcResponseError("SOROBAN_RPC_RESPONSE_MALFORMED", "simulation", [
      "result",
    ]);
  }
}

/** Node includes execFile argv in failures, including the signing source. */
function safeCliError(error: unknown): string {
  return redact(error instanceof Error ? error.message : "Unknown error");
}
