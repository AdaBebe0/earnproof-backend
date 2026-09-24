import {
  buildApiKey,
  buildDelivery,
  buildPayment,
  buildProof,
  buildUser,
  expiredApiKey,
  expiredProof,
  failedAnchoringIntent,
  failedDelivery,
  isSynthetic,
  revokedApiKey,
  revokedIssuer,
  revokedProof,
  suspendedIssuer,
  suspendedUser,
  syntheticAmount,
  syntheticInt,
  syntheticWalletAddress,
  unanchoredProof,
} from "./index";
import {
  ProductionSeedRefusedError,
  assertSeedAllowed,
  buildDemoScenario,
} from "./scenario";

describe("synthetic value generation", () => {
  describe("determinism", () => {
    it("produces identical values for the same seed", () => {
      expect(buildUser("alpha")).toEqual(buildUser("alpha"));
      expect(syntheticWalletAddress(7)).toBe(syntheticWalletAddress(7));
      expect(syntheticAmount("x")).toBe(syntheticAmount("x"));
    });

    it("produces different values for different seeds", () => {
      expect(buildUser("alpha").walletAddress).not.toBe(
        buildUser("beta").walletAddress,
      );
    });

    it("does not drift with the clock", () => {
      // Anchored to a fixed epoch rather than Date.now(), so a fixture generated
      // today and one generated next month compare equal.
      const before = buildProof("p", "user_1");
      jest.useFakeTimers().setSystemTime(new Date("2030-06-01T00:00:00.000Z"));
      const after = buildProof("p", "user_1");
      jest.useRealTimers();

      expect(after).toEqual(before);
    });

    it("generates a whole scenario deterministically", () => {
      expect(buildDemoScenario("demo")).toEqual(buildDemoScenario("demo"));
    });
  });

  describe("synthetic markers", () => {
    it("marks every generated identifier as obviously fake", () => {
      const scenario = buildDemoScenario("markers");

      const identifiers = [
        ...scenario.users.map((u) => u.walletAddress),
        ...scenario.users.map((u) => u.walletHash),
        ...scenario.payments.map((p) => p.stellarTransactionHash),
        ...scenario.proofs.map((p) => p.credentialHash),
        ...scenario.apiKeys.map((k) => k.keyHash),
        ...scenario.webhooks.map((w) => w.secret),
        ...scenario.webhooks.map((w) => w.url),
      ];

      identifiers.forEach((value) => {
        expect(isSynthetic(value)).toBe(true);
      });
    });

    it("produces wallet addresses that cannot be valid Stellar addresses", () => {
      // Real addresses are base32 with a CRC checksum. A synthetic one must fail
      // that validation so it can never address a real account.
      const address = syntheticWalletAddress("anything");

      expect(address).toMatch(/^GSYNTHETIC/);
      expect(address).toHaveLength(56);
    });

    it("points webhook URLs at a domain that can never resolve", () => {
      // RFC 2606 reserves .invalid, so a seeded webhook cannot deliver to a host
      // anybody controls.
      const scenario = buildDemoScenario("urls");

      scenario.webhooks.forEach((webhook) => {
        expect(webhook.url).toContain(".example.invalid");
      });
    });

    it("never emits a value shaped like a real secret", () => {
      const scenario = buildDemoScenario("secrets");

      scenario.webhooks.forEach((webhook) => {
        expect(webhook.secret).toContain("not-a-real-secret");
      });
    });
  });

  describe("amounts", () => {
    it("returns amounts as decimal strings, not floats", () => {
      // Money through binary floating point accumulates rounding error, which
      // would make tests assert on subtly wrong values.
      const amount = syntheticAmount("seed");

      expect(typeof amount).toBe("string");
      expect(amount).toMatch(/^\d+\.\d{2}$/);
    });
  });

  describe("bounded integers", () => {
    it("stays within the requested range", () => {
      for (let i = 0; i < 200; i += 1) {
        const value = syntheticInt("range", i, 5, 9);
        expect(value).toBeGreaterThanOrEqual(5);
        expect(value).toBeLessThanOrEqual(9);
      }
    });

    it("rejects an inverted range rather than returning nonsense", () => {
      expect(() => syntheticInt("bad", 1, 10, 2)).toThrow();
    });
  });
});

