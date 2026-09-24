import {
  ALLOWED_METRIC_LABELS,
  assertValidLabels,
  FORBIDDEN_METRIC_LABELS,
  InvalidMetricLabelError,
  maxSeriesFor,
  toRouteLabel,
  toStatusClass,
  type MetricLabelName,
} from "./metric-labels";

describe("metric label vocabulary", () => {
  describe("forbidden labels", () => {
    // The acceptance criterion names these categories explicitly. Each is
    // asserted with a realistic value so the test fails if a rule is relaxed to
    // let the shape through.
    const forbidden: Array<[string, Record<string, string>]> = [
      [
        "wallet address",
        { wallet: "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR" },
      ],
      ["wallet hash", { wallet_hash: "9f2b7c1e4a" }],
      ["proof id", { proof_id: "clx8y2k1p0000abcd1234efgh" }],
      ["credential hash", { credential_hash: "a".repeat(64) }],
      ["amount", { amount: "1250.75" }],
      ["memo", { memo: "invoice 42 for March" }],
      ["url", { url: "https://example.com/hooks/abc" }],
      ["signature", { signature: "MEUCIQD..." }],
      ["raw error", { error: "connect ECONNREFUSED 10.0.0.4:5432" }],
      ["error message", { error_message: "duplicate key value violates..." }],
    ];

    it.each(forbidden)("rejects a %s label", (_name, labels) => {
      expect(() => assertValidLabels(labels)).toThrow(InvalidMetricLabelError);
    });

    it.each(forbidden)(
      "explains why a %s label is refused",
      (_name, labels) => {
        expect(() => assertValidLabels(labels)).toThrow(
          /forbidden|not in the allowed vocabulary/,
        );
      },
    );

    it("names the privacy rule rather than a generic failure", () => {
      expect(() => assertValidLabels({ wallet: "G..." })).toThrow(
        /identifying or unbounded data/,
      );
    });

    it("rejects forbidden names case-insensitively", () => {
      // A label added as `walletAddress` must not slip past a lowercase list.
      expect(() => assertValidLabels({ WALLETADDRESS: "G..." })).toThrow(
        InvalidMetricLabelError,
      );
    });
  });

  describe("high-cardinality labels", () => {
    it("rejects a correlation identifier even though it is not private", () => {
      // A request ID leaks nothing, but one series per request is unusable.
      // It belongs in a log field, which is what the message should say.
      expect(() =>
        assertValidLabels({ request_id: "8f14e45fceea167a5a36dedd4bea2543" }),
      ).toThrow(/forbidden/);
    });

    it("rejects a trace identifier", () => {
      expect(() => assertValidLabels({ trace_id: "abc123" })).toThrow(
        InvalidMetricLabelError,
      );
    });

    it("rejects an unknown label rather than allowing it through", () => {
      // Default-deny: anything not explicitly permitted is refused, whether or
      // not it appears on the forbidden list.
      expect(() => assertValidLabels({ tenant_slug: "acme" })).toThrow(
        /not in the allowed vocabulary/,
      );
    });

    it("rejects a permitted label carrying an unlisted value", () => {
      // The name being allowed is not enough: an open value set would reopen the
      // cardinality hole the allowlist exists to close.
      expect(() =>
        assertValidLabels({ route: "/proofs/clx8y2k1p0000abcd1234efgh" }),
      ).toThrow(/not permitted for label/);
    });

    it("rejects an unlisted outcome value", () => {
      expect(() => assertValidLabels({ outcome: "kinda_worked" })).toThrow(
        /not permitted for label/,
      );
    });
  });

  describe("permitted labels", () => {
    it("accepts a fully valid label set", () => {
      expect(() =>
        assertValidLabels({
          route: "/proofs",
          method: "POST",
          status_class: "2xx",
        }),
      ).not.toThrow();
    });

    it("accepts an absent label set", () => {
      expect(() => assertValidLabels(undefined)).not.toThrow();
    });

    it("accepts every declared value of every declared label", () => {
      // Guards against a vocabulary entry that the validator would itself
      // reject — a contradiction that would only surface at runtime.
      for (const [name, values] of Object.entries(ALLOWED_METRIC_LABELS)) {
        for (const value of values) {
          expect(() => assertValidLabels({ [name]: value })).not.toThrow();
        }
      }
    });
  });

  describe("vocabulary integrity", () => {
    it("keeps the allowed and forbidden sets disjoint", () => {
      // An overlap would make the outcome depend on check order.
      for (const name of Object.keys(ALLOWED_METRIC_LABELS)) {
        expect(FORBIDDEN_METRIC_LABELS.has(name)).toBe(false);
      }
    });

    it("bounds every permitted label to a small value set", () => {
      // A label with an unbounded or merely large value set defeats the purpose
      // of the allowlist, so the ceiling is asserted rather than assumed.
      for (const values of Object.values(ALLOWED_METRIC_LABELS)) {
        expect(values.length).toBeGreaterThan(0);
        expect(values.length).toBeLessThanOrEqual(32);
      }
    });

    it("has no duplicate values within a label", () => {
      for (const values of Object.values(ALLOWED_METRIC_LABELS)) {
        expect(new Set(values).size).toBe(values.length);
      }
    });
  });

  describe("maxSeriesFor", () => {
    it("returns one for an unlabelled metric", () => {
      expect(maxSeriesFor([])).toBe(1);
    });

    it("multiplies the value counts of each label", () => {
      const names: MetricLabelName[] = ["method", "status_class"];
      expect(maxSeriesFor(names)).toBe(
        ALLOWED_METRIC_LABELS.method.length *
          ALLOWED_METRIC_LABELS.status_class.length,
      );
    });
  });

  describe("toRouteLabel", () => {
    it("maps a concrete resource path to its route template", () => {
      expect(toRouteLabel("/proofs/clx8y2k1p0000abcd1234efgh")).toBe("/proofs");
    });

    it("collapses an unrecognised path rather than creating a series", () => {
      expect(toRouteLabel("/does-not-exist/12345")).toBe("other");
    });

    it("collapses an attacker-supplied path", () => {
      // The property that matters: no input produces a new series.
      expect(toRouteLabel("/../../etc/passwd")).toBe("other");
      expect(toRouteLabel(`/${"a".repeat(4096)}`)).toBe("other");
    });

    it("strips a query string before matching", () => {
      expect(toRouteLabel("/proofs?limit=10&cursor=abc")).toBe("/proofs");
    });

    it("prefers the longest matching route", () => {
      // `/auth/sessions` must not be shadowed by a shorter `/auth…` prefix.
      expect(toRouteLabel("/auth/sessions")).toBe("/auth/sessions");
    });

    it("ignores a trailing slash", () => {
      expect(toRouteLabel("/proofs/")).toBe("/proofs");
    });

    it("only ever returns a permitted route value", () => {
      const paths = [
        "/",
        "/health",
        "/proofs/abc",
        "/webhooks/1/deliveries/2",
        "/random",
        "//",
        "/AUTH/VERIFY",
      ];

      for (const path of paths) {
        expect(() =>
          assertValidLabels({ route: toRouteLabel(path) }),
        ).not.toThrow();
      }
    });
  });

  describe("toStatusClass", () => {
    it.each([
      [200, "2xx"],
      [201, "2xx"],
      [301, "3xx"],
      [400, "4xx"],
      [404, "4xx"],
      [429, "4xx"],
      [500, "5xx"],
      [503, "5xx"],
    ])("maps %i to %s", (code, expected) => {
      expect(toStatusClass(code)).toBe(expected);
    });

    it("never produces an unpermitted value", () => {
      for (let code = 100; code < 600; code += 1) {
        expect(() =>
          assertValidLabels({ status_class: toStatusClass(code) }),
        ).not.toThrow();
      }
    });
  });
});
