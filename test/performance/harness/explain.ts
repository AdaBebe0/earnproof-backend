import { PrismaClient } from "@prisma/client";

/**
 * `EXPLAIN (ANALYZE, FORMAT JSON)` execution and summarization.
 *
 * A raw JSON plan is not something a test should assert on directly: it
 * carries actual timings, buffer counts and PostgreSQL-version-specific
 * fields that vary run to run even when the query shape is unchanged, which
 * would make every assertion flaky. This module runs the plan and reduces it
 * to a small, stable summary — node types used, index names touched, and the
 * row/cost estimates that flag a regression — which is what the tests in
 * `test/performance/*.perf-spec.ts` actually assert on.
 */

export interface PlanNode {
  nodeType: string;
  /** Index name, when this node is an index scan / index-only scan / bitmap index scan. */
  indexName?: string;
  /** Table name, when this node reads directly from a relation. */
  relationName?: string;
  /** Planner's row estimate for this node. */
  planRows: number;
  /** Actual rows returned, when ANALYZE ran. */
  actualRows?: number;
  /** Planner's total cost estimate for this node. */
  totalCost: number;
  children: PlanNode[];
}

export interface PlanSummary {
  /** The full plan tree, reduced to the fields above. */
  root: PlanNode;
  /** Every distinct node type appearing anywhere in the plan. */
  nodeTypes: Set<string>;
  /** Every index name used anywhere in the plan. */
  indexesUsed: Set<string>;
  /** Every relation scanned via Seq Scan anywhere in the plan (i.e. no index used). */
  seqScannedRelations: Set<string>;
  /** Total cost of the plan's root node — the planner's overall cost estimate. */
  totalCost: number;
  /** Wall-clock planning + execution time reported by ANALYZE, in milliseconds. */
  executionTimeMs: number;
  /** Human-readable one-line-per-node rendering, for failure messages and docs. */
  text: string;
}

interface RawPlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  "Plan Rows": number;
  "Actual Rows"?: number;
  "Total Cost": number;
  Plans?: RawPlanNode[];
}

interface RawExplainEntry {
  Plan: RawPlanNode;
  "Planning Time"?: number;
  "Execution Time"?: number;
}

function toPlanNode(raw: RawPlanNode): PlanNode {
  return {
    nodeType: raw["Node Type"],
    indexName: raw["Index Name"],
    relationName: raw["Relation Name"],
    planRows: raw["Plan Rows"],
    actualRows: raw["Actual Rows"],
    totalCost: raw["Total Cost"],
    children: (raw.Plans ?? []).map(toPlanNode),
  };
}

function collect(node: PlanNode, summary: PlanSummary, depth: number, lines: string[]): void {
  summary.nodeTypes.add(node.nodeType);

  if (node.indexName) {
    summary.indexesUsed.add(node.indexName);
  }
  if (node.nodeType === "Seq Scan" && node.relationName) {
    summary.seqScannedRelations.add(node.relationName);
  }

  const rowInfo =
    node.actualRows !== undefined
      ? `planRows=${node.planRows} actualRows=${node.actualRows}`
      : `planRows=${node.planRows}`;
  const indexInfo = node.indexName ? ` index=${node.indexName}` : "";
  const relationInfo = node.relationName ? ` on=${node.relationName}` : "";
  lines.push(
    `${"  ".repeat(depth)}${node.nodeType}${relationInfo}${indexInfo} cost=${node.totalCost} ${rowInfo}`,
  );

  for (const child of node.children) {
    collect(child, summary, depth + 1, lines);
  }
}

/**
 * Runs `EXPLAIN (ANALYZE, FORMAT JSON)` for a raw SQL query and returns a
 * stable summary.
 *
 * Takes raw SQL (built via Prisma's `Prisma.sql` tag by callers) rather than
 * a Prisma query-builder call, because `EXPLAIN` has to wrap the exact
 * statement Prisma would otherwise send — there is no supported way to ask
 * Prisma Client itself to prefix its own generated SQL with `EXPLAIN`.
 * Each `*.perf-spec.ts` file documents, next to its `explainQuery` call, the
 * Prisma call whose SQL it mirrors, so the two cannot silently drift without
 * a reviewer noticing.
 */
export async function explainQuery(
  prisma: PrismaClient,
  sql: string,
  params: unknown[] = [],
): Promise<PlanSummary> {
  const rows = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
    `EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS false, TIMING true) ${sql}`,
    ...params,
  );

  // PostgreSQL's json/jsonb wire type is normally decoded into a JS value
  // automatically, but a raw-query driver is exactly the kind of path that
  // can hand back the column as a string instead — parse defensively rather
  // than assume.
  const rawColumn = rows[0]?.["QUERY PLAN"];
  const raw: unknown =
    typeof rawColumn === "string" ? JSON.parse(rawColumn) : rawColumn;
  const planEntry = (Array.isArray(raw) ? raw[0] : undefined) as
    | RawExplainEntry
    | undefined;

  if (!planEntry) {
    throw new Error(`EXPLAIN returned no plan for query: ${sql}`);
  }

  const root = toPlanNode(planEntry.Plan);
  const summary: PlanSummary = {
    root,
    nodeTypes: new Set(),
    indexesUsed: new Set(),
    seqScannedRelations: new Set(),
    totalCost: root.totalCost,
    executionTimeMs: planEntry["Execution Time"] ?? 0,
    text: "",
  };

  const lines: string[] = [];
  collect(root, summary, 0, lines);
  summary.text = lines.join("\n");

  return summary;
}
