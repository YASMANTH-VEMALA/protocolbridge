import { Injectable } from "@nestjs/common";
import type { ActorType, Prisma } from "@protocolbridge/database";

import { PrismaService } from "../database/prisma.service";

type DatabaseClient = PrismaService | Prisma.TransactionClient;

export interface AppendAuditInput {
  merchantId?: string;
  purchaseIntentId?: string;
  orderId?: string;
  actorType: ActorType;
  actorId?: string;
  eventType: string;
  data: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  constructor(private readonly database: PrismaService) {}

  async append(input: AppendAuditInput, client: DatabaseClient = this.database): Promise<string> {
    if (input.purchaseIntentId && input.merchantId) {
      const intent = await client.purchaseIntent.findFirst({
        where: { id: input.purchaseIntentId, merchantId: input.merchantId },
        select: { id: true },
      });
      if (!intent) throw new Error("Refusing to append an audit event across merchant tenants.");
    }
    if (input.orderId && input.merchantId) {
      const order = await client.order.findFirst({
        where: { id: input.orderId, merchantId: input.merchantId },
        select: { id: true },
      });
      if (!order) throw new Error("Refusing to append an order audit event across merchant tenants.");
    }
    const event = await client.auditEvent.create({
      data: {
        ...(input.merchantId ? { merchantId: input.merchantId } : {}),
        ...(input.purchaseIntentId ? { purchaseIntentId: input.purchaseIntentId } : {}),
        ...(input.orderId ? { orderId: input.orderId } : {}),
        actorType: input.actorType,
        ...(input.actorId ? { actorId: input.actorId } : {}),
        eventType: input.eventType,
        data: input.data,
      },
      select: { id: true },
    });
    return event.id;
  }

  async getIntentTimeline(merchantId: string, purchaseIntentId: string): Promise<Record<string, unknown>[]> {
    const intent = await this.database.purchaseIntent.findFirst({
      where: { id: purchaseIntentId, merchantId },
      select: { id: true },
    });
    if (!intent) return [];
    const events = await this.database.auditEvent.findMany({
      where: { merchantId, purchaseIntentId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      actorType: event.actorType,
      actorId: event.actorId,
      data: event.data,
      createdAt: event.createdAt.toISOString(),
    }));
  }
}
