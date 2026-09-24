import {
  SsrfBlockedError,
  assertSafeWebhookDestination,
  assertSafeWebhookUrl,
} from "./webhook-ssrf-guard";

describe("assertSafeWebhookUrl", () => {
  const allow = (url: string) =>
    expect(() => assertSafeWebhookUrl(url)).not.toThrow();

  const block = (url: string) =>
    expect(() => assertSafeWebhookUrl(url)).toThrow(SsrfBlockedError);

  // -------------------------------------------------------------------------
  // Allowed destinations
  // -------------------------------------------------------------------------
  describe("allows safe public HTTPS destinations", () => {
    it("allows a plain public domain", () => allow("https://example.com/hook"));
    it("allows a public domain with path", () => allow("https://hooks.slack.com/services/T00/B00/abc"));
    it("allows a subdomain", () => allow("https://api.example.org/webhooks"));
    it("allows a public numeric IP with standard port", () => allow("https://8.8.8.8/hook"));
  });

  // -------------------------------------------------------------------------
  // Non-HTTPS
  // -------------------------------------------------------------------------
  describe("blocks non-HTTPS schemes", () => {
    it("blocks http://", () => block("http://example.com/hook"));
    it("blocks ftp://", () => block("ftp://example.com/hook"));
    it("blocks an empty string", () => block(""));
    it("blocks a relative path", () => block("/relative/path"));
  });

  // -------------------------------------------------------------------------
  // Loopback
  // -------------------------------------------------------------------------
  describe("blocks loopback addresses", () => {
    it("blocks 127.0.0.1", () => block("https://127.0.0.1/hook"));
    it("blocks 127.0.0.2", () => block("https://127.0.0.2/hook"));
    it("blocks 127.255.255.254", () => block("https://127.255.255.254/hook"));
    it("blocks ::1", () => block("https://[::1]/hook"));
    it("blocks localhost hostname", () => block("https://localhost/hook"));
    it("blocks *.localhost", () => block("https://evil.localhost/hook"));
  });

  // -------------------------------------------------------------------------
  // RFC 1918 private ranges
  // -------------------------------------------------------------------------
  describe("blocks RFC-1918 private IP ranges", () => {
    it("blocks 10.0.0.1", () => block("https://10.0.0.1/hook"));
    it("blocks 10.255.255.255", () => block("https://10.255.255.255/hook"));
    it("blocks 172.16.0.1", () => block("https://172.16.0.1/hook"));
    it("blocks 172.31.255.255", () => block("https://172.31.255.255/hook"));
    it("blocks 192.168.1.1", () => block("https://192.168.1.1/hook"));
    it("blocks 192.168.255.255", () => block("https://192.168.255.255/hook"));
  });

  // -------------------------------------------------------------------------
  // Link-local / cloud metadata
  // -------------------------------------------------------------------------
  describe("blocks link-local and cloud metadata endpoints", () => {
    it("blocks 169.254.169.254 (AWS/GCP/Azure metadata)", () =>
      block("https://169.254.169.254/latest/meta-data/"));
    it("blocks 169.254.0.1", () => block("https://169.254.0.1/hook"));
    it("blocks 100.100.100.200 (Alibaba metadata)", () =>
      block("https://100.100.100.200/latest/meta-data/"));
    it("blocks fe80:: link-local IPv6", () => block("https://[fe80::1]/hook"));
    it("blocks fc00::/7 unique local IPv6", () => block("https://[fc00::1]/hook"));
    it("blocks fd00::/8 unique local IPv6", () => block("https://[fd00::dead:beef]/hook"));
  });

  // -------------------------------------------------------------------------
  // Special-use / unroutable
  // -------------------------------------------------------------------------
  describe("blocks special-use and unroutable addresses", () => {
    it("blocks 0.0.0.0", () => block("https://0.0.0.0/hook"));
    it("blocks 0.1.2.3", () => block("https://0.1.2.3/hook"));
    it("blocks 240.0.0.1", () => block("https://240.0.0.1/hook"));
    it("blocks 255.255.255.255", () => block("https://255.255.255.255/hook"));
  });

  // -------------------------------------------------------------------------
  // Local hostnames
  // -------------------------------------------------------------------------
  describe("blocks local hostname patterns", () => {
    it("blocks *.local", () => block("https://myapp.local/hook"));
    it("blocks *.internal", () => block("https://service.internal/hook"));
  });

  // -------------------------------------------------------------------------
  // Redirect guard — tested via redirect:"error" in fetch (documented behavior)
  // -------------------------------------------------------------------------
  describe("does not allow safe-looking URL targeting a public host", () => {
    it("allows a legitimate HTTPS public URL", () =>
      allow("https://webhooks.example.com/v1/earn"));
  });
});

describe("assertSafeWebhookDestination", () => {
  it("blocks a public-looking hostname when DNS resolves to a private IP", async () => {
    const resolve = jest.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);

    await expect(
      assertSafeWebhookDestination(
        "https://hooks.example.com/event",
        resolve as never,
      ),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("accepts a hostname only when every resolved address is public", async () => {
    const resolve = jest.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);

    await expect(
      assertSafeWebhookDestination(
        "https://hooks.example.com/event",
        resolve as never,
      ),
    ).resolves.toBeUndefined();
  });
});
