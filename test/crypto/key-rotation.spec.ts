import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PaymentEncryptionKeyringService } from "../../src/common/crypto/payment-encryption-keyring.service";
import { UnknownKeyVersionError } from "../../src/common/crypto/protected-amount";

/**
 * Key-rotation rehearsal for PAYMENT_ENCRYPTION_KEY.
 *
 * These tests exercise the exact operator sequence documented in
 * docs/key-rotation.md for staged rotation of a versioned key: encrypt
 * under the current active key, introduce a new version, cut writes over
 * to it while old ciphertext keeps decrypting (dual read), simulate a
 * process restart with only the surviving key versions loaded, and finally
 * retire the old key and confirm old ciphertext becomes explicitly
 * undecryptable rather than silently wrong.
 *
 * All keys below are synthetic, test-only 32-byte values — never real
 * secrets.
 */
describe("payment encryption key rotation rehearsal", () => {
  const KEY_V0 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // base64, 32 bytes
  const KEY_V1 = "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA="; // base64, 32 bytes

  /** Builds a ConfigService test double from a flat key/value map, mirroring
   * the shape `configuration()` + `PaymentEncryptionKeyringService` expect. */
  function fakeConfigService(values: Record<string, unknown>): ConfigService {
    return {
      get: jest.fn((key: string) => {
        if (key in values) return values[key];
        // Support the dotted "paymentEncryptionKeyVersions.N" lookups the
        // keyring service performs against the indexed object produced by
        // configuration()'s loadPaymentEncryptionKeyVersions().
        const match = /^paymentEncryptionKeyVersions\.(\d+)$/.exec(key);
        if (match && values.paymentEncryptionKeyVersions) {
          const versions = values.paymentEncryptionKeyVersions as Record<
            number,
            string
          >;
          return versions[Number(match[1])];
        }
        return undefined;
      }),
    } as unknown as ConfigService;
  }

  describe("stage 0: single unversioned key (pre-rotation baseline)", () => {
    it("encrypts and decrypts using the legacy PAYMENT_ENCRYPTION_KEY as implicit version 0", () => {
      const config = fakeConfigService({
        paymentEncryptionKey: KEY_V0,
        paymentEncryptionKeyVersions: {},
      });
      const keyring = new PaymentEncryptionKeyringService(config);

      expect(keyring.writeVersion).toBe(0);
      expect(keyring.loadedVersions).toEqual([0]);

      const ciphertext = keyring.encrypt("100.50");
      expect(ciphertext).toMatch(/^enc:v0:/);
      expect(keyring.decrypt(ciphertext)).toBe("100.50");
    });
  });

  describe("stage 1: staged rotation — v1 introduced, v0 still active for writes", () => {
    it("keeps writing v0 and can still read v0 data before the write cutover", () => {
      const config = fakeConfigService({
        paymentEncryptionKey: KEY_V0,
        paymentEncryptionKeyVersions: { 0: KEY_V0, 1: KEY_V1 },
        paymentEncryptionKeyVersion: 0,
      });
      const keyring = new PaymentEncryptionKeyringService(config);

      expect(keyring.writeVersion).toBe(0);
      expect(keyring.loadedVersions).toEqual([0, 1]);

      const ciphertext = keyring.encrypt("42.00");
      expect(ciphertext).toMatch(/^enc:v0:/);
      expect(keyring.decrypt(ciphertext)).toBe("42.00");
    });
  });

  describe("stage 2: write cutover — v1 active, v0 retained for dual read", () => {
    it("new writes use v1 while old v0 ciphertext still decrypts", () => {
      // Old data was written back when v0 was active.
      const preRotationConfig = fakeConfigService({
        paymentEncryptionKey: KEY_V0,
        paymentEncryptionKeyVersions: {},
      });
      const preRotationKeyring = new PaymentEncryptionKeyringService(
        preRotationConfig,
      );
      const oldCiphertext = preRotationKeyring.encrypt("7.25");
      expect(oldCiphertext).toMatch(/^enc:v0:/);

      // Operator cuts writes over: PAYMENT_ENCRYPTION_KEY_VERSION=1, both
      // V0 and V1 remain configured for dual read.
      const rotatedConfig = fakeConfigService({
        paymentEncryptionKeyVersions: { 0: KEY_V0, 1: KEY_V1 },
        paymentEncryptionKeyVersion: 1,
      });
      const rotatedKeyring = new PaymentEncryptionKeyringService(
        rotatedConfig,
      );

      expect(rotatedKeyring.writeVersion).toBe(1);
      expect(rotatedKeyring.loadedVersions).toEqual([0, 1]);

      // New writes are stamped with v1.
      const newCiphertext = rotatedKeyring.encrypt("7.25");
      expect(newCiphertext).toMatch(/^enc:v1:/);

      // Old v0 ciphertext still decrypts under the same service instance
      // (dual read) even though writes have moved on.
      expect(rotatedKeyring.decrypt(oldCiphertext)).toBe("7.25");
      expect(rotatedKeyring.decrypt(newCiphertext)).toBe("7.25");
    });
  });

  describe("stage 3: restart with only the surviving key versions", () => {
    it("decrypts v0 data from a fresh service instance built from fresh config after a simulated restart", () => {
      const beforeRestartConfig = fakeConfigService({
        paymentEncryptionKeyVersions: { 0: KEY_V0, 1: KEY_V1 },
        paymentEncryptionKeyVersion: 0,
      });
      const beforeRestart = new PaymentEncryptionKeyringService(
        beforeRestartConfig,
      );
      const v0Ciphertext = beforeRestart.encrypt("300.00");

      // Simulate a process restart: a brand new ConfigService instance and
      // a brand new PaymentEncryptionKeyringService, as would happen on
      // deploy/restart, with the active write version now cut over to v1
      // but v0 still retained (retiring, not yet retired).
      const afterRestartConfig = fakeConfigService({
        paymentEncryptionKeyVersions: { 0: KEY_V0, 1: KEY_V1 },
        paymentEncryptionKeyVersion: 1,
      });
      const afterRestart = new PaymentEncryptionKeyringService(
        afterRestartConfig,
      );

      expect(afterRestart.writeVersion).toBe(1);
      expect(afterRestart.decrypt(v0Ciphertext)).toBe("300.00");
    });
  });

  describe("stage 4: v0 retired — old ciphertext becomes explicitly undecryptable", () => {
    it("throws a typed UnknownKeyVersionError once the retiring key's env var is removed", () => {
      const withV0Config = fakeConfigService({
        paymentEncryptionKeyVersions: { 0: KEY_V0, 1: KEY_V1 },
        paymentEncryptionKeyVersion: 0,
      });
      const withV0 = new PaymentEncryptionKeyringService(withV0Config);
      const v0Ciphertext = withV0.encrypt("999.99");

      // Operator removes PAYMENT_ENCRYPTION_KEY_V0 entirely: v0 is retired.
      const retiredConfig = fakeConfigService({
        paymentEncryptionKeyVersions: { 1: KEY_V1 },
        paymentEncryptionKeyVersion: 1,
      });
      const retired = new PaymentEncryptionKeyringService(retiredConfig);

      expect(retired.loadedVersions).toEqual([1]);
      expect(() => retired.decrypt(v0Ciphertext)).toThrow(
        UnknownKeyVersionError,
      );
      expect(() => retired.decrypt(v0Ciphertext)).toThrow(
        /version 0/,
      );

      // New data under v1 is unaffected.
      const newCiphertext = retired.encrypt("999.99");
      expect(retired.decrypt(newCiphertext)).toBe("999.99");
    });

    it("encrypting with a retired/unconfigured write version also fails with a typed error", () => {
      const config = fakeConfigService({
        paymentEncryptionKeyVersions: { 1: KEY_V1 },
        paymentEncryptionKeyVersion: 5, // misconfigured: version 5 never existed
      });
      const keyring = new PaymentEncryptionKeyringService(config);

      expect(() => keyring.encrypt("1.00")).toThrow(UnknownKeyVersionError);
    });
  });

  describe("logging never exposes key material", () => {
    it("error log lines about missing/misconfigured versions do not contain raw key bytes", () => {
      const logSpy = jest.spyOn(Logger.prototype, "error");

      const config = fakeConfigService({
        paymentEncryptionKeyVersions: { 0: KEY_V0 },
        paymentEncryptionKeyVersion: 3,
      });
      void new PaymentEncryptionKeyringService(config);

      const loggedMessages = logSpy.mock.calls.map((call) => String(call[0]));
      for (const message of loggedMessages) {
        expect(message).not.toContain(KEY_V0);
        expect(message).not.toContain(KEY_V1);
      }

      logSpy.mockRestore();
    });
  });
});
