import { CallHandler, ExecutionContext } from "@nestjs/common";
import { of, throwError, lastValueFrom, catchError, EMPTY } from "rxjs";

import { registerCoreMetrics, METRIC_NAMES } from "../observability/metrics.catalog";
import {
  MetricsRegistry,
  type CounterSnapshot,
  type HistogramSnapshot,
} from "../observability/metrics.registry";
import { HttpMetricsInterceptor } from "./http-metrics.interceptor";

/**
 * Awaits a stream that is expected to fail, swallowing the error.
 *
 * `lastValueFrom` rejects on an empty stream, so a bare `catchError(() => EMPTY)`
 * would fail the await rather than the assertion. The default value keeps the
 * test focused on what the interceptor recorded.
 */
async function settle(
  stream: Parameters<typeof lastValueFrom>[0],
): Promise<void> {
  await lastValueFrom(stream.pipe(catchError(() => EMPTY)), {
    defaultValue: undefined,
  });
}

describe("HttpMetricsInterceptor", () => {
  let registry: MetricsRegistry;
  let interceptor: HttpMetricsInterceptor;

  beforeEach(() => {
    registry = new MetricsRegistry();
    registerCoreMetrics(registry);
    interceptor = new HttpMetricsInterceptor(registry);
  });

  function contextFor(
    path: string,
    method = "GET",
    statusCode = 200,
  ): ExecutionContext {
    return {
      getType: () => "http",
      switchToHttp: () => ({
        getRequest: () => ({ path, url: path, method }),
        getResponse: () => ({ statusCode }),
      }),
    } as unknown as ExecutionContext;
  }

  const handlerReturning = (value: unknown): CallHandler =>
    ({ handle: () => of(value) }) as CallHandler;

  const handlerThrowing = (error: unknown): CallHandler =>
    ({ handle: () => throwError(() => error) }) as CallHandler;

  it("counts a successful request under its route template", async () => {
    await lastValueFrom(
      interceptor.intercept(
        contextFor("/proofs", "POST", 201),
        handlerReturning({ id: "x" }),
      ),
    );

    const counter = counterFor(registry, METRIC_NAMES.httpRequestsTotal);
    expect(counter.series).toHaveLength(1);
    expect(counter.series[0].labels).toEqual({
      route: "/proofs",
      method: "POST",
      status_class: "2xx",
    });
  });

  it("records latency for a successful request", async () => {
    await lastValueFrom(
      interceptor.intercept(contextFor("/health"), handlerReturning("ok")),
    );

    expect(
      histogramFor(registry, METRIC_NAMES.httpRequestDurationMs).series[0].count,
    ).toBe(1);
  });

  it("counts a failed request rather than dropping it", async () => {
    // A latency or availability metric that silently excludes failures measures
    // the wrong population — failures are what an operator alerts on.
    await settle(
      interceptor.intercept(
        contextFor("/proofs", "POST"),
        handlerThrowing(Object.assign(new Error("boom"), { status: 500 })),
      ),
    );

    const counter = counterFor(registry, METRIC_NAMES.httpRequestsTotal);
    expect(counter.series[0].labels.status_class).toBe("5xx");
  });

  it("records latency for a failed request", async () => {
    await settle(
      interceptor.intercept(
        contextFor("/proofs"),
        handlerThrowing(Object.assign(new Error("nope"), { status: 422 })),
      ),
    );

    expect(
      histogramFor(registry, METRIC_NAMES.httpRequestDurationMs).series[0].count,
    ).toBe(1);
  });

  it("reads the status from the thrown error, not the unset response", async () => {
    // At the point the error propagates the exception filter has not run, so
    // the response still reads 200. Trusting it would record a 5xx as a 2xx.
    await settle(
      interceptor.intercept(
        contextFor("/proofs", "GET", 200),
        handlerThrowing(Object.assign(new Error("nf"), { status: 404 })),
      ),
    );

    expect(
      counterFor(registry, METRIC_NAMES.httpRequestsTotal).series[0].labels
        .status_class,
    ).toBe("4xx");
  });

  it("collapses a per-resource path into one series", async () => {
    // The cardinality property: N requests for N distinct proofs must produce
    // one series, not N.
    for (const id of ["a1", "b2", "c3", "d4", "e5"]) {
      await lastValueFrom(
        interceptor.intercept(
          contextFor(`/proofs/${id}`),
          handlerReturning({ id }),
        ),
      );
    }

    const counter = counterFor(registry, METRIC_NAMES.httpRequestsTotal);
    expect(counter.series).toHaveLength(1);
    expect(counter.series[0].value).toBe(5);
    expect(counter.series[0].labels.route).toBe("/proofs");
  });

  it("cannot have its cardinality inflated by unrecognised paths", async () => {
    for (let i = 0; i < 20; i += 1) {
      await lastValueFrom(
        interceptor.intercept(contextFor(`/attack-${i}`), handlerReturning(null)),
      );
    }

    const counter = counterFor(registry, METRIC_NAMES.httpRequestsTotal);
    expect(counter.series).toHaveLength(1);
    expect(counter.series[0].labels.route).toBe("other");
  });

  it("folds an unusual verb into a permitted value", async () => {
    // An unrecognised method would be rejected by the registry; failing inside
    // an interceptor would turn an observability concern into a 500.
    await expect(
      lastValueFrom(
        interceptor.intercept(
          contextFor("/health", "OPTIONS"),
          handlerReturning("ok"),
        ),
      ),
    ).resolves.toBe("ok");
  });

  it("never records a request-scoped identifier as a label", async () => {
    await lastValueFrom(
      interceptor.intercept(contextFor("/proofs/abc123"), handlerReturning(null)),
    );

    const labels = counterFor(registry, METRIC_NAMES.httpRequestsTotal).series[0]
      .labels;
    expect(Object.keys(labels).sort()).toEqual([
      "method",
      "route",
      "status_class",
    ]);
    expect(JSON.stringify(labels)).not.toContain("abc123");
  });

  it("ignores non-HTTP execution contexts", async () => {
    const rpcContext = {
      getType: () => "rpc",
    } as unknown as ExecutionContext;

    await lastValueFrom(
      interceptor.intercept(rpcContext, handlerReturning("ok")),
    );

    expect(
      counterFor(registry, METRIC_NAMES.httpRequestsTotal).series,
    ).toHaveLength(0);
  });

  it("propagates the handler result unchanged", async () => {
    const payload = { id: "abc", nested: { value: 1 } };
    await expect(
      lastValueFrom(
        interceptor.intercept(contextFor("/proofs"), handlerReturning(payload)),
      ),
    ).resolves.toBe(payload);
  });

  it("propagates the handler error unchanged", async () => {
    const error = Object.assign(new Error("original"), { status: 503 });
    await expect(
      lastValueFrom(
        interceptor.intercept(contextFor("/proofs"), handlerThrowing(error)),
      ),
    ).rejects.toBe(error);
  });
});

function counterFor(registry: MetricsRegistry, name: string): CounterSnapshot {
  const metric = registry.snapshot().find((entry) => entry.name === name);
  if (!metric || metric.type !== "counter") {
    throw new Error(`counter ${name} not found`);
  }
  return metric;
}

function histogramFor(
  registry: MetricsRegistry,
  name: string,
): HistogramSnapshot {
  const metric = registry.snapshot().find((entry) => entry.name === name);
  if (!metric || metric.type !== "histogram") {
    throw new Error(`histogram ${name} not found`);
  }
  return metric;
}
