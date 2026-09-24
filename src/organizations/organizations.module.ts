import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { JobsModule } from "../jobs/jobs.module";
import { OrganizationsService } from "./organizations.service";
import { OrganizationsController } from "./organizations.controller";
import {
  EXPORT_ARTIFACT_STORE,
  FsExportArtifactStore,
} from "./exports/export-artifact-store";
import { OrganizationExportService } from "./exports/organization-export.service";
import { OrganizationExportWorkerService } from "./exports/organization-export.worker";
import {
  ExportDownloadController,
  OrganizationExportsController,
} from "./exports/organization-exports.controller";

/**
 * JobsModule is imported so the export worker can record its runs in the shared
 * job-execution history (issue #201); the artifact store is provided via a
 * factory so its base directory comes from configuration and so tests can swap
 * in an in-memory implementation against the same token.
 */
@Module({
  imports: [DatabaseModule, AuthModule, JobsModule],
  controllers: [
    OrganizationsController,
    OrganizationExportsController,
    ExportDownloadController,
  ],
  providers: [
    OrganizationsService,
    OrganizationExportService,
    OrganizationExportWorkerService,
    {
      provide: EXPORT_ARTIFACT_STORE,
      useFactory: (config: ConfigService) =>
        new FsExportArtifactStore(
          config.get<string>("organizations.export.tempDir"),
        ),
      inject: [ConfigService],
    },
  ],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
