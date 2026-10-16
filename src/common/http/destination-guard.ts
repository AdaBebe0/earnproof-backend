/**
 * Centralised outbound-destination validation (SSRF guard).
 *
 * This is the single source of truth for deciding whether an outbound HTTP
 * destination is safe to connect to. Any client that dispatches requests to a
 * URL influenced — directly or indirectly — by a user (webhook endpoints
 * today; any future outbound integration tomorrow) must run its target
 * through this module before connecting.
 *
 * Policy:
 *   - Only `https:` is accepted. No other scheme, no explicit ports: the
 *     default HTTPS port (443) is the only port this module allows, because
 *     a caller-supplied port is itself a common SSRF pivot (pointing at an
 *     internal service listening on an unusual port).
 *   - URL-embedded credentials (`https://user:pass@host/`) are rejected —
 *     they can smuggle credentials to a third party or be dropped on
 *     redirect, which is not something this module lets happen anyway.
 *   - Loopback, RFC-1918 private ranges, link-local, cloud metadata
 *     endpoints (AWS/GCP/Azure 169.254.169.254, Alibaba 100.100.100.200),
 *     carrier-grade NAT (100.64.0.0/10), TEST-NET/benchmark ranges, and
 *     other reserved/unspecified ranges are blocked for both IPv4 and IPv6,
 *     including ambiguous representations: IPv4-mapped IPv6
 *     (`::ffff:a.b.c.d` and its compressed hex form `::ffff:a9fe:a9fe`) and
 *     NAT64-embedded IPv4 (`64:ff9b::/96`) are decoded back to their IPv4
 *     payload and checked against the same IPv4 rules — a raw address is
 *     never accepted "because it round-trips through a wrapper".
 *   - Octal/hex/decimal-encoded IPv4 octets (`0x7f.0.0.1`, `2130706433`,
 *     `017.0.0.1`) are normalised by the WHATWG `URL` parser itself before
 *     this module ever inspects `hostname`, so `isBlockedHost` always sees
 *     canonical dotted-decimal or canonical IPv6. `parseIPv4` still parses
 *     defensively (no implicit octal/hex via `Number()`, strict decimal
 *     digits only) so that guarantee is not silently load-bearing.
 *   - `.local` / `.internal` / `.localhost` / `localhost` hostnames are
 *     blocked outright, regardless of what they would resolve to.
 *
 * Redirects and DNS revalidation are enforced by the *caller*, not this
 * module: `assertSafeDestination` (address-level, DNS-resolving) must be
 * re-run immediately before every connection attempt — including retries
 * and any address a redirect points at — because a hostname's resolved
 * address can change between the time it was first validated and the time a
 * socket actually opens (DNS rebinding / TOCTOU). This module only answers
 * "is this URL/address safe right now"; it has no memory of past checks.
 */

import { lookup } from "node:dns/promises";

export class DestinationBlockedError extends Error {
  /** The reason text passed to the constructor, without the message prefix. */
  readonly reason: string;

  constructor(reason: string) {
    super(`Outbound destination blocked — ${reason}`);
    this.name = "DestinationBlockedError";
    this.reason = reason;
  }
}

/**
 * Throw `DestinationBlockedError` if `url` targets a forbidden destination
 * on the URL/scheme/credential/host level. Does not perform DNS resolution
 * — call `assertSafeDestination` for that immediately before connecting.
 */
export function assertSafeDestinationUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DestinationBlockedError("invalid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new DestinationBlockedError(
      "only https:// destinations are permitted",
    );
  }
  if (parsed.username || parsed.password) {
    throw new DestinationBlockedError("URL credentials are not permitted");
  }
  // The WHATWG URL parser leaves `port` empty when it equals the scheme's
  // default (443 for https). Any explicit, non-default port is rejected —
  // a caller-controlled port is itself a common way to reach an internal
  // service that happens to share a public hostname.
  if (parsed.port !== "") {
    throw new DestinationBlockedError(
      `explicit port ${parsed.port} is not permitted; only the default https port is allowed`,
    );
  }

  const host = parsed.hostname.toLowerCase();

  // Strip IPv6 brackets if present
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;

  if (isBlockedHost(bare)) {
    throw new DestinationBlockedError(`destination ${bare} is not routable`);
  }
}

/**
 * Resolve a hostname immediately before connecting and reject it when any
 * returned address is non-public. Checking every A/AAAA result prevents a
 * hostname from hiding an internal destination behind a public answer, and
 * re-running this right before each connection attempt (rather than once,
 * cached) is what defeats DNS-rebinding: the addresses a name resolves to
 * are only trusted for the instant this function checked them.
 */
export async function assertSafeDestination(
  raw: string,
  resolve: typeof lookup = lookup,
): Promise<void> {
  assertSafeDestinationUrl(raw);
  const parsed = new URL(raw);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");

  if (parseIPv4(host) !== null || parseIPv6(host) !== null) return;

  const addresses = await resolve(host, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error("Destination did not resolve");
  }
  for (const { address } of addresses) {
    if (isBlockedHost(address)) {
      throw new DestinationBlockedError(
        `destination ${host} resolved to a non-public address`,
      );
    }
  }
}

export function isBlockedHost(host: string): boolean {
  // Check if it parses as a numeric IP address
  const v4 = parseIPv4(host);
  if (v4 !== null) {
    return isBlockedIPv4(v4);
  }

  const v6 = parseIPv6(host);
  if (v6 !== null) {
    return isBlockedIPv6(v6);
  }

  // Hostnames: block "localhost" and any *.local / *.internal / *.localhost
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  return false;
}

