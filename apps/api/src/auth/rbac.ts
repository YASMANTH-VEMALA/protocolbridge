import { ForbiddenException, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { GlobalRole, MerchantRole } from "@protocolbridge/database";

import { PrismaService } from "../database/prisma.service";
import type { UserAuthenticatedRequest } from "./auth.types";

const GLOBAL_ROLES = "protocolbridge:global-roles";
const MERCHANT_ROLES = "protocolbridge:merchant-roles";

export const RequireGlobalRoles = (...roles: GlobalRole[]) => SetMetadata(GLOBAL_ROLES, roles);
export const RequireMerchantRoles = (...roles: MerchantRole[]) => SetMetadata(MERCHANT_ROLES, roles);

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly database: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<UserAuthenticatedRequest>();
    const user = request.authenticatedUser;
    const globalRoles = this.reflector.getAllAndOverride<GlobalRole[]>(GLOBAL_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (globalRoles?.length && !globalRoles.includes(user.globalRole)) {
      throw this.forbidden();
    }

    const merchantRoles = this.reflector.getAllAndOverride<MerchantRole[]>(MERCHANT_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (merchantRoles?.length) {
      const merchantId = request.params["merchantId"];
      if (typeof merchantId !== "string" || !merchantId) {
        throw this.forbidden();
      }
      const membership = await this.database.merchantMember.findUnique({
        where: { merchantId_userId: { merchantId, userId: user.id } },
        select: { role: true },
      });
      if (!membership || !merchantRoles.includes(membership.role)) {
        throw this.forbidden();
      }
    }
    return true;
  }

  private forbidden(): ForbiddenException {
    return new ForbiddenException({
      code: "FORBIDDEN",
      message: "The authenticated identity does not have access to this tenant resource.",
    });
  }
}
