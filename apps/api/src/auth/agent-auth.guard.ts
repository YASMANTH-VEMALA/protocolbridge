import type { CanActivate, ExecutionContext} from "@nestjs/common";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { hashAgentApiKey } from "@protocolbridge/auth";
import { AgentStatus, MerchantStatus } from "@protocolbridge/database";

import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../database/prisma.service";
import type { AgentAuthenticatedRequest } from "./auth.types";

@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(
    private readonly database: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AgentAuthenticatedRequest>();
    const apiKey = request.header("x-agent-api-key");
    if (!apiKey) {
      throw this.unauthorized();
    }

    const secretHash = hashAgentApiKey(apiKey, this.config.value.agentCredentialPepper);
    const credential = await this.database.agentCredential.findUnique({
      where: { secretHash },
      include: {
        agent: true,
        merchant: { select: { status: true } },
      },
    });
    const now = new Date();
    if (
      !credential ||
      credential.revokedAt ||
      (credential.expiresAt && credential.expiresAt <= now) ||
      credential.agent.status !== AgentStatus.ACTIVE ||
      credential.merchant.status !== MerchantStatus.ACTIVE ||
      credential.agent.merchantId !== credential.merchantId
    ) {
      throw this.unauthorized();
    }

    request.authenticatedAgent = {
      id: credential.agentId,
      status: credential.agent.status,
      merchantId: credential.merchantId,
      merchantStatus: credential.merchant.status,
      credentialId: credential.id,
    };
    await this.database.agentCredential.update({
      where: { id: credential.id },
      data: { lastUsedAt: now },
    });
    return true;
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      code: "INVALID_AGENT_CREDENTIAL",
      message: "A valid active agent API key is required.",
    });
  }
}
