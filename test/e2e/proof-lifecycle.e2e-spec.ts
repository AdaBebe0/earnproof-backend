import * as request from "supertest";
import { integrationDatabase } from "../integration/harness/database";
import { seedPayment } from "../integration/harness/fixtures";
import { e2eApp } from "./harness/app";
import { authenticateNewWallet } from "./harness/wallet-auth";

/**
 * The proof lifecycle over real HTTP against real Postgres: issue a
 * minimum-income proof from real (encrypted) payment rows, verify it through
 * the public verification endpoint, revoke it, and confirm every ownership
 * and not-found boundary a caller can actually hit.
 *
 * Payments are seeded directly into the database rather than produced by a
 * Stellar sync, the same way `transaction-rollback-matrix.int-spec.ts` does:
 * payment ingestion is a separate concern (`payments.int-spec.ts`), and what
 * this file needs is eligible, encrypted rows to build a proof from.
 */

const db = integrationDatabase();
const e2e = e2eApp();

const PERIOD_START = "2025-01-01T00:00:00.000Z";
const PERIOD_END = "2025-01-31T23:59:59.000Z";

describe("proof lifecycle (e2e)", () => {
  it("issues a minimum-income proof and verifies it publicly", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    const { row: payment } = await seedPayment(db.prisma, "e2e-min-income", client.userId, {
      amount: "1000.0000000",
      occurredAt: new Date("2025-01-15T00:00:00.000Z"),
    });

    const created = await request(e2e.httpServer)
      .post("/api/v1/proofs/minimum-income")
      .set("Authorization", `Bearer ${client.token}`)
      .send({
        selectedPaymentIds: [payment.id],
        thresholdAmount: "500.0000000",
        assetCode: payment.assetCode,
        assetIssuer: payment.assetIssuer,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      })
      .expect(201);

    const proofId = created.body.proofId as string;
    expect(proofId).toEqual(expect.any(String));

    // Public endpoint: no Authorization header at all.
    const verified = await request(e2e.httpServer)
      .get(`/api/v1/proofs/${proofId}/verify`)
      .expect(200);

    expect(verified.body).toMatchObject({
      result: "VALID",
      status: "valid",
      proof: { id: proofId, revokedAt: null },
    });

    const detail = await request(e2e.httpServer)
      .get(`/api/v1/proofs/${proofId}`)
      .set("Authorization", `Bearer ${client.token}`)
      .expect(200);

    expect(detail.body.id).toBe(proofId);
  });

  it("rejects a proof request whose threshold is not met", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    const { row: payment } = await seedPayment(db.prisma, "e2e-below-threshold", client.userId, {
      amount: "10.0000000",
      occurredAt: new Date("2025-01-15T00:00:00.000Z"),
    });

    await request(e2e.httpServer)
      .post("/api/v1/proofs/minimum-income")
      .set("Authorization", `Bearer ${client.token}`)
      .send({
        selectedPaymentIds: [payment.id],
        thresholdAmount: "500.0000000",
        assetCode: payment.assetCode,
        assetIssuer: payment.assetIssuer,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      })
      .expect(400);
  });

  it("rejects proof creation with no bearer token", async () => {
    await request(e2e.httpServer)
      .post("/api/v1/proofs/minimum-income")
      .send({
        selectedPaymentIds: ["does-not-matter"],
        thresholdAmount: "500.0000000",
        assetCode: "USDC",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      })
      .expect(401);
  });

  it("rejects a malformed proof creation request", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);

    await request(e2e.httpServer)
      .post("/api/v1/proofs/minimum-income")
      .set("Authorization", `Bearer ${client.token}`)
      .send({
        // selectedPaymentIds omitted, thresholdAmount not a valid decimal.
        thresholdAmount: "not-a-number",
        assetCode: "USDC",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      })
      .expect(422);
  });

  it("returns 200 unknown for verifying a proof that does not exist", async () => {
    const response = await request(e2e.httpServer)
      .get("/api/v1/proofs/does-not-exist/verify")
      .expect(200);

    expect(response.body).toMatchObject({
      result: "UNKNOWN_PROOF",
      status: "unknown",
    });
  });

  it("returns 404 for a proof owned by someone else", async () => {
    const owner = await authenticateNewWallet(e2e.httpServer);
    const other = await authenticateNewWallet(e2e.httpServer);

    const { row: payment } = await seedPayment(db.prisma, "e2e-not-yours", owner.userId, {
      amount: "1000.0000000",
      occurredAt: new Date("2025-01-15T00:00:00.000Z"),
    });

    const created = await request(e2e.httpServer)
      .post("/api/v1/proofs/minimum-income")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        selectedPaymentIds: [payment.id],
        thresholdAmount: "500.0000000",
        assetCode: payment.assetCode,
        assetIssuer: payment.assetIssuer,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      })
      .expect(201);

    await request(e2e.httpServer)
      .get(`/api/v1/proofs/${created.body.proofId}`)
      .set("Authorization", `Bearer ${other.token}`)
      .expect(404);
  });

  it("returns 404 revoking a proof that does not exist", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);

    await request(e2e.httpServer)
      .patch("/api/v1/proofs/does-not-exist/revoke")
      .set("Authorization", `Bearer ${client.token}`)
      .expect(404);
  });

  it("revokes an owned proof, forbids revocation by anyone else, and the public verify reflects it", async () => {
    const owner = await authenticateNewWallet(e2e.httpServer);
    const other = await authenticateNewWallet(e2e.httpServer);

    const { row: payment } = await seedPayment(db.prisma, "e2e-revoke", owner.userId, {
      amount: "1000.0000000",
      occurredAt: new Date("2025-01-15T00:00:00.000Z"),
    });

    const created = await request(e2e.httpServer)
      .post("/api/v1/proofs/minimum-income")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        selectedPaymentIds: [payment.id],
        thresholdAmount: "500.0000000",
        assetCode: payment.assetCode,
        assetIssuer: payment.assetIssuer,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      })
      .expect(201);

    const proofId = created.body.proofId as string;

    // Forbidden: `other` does not own this proof.
    await request(e2e.httpServer)
      .patch(`/api/v1/proofs/${proofId}/revoke`)
      .set("Authorization", `Bearer ${other.token}`)
      .expect(403);

    const revoked = await request(e2e.httpServer)
      .patch(`/api/v1/proofs/${proofId}/revoke`)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(200);

    expect(revoked.body).toMatchObject({ id: proofId, status: "REVOKED" });

    const verified = await request(e2e.httpServer)
      .get(`/api/v1/proofs/${proofId}/verify`)
      .expect(200);

    expect(verified.body).toMatchObject({
      result: "REVOKED",
      proof: { id: proofId },
    });
    expect(verified.body.proof.revokedAt).not.toBeNull();
  });
});
