import type { AgentStatus, GlobalRole, MerchantRole, MerchantStatus } from "@protocolbridge/database";
import type { Request } from "express";

export interface AuthenticatedUser {
  id: string;
  globalRole: GlobalRole;
}

export interface AuthenticatedAgent {
  id: string;
  status: AgentStatus;
  merchantId: string;
  merchantStatus: MerchantStatus;
  credentialId: string;
}

export type UserAuthenticatedRequest = Request & { authenticatedUser: AuthenticatedUser };
export type AgentAuthenticatedRequest = Request & { authenticatedAgent: AuthenticatedAgent };

export interface MerchantAccess {
  merchantId: string;
  role: MerchantRole;
}
