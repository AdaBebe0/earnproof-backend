import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { DependencyKind, DependencyStatus } from "./health.types";

function buildService(overrides: Partial<HealthService> = {}): HealthService {
  return {
    checkLiveness: jest.fn().mockReturnValue({
      status: "ok",
      service: "earnproof-api",
      timestamp: new Date().toISOString(),
    }),
    checkReadiness: jest.fn().mockResolvedValue({
      status: "ready",
      dependencies: [
        {
          name: "database",
          kind: DependencyKind.REQUIRED,
          status: DependencyStatus.OK,
        },
      ],
    }),
    checkDiagnostics: jest.fn().mockResolvedValue({
      status: "ready",
      dependencies: [],
    }),
    ...overrides,
  } as unknown as HealthService;
}

describe("HealthController", () => {
  describe("legacy aggregate endpoint", () => {
    // The existing /health contract is relied on by deployments and compose
    // healthchecks, so its shape must not drift.
    it("returns service health", async () => {
      const controller = new HealthController(buildService());

      await expect(controller.getHealth()).resolves.toMatchObject({
        status: "ok",
        service: "earnproof-api",
        database: "ok",
      });
    });

    it("reports unavailable when the database dependency is unhealthy", async () => {
      const controller = new HealthController(
        buildService({
          checkReadiness: jest.fn().mockResolvedValue({
            status: "not_ready",
            dependencies: [
              {
                name: "database",
                kind: DependencyKind.REQUIRED,
                status: DependencyStatus.ERROR,
                reason: "probe_failed",
              },
            ],
          }),
        } as Partial<HealthService>),
      );

      await expect(controller.getHealth()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe("liveness", () => {
    it("reports process availability", () => {
      const controller = new HealthController(buildService());

      expect(controller.getLiveness()).toMatchObject({
        status: "ok",
        service: "earnproof-api",
      });
    });

    it("does not consult readiness or any dependency", () => {
      const service = buildService();
      const controller = new HealthController(service);

      controller.getLiveness();

      // Liveness must never fail because a dependency is down; if it did, an
      // outage would cause the orchestrator to restart healthy replicas.
      expect(service.checkReadiness).not.toHaveBeenCalled();
      expect(service.checkDiagnostics).not.toHaveBeenCalled();
    });
  });

  describe("readiness", () => {
    it("returns the readiness payload when required dependencies are healthy", async () => {
      const controller = new HealthController(buildService());

      await expect(controller.getReadiness()).resolves.toMatchObject({
        status: "ready",
      });
    });

    it("throws 503 and includes which dependency blocked readiness", async () => {
      const notReady = {
        status: "not_ready",
        dependencies: [
          {
            name: "database",
            kind: DependencyKind.REQUIRED,
            status: DependencyStatus.TIMEOUT,
            reason: "probe_timeout",
          },
        ],
      };

      const controller = new HealthController(
        buildService({
          checkReadiness: jest.fn().mockResolvedValue(notReady),
        } as Partial<HealthService>),
      );

      await expect(controller.getReadiness()).rejects.toMatchObject({
        response: notReady,
      });
    });
  });

  describe("diagnostics", () => {
    it("returns the full dependency set", async () => {
      const diagnostics = {
        status: "ready",
        dependencies: [
          {
            name: "horizon",
            kind: DependencyKind.OPTIONAL,
            status: DependencyStatus.OK,
          },
        ],
      };

      const controller = new HealthController(
        buildService({
          checkDiagnostics: jest.fn().mockResolvedValue(diagnostics),
        } as Partial<HealthService>),
      );

      await expect(controller.getDiagnostics()).resolves.toEqual(diagnostics);
    });

    it("returns 200 even when a dependency is degraded", async () => {
      // Diagnostics is an inspection surface. Returning 503 here would tempt
      // operators to point load balancers at it, recreating the conflation of
      // liveness/readiness this module exists to remove.
      const controller = new HealthController(
        buildService({
          checkDiagnostics: jest.fn().mockResolvedValue({
            status: "not_ready",
            dependencies: [
              {
                name: "database",
                kind: DependencyKind.REQUIRED,
                status: DependencyStatus.ERROR,
              },
            ],
          }),
        } as Partial<HealthService>),
      );

      await expect(controller.getDiagnostics()).resolves.toMatchObject({
        status: "not_ready",
      });
    });
  });
});
