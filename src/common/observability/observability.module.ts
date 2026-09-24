import { Global, Module, OnModuleInit } from "@nestjs/common";
import { registerCoreMetrics } from "./metrics.catalog";
import { MetricsRegistry } from "./metrics.registry";

/**
 * Provides the metrics registry and registers the SLI catalog at boot.
 *
 * Global because instrumentation is cross-cutting: requiring every feature
 * module to import an observability module is the kind of friction that leads
 * to workflows going uninstrumented.
 *
 * Registering the whole catalog at startup — rather than lazily on first use —
 * means a metric that violates the label rules fails the application boot, and
 * therefore fails the test suite, instead of failing on the first production
 * request that happens to exercise that path.
 */
@Global()
@Module({
  providers: [MetricsRegistry],
  exports: [MetricsRegistry],
})
export class ObservabilityModule implements OnModuleInit {
  constructor(private readonly metrics: MetricsRegistry) {}

  onModuleInit(): void {
    registerCoreMetrics(this.metrics);
  }
}
