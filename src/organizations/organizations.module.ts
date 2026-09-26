import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { OrganizationsService } from "./organizations.service";
import { OrganizationsController } from "./organizations.controller";
import { OrganizationMembersService } from "./organization-members.service";
import { OrganizationMemberGuard } from "./guards/organization-member.guard";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService, OrganizationMembersService, OrganizationMemberGuard],
  exports: [OrganizationsService, OrganizationMembersService],
})
export class OrganizationsModule {}
