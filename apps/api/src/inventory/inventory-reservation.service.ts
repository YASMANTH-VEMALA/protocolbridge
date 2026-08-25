import { ConflictException, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { IntentStatus, Prisma, QuoteStatus, ReservationStatus } from "@protocolbridge/database";
import type { QuoteSnapshot } from "@protocolbridge/types";

import { PrismaService } from "../database/prisma.service";

interface LockedVariantRow {
  id: string;
  priceMinor: bigint;
  currency: string;
  stock: number;
  version: number;
  active: boolean;
}

@Injectable()
export class InventoryReservationService {
  constructor(private readonly database: PrismaService) {}

  async reserve(input: {
    merchantId: string;
    purchaseIntentId: string;
    quote: QuoteSnapshot;
  }): Promise<{ id: string; productVariantId: string; quantity: number; expiresAt: string }> {
    const line = input.quote.lines[0];
    if (!line || input.quote.lines.length !== 1) {
      throw new UnprocessableEntityException({
        code: "UNSUPPORTED_CART_SHAPE",
        message: "P0 supports exactly one verified product variant per agent purchase.",
      });
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.database.$transaction(
          async (transaction) => {
            const intent = await transaction.purchaseIntent.findFirst({
              where: {
                id: input.purchaseIntentId,
                merchantId: input.merchantId,
                status: IntentStatus.APPROVED,
              },
              select: { id: true },
            });
            if (!intent) {
              throw new ConflictException({
                code: "INTENT_NOT_APPROVED",
                message: "Inventory can only be reserved for an approved tenant-scoped intent.",
              });
            }

            const authoritativeQuote = await transaction.quote.findFirst({
              where: {
                id: input.quote.quoteId,
                merchantId: input.merchantId,
                purchaseIntentId: input.purchaseIntentId,
                status: QuoteStatus.ACTIVE,
                expiresAt: { gt: new Date() },
              },
            });
            if (!authoritativeQuote) {
              throw new ConflictException({
                code: "QUOTE_EXPIRED",
                message: "Only a fresh active quote may reserve inventory.",
              });
            }

            const locked = await transaction.$queryRaw<LockedVariantRow[]>(Prisma.sql`
              SELECT id, "priceMinor", currency, stock, version, active
              FROM "ProductVariant"
              WHERE id = ${line.productVariantId} AND "merchantId" = ${input.merchantId}
              FOR UPDATE
            `);
            const variant = locked[0];
            if (!variant || !variant.active) {
              throw new UnprocessableEntityException({
                code: "PRODUCT_NOT_FOUND",
                message: "The quoted variant is no longer active in the merchant tenant.",
              });
            }
            if (
              variant.priceMinor !== BigInt(line.unitAmountMinor) ||
              variant.currency !== input.quote.currency ||
              variant.version !== line.variantVersion
            ) {
              throw new ConflictException({
                code: "QUOTE_CHANGED",
                message: "Price or variant state changed after the quote; refresh before execution.",
              });
            }

            const existing = await transaction.inventoryReservation.findFirst({
              where: {
                merchantId: input.merchantId,
                purchaseIntentId: input.purchaseIntentId,
                status: ReservationStatus.ACTIVE,
              },
            });
            const now = new Date();
            if (existing && existing.expiresAt > now) {
              if (
                existing.productVariantId !== line.productVariantId ||
                existing.quantity !== line.quantity
              ) {
                throw new ConflictException({
                  code: "RESERVATION_CONFLICT",
                  message: "The intent already holds a different inventory reservation.",
                });
              }
              return {
                id: existing.id,
                productVariantId: existing.productVariantId,
                quantity: existing.quantity,
                expiresAt: existing.expiresAt.toISOString(),
              };
            }
            if (existing) {
              await transaction.inventoryReservation.update({
                where: { id: existing.id },
                data: { status: ReservationStatus.EXPIRED },
              });
            }

            const otherReservations = await transaction.inventoryReservation.aggregate({
              where: {
                merchantId: input.merchantId,
                productVariantId: line.productVariantId,
                purchaseIntentId: { not: input.purchaseIntentId },
                status: ReservationStatus.ACTIVE,
                expiresAt: { gt: now },
              },
              _sum: { quantity: true },
            });
            const available = variant.stock - (otherReservations._sum.quantity ?? 0);
            if (available < line.quantity) {
              throw new UnprocessableEntityException({
                code: "OUT_OF_STOCK",
                message: "Verified inventory is insufficient; no payment artifact was created.",
              });
            }

            const reservation = await transaction.inventoryReservation.create({
              data: {
                merchantId: input.merchantId,
                purchaseIntentId: input.purchaseIntentId,
                productVariantId: line.productVariantId,
                quantity: line.quantity,
                status: ReservationStatus.ACTIVE,
                expiresAt: new Date(now.getTime() + 15 * 60_000),
              },
            });
            return {
              id: reservation.id,
              productVariantId: reservation.productVariantId,
              quantity: reservation.quantity,
              expiresAt: reservation.expiresAt.toISOString(),
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error: unknown) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034" &&
          attempt < 3
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("Inventory reservation retry budget was exhausted.");
  }

  async releaseForIntent(merchantId: string, purchaseIntentId: string): Promise<void> {
    await this.database.inventoryReservation.updateMany({
      where: { merchantId, purchaseIntentId, status: ReservationStatus.ACTIVE },
      data: { status: ReservationStatus.RELEASED },
    });
  }
}
