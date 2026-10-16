/**
 * SSRF / outbound-destination validation contract tests.
 *
 * These exercise `src/common/http/destination-guard.ts` — the single source
 * of truth every outbound HTTP client (webhooks today) must run a
 * caller-influenced destination through before connecting.
 *
 * Everything here is local and deterministic: no real DNS lookups and no
 * real network calls. `dns.lookup` is mocked per-test with a fake resolver
 * function, and malicious/edge-case destinations are fixed strings, not
 * live hosts.
 */

import { lookup } from "node:dns/promises";
import {
  DestinationBlockedError,
  assertSafeDestination,
  assertSafeDestinationUrl,
  isBlockedHost,
  parseIPv4,
} from "../../src/common/http/destination-guard";

type LookupResult = { address: string; family: number };
type LookupFn = typeof lookup;

function fakeResolver(addresses: LookupResult[]): LookupFn {
  return jest.fn().mockResolvedValue(addresses) as unknown as LookupFn;
}

const allowUrl = (url: string) =>
  expect(() => assertSafeDestinationUrl(url)).not.toThrow();
const blockUrl = (url: string) =>
  expect(() => assertSafeDestinationUrl(url)).toThrow(DestinationBlockedError);

describe("assertSafeDestinationUrl — scheme allowlist", () => {
  it("allows https with no explicit port", () => allowUrl("https://example.com/hook"));
  it("allows https with the explicit default port (443)", () =>
    allowUrl("https://example.com:443/hook"));

  it.each([
    ["http:", "http://example.com/hook"],
    ["ftp:", "ftp://example.com/hook"],
    ["file:", "file:///etc/passwd"],
    ["gopher:", "gopher://example.com/hook"],
    ["ws:", "ws://example.com/hook"],
    ["data:", "data:text/plain,hello"],
  ])("blocks %s scheme", (_label, url) => blockUrl(url));

  it("blocks an empty string", () => blockUrl(""));
  it("blocks a relative path (no scheme)", () => blockUrl("/relative/path"));
});

describe("assertSafeDestinationUrl — port allowlist", () => {
  it.each([
    "https://example.com:80/hook",
    "https://example.com:8080/hook",
    "https://example.com:8443/hook",
    "https://example.com:22/hook",
    "https://example.com:6379/hook",
    "https://example.com:9200/hook",
    "https://example.com:0/hook",
  ])("blocks explicit non-default port %s", (url) => blockUrl(url));
});

describe("assertSafeDestinationUrl — credential handling", () => {
  it.each([
    "https://user:pass@example.com/hook",
    "https://user@example.com/hook",
    "https://:pass@example.com/hook",
  ])("blocks URL-embedded credentials in %s", (url) => blockUrl(url));
});

describe("assertSafeDestinationUrl — IPv4 address-range blocking", () => {
  it.each([
    ["loopback network", "https://127.0.0.1/hook"],
    ["loopback upper bound", "https://127.255.255.254/hook"],
    ["unspecified", "https://0.0.0.0/hook"],
    ["unspecified network", "https://0.1.2.3/hook"],
    ["RFC1918 10/8", "https://10.0.0.1/hook"],
    ["RFC1918 172.16/12", "https://172.16.0.1/hook"],
    ["RFC1918 172.31/12 upper bound", "https://172.31.255.255/hook"],
    ["RFC1918 192.168/16", "https://192.168.1.1/hook"],
    ["link-local", "https://169.254.0.1/hook"],
    ["AWS/GCP/Azure metadata", "https://169.254.169.254/hook"],
    ["Alibaba metadata", "https://100.100.100.200/hook"],
    ["carrier-grade NAT", "https://100.64.0.1/hook"],
    ["benchmark/testing 198.18/15", "https://198.18.0.1/hook"],
    ["TEST-NET-2", "https://198.51.100.1/hook"],
    ["TEST-NET-3", "https://203.0.113.1/hook"],
    ["reserved 240/4", "https://240.0.0.1/hook"],
    ["broadcast", "https://255.255.255.255/hook"],
  ])("blocks %s (%s)", (_label, url) => blockUrl(url));

  it("allows a public IPv4 address", () => allowUrl("https://8.8.8.8/hook"));
});

describe("assertSafeDestinationUrl — IPv6 address-range blocking", () => {
  it.each([
    ["unspecified", "https://[::]/hook"],
    ["loopback", "https://[::1]/hook"],
    ["link-local", "https://[fe80::1]/hook"],
    ["link-local upper", "https://[febf::1]/hook"],
    ["unique-local fc00::/7 low half", "https://[fc00::1]/hook"],
    ["unique-local fc00::/7 high half", "https://[fd00::dead:beef]/hook"],
  ])("blocks %s (%s)", (_label, url) => blockUrl(url));

  it("allows a public IPv6 address", () =>
    allowUrl("https://[2606:2800:220:1:248:1893:25c8:1946]/hook"));
});

