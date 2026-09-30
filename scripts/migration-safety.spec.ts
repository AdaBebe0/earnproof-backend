import { migrationSafetyIssues } from "./migration-safety";

describe("migration safety gate", () => {
  const fixtures = (name: string) => `${process.cwd()}/test/fixtures/migrations/${name}`;

  it("accepts the production history while explicitly grandfathering its legacy duplicate", () => {
    expect(migrationSafetyIssues()).toEqual([]);
  });

  it("fails a destructive fixture without containment documentation", () => {
    expect(migrationSafetyIssues(fixtures("unsafe-destructive"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unsafe_sql" })]),
    );
  });

  it("fails duplicate timestamp and checksum fixtures", () => {
    const issues = migrationSafetyIssues(fixtures("duplicate-timestamp"));
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "timestamp" }),
      expect.objectContaining({ code: "checksum" }),
    ]));
  });
});
