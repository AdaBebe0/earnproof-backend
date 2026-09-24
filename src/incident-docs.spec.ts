import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

/**
 * Incident runbook checks.
 *
 * A runbook is read once, under pressure, by someone who did not write it. Two
 * properties have to hold for that to work, and neither survives on good
 * intentions:
 *
 * 1. **Every scenario document has the same sections, in the same order.** A
 *    responder should not have to search a document at 3am for where
 *    containment is described.
 * 2. **A command that destroys state says so.** The runbooks contain SQL, and a
 *    responder copying an `UPDATE` out of a document because it sat next to a
 *    read-only `SELECT` is the exact accident these documents exist to prevent.
 *
 * Link targets are already checked by `docs-links.spec.ts`, which covers every
 * markdown file under `docs/`, including these.
 */

const REPO_ROOT = resolve(__dirname, "..");
const INCIDENTS = join(REPO_ROOT, "docs", "incidents");

/** Scenario runbooks: everything but the index and the two supporting docs. */
const SUPPORTING = new Set([
  "README.md",
  "evidence-preservation.md",
  "tabletop.md",
]);

const allDocs = readdirSync(INCIDENTS).filter((name) => name.endsWith(".md"));
const scenarios = allDocs.filter((name) => !SUPPORTING.has(name));

/** The sections every scenario runbook must carry, in order. */
const REQUIRED_SECTIONS = [
  "## Severity",
  "## Detect",
  "## Contain",
  "## Preserve evidence",
  "## Recover",
  "## Communicate",
  "## Exit criteria",
];

/**
 * Tokens that mean a command changes or destroys state.
 *
 * Word-boundary matched so `SELECT ... FROM "AuditLog" WHERE "action" =
 * 'api_key.revoked'` — a read about a destructive action — is not mistaken for
 * one.
 */
const DESTRUCTIVE_TOKENS = [
  /\bUPDATE\s+"/i,
  /\bDELETE\s+FROM\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bTRUNCATE\b/i,
  /\bINSERT\s+INTO\b/i,
  /\brm\s+-[rf]/,
  /\bkubectl\s+delete\b/,
];

/** Fenced code blocks in a markdown file, with the line each one opens on. */
function fencedBlocks(content: string): Array<{ body: string; line: number }> {
  const lines = content.split("\n");
  const blocks: Array<{ body: string; line: number }> = [];

  let open: number | undefined;
  lines.forEach((line, index) => {
    if (!line.startsWith("```")) return;

    if (open === undefined) {
      open = index;
      return;
    }

    blocks.push({ body: lines.slice(open + 1, index).join("\n"), line: open });
    open = undefined;
  });

  return blocks;
}

describe("incident runbooks", () => {
  it("exist and are indexed", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(5);

    const index = readFileSync(join(INCIDENTS, "README.md"), "utf8");
    const unlisted = allDocs.filter(
      (name) => name !== "README.md" && !index.includes(`(${name})`),
    );

    expect(unlisted).toEqual([]);
  });

  it.each(scenarios)("%s carries every required section in order", (name) => {
    const content = readFileSync(join(INCIDENTS, name), "utf8");

    const positions = REQUIRED_SECTIONS.map((section) => ({
      section,
      at: content.indexOf(`\n${section}`),
    }));

    expect(positions.filter((entry) => entry.at === -1).map((e) => e.section)).toEqual(
      [],
    );

    const order = positions.map((entry) => entry.at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it.each(allDocs)("%s marks every state-changing command as destructive", (name) => {
    const content = readFileSync(join(INCIDENTS, name), "utf8");

    const unmarked = fencedBlocks(content)
      .filter((block) =>
        DESTRUCTIVE_TOKENS.some((token) => token.test(block.body)),
      )
      .filter((block) => !block.body.includes("DESTRUCTIVE"))
      .map((block) => `line ${block.line + 1}`);

    expect(unmarked).toEqual([]);
  });

  it.each(allDocs)("%s keeps read-only queries free of a destructive marker", (name) => {
    // The inverse check. A marker on every block would satisfy the test above
    // while telling a responder nothing, so a block that changes nothing must
    // not claim to.
    const content = readFileSync(join(INCIDENTS, name), "utf8");

    const mismarked = fencedBlocks(content)
      .filter((block) => block.body.includes("DESTRUCTIVE"))
      .filter(
        (block) => !DESTRUCTIVE_TOKENS.some((token) => token.test(block.body)),
      )
      .map((block) => `line ${block.line + 1}`);

    expect(mismarked).toEqual([]);
  });

  it("defines severity, roles, decision points and escalation once, in the index", () => {
    const index = readFileSync(join(INCIDENTS, "README.md"), "utf8");

    for (const section of [
      "## Severity",
      "## Roles",
      "## Decision points",
      "## Escalating safely",
    ]) {
      expect(index).toContain(section);
    }

    // Severity levels are referenced by name across the scenario runbooks; the
    // index is where they are defined.
    for (const level of ["S1", "S2", "S3", "S4"]) {
      expect(index).toContain(`**${level}**`);
    }
  });

  it("includes a tabletop checklist", () => {
    const tabletop = join(INCIDENTS, "tabletop.md");
    expect(existsSync(tabletop)).toBe(true);

    const content = readFileSync(tabletop, "utf8");
    const checkboxes = content.match(/^- \[ \] /gm) ?? [];

    // A checklist with a handful of items is a heading, not a checklist.
    expect(checkboxes.length).toBeGreaterThanOrEqual(10);
    // Each scenario runbook is exercised by at least one scenario.
    for (const name of scenarios) {
      expect(content).toContain(`(${name})`);
    }
  });

  it("is reachable from the security policy and the alert runbooks", () => {
    // The way in matters as much as the content: a responder starts at
    // SECURITY.md or at the runbook index, not at this directory.
    expect(readFileSync(join(REPO_ROOT, "SECURITY.md"), "utf8")).toContain(
      "docs/incidents/README.md",
    );
    expect(
      readFileSync(join(REPO_ROOT, "docs", "runbooks", "README.md"), "utf8"),
    ).toContain("../incidents/README.md");
  });
});
