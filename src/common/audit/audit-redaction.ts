/**
 * Forbidden-content scanning for audit records.
 *
 * The audit trail is the one store that is deliberately long-lived, widely
 * readable inside the organisation, and exported during incidents. That makes
 * it the worst possible place for a secret or a re-identifier to land, and the
 * easiest place for one to arrive unnoticed: audit metadata is untyped `Json`,
 * so a contributor spreading a domain object into it (`metadata: { ...payment }`)
 * compiles, passes review, and quietly persists an exact income figure forever.
 *
 * This module answers one question — "does this value contain something that
 * must never be audited?" — by key name and by value shape. It is used by the
 * audit matrix tests rather than by the write path, deliberately: a silent
 * runtime stripper would hide the mistake instead of failing the build, and the
 * cost of the scan on every write is not worth paying for a rule that a test
 * can enforce before the code ships.
 */

/** One thing the scan objected to. */
export interface ForbiddenAuditFinding {
  /** Dotted path from the scanned root, e.g. `metadata.payment.amount`. */
  readonly path: string;
  /** Why it was rejected, phrased for a failing assertion. */
  readonly reason: string;
}

/**
 * Key names that must never appear in an audit record.
 *
 * Matched case-insensitively against each key. A key is exempt when it names a
 * digest rather than the value itself (`walletHash`, `metadata_hash`): hashing
 * is the sanctioned way to keep a joinable identifier, and the taxonomy relies
 * on it for tenant context on authentication events.
 */
const FORBIDDEN_KEY_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /token/i, reason: "session or bearer tokens are credentials" },
  { pattern: /secret|passphrase|password/i, reason: "secrets are credentials" },
  { pattern: /signature|signed/i, reason: "signatures are replayable material" },
  { pattern: /privatekey|private_key|seed/i, reason: "key material" },
  { pattern: /challengeMessage|challenge_message/i, reason: "challenge text is signable material" },
  { pattern: /credential/i, reason: "credential bodies are not audit context" },
  { pattern: /proofbody|proof_body|proofpayload|payload|rawbody/i, reason: "proof bodies carry protected claims" },
  { pattern: /^amount$|amountexact|exactamount|grossamount|netamount/i, reason: "exact amounts are protected income data" },
  { pattern: /income|salary|earnings|balance/i, reason: "income figures are protected" },
  { pattern: /paymenthistory|payment_history|transactions|payments/i, reason: "payment history is protected" },
  { pattern: /walletaddress|wallet_address|publickey|public_key|stellaraddress|sourceaddress/i, reason: "wallet addresses are re-identifiers" },
  { pattern: /ipaddress|ip_address|remoteaddr|useragent|user_agent/i, reason: "client identifiers are not retained" },
  { pattern: /email|phone|ssn|taxid|dateofbirth/i, reason: "personal data is not audit context" },
];

/** Keys that look forbidden but name a digest, which is the sanctioned form. */
const DIGEST_KEY = /(hash|digest|fingerprint)$/i;

/**
 * Value shapes that must never appear, regardless of the key they sit under.
 *
 * These catch the case the key rules cannot: an innocuous key name (`context`,
 * `detail`, `value`) holding something dangerous.
 */
const FORBIDDEN_VALUE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^S[A-Z2-7]{55}$/, reason: "looks like a Stellar secret seed" },
  { pattern: /^G[A-Z2-7]{55}$/, reason: "looks like a Stellar account address" },
  { pattern: /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, reason: "looks like a JWT" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: "PEM private key" },
  { pattern: /^\d{1,3}(\.\d{1,3}){3}$/, reason: "looks like an IPv4 address" },
];

/**
 * A base64/base64url blob long enough to be key or signature material.
 *
 * The bound is 43 characters: the encoded length of this service's own 32-byte
 * API key secret, and below the 88 of an encoded ed25519 signature. It sits
 * above every legitimate identifier that is audited — cuids are 25 characters,
 * key prefixes are 8 — and hex digests are exempted separately below, so a
 * sanctioned `sha256:` value does not trip it.
 */
const LONG_OPAQUE_BLOB = /^[A-Za-z0-9+/_-]{43,}={0,2}$/;

/** `sha256:<hex>` or a bare hex digest: a sanctioned digest, not a blob. */
const DIGEST_VALUE = /^(sha256:)?[a-f0-9]{64}$/i;

interface ScanOptions {
  /**
   * Keys naming deliberately public identifiers, exempt from both rule sets.
   * Compared case-sensitively against the key, as declared by the taxonomy.
   */
  readonly publicIdentifierFields?: readonly string[];
}

function isForbiddenKey(key: string): string | undefined {
  if (DIGEST_KEY.test(key)) return undefined;

  for (const { pattern, reason } of FORBIDDEN_KEY_PATTERNS) {
    if (pattern.test(key)) return reason;
  }

  return undefined;
}

function isForbiddenValue(value: string): string | undefined {
  for (const { pattern, reason } of FORBIDDEN_VALUE_PATTERNS) {
    if (pattern.test(value)) return reason;
  }

  if (LONG_OPAQUE_BLOB.test(value) && !DIGEST_VALUE.test(value)) {
    return "long opaque blob; looks like key, token or signature material";
  }

  return undefined;
}

/**
 * Walks a value and reports everything an audit record must not contain.
 *
 * Depth-first over plain objects and arrays. Dates and numbers are inspected
 * only through their key, since a timestamp is safe by shape and a number
 * carries no recognisable secret shape — an amount is caught by its key name,
 * which is why the key rules cover `amount` explicitly.
 */
export function findForbiddenAuditContent(
  value: unknown,
  options: ScanOptions = {},
  path = "",
): ForbiddenAuditFinding[] {
  const findings: ForbiddenAuditFinding[] = [];
  const publicFields = new Set(options.publicIdentifierFields ?? []);

  const walk = (node: unknown, nodePath: string): void => {
    if (node === null || node === undefined) return;

    if (typeof node === "string") {
      const reason = isForbiddenValue(node);
      if (reason) findings.push({ path: nodePath, reason });
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${nodePath}[${index}]`));
      return;
    }

    if (node instanceof Date || typeof node !== "object") return;

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = nodePath ? `${nodePath}.${key}` : key;

      if (publicFields.has(key)) {
        // Declared public by the taxonomy: exempt from both rule sets, because
        // the point of the declaration is that this identifier is publishable.
        continue;
      }

      const keyReason = isForbiddenKey(key);
      if (keyReason) {
        findings.push({ path: childPath, reason: keyReason });
        // Still descend: a forbidden container may hold more than one problem,
        // and reporting all of them at once makes the fix a single pass.
      }
      walk(child, childPath);
    }
  };

  walk(value, path);

  return findings;
}

/**
 * Throws unless the value is free of forbidden audit content.
 *
 * The message lists every finding, so a failing test names all the offending
 * paths rather than the first one.
 */
export function assertNoForbiddenAuditContent(
  value: unknown,
  options: ScanOptions = {},
): void {
  const findings = findForbiddenAuditContent(value, options);
  if (findings.length === 0) return;

  throw new Error(
    `Audit record contains forbidden content:\n${findings
      .map((finding) => `  - ${finding.path || "<root>"}: ${finding.reason}`)
      .join("\n")}`,
  );
}
