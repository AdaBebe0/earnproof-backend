import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ENCRYPTED_PREFIX = "enc:";
const LEGACY_PREFIX = "redacted:";
/** Matches "enc:v<version>:<iv>:<tag>:<ciphertext>". */
const ENCRYPTED_PATTERN =
  /^enc:v(\d+):([^:]+):([^:]+):([^:]+)$/;

/**
 * Key material for protected-amount encryption, keyed by key version.
 *
 * Version 0 is always the legacy single-key slot (`PAYMENT_ENCRYPTION_KEY`)
 * for backward compatibility with data encrypted before versioning existed.
 * Higher versions come from `PAYMENT_ENCRYPTION_KEY_V<N>`.
 */
export type ProtectedAmountKeyring = ReadonlyMap<number, string>;

export class UnknownKeyVersionError extends Error {
  constructor(public readonly version: number) {
    super(
      `No key configured for payment encryption key version ${version}. ` +
        "The key that produced this ciphertext may have been retired.",
    );
    this.name = "UnknownKeyVersionError";
  }
}

/**
 * Encrypt a value using the given key version from the keyring.
 *
 * @param amount     Plaintext to encrypt.
 * @param keyring    Map of key version -> key material.
 * @param writeVersion Key version to encrypt with (the "active" write key).
 */
export function encryptProtectedAmount(
  amount: string,
  keyring: ProtectedAmountKeyring,
  writeVersion: number,
): string {
  const keyMaterial = keyring.get(writeVersion);
  if (keyMaterial === undefined) {
    throw new UnknownKeyVersionError(writeVersion);
  }

  const key = decodeAmountKey(keyMaterial, writeVersion);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(amount, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}v${writeVersion}:${iv.toString(
    "base64url",
  )}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

/**
 * Decrypt a protected-amount value.
 *
 * Dual-read behaviour: the key version is read from the ciphertext envelope
 * (`enc:v<N>:...`) and the matching key is looked up in the keyring. This
 * lets old ciphertext written under a retiring key continue to decrypt while
 * new writes use the current active key, satisfying staged key rotation.
 *
 * `redacted:` values (pre-encryption legacy format) are passed through
 * unchanged, as before.
 */
export function decryptProtectedAmount(
  value: string,
  keyring: ProtectedAmountKeyring,
): string {
  if (value.startsWith(LEGACY_PREFIX)) {
    return Buffer.from(value.slice(LEGACY_PREFIX.length), "base64url").toString(
      "utf8",
    );
  }

  const match = ENCRYPTED_PATTERN.exec(value);
  if (!match) {
    throw new Error("Unsupported protected amount format");
  }

  const [, versionRaw, ivValue, tagValue, ciphertextValue] = match;
  const version = Number(versionRaw);

  const keyMaterial = keyring.get(version);
  if (keyMaterial === undefined) {
    throw new UnknownKeyVersionError(version);
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    decodeAmountKey(keyMaterial, version),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function decodeAmountKey(keyMaterial: string, version: number) {
  const key = /^[a-fA-F0-9]{64}$/.test(keyMaterial)
    ? Buffer.from(keyMaterial, "hex")
    : Buffer.from(keyMaterial, "base64");

  if (key.length !== 32) {
    throw new Error(
      `Payment encryption key version ${version} must decode to 32 bytes`,
    );
  }

  return key;
}
