import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma, QuoteStatus } from "@protocolbridge/database";
import { minorToWire, type QuoteSnapshot } from "@protocolbridge/types";

import { PrismaService } from "../database/prisma.service";

@Injectable()
export class QuoteService {
  constructor(private readonly database: PrismaService) {}

  async createFreshQuote(input: {
    merchantId: string;
    purchaseIntentId: string;
    productVariantId: string;
    quantity: number;
  }): Promise<QuoteSnapshot> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.database.$transaction(
          async (transaction) => {
            const intent = await transaction.purchaseIntent.findFirst({
              where: { id: input.purchaseIntentId, merchantId: input.merchantId },
              select: { id: true },
            });
            if (!intent) {
              throw new UnprocessableEntityException({
                code: "INTENT_NOT_FOUND",
                message: "The purchase intent does not exist in the authenticated merchant tenant.",
              });
            }

            const variant = await transaction.productVariant.findFirst({
              where: {
                id: input.productVariantId,
                merchantId: input.merchantId,
                active: true,
                product: { merchantId: input.merchantId, active: true },
              },
              include: { product: true },
            });
            if (!variant) {
              throw new UnprocessableEntityException({
                code: "PRODUCT_NOT_FOUND",
                message: "The quoted product variant is unavailable in this merchant tenant.",
              });
            }

            const reserved = await transaction.inventoryReservation.aggregate({
              where: {
                merchantId: input.merchantId,
                productVariantId: variant.id,
                status: "ACTIVE",
                expiresAt: { gt: new Date() },
                purchaseIntentId: { not: input.purchaseIntentId },
              },
              _sum: { quantity: true },
            });
            const availableStock = Math.max(0, variant.stock - (reserved._sum.quantity ?? 0));
            const subtotalMinor = variant.priceMinor * BigInt(input.quantity);
            const now = new Date();
            const expiresAt = new Date(now.getTime() + 120_000);

            await transaction.quote.updateMany({
              where: { purchaseIntentId: input.purchaseIntentId, status: QuoteStatus.ACTIVE },
              data: { status: QuoteStatus.SUPERSEDED },
            });
            const latest = await transaction.quote.findFirst({
              where: { purchaseIntentId: input.purchaseIntentId },
              orderBy: { version: "desc" },
              select: { version: true },
            });
            const version = (latest?.version ?? 0) + 1;
            const line = {
              productId: variant.productId,
              productVariantId: variant.id,
              productName: variant.product.name,
              variantLabel: `${variant.color} / Size ${variant.size}`,
              quantity: input.quantity,
              unitAmountMinor: minorToWire(variant.priceMinor),
              lineTotalMinor: minorToWire(subtotalMinor),
              availableStock,
              variantVersion: variant.version,
            };
            const wireSnapshot = {
              version,
              lines: [line],
              pricedAt: now.toISOString(),
            };
            const quote = await transaction.quote.create({
              data: {
                merchantId: input.merchantId,
                purchaseIntentId: input.purchaseIntentId,
                version,
                status: QuoteStatus.ACTIVE,
                subtotalMinor,
                totalMinor: subtotalMinor,
                currency: variant.currency,
                snapshot: wireSnapshot,
                expiresAt,
              },
            });

            return {
              quoteId: quote.id,
              version,
              merchantId: input.merchantId,
              purchaseIntentId: input.purchaseIntentId,
              subtotalMinor: minorToWire(subtotalMinor),
              totalMinor: minorToWire(subtotalMinor),
              currency: variant.currency,
              lines: [line],
              expiresAt: quote.expiresAt.toISOString(),
              createdAt: quote.createdAt.toISOString(),
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error: unknown) {
        if (this.isRetryableTransactionError(error) && attempt < 3) continue;
        throw error;
      }
    }
    throw new Error("Quote transaction retry budget was exhausted.");
  }

  private isRetryableTransactionError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
  }
}
