import { Injectable } from "@nestjs/common";
import {
  ALLOWED_METRIC_LABELS,
  assertValidLabels,
  InvalidMetricLabelError,
  maxSeriesFor,
  type MetricLabelName,
  type MetricLabels,
} from "./metric-labels";

/**
 * In-process metrics registry with a bounded label vocabulary.
 *
 * Deliberately dependency-free. The value this adds over a general-purpose
 * client is the guard, not the storage: every counter and histogram declares
 * the label names it accepts up front, and both the names and the values are
 * checked against the allowlist in `metric-labels.ts` before any series is
 * created. A metric that would carry a wallet address or an unbounded
 * identifier fails at registration or at observation, not in production.
 *
 * Series are held in memory and exposed through {@link snapshot}. Wiring that
 * to a scrape endpoint or a push exporter is a deployment concern and is
 * deliberately out of scope here.
 */

/** Upper bound on the theoretical series count for a single metric. */
const MAX_SERIES_PER_METRIC = 512;

/** Upper bound on live series, as a backstop against a registration mistake. */
const MAX_LIVE_SERIES_PER_METRIC = 1_000;

/**
 * Latency histogram boundaries in milliseconds.
 *
 * Chosen to bracket the SLO thresholds in `docs/observability.md` rather than
 * to be evenly spaced: a bucket edge that does not sit near a threshold cannot
 * answer whether the threshold was breached.
 */
export const DEFAULT_LATENCY_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000,
] as const;

/** Declaration of a metric, supplied once at registration. */
export interface MetricDefinition {
  /** Metric name in `snake_case`, e.g. `http_requests_total`. */
  name: string;
  /** One sentence describing what the metric measures. */
  help: string;
  /** Label names this metric accepts. Must be in the allowed vocabulary. */
  labelNames?: readonly MetricLabelName[];
}

/** A histogram definition, adding explicit bucket boundaries. */
export interface HistogramDefinition extends MetricDefinition {
  /** Upper bounds in milliseconds, ascending. */
  buckets?: readonly number[];
}

/** One counter series and its accumulated value. */
interface CounterSeries {
  labels: MetricLabels;
  value: number;
}

/** One histogram series: bucket counts plus sum and count. */
interface HistogramSeries {
  labels: MetricLabels;
  bucketCounts: number[];
  sum: number;
  count: number;
}

/** Point-in-time view of a counter, for {@link MetricsRegistry.snapshot}. */
export interface CounterSnapshot {
  name: string;
  help: string;
  type: "counter";
  series: Array<{ labels: MetricLabels; value: number }>;
}

/** Point-in-time view of a histogram. */
export interface HistogramSnapshot {
  name: string;
  help: string;
  type: "histogram";
  buckets: readonly number[];
  series: Array<{
    labels: MetricLabels;
    bucketCounts: readonly number[];
    sum: number;
    count: number;
  }>;
}

export type MetricSnapshot = CounterSnapshot | HistogramSnapshot;

/** Raised when a metric is registered incorrectly. */
export class MetricDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricDefinitionError";
  }
}

@Injectable()
export class MetricsRegistry {
  private readonly counters = new Map<
    string,
    { definition: MetricDefinition; series: Map<string, CounterSeries> }
  >();

  private readonly histograms = new Map<
    string,
    {
      definition: HistogramDefinition;
      buckets: readonly number[];
      series: Map<string, HistogramSeries>;
    }
  >();

  /**
   * Declares a counter.
   *
   * Registering the same name twice with an identical definition is a no-op, so
   * a module imported more than once does not fail at boot. Registering the
   * same name with a *different* label set is an error: two definitions of one
   * metric produce a series set no query can interpret.
   */
  registerCounter(definition: MetricDefinition): void {
    this.assertDefinition(definition);

    const existing = this.counters.get(definition.name);
    if (existing) {
      this.assertSameDefinition(existing.definition, definition);
      return;
    }

    this.counters.set(definition.name, { definition, series: new Map() });
  }

  /** Declares a histogram. Same idempotency rules as {@link registerCounter}. */
  registerHistogram(definition: HistogramDefinition): void {
    this.assertDefinition(definition);

    const buckets = definition.buckets ?? DEFAULT_LATENCY_BUCKETS_MS;
    this.assertAscending(definition.name, buckets);

    const existing = this.histograms.get(definition.name);
    if (existing) {
      this.assertSameDefinition(existing.definition, definition);
      return;
    }

    this.histograms.set(definition.name, {
      definition,
      buckets,
      series: new Map(),
    });
  }

