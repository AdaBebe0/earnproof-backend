import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { SchemaImportsController } from "./schema-imports.controller";
import { SchemaImportsService } from "./schema-imports.service";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [SchemaImportsController],
  providers: [SchemaImportsService],
  exports: [SchemaImportsService],
})
export class SchemaImportsModule {}
