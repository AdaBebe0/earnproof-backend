import { integrationDatabase } from "./harness/database";
import { redactErrorInPlace, redactTestOutput } from "./harness/redaction";
import { seedPayment, seedUser } from "./harness/fixtures";

/**
 * The redaction that makes a failing integration test safe to read.
 *
 * A failure in this suite is assembled from real material — a live connection
 * string, an encrypted amount, a session token minted seconds earlier — and it
 * is printed somewhere far less guarded than an application log: CI output,
 * terminal scrollback, a screenshot in an issue. Redaction is therefore part of
 * the harness's contract, and a contract that is not tested is a hope.
 *
 * These tests assert the contract in both directions: the sensitive shapes are
 * removed, and the diagnostic detail that makes a failure actionable is not.
 */

const db = integrationDatabase();

describe("redaction of sensitive shapes", () => {
  it("removes a connection string, credentials included", () => {
    const output = redactTestOutput(
      "Can't reach database server at postgresql://earnproof:hunter2@localhost:5432/earnproof_test_w1",
    );

    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("earnproof_test_w1");
    expect(output).toContain("[REDACTED_CONNECTION_STRING]");
  });

  it("removes the configured test database URL wherever it appears", () => {
    // Belt and braces for a secret with no recognisable shape: the literal
    // value is known at runtime, so it is matched directly.
    const url = process.env.TEST_DATABASE_URL as string;
    const output = redactTestOutput(`connecting to ${url} failed`);

    expect(output).not.toContain(url);
  });

  it("removes wallet addresses, including the synthetic ones", () => {
    const address = "GSYNTHETIC0123456789ABCDEF".padEnd(56, "X");
    const output = redactTestOutput(`payment from ${address} rejected`);

    expect(output).not.toContain(address);
    expect(output).toContain("[REDACTED_WALLET_ADDRESS]");
  });

  it("removes a Stellar secret seed before it can be read as an address", () => {
    const seed = `S${"A".repeat(55)}`;
    const output = redactTestOutput(`signing with ${seed}`);

    expect(output).not.toContain(seed);
    expect(output).toContain("[REDACTED_SIGNING_MATERIAL]");
  });

  it("removes a protected amount", () => {
    const encrypted = "enc:v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB:CCCCCCCCCCCC";
    const output = redactTestOutput(`amountEncrypted was ${encrypted}`);

    expect(output).not.toContain(encrypted);
    expect(output).toContain("[REDACTED_PROTECTED_AMOUNT]");
  });

  it("removes an opaque session token", () => {
    const token = `${"A".repeat(16)}.${"a".repeat(64)}`;
    const output = redactTestOutput(`Authorization: Bearer ${token}`);

    expect(output).not.toContain(token);
    expect(output).toContain("[REDACTED_SESSION_TOKEN]");
  });

  it("removes credential hashes and signing material", () => {
    const output = redactTestOutput(
      "credentialHash: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'",
    );

    expect(output).not.toContain("9f86d081884c7d659a2feaa0c55ad015");
    expect(output).toContain("[REDACTED]");
  });

  it("removes sensitive columns from a printed row", () => {
    const row = JSON.stringify({
      id: "synthetic_payment_1",
      operationId: "synthetic-op-1",
      amountEncrypted: "enc:v1:abc:def:ghi",
      walletHash: "sha256:synthetic-1234",
    });

    const output = redactTestOutput(row);

    expect(output).not.toContain("enc:v1:abc");
    expect(output).not.toContain("sha256:synthetic-1234");
    // The identifiers that make the failure diagnosable stay.
    expect(output).toContain("synthetic_payment_1");
    expect(output).toContain("operationId");
  });
});

describe("what redaction must not destroy", () => {
  it("keeps the line structure of a diff", () => {
    const diff = ["- Expected", "+ Received", "  status: 'ACTIVE'"].join("\n");
    expect(redactTestOutput(diff).split("\n")).toHaveLength(3);
  });

  it("does not truncate long output", () => {
    // The production log redactor clips at 512 characters. A clipped diff hides
    // the mismatch it was printed to show, so this one must not.
    const long = "field: 'value'\n".repeat(200);
    expect(redactTestOutput(long).length).toBeGreaterThan(1000);
  });

  it("keeps counts, attempts and status codes readable", () => {
    const output = redactTestOutput(
      "delivery failed on attempt 3 of 5 with HTTP 500 after 1200 ms",
    );

    expect(output).toContain("attempt 3 of 5");
    expect(output).toContain("500");
  });
});

describe("redaction of live database errors", () => {
  it("redacts a Prisma error without discarding its code", async () => {
    const user = await seedUser(db.prisma, "redaction-live");
    const first = await seedPayment(db.prisma, "redaction-live-1", user.id);

    const error = await seedPayment(db.prisma, "redaction-live-2", user.id, {
      operationId: first.row.operationId,
    }).catch((thrown: unknown) => thrown);

    // The client wrapper has already redacted this on the way out.
    expect(error).toMatchObject({ code: "P2002" });
    expect((error as Error).message).not.toContain(
      process.env.TEST_DATABASE_URL as string,
    );
  });

  it("redacts a connection failure in place, preserving the error class", () => {
    class ConnectionError extends Error {
      code = "P1001";
    }

    const error = new ConnectionError(
      "Can't reach database server at postgresql://earnproof:secret@localhost:5432/earnproof_test",
    );

    const redacted = redactErrorInPlace(error);

    expect(redacted).toBe(error);
    expect(redacted).toBeInstanceOf(ConnectionError);
    expect(redacted.code).toBe("P1001");
    expect(redacted.message).not.toContain("secret");
    expect(redacted.stack).not.toContain("secret");
  });
});
