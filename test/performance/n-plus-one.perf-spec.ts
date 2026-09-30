import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Static N+1 guard for the modules this issue scopes: payments, proofs,
 * auth, credentials.
 *
 * A `findUnique`/`findFirst` call sitting inside a `for`/`for...of`/`.map`/
 * `.forEach` body is the classic N+1 shape: one query becomes one-per-row.
 * This does not need a live database — it is a property of the source code
 * — so it runs unconditionally, unlike the EXPLAIN-based specs in this
 * directory which need Postgres.
 *
 * This is deliberately a narrow, source-level check, not a general control-
 * flow analyzer: it flags a per-item Prisma call textually inside a loop
 * body and requires a human to look at the flagged line. That is enough to
 * catch a regression (someone adding a `for` loop with a query inside it)
 * without trying to be a static analysis tool. False negatives (a query
 * hidden behind a helper function called from a loop) are possible; false
 * positives are the failure mode preferred here, since the fix is reading
 * one flagged line.
 *
 * Investigated as part of this suite (see docs/database-performance.md,
 * "N+1 detection"): `src/proofs/proofs.service.ts` contains
 * `for (const payment of payments)` loops, but only over an array already
 * fetched in a single `findMany` — no query runs inside them.
 * `src/payments/payments.service.ts`'s `syncPayments` did have a genuine
 * per-item `findUnique` inside its `for (const payment of incomingPayments)`
 * loop; it was found and fixed as part of building this suite (batched into
 * one `findMany` ahead of the loop), so this test now guards against a
 * regression back to the pattern it originally caught.
 */

const REPO_ROOT = join(__dirname, "..", "..");

const WATCHED_FILES = [
  "src/payments/payments.service.ts",
  "src/proofs/proofs.service.ts",
  "src/auth/session.service.ts",
  "src/auth/auth.service.ts",
  "src/auth/cleanup.job.ts",
  "src/credentials/credentials.service.ts",
];

const PER_ITEM_QUERY_METHODS = ["findUnique", "findFirst", "findUniqueOrThrow", "findFirstOrThrow"];

/**
 * Finds `for`/`for...of`/`.forEach(`/`.map(` loop bodies and reports any
 * line inside them that calls a per-item Prisma read.
 *
 * Loop-body extent is found with brace counting from the loop's opening
 * `{`, which is sufficient for this codebase's formatting (one loop body
 * per statement block, no single-line loops without braces) without pulling
 * in a full parser for a lint-shaped check. The `{` must appear within a
 * short lookahead of the loop/callback header — skipping only whitespace,
 * the callback's parameter list, and an arrow — so an *expression-bodied*
 * callback (`.map((x) => f(x))`, with no block body at all) is correctly
 * skipped rather than accidentally matched against the next unrelated `{`
 * later in the file (which, for a top-level `.map(...)` call, is often a
 * class or function body far below it).
 */
function findLoopBodyViolations(source: string, filePath: string): string[] {
  const violations: string[] = [];
  const loopStart = /\bfor\s*\([^)]*\)\s*{|\.(?:forEach|map)\(\s*(?:\([^)]*\)|\w+)\s*=>\s*{/g;
  let match: RegExpExecArray | null;

  while ((match = loopStart.exec(source))) {
    const openBraceIndex = match.index + match[0].length - 1;

    let depth = 1;
    let index = openBraceIndex + 1;
    while (depth > 0 && index < source.length) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    const body = source.slice(openBraceIndex + 1, index - 1);

    for (const method of PER_ITEM_QUERY_METHODS) {
      if (new RegExp(`\\.${method}\\s*\\(`).test(body)) {
        const line = source.slice(0, openBraceIndex).split("\n").length;
        violations.push(
          `${filePath}:${line} — loop body calls .${method}(...); this is the N+1 shape`,
        );
      }
    }
  }

  return violations;
}

describe("N+1 guard: no per-item Prisma reads inside loops", () => {
  it.each(WATCHED_FILES)("%s has no per-item query inside a loop body", (relativePath) => {
    const source = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    const violations = findLoopBodyViolations(source, relativePath);
    expect(violations).toEqual([]);
  });
});
