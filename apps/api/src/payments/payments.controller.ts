import { Body, Controller, Headers, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import type { UserAuthenticatedRequest } from "../auth/auth.types";
import { UserAuthGuard } from "../auth/user-auth.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { CheckoutVerificationService } from "./checkout-verification.service";
import { type VerifyCheckoutInput } from "./checkout-verification.service";

const verifyCheckoutSchema = z.object({
  paymentId: z.string().min(1),
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().regex(/^[a-f0-9]{64}$/i),
});

@ApiTags("payments")
@Controller("payments/razorpay")
export class PaymentsController {
  constructor(
    private readonly verification: CheckoutVerificationService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post("verify")
  @HttpCode(200)
  @UseGuards(UserAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Verify Standard Checkout HMAC; final capture still requires a webhook" })
  async verifyCheckout(
    @Req() request: UserAuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(verifyCheckoutSchema)) input: VerifyCheckoutInput,
  ): Promise<Record<string, unknown>> {
    const context = await this.verification.getContext(input.paymentId, request.authenticatedUser.id);
    const result = await this.idempotency.execute({
      merchantId: context.merchantId,
      actorId: request.authenticatedUser.id,
      key: idempotencyKey ?? "",
      method: "POST",
      path: "/v1/payments/razorpay/verify",
      requestBody: input,
      operation: async () => ({
        statusCode: 200,
        body: await this.verification.verify(request.authenticatedUser.id, input),
      }),
    });
    return { ...result.body, idempotencyReplayed: result.replayed };
  }
}