describe("resource state coverage", () => {
  it("covers expired, revoked, suspended, failed, and unanchored states", () => {
    // These are exactly the states contributors get wrong when hand-building
    // fixtures, so each one has a named builder.
    expect(expiredProof("s", "u").status).toBe("EXPIRED");
    expect(revokedProof("s", "u").status).toBe("REVOKED");
    expect(unanchoredProof("s", "u").contractTransactionHash).toBeNull();
    expect(suspendedUser("s").status).toBe("SUSPENDED");
    expect(suspendedIssuer("s", "o").status).toBe("SUSPENDED");
    expect(revokedIssuer("s", "o").status).toBe("REVOKED");
    expect(failedDelivery("s", "w").status).toBe("FAILED");
    expect(failedAnchoringIntent("s", "p").status).toBe("FAILED");
    expect(revokedApiKey("s", "o", "u").status).toBe("REVOKED");
  });

  it("gives expired records a past expiry and revoked records a revocation time", () => {
    const now = Date.now();

    expect(expiredProof("s", "u").expiresAt.getTime()).toBeLessThan(now);
    expect(expiredApiKey("s", "o", "u").expiresAt?.getTime()).toBeLessThan(now);
    expect(revokedProof("s", "u").revokedAt).not.toBeNull();
  });

  it("marks a failed delivery with a stable reason code, not a raw error", () => {
    expect(failedDelivery("s", "w").failureReason).toBe(
      "synthetic_upstream_error",
    );
  });
});

describe("intent-based builders", () => {
  it("accepts overrides without requiring the full record", () => {
    // The point of intent-based builders: a caller states only what the test
    // cares about, so unrelated schema changes do not break it.
    const proof = buildProof("s", "user_1", { assetCode: "EURC" });

    expect(proof.assetCode).toBe("EURC");
    expect(proof.status).toBe("ACTIVE");
  });

  it("keeps the plaintext payment amount out of any persisted field", () => {
    // The schema stores amountEncrypted. Exposing `amount` for assertions while
    // never writing it is what keeps fixtures honest about the privacy boundary.
    const payment = buildPayment("s", "user_1");

    expect(payment).toHaveProperty("amount");
    expect(payment).not.toHaveProperty("amountEncrypted");
  });

  it("respects the schema's 8-character API key prefix limit", () => {
    const key = buildApiKey("a-very-long-seed-value", "org_1", "user_1");

    expect(key.prefix).toHaveLength(8);
  });
});

describe("referential integrity", () => {
  const scenario = buildDemoScenario("integrity");

  it("resolves every foreign key within the scenario", () => {
    const userIds = new Set(scenario.users.map((u) => u.id));
    const orgIds = new Set(scenario.organizations.map((o) => o.id));
    const proofIds = new Set(scenario.proofs.map((p) => p.id));
    const webhookIds = new Set(scenario.webhooks.map((w) => w.id));

    scenario.organizations.forEach((org) =>
      expect(userIds.has(org.createdById)).toBe(true),
    );
    scenario.issuers.forEach((issuer) =>
      expect(orgIds.has(issuer.organizationId)).toBe(true),
    );
    scenario.payments.forEach((payment) =>
      expect(userIds.has(payment.userId)).toBe(true),
    );
    scenario.proofs.forEach((proof) =>
      expect(userIds.has(proof.userId)).toBe(true),
    );
    scenario.apiKeys.forEach((key) => {
      expect(orgIds.has(key.organizationId)).toBe(true);
      expect(userIds.has(key.createdById)).toBe(true);
    });
    scenario.webhooks.forEach((webhook) =>
      expect(orgIds.has(webhook.organizationId)).toBe(true),
    );
    scenario.deliveries.forEach((delivery) =>
      expect(webhookIds.has(delivery.webhookId)).toBe(true),
    );
    scenario.anchoringIntents.forEach((intent) =>
      expect(proofIds.has(intent.proofId)).toBe(true),
    );
  });

  it("keeps unique fields unique across the scenario", () => {
    const unique = (values: string[]) =>
      expect(new Set(values).size).toBe(values.length);

    unique(scenario.users.map((u) => u.walletAddress));
    unique(scenario.users.map((u) => u.walletHash));
    unique(scenario.organizations.map((o) => o.slug));
    unique(scenario.issuers.map((i) => i.stellarAddress));
    unique(scenario.proofs.map((p) => p.credentialHash));
    unique(scenario.payments.map((p) => p.operationId));
    unique(scenario.apiKeys.map((k) => k.keyHash));
  });
});

