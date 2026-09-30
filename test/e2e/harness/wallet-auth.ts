import { Keypair } from "@stellar/stellar-base";
import { createHash } from "crypto";
import * as request from "supertest";

/**
 * Drives the real challenge/verify HTTP flow with a fresh, throwaway Stellar
 * keypair, so e2e specs authenticate exactly the way a real client does —
 * no service bypassed, no session inserted directly into the database.
 *
 * The message hash matches `AuthService`'s private `sep53MessageHash`
 * (SHA-256 of `"Stellar Signed Message:\n" + message`, SEP-53-style): there is
 * no exported helper to reuse, so this mirrors it deliberately rather than
 * reaching into the service's private implementation.
 */
function sep53MessageHash(message: string): Buffer {
  return createHash("sha256")
    .update("Stellar Signed Message:\n", "utf8")
    .update(message, "utf8")
    .digest();
}

export interface AuthenticatedClient {
  readonly userId: string;
  readonly walletAddress: string;
  readonly token: string;
  readonly sessionId: string;
}

/**
 * Registers (or logs back in as) a brand-new synthetic wallet and returns a
 * live bearer token, by actually calling `POST /auth/challenge` and
 * `POST /auth/verify` over HTTP.
 */
export async function authenticateNewWallet(
  httpServer: import("http").Server,
): Promise<AuthenticatedClient> {
  const keypair = Keypair.random();
  const walletAddress = keypair.publicKey();

  const challengeResponse = await request(httpServer)
    .post("/api/v1/auth/challenge")
    .send({ walletAddress })
    .expect(201);

  const { id: challengeId, message } = challengeResponse.body as {
    id: string;
    message: string;
  };

  const signature = keypair.sign(sep53MessageHash(message)).toString("base64");

  const verifyResponse = await request(httpServer)
    .post("/api/v1/auth/verify")
    .send({ challengeId, walletAddress, signature })
    .expect(201);

  const { user, session } = verifyResponse.body as {
    user: { id: string };
    session: { token: string; sessionId: string };
  };

  return {
    userId: user.id,
    walletAddress,
    token: session.token,
    sessionId: session.sessionId,
  };
}
