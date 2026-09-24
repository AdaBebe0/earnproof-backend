import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { PublicRoute } from "../common/decorators/authorization-policy.decorator";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @PublicRoute()
  async getHealth() {
    await this.prisma.$queryRaw`SELECT 1`;

    return {
      status: "ok",
      service: "earnproof-api",
      database: "ok",
      timestamp: new Date().toISOString(),
    };
  }
}
