export * from "@prisma/client";
export { PrismaClient } from "@prisma/client";

import { PrismaClient } from "@prisma/client";

const globalDatabase = globalThis as unknown as {
  protocolBridgePrisma?: PrismaClient;
};

export const prisma =
  globalDatabase.protocolBridgePrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalDatabase.protocolBridgePrisma = prisma;
}
