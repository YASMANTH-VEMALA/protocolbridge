import { Injectable } from "@nestjs/common";
import { DeterministicAuthorizationEngine, type AuthorizationCheckResult } from "@protocolbridge/authorization";
import { minorToWire, type AuthorizationSnapshot, type QuoteSnapshot, type SearchConstraints } from "@protocolbridge/types";

import { PrismaService } from "../database/prisma.service";

@Injectable()
export class AuthorizationService {
  private readonly engine = new DeterministicAuthorizationEngine();

  constructor(private readonly database: PrismaService) {}

  async evaluate(input: {
    merchantId: string;
    userId: string;
    agentId: string;
    purchaseIntentId: string;
    productVariantId: string;
    quote: QuoteSnapshot;
    constraints: SearchConstraints;
  }): Promise<AuthorizationCheckResult> {
    const authorization = await this.database.authorization.findFirst({
      where: {
        merchantId: input.merchantId,
        userId: input.userId,
        status: "ACTIVE",
        expiresAt: { gt: new Date() },
        OR: [{ agentId: null }, { agentId: input.agentId }],
        AND: [
          { OR: [{ productVariantId: null }, { productVariantId: input.productVariantId }] },
          { OR: [{ boundIntentId: null }, { boundIntentId: input.purchaseIntentId }] },
        ],
      },
      orderBy: [{ type: "desc" }, { createdAt: "desc" }],
    });

    const snapshot: AuthorizationSnapshot | null = authorization
      ? {
          authorizationId: authorization.id,
          type: authorization.type,
          status: authorization.status,
          merchantId: authorization.merchantId,
          userId: authorization.userId,
          agentId: authorization.agentId,
          productVariantId: authorization.productVariantId,
          boundIntentId: authorization.boundIntentId,
          maxAmountMinor: minorToWire(authorization.maxAmountMinor),
          currency: authorization.currency,
          maxQuantity: authorization.maxQuantity,
          subscriptionsAllowed: authorization.subscriptionsAllowed,
          usesRemaining: authorization.usesRemaining,
          expiresAt: authorization.expiresAt.toISOString(),
        }
      : null;

    return this.engine.evaluate({
      authorization: snapshot,
      merchantId: input.merchantId,
      userId: input.userId,
      agentId: input.agentId,
      purchaseIntentId: input.purchaseIntentId,
      productVariantId: input.productVariantId,
      totalMinor: input.quote.totalMinor,
      currency: input.quote.currency,
      quantity: input.constraints.quantity,
      subscription: input.constraints.subscription,
      now: new Date(),
    });
  }
}
