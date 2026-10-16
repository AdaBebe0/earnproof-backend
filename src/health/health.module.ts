import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { DeploymentMetadataService } from "./deployment-metadata.service";
import { HealthController } from "./health.controller";
import { IncidentsController } from "./incidents.controller";
import { HealthService } from "./health.service";
import { HealthIncidentService } from "./health-incident.service";
import { HealthHysteresisService } from "./health-hysteresis.service";

/**
 * ApiKeysModule is imported for its exported ApiKeyGuard and ScopesGuard, which
 * protect the diagnostics and incidents endpoints. Reusing the existing authorization
 * path is deliberate: a second, health-specific auth mechanism would be one more
 * secret to rotate and one more place for an authorization bug to hide.
 */
@Module({
  imports: [ApiKeysModule],
  controllers: [HealthController, IncidentsController],
  providers: [
    HealthService,
    DeploymentMetadataService,
    HealthIncidentService,
    HealthHysteresisService,
  ],
  exports: [HealthService, HealthIncidentService, HealthHysteresisService],
})
export class HealthModule {}
