import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Payment,
  PaymentClassification,
  Prisma,
  ResourceStatus,
} from "@prisma/client";
import { PaymentEncryptionKeyringService } from "../common/crypto/payment-encryption-keyring.service";
import { PrismaService } from "../database/prisma.service";
import { StellarService } from "../stellar/stellar.service";
import { normalizeMemo } from "../stellar/memo-normalizer";
import { ledgerSequenceFromPagingToken } from "../stellar/ledger-finality";
import { NormalizedMemo, NormalizedPayment } from "../stellar/stellar.types";
import {
  FinalityOutcome,
  PaymentFinalityService,
} from "./payment-finality.service";

/**
 * A plan is re-read at most once per sync: when a forward read diverges, the
 * same call switches to reconciliation and reads again. A second divergence is
 * left for the next sync rather than looping against an inconsistent Horizon.
 */
const MAX_READS_PER_SYNC = 2;

@Injectable()
export class PaymentsService {
  private readonly paymentEncryptionKeyring: PaymentEncryptionKeyringService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellarService: StellarService,
    configService: ConfigService,
    private readonly finality: PaymentFinalityService,
  ) {
    this.paymentEncryptionKeyring = new PaymentEncryptionKeyringService(
      configService,
    );
  }

  /**
   * Synchronises incoming payments behind the wallet's ledger checkpoint.
   *
   * The checkpoint is re-proved against Horizon before any page is read, and
   * every read is inspected before any row is written. A read that contradicts
   * the verified view writes nothing: the affected payments are held from proof
   * issuance and a bounded reconciliation decides what survives. See
   * docs/ledger-finality.md.
   */
  async syncPayments(user: { id: string; walletAddress: string }) {
    let plan = await this.finality.plan(user.id);
    const supportedAssets = await this.prisma.supportedAsset.findMany({
      where: {
        status: ResourceStatus.ACTIVE,
      },
      select: {
        code: true,
        issuer: true,
        network: true,
      },
    });
    const supportedAssetKeys = new Set(
      supportedAssets.map((asset) => this.assetKey(asset.code, asset.issuer)),
    );

    for (let reads = 1; ; reads += 1) {
      const read = await this.stellarService.readIncomingPayments(
        user.walletAddress,
        this.finality.readOptions(plan),
      );
      const incomingPayments = read.payments;

      // Batch the "does this payment already exist" check into a single query
      // ahead of the loop, instead of one findUnique per incoming payment.
      // incomingPayments comes from Stellar Horizon and can run into the
      // hundreds for an active wallet; a query per row turned a sync into N+1
      // round trips to the database on top of the (already-batched) N calls to
      // Horizon for memo enrichment.
      const stored = new Map(
        (
          await this.prisma.payment.findMany({
            where: {
              operationId: {
                in: incomingPayments.map((payment) => payment.operationId),
              },
            },
            select: { operationId: true, stellarTransactionHash: true, userId: true },
          })
        ).map((row) => [
          row.operationId,
          { transactionHash: row.stellarTransactionHash, userId: row.userId },
        ]),
      );

      const divergence = this.finality.inspect(plan, read, stored, user.id);
      if (divergence) {
        if (plan.mode === "resume" && reads < MAX_READS_PER_SYNC) {
          plan = await this.finality.diverge(user.id, plan.checkpoint, divergence);
          continue;
        }
        return this.syncResult(
          incomingPayments.length,
          { created: 0, updated: 0, skipped: 0, enrichmentErrors: 0 },
          await this.finality.diverged(user.id, divergence),
        );
      }

      const counts = await this.writePayments(
        user.id,
        incomingPayments,
        stored,
        this.finality.replacements(read, stored, user.id),
        supportedAssetKeys,
      );
      const finality = await this.finality.settle(user.id, plan, read, counts);
      return this.syncResult(incomingPayments.length, counts, finality);
    }
  }

  private async writePayments(
    userId: string,
    incomingPayments: NormalizedPayment[],
    stored: ReadonlyMap<string, unknown>,
    replaced: ReadonlySet<string>,
    supportedAssetKeys: ReadonlySet<string>,
  ) {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let rewritten = 0;
    let enrichmentErrors = 0;
    const memoCache = new Map<string, NormalizedMemo>();

    for (const payment of incomingPayments) {
      const isEligible = supportedAssetKeys.has(
        this.assetKey(payment.assetCode, payment.assetIssuer),
      );

      if (!isEligible) {
        skipped += 1;
      }

      let memoContext = memoCache.get(payment.stellarTransactionHash);
      if (!memoContext) {
        try {
          const transaction = await this.stellarService.fetchTransaction(
            payment.stellarTransactionHash,
          );
          if (!transaction) {
            enrichmentErrors += 1;
          }
          memoContext = normalizeMemo(transaction);
        } catch {
          enrichmentErrors += 1;
          memoContext = { type: "none" };
        }
        memoCache.set(payment.stellarTransactionHash, memoContext);
      }

      const existing = stored.has(payment.operationId);
      const ledgerContext = {
        pagingToken: payment.pagingToken ?? null,
        ledgerSequence: ledgerSequenceFromPagingToken(payment.pagingToken),
        // Written only from a read that passed finality inspection, so the
        // record is confirmed by a consistent view and any hold is lifted.
        finalityHoldAt: null,
        finalityHoldReason: null,
      };
      const content = {
        userId,
        stellarTransactionHash: payment.stellarTransactionHash,
        sourceAddress: payment.sourceAddress,
        destinationAddress: payment.destinationAddress,
        assetCode: payment.assetCode,
        assetIssuer: payment.assetIssuer,
        amountEncrypted: this.protectAmount(payment.amount),
        occurredAt: payment.occurredAt,
        memo: memoContext as Prisma.InputJsonValue,
        isEligible,
        ...ledgerContext,
      };

      // A replaced operation id now names a different payment. Its stored
      // content — and the owner's classification of it — described the old
      // one, so it is rebuilt from Horizon and must be classified again.
      const isReplaced = replaced.has(payment.operationId);

      await this.prisma.payment.upsert({
        where: {
          operationId: payment.operationId,
        },
        update: isReplaced
          ? { ...content, classification: PaymentClassification.UNKNOWN }
          : {
              isEligible,
              occurredAt: payment.occurredAt,
              memo: memoContext as Prisma.InputJsonValue,
              ...ledgerContext,
            },
        create: {
          ...content,
          operationId: payment.operationId,
          classification: PaymentClassification.UNKNOWN,
        },
      });

      if (isReplaced) rewritten += 1;
      if (existing) {
        updated += 1;
      } else {
        created += 1;
      }
    }

    return { created, updated, skipped, enrichmentErrors, rewritten };
  }

  private syncResult(
    totalFetched: number,
    counts: { created: number; updated: number; skipped: number; enrichmentErrors: number },
    finality: FinalityOutcome,
  ) {
    return {
      totalFetched,
      created: counts.created,
      updated: counts.updated,
      skipped: counts.skipped,
      enrichmentErrors: counts.enrichmentErrors,
      finality,
    };
  }

  async listPayments(
    userId: string,
    filters: { classification?: PaymentClassification; assetCode?: string },
  ) {
    const payments = await this.prisma.payment.findMany({
      where: {
        userId,
        classification: filters.classification,
        assetCode: filters.assetCode,
      },
      orderBy: {
        occurredAt: "desc",
      },
      take: 100,
    });

    return payments.map((payment) => this.toPaymentDto(payment));
  }

  async getPayment(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        userId,
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    return this.toPaymentDto(payment);
  }

  async updateClassification(
    user: { id: string },
    paymentId: string,
    classification: PaymentClassification,
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        userId: user.id,
      },
      select: {
        id: true,
        classification: true,
        assetCode: true,
        assetIssuer: true,
        isEligible: true,
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    const updated = await this.prisma.payment.update({
      where: {
        id: payment.id,
      },
      data: {
        classification,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: user.id,
        action: "payment.classification.updated",
        resourceType: "payment",
        resourceId: payment.id,
        metadata: {
          previousClassification: payment.classification,
          nextClassification: classification,
          assetCode: payment.assetCode,
          assetIssuer: payment.assetIssuer,
          isEligible: payment.isEligible,
        },
      },
    });

    return this.toPaymentDto(updated);
  }

  private assetKey(code: string, issuer: string | null) {
    return `${code}:${issuer ?? "native"}`;
  }

  private protectAmount(amount: string) {
    return this.paymentEncryptionKeyring.encrypt(amount);
  }

  private toPaymentDto(payment: Payment) {
    return {
      id: payment.id,
      operationId: payment.operationId,
      stellarTransactionHash: payment.stellarTransactionHash,
      sourceAddress: payment.sourceAddress,
      destinationAddress: payment.destinationAddress,
      assetCode: payment.assetCode,
      assetIssuer: payment.assetIssuer,
      occurredAt: payment.occurredAt,
      classification: payment.classification,
      isEligible: payment.isEligible,
      finalityHeld: payment.finalityHoldAt !== null,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
      memoContext: this.readMemoContext(payment.memo),
    };
  }

  private readMemoContext(memo: Prisma.JsonValue | null): NormalizedMemo {
    if (!memo || typeof memo !== "object" || Array.isArray(memo)) {
      return { type: "none" };
    }

    const stored = memo as Record<string, Prisma.JsonValue>;
    if (stored.type === "none") {
      return { type: "none" };
    }

    if (typeof stored.type !== "string" || typeof stored.value !== "string") {
      return { type: "none" };
    }

    if (stored.type === "text") {
      return {
        type: "text",
        value: Array.from(stored.value).slice(0, 500).join(""),
        truncated: stored.truncated === true,
      };
    }

    return normalizeMemo({
      memo_type: stored.type === "return_hash" ? "return" : stored.type,
      memo: stored.value,
    });
  }
}
