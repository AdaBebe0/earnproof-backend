import {
  DestructiveResetRefusedError,
  assertResetAllowed,
  databaseNameFromUrl,
} from "./database-reset";

/**
 * Reset guard.
 *
 * These are the tests that stand between a contributor's muscle memory and a
 * truncated production database, so they are written as a refusal matrix rather
 * than as a happy path with a couple of negative cases: every way in has to be
 * closed, not most of them.
 */

const LOCAL = "postgresql://earnproof:pw@localhost:5432/earnproof_test";

describe("assertResetAllowed", () => {
  it("permits a locally hosted, disposably named database with confirmation", () => {
    expect(() =>
      assertResetAllowed({
        nodeEnv: "development",
        databaseUrl: LOCAL,
        confirmDatabase: "earnproof_test",
      }),
    ).not.toThrow();
  });

  it("refuses when NODE_ENV is production", () => {
    expect(() =>
      assertResetAllowed({
        nodeEnv: "production",
        databaseUrl: LOCAL,
        confirmDatabase: "earnproof_test",
      }),
    ).toThrow(DestructiveResetRefusedError);
  });

  it("refuses production even when the override is set", () => {
    // The override exists for disposable environments whose hostnames are not
    // local. It must not become a way to reset production.
    expect(() =>
      assertResetAllowed({
        nodeEnv: "production",
        databaseUrl: LOCAL,
        confirmDatabase: "earnproof_test",
        allowOverride: "true",
      }),
    ).toThrow(/NODE_ENV is production/);
  });

  it.each([
    ["no database URL", { databaseUrl: undefined }],
    ["an empty database URL", { databaseUrl: "   " }],
    ["an unparseable database URL", { databaseUrl: "not-a-url" }],
    [
      "a URL naming no database",
      { databaseUrl: "postgresql://earnproof:pw@localhost:5432" },
    ],
  ])("refuses %s", (_label, override) => {
    expect(() =>
      assertResetAllowed({
        nodeEnv: "development",
        confirmDatabase: "earnproof_test",
        ...override,
      }),
    ).toThrow(DestructiveResetRefusedError);
  });

  it("refuses a production-shaped database name even on localhost", () => {
    // The realistic accident: a laptop shell still holding a tunnelled
    // connection to something that is not disposable.
    expect(() =>
      assertResetAllowed({
        nodeEnv: "development",
        databaseUrl: "postgresql://earnproof:pw@localhost:5432/earnproof",
        confirmDatabase: "earnproof",
      }),
    ).toThrow(/is not named as a test, dev or local database/);
  });

  it("refuses a remote host by default", () => {
    expect(() =>
      assertResetAllowed({
        nodeEnv: "development",
        databaseUrl: "postgresql://earnproof:pw@db.example.com:5432/earnproof_test",
        confirmDatabase: "earnproof_test",
      }),
    ).toThrow(/is not recognised as local/);
  });

  it("allows a remote host only with an explicit override", () => {
    expect(() =>
      assertResetAllowed({
        nodeEnv: "test",
        databaseUrl: "postgresql://earnproof:pw@db.example.com:5432/earnproof_ci",
        confirmDatabase: "earnproof_ci",
        allowOverride: "true",
      }),
    ).not.toThrow();
  });

  it("refuses without a confirmation, and names what to type", () => {
    expect(() =>
      assertResetAllowed({ nodeEnv: "development", databaseUrl: LOCAL }),
    ).toThrow(/CONFIRM_RESET="earnproof_test"/);
  });

  it("refuses a confirmation that names a different database", () => {
    // The exact case the confirmation exists for: the operator means the local
    // database, the environment points at another one.
    expect(() =>
      assertResetAllowed({
        nodeEnv: "development",
        databaseUrl: LOCAL,
        confirmDatabase: "earnproof_dev",
      }),
    ).toThrow(/does not name the target database/);
  });

  it("refuses a truthy-looking confirmation that is not the name", () => {
    for (const confirmation of ["true", "yes", "y", "1", "confirm"]) {
      expect(() =>
        assertResetAllowed({
          nodeEnv: "development",
          databaseUrl: LOCAL,
          confirmDatabase: confirmation,
        }),
      ).toThrow(DestructiveResetRefusedError);
    }
  });

  it("never leaks the database password in a refusal message", () => {
    // A safety message that prints the connection string turns a guard into a
    // credential leak, in a terminal that is often pasted into an issue.
    try {
      assertResetAllowed({
        nodeEnv: "development",
        databaseUrl: "postgresql://earnproof:sup3r-s3cret@db.example.com:5432/earnproof_test",
        confirmDatabase: "earnproof_test",
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).not.toContain("sup3r-s3cret");
      expect((error as Error).message).toContain("db.example.com");
    }
  });
});

describe("databaseNameFromUrl", () => {
  it("returns the database name", () => {
    expect(databaseNameFromUrl(LOCAL)).toBe("earnproof_test");
  });

  it("returns nothing for a URL with no database or an unparseable one", () => {
    expect(
      databaseNameFromUrl("postgresql://earnproof:pw@localhost:5432"),
    ).toBeUndefined();
    expect(databaseNameFromUrl("nonsense")).toBeUndefined();
  });
});
