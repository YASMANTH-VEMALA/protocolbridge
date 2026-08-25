import { Injectable } from "@nestjs/common";
import { DeterministicPolicyEngine, type PolicyRuleInput } from "@protocolbridge/policy-engine";
import type {
  AuthorizationSnapshot,
  DecisionReason,
  PolicyDecision,
  QuoteSnapshot,
  SearchConstraints,
} from "@protocolbridge/types";

import { PrismaService } from "../database/prisma.service";

@Injectable()
export class PolicyService {
  private readonly engine = new DeterministicPolicyEngine();

  constructor(private readonly database: PrismaService) {}

  async evaluate(input: {
    merchantId: string;
    quote: QuoteSnapshot;
    constraints: SearchConstraints;
    authorization: AuthorizationSnapshot | null;
    authorizationReasons: DecisionReason[];
    agentActive: boolean;
  }): Promise<PolicyDecision> {
    const rules = await this.database.policyRule.findMany({
      where: { merchantId: input.merchantId, enabled: true },
      orderBy: [{ priority: "asc" }, { id: "asc" }],
    });
    return this.engine.evaluate({
      quote: input.quote,
      constraints: input.constraints,
      authorization: input.authorization,
      authorizationReasons: input.authorizationReasons,
      agentActive: input.agentActive,
      rules: rules.map(
        (rule): PolicyRuleInput => ({
          type: rule.type,
          enabled: rule.enabled,
          config: rule.config,
        }),
      ),
      now: new Date(),
    });
  }
}
