import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * Documentation link and reference checks.
 *
 * The architecture handbook is only useful while its references are accurate. A
 * handbook pointing at a moved file is worse than one pointing nowhere, because
 * it reads as current — someone follows the link, finds nothing, and concludes
 * the documentation is stale in general rather than in one place.
 *
 * These tests fail when a referenced path stops existing, which turns
 * documentation rot into a build failure rather than a discovery.
 */

const REPO_ROOT = resolve(__dirname, "..");
const DOCS_ROOT = join(REPO_ROOT, "docs");

/** Every markdown file under docs/, plus the root README. */
function markdownFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...markdownFiles(full));
    } else if (entry.endsWith(".md")) {
      found.push(full);
    }
  }

  return found;
}

/**
 * Relative link targets in a markdown file.
 *
 * External URLs and bare anchors are skipped; a fragment on a relative path is
 * stripped so `../src/x.ts#L12` resolves to the file.
 */
function relativeLinks(file: string): string[] {
  const content = readFileSync(file, "utf8");
  const targets: string[] = [];

  for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
    const raw = match[1].trim();

    if (raw.startsWith("http://") || raw.startsWith("https://")) continue;
    if (raw.startsWith("#")) continue;
    if (raw.startsWith("mailto:")) continue;

    targets.push(raw.split("#")[0]);
  }

  return targets.filter((target) => target.length > 0);
}

describe("documentation links", () => {
  const docs = [...markdownFiles(DOCS_ROOT), join(REPO_ROOT, "README.md")];

  it("finds documentation to check", () => {
    // Guards against the suite passing vacuously if docs/ were ever emptied or
    // the traversal broke.
    expect(docs.length).toBeGreaterThan(5);
  });

  it.each(docs.map((doc) => [doc.replace(REPO_ROOT, "").slice(1), doc]))(
    "%s references only paths that exist",
    (_label, file) => {
      const broken: string[] = [];

      for (const target of relativeLinks(file)) {
        const resolved = resolve(dirname(file), target);
        if (!existsSync(resolved)) {
          broken.push(target);
        }
      }

      expect(broken).toEqual([]);
    },
  );
});

describe("architecture handbook", () => {
  const handbook = join(DOCS_ROOT, "architecture.md");

  it("exists", () => {
    expect(existsSync(handbook)).toBe(true);
  });

  it("documents every module registered in app.module.ts", () => {
    // The handbook is a map of the application. A module wired into
    // app.module.ts but absent from the handbook is exactly the drift this
    // check exists to catch.
    const appModule = readFileSync(join(REPO_ROOT, "src", "app.module.ts"), "utf8");
    const content = readFileSync(handbook, "utf8");

    const imported = [...appModule.matchAll(/from "\.\/([a-z-]+)\//g)].map(
      (match) => match[1],
    );

    const missing = [...new Set(imported)].filter(
      (module) => !content.includes(`\`${module}\``),
    );

    expect(missing).toEqual([]);
  });

  it("links every invariant to enforcing code", () => {
    const content = readFileSync(handbook, "utf8");
    const invariantRows = content
      .split("\n")
      .filter((line) => /^\| I\d+ \|/.test(line));

    expect(invariantRows.length).toBeGreaterThanOrEqual(20);

    // Prose that cannot point at code is not an invariant. Every row must
    // reference a real path.
    for (const row of invariantRows) {
      expect(row).toMatch(/\]\(\.\.\/(src|prisma)\//);
    }
  });

  it("links every invariant to a test", () => {
    const content = readFileSync(handbook, "utf8");
    const invariantRows = content
      .split("\n")
      .filter((line) => /^\| I\d+ \|/.test(line));

    for (const row of invariantRows) {
      // The last column names the covering test. Without it the row records an
      // intention, and an intention does not fail a build.
      expect(row).toMatch(/\.spec\.ts|schema\.prisma/);
    }
  });
});

describe("architecture decision records", () => {
  const adrDir = join(DOCS_ROOT, "adr");

  it("has an index", () => {
    expect(existsSync(join(adrDir, "README.md"))).toBe(true);
  });

  it("indexes every ADR that exists", () => {
    const index = readFileSync(join(adrDir, "README.md"), "utf8");
    const files = readdirSync(adrDir).filter(
      (entry) => entry.endsWith(".md") && entry !== "README.md",
    );

    expect(files.length).toBeGreaterThan(0);

    const unindexed = files.filter((file) => !index.includes(file));
    expect(unindexed).toEqual([]);
  });

  it("numbers ADRs sequentially without gaps", () => {
    // Renumbering or deleting an ADR would break references to it. Sequential
    // numbering makes a gap visible rather than silent.
    const numbers = readdirSync(adrDir)
      .filter((entry) => /^\d{4}-/.test(entry))
      .map((entry) => Number.parseInt(entry.slice(0, 4), 10))
      .sort((a, b) => a - b);

    expect(numbers).toEqual(
      Array.from({ length: numbers.length }, (_, index) => index + 1),
    );
  });

  it("gives every ADR a status and the required sections", () => {
    const files = readdirSync(adrDir).filter((entry) => /^\d{4}-/.test(entry));

    for (const file of files) {
      const content = readFileSync(join(adrDir, file), "utf8");

      expect(content).toMatch(/\*\*Status:\*\*\s*(proposed|accepted|superseded)/);
      expect(content).toContain("## Context");
      expect(content).toContain("## Decision");
      expect(content).toContain("## Consequences");

      // An ADR listing only benefits is marketing. Requiring the alternatives
      // section is what keeps the trade-off visible.
      expect(content).toContain("## Alternatives considered");
    }
  });

  it("states when a new ADR is required", () => {
    const index = readFileSync(join(adrDir, "README.md"), "utf8");
    expect(index).toMatch(/When a new ADR is required/i);
  });
});