/**
 * Parse a dotted-decimal IPv4 string into a 32-bit unsigned integer,
 * or return null if not a valid IPv4 address.
 *
 * Deliberately strict: each octet must be one to three ASCII decimal
 * digits with no leading zero (except the literal octet "0"), so this
 * function itself can never be fooled by octal (`017`), hex (`0x7f`), or
 * whitespace/exponential forms that `Number()` would otherwise coerce.
 * The WHATWG `URL` parser already canonicalises those before `hostname` is
 * produced, but this function does not rely on that alone.
 */
export function parseIPv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    // Reject leading zeros (e.g. "017") — those are the classic
    // octal-ambiguity vector and have no legitimate canonical use.
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }

  return (
    ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>>
    0
  );
}

function isBlockedIPv4(ip: number): boolean {
  // 0.0.0.0/8
  if ((ip >>> 24) === 0) return true;
  // 10.0.0.0/8
  if ((ip >>> 24) === 10) return true;
  // 100.64.0.0/10 (CGN / shared address space)
  if ((ip >>> 22) === (0x64400000 >>> 22)) return true;
  // 127.0.0.0/8 — loopback
  if ((ip >>> 24) === 127) return true;
  // 169.254.0.0/16 — link-local & cloud metadata (AWS, Azure, GCP)
  if ((ip >>> 16) === 0xa9fe) return true;
  // 172.16.0.0/12 — private
  if ((ip >>> 20) === (0xac100000 >>> 20)) return true;
  // 192.168.0.0/16 — private
  if ((ip >>> 16) === 0xc0a8) return true;
  // 198.18.0.0/15 — benchmark / testing
  if ((ip >>> 17) === (0xc6120000 >>> 17)) return true;
  // 198.51.100.0/24 — TEST-NET-2
  if ((ip >>> 8) === 0xc6336400 >>> 8) return true;
  // 203.0.113.0/24 — TEST-NET-3
  if ((ip >>> 8) === 0xcb007100 >>> 8) return true;
  // 240.0.0.0/4 — reserved
  if ((ip >>> 28) === 0xf) return true;
  // 255.255.255.255
  if (ip === 0xffffffff) return true;
  // Alibaba Cloud metadata 100.100.100.200
  if (ip === parseIPv4("100.100.100.200")) return true;

  return false;
}

/**
 * Full 128-bit IPv6 parse into eight 16-bit groups, or null if `host` is
 * not a valid IPv6 literal. Handles `::` compression and a trailing
 * IPv4-dotted tail (`::ffff:127.0.0.1`).
 */
function parseIPv6(host: string): number[] | null {
  if (!host.includes(":")) return null;

  let addr = host;

  // Trailing embedded IPv4 (e.g. "::ffff:127.0.0.1" or "64:ff9b::1.2.3.4").
  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    const hi = (v4 >>> 16) & 0xffff;
    const lo = v4 & 0xffff;
    addr = `${addr.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }

  if (addr === "::") return new Array(8).fill(0);

  const hasDoubleColon = addr.includes("::");
  if ((addr.match(/::/g) ?? []).length > 1) return null;

  let head: string[];
  let tailGroups: string[];
  if (hasDoubleColon) {
    const [left, right] = addr.split("::");
    head = left ? left.split(":") : [];
    tailGroups = right ? right.split(":") : [];
  } else {
    head = addr.split(":");
    tailGroups = [];
  }

  const allGroups = [...head, ...tailGroups];
  if (allGroups.some((g) => g === "" || !/^[0-9a-fA-F]{1,4}$/.test(g))) {
    return null;
  }

  const missing = 8 - (head.length + tailGroups.length);
  if (!hasDoubleColon && missing !== 0) return null;
  if (hasDoubleColon && missing < 1) return null;

  const groups = [
    ...head.map((g) => parseInt(g, 16)),
    ...(hasDoubleColon ? new Array(missing).fill(0) : []),
    ...tailGroups.map((g) => parseInt(g, 16)),
  ];

  return groups.length === 8 ? groups : null;
}

function isBlockedIPv6(groups: number[]): boolean {
  const isZero = (n: number) => n === 0;

  // Unspecified ::
  if (groups.every(isZero)) return true;
  // Loopback ::1
  if (groups.slice(0, 7).every(isZero) && groups[7] === 1) return true;
  // Link-local fe80::/10 → top 10 bits of first group are 1111111010
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  // Unique local fc00::/7 → top 7 bits are 1111110
  if ((groups[0]! & 0xfe00) === 0xfc00) return true;

  // IPv4-mapped ::ffff:0:0/96 → groups[0..4] = 0, groups[5] = 0xffff,
  // IPv4 payload in the low 32 bits (groups[6..7]). E.g. ::ffff:127.0.0.1
  // canonicalises to 0:0:0:0:0:ffff:7f00:1.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const v4 = ((groups[6]! << 16) | groups[7]!) >>> 0;
    return isBlockedIPv4(v4);
  }

  // IPv4-compatible ::a.b.c.d/96 (deprecated but still parseable) —
  // groups[0..5] = 0, non-zero payload in groups[6..7].
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    !(groups[6] === 0 && groups[7] === 0) &&
    !(groups[6] === 0 && groups[7] === 1)
  ) {
    const v4 = ((groups[6]! << 16) | groups[7]!) >>> 0;
    return isBlockedIPv4(v4);
  }

  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address in the
  // low 32 bits — decode and re-check under the same IPv4 rules.
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    const v4 = ((groups[6]! << 16) | groups[7]!) >>> 0;
    return isBlockedIPv4(v4);
  }

  return false;
}