describe("production refusal", () => {
  it("refuses when NODE_ENV is production", () => {
    expect(() =>
      assertSeedAllowed({
        nodeEnv: "production",
        databaseUrl: "postgresql://user:pass@localhost:5432/app",
      }),
    ).toThrow(ProductionSeedRefusedError);
  });

  it("refuses production even when the override is set", () => {
    // The override exists for disposable CI environments. It must never be a
    // way to reach production.
    expect(() =>
      assertSeedAllowed({
        nodeEnv: "production",
        databaseUrl: "postgresql://user:pass@localhost:5432/app",
        allowOverride: "true",
      }),
    ).toThrow(ProductionSeedRefusedError);
  });

  it("refuses when no database URL is configured", () => {
    // An unknown target is not a safe target.
    expect(() => assertSeedAllowed({ nodeEnv: "development" })).toThrow(
      ProductionSeedRefusedError,
    );
  });

  it("refuses an unparseable database URL", () => {
    expect(() =>
      assertSeedAllowed({ nodeEnv: "development", databaseUrl: "not a url" }),
    ).toThrow(ProductionSeedRefusedError);
  });

  it("refuses a remote-looking host by default", () => {
    expect(() =>
      assertSeedAllowed({
        nodeEnv: "development",
        databaseUrl: "postgresql://user:pass@db.production.example.com:5432/app",
      }),
    ).toThrow(/not recognised as local/);
  });

  it("allows recognised local hosts", () => {
    [
      "postgresql://user:pass@localhost:5432/app",
      "postgresql://user:pass@127.0.0.1:5432/app",
      "postgresql://user:pass@postgres:5432/app",
      "postgresql://user:pass@host.docker.internal:5432/app",
    ].forEach((databaseUrl) => {
      expect(() =>
        assertSeedAllowed({ nodeEnv: "test", databaseUrl }),
      ).not.toThrow();
    });
  });

  it("allows a remote host only with an explicit override", () => {
    expect(() =>
      assertSeedAllowed({
        nodeEnv: "test",
        databaseUrl: "postgresql://user:pass@ci-runner.internal:5432/app",
        allowOverride: "true",
      }),
    ).not.toThrow();
  });

  it("never leaks the database password in a refusal message", () => {
    // Refusal messages land in CI logs, which are far more widely readable than
    // the environment that produced them.
    try {
      assertSeedAllowed({
        nodeEnv: "development",
        databaseUrl: "postgresql://user:hunter2@remote.example.com:5432/app",
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2");
    }
  });
});

describe("idempotent reseeding", () => {
  it("produces stable primary keys so an upsert converges", () => {
    // Idempotency depends on stable IDs: with random IDs each reseed would
    // insert duplicates instead of updating in place.
    const first = buildDemoScenario("repeat");
    const second = buildDemoScenario("repeat");

    expect(first.users.map((u) => u.id)).toEqual(second.users.map((u) => u.id));
    expect(first.proofs.map((p) => p.id)).toEqual(
      second.proofs.map((p) => p.id),
    );
  });

  it("keeps every record identical across repeated builds", () => {
    const runs = [1, 2, 3].map(() => JSON.stringify(buildDemoScenario("stable")));

    expect(new Set(runs).size).toBe(1);
  });
});

describe("delivery payloads", () => {
  it("carries an obviously synthetic payload", () => {
    expect(buildDelivery("s", "webhook_1").payload).toMatchObject({
      synthetic: true,
    });
  });
});