  /**
   * Increments a counter.
   *
   * Throws {@link InvalidMetricLabelError} when the label set is not permitted.
   * Callers are not expected to catch it: a rejected label is a programming
   * error that the test suite should surface, not a runtime condition.
   */
  increment(
    name: string,
    labels?: Record<string, string>,
    amount = 1,
  ): void {
    const entry = this.counters.get(name);
    if (!entry) {
      throw new MetricDefinitionError(
        `Counter "${name}" was incremented before it was registered.`,
      );
    }

    if (!Number.isFinite(amount) || amount < 0) {
      throw new MetricDefinitionError(
        `Counter "${name}" must be incremented by a finite, non-negative amount.`,
      );
    }

    this.assertLabelsMatchDefinition(entry.definition, labels);
    assertValidLabels(labels);

    const key = seriesKey(labels);
    const series = entry.series.get(key);

    if (series) {
      series.value += amount;
      return;
    }

    this.assertSeriesBudget(name, entry.series.size);
    entry.series.set(key, { labels: (labels ?? {}) as MetricLabels, value: amount });
  }

  /** Records one observation, in milliseconds, against a histogram. */
  observe(name: string, valueMs: number, labels?: Record<string, string>): void {
    const entry = this.histograms.get(name);
    if (!entry) {
      throw new MetricDefinitionError(
        `Histogram "${name}" was observed before it was registered.`,
      );
    }

    if (!Number.isFinite(valueMs) || valueMs < 0) {
      throw new MetricDefinitionError(
        `Histogram "${name}" must observe a finite, non-negative value.`,
      );
    }

    this.assertLabelsMatchDefinition(entry.definition, labels);
    assertValidLabels(labels);

    const key = seriesKey(labels);
    let series = entry.series.get(key);

    if (!series) {
      this.assertSeriesBudget(name, entry.series.size);
      series = {
        labels: (labels ?? {}) as MetricLabels,
        // One extra slot for the implicit +Inf bucket.
        bucketCounts: new Array(entry.buckets.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      entry.series.set(key, series);
    }

    series.sum += valueMs;
    series.count += 1;

    // Cumulative buckets: an observation lands in its own bucket and every
    // wider one, which is what makes quantile estimation possible.
    let landed = false;
    for (let i = 0; i < entry.buckets.length; i += 1) {
      if (valueMs <= entry.buckets[i]) {
        series.bucketCounts[i] += 1;
        landed = true;
      }
    }
    if (!landed) {
      series.bucketCounts[entry.buckets.length] += 1;
    }
  }

  /**
   * Times an async operation and records its duration.
   *
   * The observation is recorded whether the operation succeeds or throws, so a
   * latency metric does not silently exclude failures — which is exactly the
   * population an operator cares about during an incident.
   */
  async time<T>(
    name: string,
    labels: Record<string, string> | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      return await operation();
    } finally {
      this.observe(name, Date.now() - startedAt, labels);
    }
  }

  /** Returns every registered metric and its current series. */
  snapshot(): MetricSnapshot[] {
    const counters: MetricSnapshot[] = [...this.counters.values()].map(
      (entry) => ({
        name: entry.definition.name,
        help: entry.definition.help,
        type: "counter" as const,
        series: [...entry.series.values()].map((series) => ({
          labels: series.labels,
          value: series.value,
        })),
      }),
    );

    const histograms: MetricSnapshot[] = [...this.histograms.values()].map(
      (entry) => ({
        name: entry.definition.name,
        help: entry.definition.help,
        type: "histogram" as const,
        buckets: entry.buckets,
        series: [...entry.series.values()].map((series) => ({
          labels: series.labels,
          bucketCounts: [...series.bucketCounts],
          sum: series.sum,
          count: series.count,
        })),
      }),
    );

    return [...counters, ...histograms];
  }

  /** Clears all series, retaining registrations. Intended for tests. */
  reset(): void {
    for (const entry of this.counters.values()) entry.series.clear();
    for (const entry of this.histograms.values()) entry.series.clear();
  }

  // ─── Validation ───────────────────────────────────────────────────────────

  private assertDefinition(definition: MetricDefinition): void {
    if (!/^[a-z][a-z0-9_]*$/.test(definition.name)) {
      throw new MetricDefinitionError(
        `Metric name "${definition.name}" must be lower_snake_case.`,
      );
    }

    if (!definition.help?.trim()) {
      throw new MetricDefinitionError(
        `Metric "${definition.name}" must carry a help string.`,
      );
    }

    const labelNames = definition.labelNames ?? [];

    // Validating the names here means a metric that *could* carry a forbidden
    // dimension is rejected at boot, rather than on the first request that
    // happens to populate it.
    //
    // The name is probed with a sentinel value rather than a real one, because
    // an unknown name has no real value to offer — looking one up would fault
    // before the intended error could be raised.
    for (const name of labelNames) {
      try {
        assertValidLabels({ [name]: firstAllowedValue(name) ?? UNKNOWN_VALUE });
      } catch (error) {
        if (error instanceof InvalidMetricLabelError) {
          throw new MetricDefinitionError(
            `Metric "${definition.name}" declares an unusable label: ${error.message}`,
          );
        }
        throw error;
      }
    }

    const theoretical = maxSeriesFor(labelNames);
    if (theoretical > MAX_SERIES_PER_METRIC) {
      throw new MetricDefinitionError(
        `Metric "${definition.name}" would permit ${theoretical} series, exceeding ` +
          `the ${MAX_SERIES_PER_METRIC} limit. Drop a label or narrow a value set.`,
      );
    }
  }

  private assertSameDefinition(
    existing: MetricDefinition,
    incoming: MetricDefinition,
  ): void {
    const a = [...(existing.labelNames ?? [])].sort().join(",");
    const b = [...(incoming.labelNames ?? [])].sort().join(",");

    if (a !== b) {
      throw new MetricDefinitionError(
        `Metric "${incoming.name}" is already registered with labels [${a}] ` +
          `and cannot be re-registered with [${b}].`,
      );
    }
  }

  private assertLabelsMatchDefinition(
    definition: MetricDefinition,
    labels: Record<string, string> | undefined,
  ): void {
    const declared = new Set<string>(definition.labelNames ?? []);
    const supplied = Object.keys(labels ?? {});

    for (const name of supplied) {
      if (!declared.has(name)) {
        throw new MetricDefinitionError(
          `Metric "${definition.name}" was given undeclared label "${name}". ` +
            `Declared labels: ${[...declared].join(", ") || "(none)"}.`,
        );
      }
    }

    // A missing declared label would merge two distinct series into one, which
    // silently changes what the metric means.
    for (const name of declared) {
      if (!supplied.includes(name)) {
        throw new MetricDefinitionError(
          `Metric "${definition.name}" requires label "${name}".`,
        );
      }
    }
  }

  private assertSeriesBudget(name: string, current: number): void {
    if (current >= MAX_LIVE_SERIES_PER_METRIC) {
      throw new MetricDefinitionError(
        `Metric "${name}" reached the ${MAX_LIVE_SERIES_PER_METRIC}-series ceiling. ` +
          `This indicates an unbounded label value slipped through validation.`,
      );
    }
  }

  private assertAscending(name: string, buckets: readonly number[]): void {
    if (buckets.length === 0) {
      throw new MetricDefinitionError(
        `Histogram "${name}" must declare at least one bucket.`,
      );
    }
    for (let i = 1; i < buckets.length; i += 1) {
      if (buckets[i] <= buckets[i - 1]) {
        throw new MetricDefinitionError(
          `Histogram "${name}" buckets must be strictly ascending.`,
        );
      }
    }
  }
}

/**
 * Stable key for a label set.
 *
 * Sorted so that `{a, b}` and `{b, a}` map to the same series regardless of the
 * order the caller wrote them in.
 */
function seriesKey(labels: Record<string, string> | undefined): string {
  if (!labels) return "";
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}=${labels[name]}`)
    .join(",");
}

/**
 * Sentinel used when probing a label name that is not in the vocabulary.
 *
 * The value is irrelevant — validation fails on the name before it is reached —
 * but a placeholder is needed so the probe itself does not fault.
 */
const UNKNOWN_VALUE = "__unknown__";

/**
 * Any permitted value for a label, or `undefined` when the name is unknown.
 *
 * Returning `undefined` rather than indexing blindly is what lets an unknown
 * label name surface as a `MetricDefinitionError` naming the vocabulary, instead
 * of a `TypeError` from reading a property of `undefined`.
 */
function firstAllowedValue(name: MetricLabelName): string | undefined {
  return ALLOWED_METRIC_LABELS[name]?.[0];
}
