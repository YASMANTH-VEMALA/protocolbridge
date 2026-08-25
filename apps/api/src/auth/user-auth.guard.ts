import type { CanActivate, ExecutionContext} from "@nestjs/common";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { verifyUserToken } from "@protocolbridge/auth";

import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../database/prisma.service";
import type { UserAuthenticatedRequest } from "./auth.types";

@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(
    private readonly database: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<UserAuthenticatedRequest>();
    const authorization = request.header("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      throw this.unauthorized();
    }

    try {
      const claims = verifyUserToken(authorization.slice(7), this.config.value.jwtSecret);
      const user = await this.database.user.findUnique({
        where: { id: claims.userId },
        select: { id: true, globalRole: true },
      });
      if (!user || user.globalRole !== claims.globalRole) {
        throw this.unauthorized();
      }
      request.authenticatedUser = user;
      return true;
    } catch {
      throw this.unauthorized();
    }
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      code: "INVALID_USER_TOKEN",
      message: "A valid user access token is required.",
    });
  }
}
