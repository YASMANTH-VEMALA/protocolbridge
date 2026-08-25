import { ConflictException, Injectable } from "@nestjs/common";
import { PurchaseStateMachine, type PurchaseIntentState } from "@protocolbridge/commerce-core";
import { type IntentStatus } from "@protocolbridge/database";
import { ActorType } from "@protocolbridge/database";

import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../database/prisma.service";

@Injectable()
export class IntentStateService {
  private readonly machine = new PurchaseStateMachine();

  constructor(
    private readonly database: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async transition(input: {
    merchantId: string;
    intentId: string;
    from: PurchaseIntentState;
    to: PurchaseIntentState;
    reasonCode?: string | null;
    actorType?: ActorType;
    actorId?: string;
  }): Promise<void> {
    this.machine.assertTransition(input.from, input.to);
    await this.database.$transaction(async (transaction) => {
      const result = await transaction.purchaseIntent.updateMany({
        where: { id: input.intentId, merchantId: input.merchantId, status: input.from as IntentStatus },
        data: {
          status: input.to as IntentStatus,
          ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
        },
      });
      if (result.count !== 1) {
        throw new ConflictException({
          code: "INTENT_STATE_CONFLICT",
          message: "The purchase intent changed concurrently; the operation was not applied.",
        });
      }
      await this.audit.append(
        {
          merchantId: input.merchantId,
          purchaseIntentId: input.intentId,
          actorType: input.actorType ?? ActorType.SYSTEM,
          ...(input.actorId ? { actorId: input.actorId } : {}),
          eventType: "INTENT_STATE_CHANGED",
          data: {
            from: input.from,
            to: input.to,
            ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
          },
        },
        transaction,
      );
    });
  }
}