describe("assertSafeDestinationUrl — ambiguous IPv4 representations", () => {
  // These must all be rejected — either because the strict parser refuses to
  // treat them as IPv4 at all (so they fall through to hostname rules and are
  // not blocked purely on grounds of *being* an IP), or, when the WHATWG URL
  // parser itself canonicalises them into a real (blocked) address, because
  // isBlockedHost then sees the canonical form. Either way "0x7f.0.0.1" must
  // never reach the network as a trusted, unblocked destination.
  it("parseIPv4 rejects octal-looking octets (leading zero)", () => {
    expect(parseIPv4("017.0.0.1")).toBeNull();
    expect(parseIPv4("0177.0.0.1")).toBeNull();
  });

  it("parseIPv4 rejects hex octets", () => {
    expect(parseIPv4("0x7f.0.0.1")).toBeNull();
  });

  it("parseIPv4 rejects a single decimal-integer form (2130706433 == 127.0.0.1)", () => {
    expect(parseIPv4("2130706433")).toBeNull();
  });

  it("parseIPv4 rejects fewer-than-4-part shorthand (127.1 == 127.0.0.1)", () => {
    expect(parseIPv4("127.1")).toBeNull();
    expect(parseIPv4("127.0.1")).toBeNull();
  });

  it("parseIPv4 rejects out-of-range octets", () => {
    expect(parseIPv4("256.0.0.1")).toBeNull();
    expect(parseIPv4("127.0.0.999")).toBeNull();
  });

  it("parseIPv4 rejects whitespace/garbage octets Number() would coerce", () => {
    expect(parseIPv4(" 127.0.0.1")).toBeNull();
    expect(parseIPv4("127.0.0.1 ")).toBeNull();
    expect(parseIPv4("127.0.0.")).toBeNull();
    expect(parseIPv4("...")).toBeNull();
  });

  it("parseIPv4 accepts canonical dotted-decimal", () => {
    expect(parseIPv4("127.0.0.1")).toBe(0x7f000001);
    expect(parseIPv4("0.0.0.0")).toBe(0);
    expect(parseIPv4("255.255.255.255")).toBe(0xffffffff);
    // A single literal "0" octet is fine — it is not a leading zero.
    expect(parseIPv4("10.0.0.1")).not.toBeNull();
  });

  it("the WHATWG URL parser's own canonicalisation of octal/hex/integer forms never yields an unblocked loopback destination", () => {
    for (const candidate of [
      "https://0x7f.0.0.1/hook", // hex
      "https://017700000001/hook", // decimal-looking, would be an int form
      "https://2130706433/hook", // pure decimal loopback
      "https://127.1/hook", // shorthand
      "https://0177.0.0.1/hook", // octal
    ]) {
      let blocked = false;
      try {
        assertSafeDestinationUrl(candidate);
      } catch (err) {
        blocked = err instanceof DestinationBlockedError;
      }
      // Either the URL constructor rejects/mangles it into something that
      // is not treated as a trusted loopback bypass, or our guard blocks
      // the canonical form outright. What must never happen is this
      // resolving to an *allowed* loopback address.
      if (!blocked) {
        const parsed = new URL(candidate);
        expect(isBlockedHost(parsed.hostname)).toBe(false); // hostname form, not IP — safe to allow only if not a disguised loopback
        expect(parsed.hostname).not.toBe("127.0.0.1");
      }
    }
  });
});

describe("assertSafeDestinationUrl — IPv4-mapped / NAT64 IPv6 disguises", () => {
  it.each([
    ["IPv4-mapped loopback (dotted tail)", "https://[::ffff:127.0.0.1]/hook"],
    ["IPv4-mapped metadata (hex form)", "https://[::ffff:a9fe:a9fe]/hook"],
    ["IPv4-mapped private 10/8", "https://[::ffff:10.0.0.1]/hook"],
    ["NAT64-embedded loopback", "https://[64:ff9b::7f00:1]/hook"],
    ["NAT64-embedded metadata", "https://[64:ff9b::a9fe:a9fe]/hook"],
  ])("blocks %s (%s)", (_label, url) => blockUrl(url));

  it("allows an IPv4-mapped public address", () =>
    allowUrl("https://[::ffff:8.8.8.8]/hook"));
});

