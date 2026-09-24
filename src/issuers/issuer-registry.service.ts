import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ResourceStatus } from "@prisma/client";
import { execFile } from "child_process";
import { promisify } from "util";
import { sha256 } from "../common/crypto/hash";

const execFileAsync = promisify(execFile);

export type IssuerRegistrySyncInput = {
  issuerId: string;
  stellarAddress: string;
  metadataHash: string;
  status: ResourceStatus;
  contractSyncedStatus: ResourceStatus | null;
};

export type IssuerRegistrySyncResult =
  | { state: "synced"; transactionHash: string; operation: string }
  | { state: "pending"; reason: string }
  | { state: "disabled"; reason: string }
  | { state: "failed"; reason: string; error: string };

@Injectable()
export class IssuerRegistryService {
  private readonly logger = new Logger(IssuerRegistryService.name);
  private readonly enabled: boolean;
  private readonly stellarCliPath: string;
  private readonly source?: string;
  private readonly network: string;
  private readonly contractId?: string;

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>("issuerRegistry.enabled") ?? false;
    this.stellarCliPath =
      config.get<string>("issuerRegistry.stellarCliPath") ?? "stellar";
    this.source = config.get<string>("issuerRegistry.source");
    this.network = config.get<string>("stellar.network") ?? "testnet";
    this.contractId = config.get<string>("issuerRegistry.contractId");
  }

  async sync(
    input: IssuerRegistrySyncInput,
  ): Promise<IssuerRegistrySyncResult> {
    if (input.status === ResourceStatus.PENDING) {
      return {
        state: "pending",
        reason: "Issuer must be ACTIVE before contract registration",
      };
    }

    if (!this.enabled || !this.source || !this.contractId) {
      return {
        state: "disabled",
        reason: "Issuer registry synchronization is not configured",
      };
    }

    const issuerIdHash = sha256(input.issuerId);
    let operation: string;
    let args: string[];

    if (!input.contractSyncedStatus) {
      if (input.status !== ResourceStatus.ACTIVE) {
        return {
          state: "pending",
          reason:
            "Issuer must be registered while ACTIVE before status synchronization",
        };
      }
      operation = "register_issuer";
      args = [
        "--issuer_id_hash",
        issuerIdHash,
        "--issuer_address",
        input.stellarAddress,
        "--metadata_hash",
        input.metadataHash,
      ];
    } else if (
      input.status === ResourceStatus.ACTIVE &&
      input.contractSyncedStatus === ResourceStatus.SUSPENDED
    ) {
      operation = "reactivate_issuer";
      args = ["--issuer_id_hash", issuerIdHash];
    } else if (input.status === ResourceStatus.ACTIVE) {
      operation = "update_issuer";
      args = [
        "--issuer_id_hash",
        issuerIdHash,
        "--metadata_hash",
        input.metadataHash,
      ];
    } else if (input.status === ResourceStatus.SUSPENDED) {
      operation = "suspend_issuer";
      args = ["--issuer_id_hash", issuerIdHash];
    } else if (input.status === ResourceStatus.REVOKED) {
      operation = "revoke_issuer";
      args = ["--issuer_id_hash", issuerIdHash];
    } else {
      return {
        state: "pending",
        reason: `Status ${input.status} is not syncable`,
      };
    }

    try {
      const { stdout } = await execFileAsync(
        this.stellarCliPath,
        [
          "contract",
          "invoke",
          "--source",
          this.source,
          "--network",
          this.network,
          "--id",
          this.contractId,
          "--",
          operation,
          ...args,
        ],
        { windowsHide: true, timeout: 120_000 },
      );
      const transactionHash = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);

      if (!transactionHash) {
        throw new Error("Issuer registry returned no transaction evidence");
      }
      return { state: "synced", transactionHash, operation };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(`Issuer registry sync failed: ${message}`);
      return { state: "failed", reason: "failed", error: message };
    }
  }
}
