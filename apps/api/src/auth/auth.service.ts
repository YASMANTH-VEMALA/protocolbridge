import { Injectable, UnauthorizedException } from "@nestjs/common";
import { issueUserToken, verifyPassword } from "@protocolbridge/auth";
import { z } from "zod";

import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../database/prisma.service";

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(256),
});

export type LoginInput = z.infer<typeof loginSchema>;

@Injectable()
export class AuthService {
  constructor(
    private readonly database: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async login(input: LoginInput): Promise<Record<string, unknown>> {
    const user = await this.database.user.findUnique({
      where: { email: input.email },
      include: {
        merchantMemberships: {
          select: { merchantId: true, role: true },
        },
      },
    });

    if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
      throw new UnauthorizedException({
        code: "INVALID_CREDENTIALS",
        message: "Email or password is incorrect.",
      });
    }

    return {
      accessToken: issueUserToken(
        { userId: user.id, globalRole: user.globalRole },
        this.config.value.jwtSecret,
      ),
      expiresInSeconds: 1_800,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        globalRole: user.globalRole,
        memberships: user.merchantMemberships,
      },
    };
  }
}
