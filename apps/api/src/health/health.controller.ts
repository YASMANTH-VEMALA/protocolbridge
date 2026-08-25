import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../database/prisma.service";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly database: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Check API, database, and optional provider readiness" })
  async getHealth(): Promise<Record<string, unknown>> {
    try {
      await this.database.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({
        code: "DATABASE_UNAVAILABLE",
        message: "PostgreSQL is not reachable.",
      });
    }

    return {
      status: "ok",
      database: "connected",
      resolver: this.config.value.openAi ? "openai_with_deterministic_fallback" : "deterministic",
      payments: this.config.value.razorpay ? "razorpay_test_mode_configured" : "not_configured",
    };
  }
}