describe("assertSafeDestinationUrl — local hostname patterns", () => {
  it.each([
    "https://localhost/hook",
    "https://evil.localhost/hook",
    "https://myapp.local/hook",
    "https://service.internal/hook",
  ])("blocks %s", (url) => blockUrl(url));

  it("allows an ordinary public hostname", () => allowUrl("https://example.com/hook"));
});

describe("assertSafeDestination — DNS revalidation at connection time (TOCTOU / rebinding)", () => {
  it("blocks when the resolved address is private even though the hostname looks public", async () => {
    const resolve = fakeResolver([{ address: "169.254.169.254", family: 4 }]);

    await expect(
      assertSafeDestination("https://hooks.example.com/event", resolve),
    ).rejects.toThrow(DestinationBlockedError);
    expect(resolve).toHaveBeenCalledWith(
      "hooks.example.com",
      expect.objectContaining({ all: true }),
    );
  });

  it("blocks when only one of several resolved addresses is private", async () => {
    const resolve = fakeResolver([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);

    await expect(
      assertSafeDestination("https://hooks.example.com/event", resolve),
    ).rejects.toThrow(DestinationBlockedError);
  });

  it("allows a hostname only when every resolved address is public", async () => {
    const resolve = fakeResolver([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);

    await expect(
      assertSafeDestination("https://hooks.example.com/event", resolve),
    ).resolves.toBeUndefined();
  });

  it("re-resolves on every call — simulating DNS rebinding between two connection attempts", async () => {
    // First attempt: hostname resolves to a public address, guard passes.
    const firstResolve = fakeResolver([{ address: "93.184.216.34", family: 4 }]);
    await expect(
      assertSafeDestination("https://hooks.example.com/event", firstResolve),
    ).resolves.toBeUndefined();

    // Attacker rebinds DNS between delivery attempts (e.g. this is a retry).
    // Because the guard re-resolves on every call rather than caching the
    // first attempt's result, the second attempt must be caught.
    const secondResolve = fakeResolver([{ address: "127.0.0.1", family: 4 }]);
    await expect(
      assertSafeDestination("https://hooks.example.com/event", secondResolve),
    ).rejects.toThrow(DestinationBlockedError);

    expect(firstResolve).toHaveBeenCalledTimes(1);
    expect(secondResolve).toHaveBeenCalledTimes(1);
  });

  it("throws when DNS resolution returns zero addresses", async () => {
    const resolve = fakeResolver([]);
    await expect(
      assertSafeDestination("https://hooks.example.com/event", resolve),
    ).rejects.toThrow("did not resolve");
  });

  it("skips DNS resolution entirely for a literal IPv4 destination and blocks it directly", async () => {
    const resolve = jest.fn();
    await expect(
      assertSafeDestination("https://127.0.0.1/hook", resolve as unknown as LookupFn),
    ).rejects.toThrow(DestinationBlockedError);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("skips DNS resolution entirely for a literal IPv6 destination and allows a public one", async () => {
    const resolve = jest.fn();
    await expect(
      assertSafeDestination(
        "https://[2606:2800:220:1:248:1893:25c8:1946]/hook",
        resolve as unknown as LookupFn,
      ),
    ).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects scheme/credential/port violations before ever calling the resolver", async () => {
    const resolve = jest.fn();
    await expect(
      assertSafeDestination(
        "http://user:pass@hooks.example.com:8080/event",
        resolve as unknown as LookupFn,
      ),
    ).rejects.toThrow(DestinationBlockedError);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("assertSafeDestination — redirect and credential-forwarding boundary", () => {
  // The guard itself has no notion of "redirect" — a redirect is a brand new
  // URL that the transport layer must re-run through the whole guard rather
  // than blindly following. These tests document and lock in that contract:
  // a redirect target that would itself be blocked must be blocked
  // identically to a first-hop destination, and credentials never survive
  // into a validated URL.
  it("treats a redirect target exactly like any other destination — blocks if it points internal", () => {
    const originalUrl = "https://hooks.example.com/event";
    const redirectTarget = "https://169.254.169.254/latest/meta-data/";

    allowUrl(originalUrl);
    expect(() => assertSafeDestinationUrl(redirectTarget)).toThrow(
      DestinationBlockedError,
    );
  });

  it("blocks a redirect target that smuggles credentials", () => {
    const redirectTarget = "https://attacker:token@example.com/collect";
    expect(() => assertSafeDestinationUrl(redirectTarget)).toThrow(
      DestinationBlockedError,
    );
  });

  it("blocks a redirect target that downgrades scheme to strip TLS", () => {
    const redirectTarget = "http://example.com/collect";
    expect(() => assertSafeDestinationUrl(redirectTarget)).toThrow(
      DestinationBlockedError,
    );
  });
});
