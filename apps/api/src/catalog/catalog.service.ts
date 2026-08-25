import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { SearchConstraints, ResolvedVariant } from "@protocolbridge/types";
import { minorToWire } from "@protocolbridge/types";

import { PrismaService } from "../database/prisma.service";

@Injectable()
export class CatalogService {
  constructor(private readonly database: PrismaService) {}

  async resolveVariant(merchantId: string, constraints: SearchConstraints): Promise<ResolvedVariant> {
    const variants = await this.database.productVariant.findMany({
      where: {
        merchantId,
        active: true,
        ...(constraints.color
          ? { color: { equals: constraints.color, mode: "insensitive" } }
          : {}),
        ...(constraints.size ? { size: { equals: constraints.size, mode: "insensitive" } } : {}),
        product: {
          merchantId,
          active: true,
          ...(constraints.category
            ? { category: { contains: constraints.category, mode: "insensitive" } }
            : {}),
          ...(constraints.brand
            ? { brand: { equals: constraints.brand, mode: "insensitive" } }
            : {}),
        },
      },
      include: { product: true },
      orderBy: [{ priceMinor: "asc" }, { product: { name: "asc" } }, { id: "asc" }],
      take: 25,
    });

    const selected = variants[0];
    if (!selected) {
      throw new UnprocessableEntityException({
        code: "PRODUCT_NOT_FOUND",
        message: "No active merchant product variant matches the verified search constraints.",
      });
    }

    return {
      merchantId,
      productId: selected.productId,
      productVariantId: selected.id,
      productName: selected.product.name,
      brand: selected.product.brand,
      category: selected.product.category,
      sku: selected.sku,
      color: selected.color,
      size: selected.size,
      unitAmountMinor: minorToWire(selected.priceMinor),
      currency: selected.currency,
      availableStock: selected.stock,
      variantVersion: selected.version,
    };
  }
}
