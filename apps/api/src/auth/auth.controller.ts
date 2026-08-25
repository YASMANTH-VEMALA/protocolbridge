import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AuthService } from "./auth.service";
import { type LoginInput, loginSchema } from "./auth.service";
import type { UserAuthenticatedRequest } from "./auth.types";
import { UserAuthGuard } from "./user-auth.guard";

@ApiTags("authentication")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  @ApiOperation({ summary: "Authenticate a seeded buyer, merchant member, or super admin" })
  login(@Body(new ZodValidationPipe(loginSchema)) input: LoginInput): Promise<Record<string, unknown>> {
    return this.auth.login(input);
  }

  @Get("me")
  @UseGuards(UserAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Return the database-validated user identity" })
  me(@Req() request: UserAuthenticatedRequest): Record<string, unknown> {
    return { user: request.authenticatedUser };
  }
}
