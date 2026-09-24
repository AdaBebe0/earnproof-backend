import { ConfigService } from "@nestjs/config";
import { readFileSync } from "fs";
import { join } from "path";
import { AuthTokenService } from "./auth-token.service";

describe("AuthTokenService", () => {
  const service = new AuthTokenService({
    getOrThrow: () => "test_secret_123",
  } as unknown as ConfigService);

  it("signs and verifies auth token payloads", () => {
    const token = service.sign({
      id: "user_1",
      walletAddress: "G".padEnd(56, "A"),
      walletHash: "sha256:abc",
      role: "WORKER",
    });

    expect(service.verify(token)).toMatchObject({
      id: "user_1",
      walletHash: "sha256:abc",
      role: "WORKER",
    });
  });

  it("rejects tampered tokens", () => {
    const token = service.sign({
      id: "user_1",
      walletAddress: "G".padEnd(56, "A"),
      walletHash: "sha256:abc",
      role: "WORKER",
    });

    expect(() => service.verify(`${token}x`)).toThrow("Invalid auth token");
  });

  it("is not referenced by the active guard or authentication service", () => {
    const guardSource = readFileSync(
      join(process.cwd(), "src/common/guards/auth.guard.ts"),
      "utf8",
    );
    const authServiceSource = readFileSync(
      join(process.cwd(), "src/auth/auth.service.ts"),
      "utf8",
    );
    const rateLimitGuardSource = readFileSync(
      join(process.cwd(), "src/common/guards/rate-limit.guard.ts"),
      "utf8",
    );

    expect(guardSource).not.toContain("AuthTokenService");
    expect(authServiceSource).not.toContain("AuthTokenService");
    expect(rateLimitGuardSource).not.toContain("AuthTokenService");
  });

  describe("tryVerify", () => {
    it("returns the payload for a valid token, same as verify()", () => {
      const token = service.sign({
        id: "user_1",
        walletAddress: "G".padEnd(56, "A"),
        walletHash: "sha256:abc",
        role: "WORKER",
      });

      expect(service.tryVerify(token)).toMatchObject({
        id: "user_1",
        walletHash: "sha256:abc",
        role: "WORKER",
      });
    });

    it("returns undefined (never throws) for a tampered token", () => {
      const token = service.sign({
        id: "user_1",
        walletAddress: "G".padEnd(56, "A"),
        walletHash: "sha256:abc",
        role: "WORKER",
      });

      expect(service.tryVerify(`${token}x`)).toBeUndefined();
    });

    it("returns undefined for a malformed token (no signature segment)", () => {
      expect(service.tryVerify("not-a-real-token")).toBeUndefined();
    });

    it("returns undefined for an empty string", () => {
      expect(service.tryVerify("")).toBeUndefined();
    });

    it("returns undefined for an expired token", () => {
      const token = service.sign(
        {
          id: "user_1",
          walletAddress: "G".padEnd(56, "A"),
          walletHash: "sha256:abc",
          role: "WORKER",
        },
        -1, // already expired
      );

      expect(service.tryVerify(token)).toBeUndefined();
    });
  });
});
