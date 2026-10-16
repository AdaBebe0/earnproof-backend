import { Keypair } from "@stellar/stellar-base";
import { createHash } from "crypto";
import * as request from "supertest";
import { integrationDatabase } from "../integration/harness/database";
import { e2eApp } from "./harness/app";
import { authenticateNewWallet } from "./harness/wallet-auth";

/**
 * The full wallet-authentication journey over real HTTP: challenge, verify,
 * session, rotate, logout — plus the error paths a client actually hits
 * (invalid signature, replayed challenge, expired session, missing/garbage
 * bearer token).
 *
 * `#128`/`transaction-rollback-matrix.int-spec.ts` already prove the
 * database-level correctness of session rotation and revocation against a
 * mocked call into the service. What this file adds is the thing neither of
 * those exercises: that a real HTTP client, hitting the real routes with a
 * real Stellar signature, gets a session it can actually use — and that a
 * client without one is turned away by the real guard, not a stand-in for it.
 */

const db = integrationDatabase();
const e2e = e2eApp();

function sep53MessageHash(message: string): Buffer {
  return createHash("sha256")
    .update("Stellar Signed Message:\n", "utf8")
    .update(message, "utf8")
    .digest();
}

describe("wallet authentication (e2e)", () => {
  it("takes a wallet from challenge through verify to an authenticated session", async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    const challenge = await request(e2e.httpServer)
      .post("/api/v1/auth/challenge")
      .send({ walletAddress })
      .expect(201);

    expect(challenge.body).toMatchObject({
      id: expect.any(String),
      message: expect.stringContaining(walletAddress),
      expiresAt: expect.any(String),
    });

    const signature = keypair
      .sign(sep53MessageHash(challenge.body.message))
      .toString("base64");

    const verify = await request(e2e.httpServer)
      .post("/api/v1/auth/verify")
      .send({ challengeId: challenge.body.id, walletAddress, signature })
      .expect(201);

    expect(verify.body.user).toMatchObject({ walletAddress });
    expect(verify.body.session).toMatchObject({
      token: expect.any(String),
      tokenType: "Bearer",
      sessionId: expect.any(String),
    });

    const token = verify.body.session.token as string;

    const session = await request(e2e.httpServer)
      .get("/api/v1/auth/session")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(session.body.user).toMatchObject({ walletAddress });
  });

  it("refuses a challenge signed with the wrong key", async () => {
    const owner = Keypair.random();
    const impostor = Keypair.random();
    const walletAddress = owner.publicKey();

    const challenge = await request(e2e.httpServer)
      .post("/api/v1/auth/challenge")
      .send({ walletAddress })
      .expect(201);

    const forgedSignature = impostor
      .sign(sep53MessageHash(challenge.body.message))
      .toString("base64");

    await request(e2e.httpServer)
      .post("/api/v1/auth/verify")
      .send({
        challengeId: challenge.body.id,
        walletAddress,
        signature: forgedSignature,
      })
      .expect(401);
  });

  it("refuses to replay an already-verified challenge", async () => {
    const keypair = Keypair.random();
    const walletAddress = keypair.publicKey();

    const challenge = await request(e2e.httpServer)
      .post("/api/v1/auth/challenge")
      .send({ walletAddress })
      .expect(201);

    const signature = keypair
      .sign(sep53MessageHash(challenge.body.message))
      .toString("base64");

    await request(e2e.httpServer)
      .post("/api/v1/auth/verify")
      .send({ challengeId: challenge.body.id, walletAddress, signature })
      .expect(201);

    await request(e2e.httpServer)
      .post("/api/v1/auth/verify")
      .send({ challengeId: challenge.body.id, walletAddress, signature })
      .expect(401);
  });

  it("rejects a wallet address that isn't a valid Stellar public key", async () => {
    await request(e2e.httpServer)
      .post("/api/v1/auth/challenge")
      .send({ walletAddress: "not-a-real-wallet-address" })
      .expect(422);
  });

  it("rejects a request with no bearer token", async () => {
    await request(e2e.httpServer).get("/api/v1/auth/session").expect(401);
  });

  it("rejects a request with a malformed bearer token", async () => {
    await request(e2e.httpServer)
      .get("/api/v1/auth/session")
      .set("Authorization", "Bearer this-is-not-a-real-token")
      .expect(401);
  });

  it("rejects a session token after it expires", async () => {
    const { token, sessionId } = await authenticateNewWallet(e2e.httpServer);

    await request(e2e.httpServer)
      .get("/api/v1/auth/session")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    await db.prisma.authSession.update({
      where: { id: sessionId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    await request(e2e.httpServer)
      .get("/api/v1/auth/session")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });

  it("rejects a session token after logout revokes it", async () => {
    const { token } = await authenticateNewWallet(e2e.httpServer);

    await request(e2e.httpServer)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    await request(e2e.httpServer)
      .get("/api/v1/auth/session")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });

  it("rotates a session: the old token stops working and the new one works", async () => {
    const { token } = await authenticateNewWallet(e2e.httpServer);

    const rotated = await request(e2e.httpServer)
      .post("/api/v1/auth/rotate")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const newToken = rotated.body.token as string;
    expect(newToken).not.toBe(token);

    await request(e2e.httpServer)
      .get("/api/v1/auth/session")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);

    await request(e2e.httpServer)
      .get("/api/v1/auth/session")
      .set("Authorization", `Bearer ${newToken}`)
      .expect(200);
  });
});
