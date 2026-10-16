import { Keypair } from "@stellar/stellar-base";
import { sha256 } from "../crypto/hash";
import {
  assertNoForbiddenAuditContent,
  findForbiddenAuditContent,
} from "./audit-redaction";

/**
 * Negative-path coverage for the audit scanner.
 *
 * The matrix test only proves today's records are clean. These tests prove the
 * scanner would notice if they stopped being clean — a scanner that silently
 * approves everything passes the matrix perfectly.
 */

const WALLET = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5)).publicKey();
const SEED = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5)).secret();

describe("findForbiddenAuditContent", () => {
  it("accepts a well-formed audit record", () => {
    expect(
      findForbiddenAuditContent({
        actorType: "user",
        actorId: "user_1",
        action: "api_key.revoked",
        resourceType: "api_key",
        resourceId: "key_1",
        metadata: {
          prefix: "ak012345",
          organizationId: "org_1",
          revokedAt: "2026-02-01T00:00:00.000Z",
        },
      }),
    ).toEqual([]);
  });

  it.each([
    ["a session token", { metadata: { sessionToken: "abc" } }, "metadata.sessionToken"],
    ["a signing secret", { metadata: { signingSecret: "abc" } }, "metadata.signingSecret"],
    ["a webhook signature", { metadata: { signature: "abc" } }, "metadata.signature"],
    ["a proof body", { metadata: { proofBody: { claim: 1 } } }, "metadata.proofBody"],
    ["a request payload", { metadata: { payload: "{}" } }, "metadata.payload"],
    ["an exact amount", { metadata: { amount: "1234.56" } }, "metadata.amount"],
    ["monthly income", { metadata: { monthlyIncome: 4200 } }, "metadata.monthlyIncome"],
    ["payment history", { metadata: { paymentHistory: [] } }, "metadata.paymentHistory"],
    ["a wallet address field", { metadata: { walletAddress: "x" } }, "metadata.walletAddress"],
    ["a client user agent", { metadata: { userAgent: "curl/8" } }, "metadata.userAgent"],
    ["an email address", { metadata: { email: "a@b.test" } }, "metadata.email"],
  ])("rejects %s", (_label, record, path) => {
    expect(findForbiddenAuditContent(record)).toContainEqual(
      expect.objectContaining({ path }),
    );
  });

  it("rejects forbidden content nested under an innocuous key", () => {
    const findings = findForbiddenAuditContent({
      metadata: { context: { detail: { apiSecret: "s3cr3t" } } },
    });

    expect(findings).toEqual([
      expect.objectContaining({ path: "metadata.context.detail.apiSecret" }),
    ]);
  });

  it("rejects forbidden content inside an array", () => {
    const findings = findForbiddenAuditContent({
      metadata: { entries: [{ ok: 1 }, { accessToken: "t" }] },
    });

    expect(findings).toEqual([
      expect.objectContaining({ path: "metadata.entries[1].accessToken" }),
    ]);
  });

  it.each([
    ["a wallet address", WALLET],
    ["a secret seed", SEED],
    ["a JWT", "eyJhbGciOi.eyJzdWIiOiJ1.c2lnbmF0dXJl"],
    ["an IPv4 address", "203.0.113.7"],
    ["a 32-byte base64url secret", "A".repeat(43)],
  ])("rejects %s regardless of the key it hides under", (_label, value) => {
    expect(findForbiddenAuditContent({ metadata: { note: value } })).toEqual([
      expect.objectContaining({ path: "metadata.note" }),
    ]);
  });

  it("accepts a hashed identifier", () => {
    expect(
      findForbiddenAuditContent({
        walletHash: `sha256:${sha256(WALLET)}`,
        metadata: { sourceAddressHash: sha256(WALLET), metadataHash: sha256("{}") },
      }),
    ).toEqual([]);
  });

  it("accepts an identifier the taxonomy declares public", () => {
    const record = { metadata: { stellarAddress: WALLET } };

    expect(findForbiddenAuditContent(record)).not.toEqual([]);
    expect(
      findForbiddenAuditContent(record, {
        publicIdentifierFields: ["stellarAddress"],
      }),
    ).toEqual([]);
  });

  it("reports every finding rather than stopping at the first", () => {
    const findings = findForbiddenAuditContent({
      metadata: { refreshToken: "t", amount: "10", userAgent: "curl/8" },
    });

    expect(findings.map((finding) => finding.path).sort()).toEqual([
      "metadata.amount",
      "metadata.refreshToken",
      "metadata.userAgent",
    ]);
  });
});

describe("assertNoForbiddenAuditContent", () => {
  it("passes a clean record", () => {
    expect(() =>
      assertNoForbiddenAuditContent({ metadata: { organizationId: "org_1" } }),
    ).not.toThrow();
  });

  it("names every offending path in the failure", () => {
    expect(() =>
      assertNoForbiddenAuditContent({
        metadata: { idToken: "t", proofPayload: "{}" },
      }),
    ).toThrow(/metadata\.idToken[\s\S]*metadata\.proofPayload/);
  });
});
