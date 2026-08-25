import { Algorithm, hash } from "@node-rs/argon2";
import { createHash } from "node:crypto";

import {
  AgentStatus,
  AuthorizationStatus,
  AuthorizationType,
  GlobalRole,
  MerchantRole,
  MerchantStatus,
  PolicyRuleType,
  PrismaClient,
} from "@prisma/client";

const prisma = new PrismaClient();

const ids = {
  merchant: "mer_solekart",
  superAdmin: "usr_protocolbridge_admin",
  merchantAdmin: "usr_solekart_admin",
  buyer: "usr_demo_buyer",
  agent: "agt_demo_shopper",
  agentCredential: "agc_demo_shopper",
  authorization: "auth_demo_buyer_2000",
  runfalconProduct: "prod_adidas_runfalcon",
  runfalconBlack9: "var_runfalcon_black_9",
  airMaxProduct: "prod_nike_air_max",
  airMaxBlack9: "var_airmax_black_9",
  flyerProduct: "prod_puma_flyer",
  flyerBlack9: "var_flyer_black_9",
} as const;

const demoPassword = process.env.SEED_DEMO_PASSWORD ?? "DemoPass!2026";
const demoAgentKey = process.env.SEED_AGENT_API_KEY ?? "pb_test_solekart_agent_2026";
const credentialPepper = process.env.AGENT_CREDENTIAL_PEPPER;

if (!credentialPepper || credentialPepper.length < 32) {
  throw new Error("AGENT_CREDENTIAL_PEPPER must contain at least 32 characters before seeding.");
}

const hashAgentKey = (apiKey: string): string =>
  createHash("sha256").update(`${credentialPepper}:${apiKey}`, "utf8").digest("hex");

async function upsertUser(input: {
  id: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  passwordHash: string;
}): Promise<void> {
  await prisma.user.upsert({
    where: { id: input.id },
    create: input,
    update: {
      email: input.email,
      name: input.name,
      globalRole: input.globalRole,
      passwordHash: input.passwordHash,
    },
  });
}

async function main(): Promise<void> {
  const passwordHash = await hash(demoPassword, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  await prisma.merchant.upsert({
    where: { id: ids.merchant },
    create: {
      id: ids.merchant,
      slug: "solekart",
      name: "SoleKart",
      status: MerchantStatus.ACTIVE,
    },
    update: { name: "SoleKart", status: MerchantStatus.ACTIVE },
  });

  await upsertUser({
    id: ids.superAdmin,
    email: "admin@protocolbridge.local",
    name: "ProtocolBridge Admin",
    globalRole: GlobalRole.SUPER_ADMIN,
    passwordHash,
  });
  await upsertUser({
    id: ids.merchantAdmin,
    email: "owner@solekart.local",
    name: "SoleKart Owner",
    globalRole: GlobalRole.BUYER,
    passwordHash,
  });
  await upsertUser({
    id: ids.buyer,
    email: "buyer@protocolbridge.local",
    name: "Demo Buyer",
    globalRole: GlobalRole.BUYER,
    passwordHash,
  });

  await prisma.merchantMember.upsert({
    where: {
      merchantId_userId: { merchantId: ids.merchant, userId: ids.merchantAdmin },
    },
    create: {
      merchantId: ids.merchant,
      userId: ids.merchantAdmin,
      role: MerchantRole.MERCHANT_ADMIN,
    },
    update: { role: MerchantRole.MERCHANT_ADMIN },
  });

  await prisma.agent.upsert({
    where: { id: ids.agent },
    create: {
      id: ids.agent,
      merchantId: ids.merchant,
      name: "Demo Shopping Agent",
      status: AgentStatus.ACTIVE,
    },
    update: { status: AgentStatus.ACTIVE, name: "Demo Shopping Agent" },
  });

  await prisma.agentCredential.upsert({
    where: { id: ids.agentCredential },
    create: {
      id: ids.agentCredential,
      merchantId: ids.merchant,
      agentId: ids.agent,
      keyPrefix: demoAgentKey.slice(0, 12),
      secretHash: hashAgentKey(demoAgentKey),
    },
    update: {
      keyPrefix: demoAgentKey.slice(0, 12),
      secretHash: hashAgentKey(demoAgentKey),
      revokedAt: null,
      expiresAt: null,
    },
  });

  const products = [
    {
      id: ids.runfalconProduct,
      slug: "adidas-runfalcon",
      brand: "Adidas",
      name: "Adidas Runfalcon",
      description: "Black everyday running shoes.",
    },
    {
      id: ids.airMaxProduct,
      slug: "nike-air-max",
      brand: "Nike",
      name: "Nike Air Max",
      description: "Cushioned black lifestyle running shoes.",
    },
    {
      id: ids.flyerProduct,
      slug: "puma-flyer",
      brand: "Puma",
      name: "Puma Flyer",
      description: "Lightweight black running shoes.",
    },
  ] as const;

  for (const product of products) {
    await prisma.product.upsert({
      where: { id: product.id },
      create: {
        ...product,
        merchantId: ids.merchant,
        category: "running shoes",
        active: true,
      },
      update: {
        slug: product.slug,
        brand: product.brand,
        name: product.name,
        description: product.description,
        category: "running shoes",
        active: true,
      },
    });
  }

  const variants = [
    {
      id: ids.runfalconBlack9,
      productId: ids.runfalconProduct,
      sku: "ADI-RUNFALCON-BLK-9",
      priceMinor: 189_900n,
      stock: 12,
    },
    {
      id: ids.airMaxBlack9,
      productId: ids.airMaxProduct,
      sku: "NIKE-AIRMAX-BLK-9",
      priceMinor: 699_900n,
      stock: 7,
    },
    {
      id: ids.flyerBlack9,
      productId: ids.flyerProduct,
      sku: "PUMA-FLYER-BLK-9",
      priceMinor: 229_900n,
      stock: 10,
    },
  ] as const;

  for (const variant of variants) {
    await prisma.productVariant.upsert({
      where: { id: variant.id },
      create: {
        ...variant,
        merchantId: ids.merchant,
        color: "Black",
        size: "9",
        currency: "INR",
        active: true,
      },
      update: {
        productId: variant.productId,
        sku: variant.sku,
        color: "Black",
        size: "9",
        priceMinor: variant.priceMinor,
        stock: variant.stock,
        version: 1,
        currency: "INR",
        active: true,
      },
    });
  }

  await prisma.authorization.upsert({
    where: { id: ids.authorization },
    create: {
      id: ids.authorization,
      merchantId: ids.merchant,
      userId: ids.buyer,
      agentId: ids.agent,
      type: AuthorizationType.MAX_AMOUNT,
      status: AuthorizationStatus.ACTIVE,
      maxAmountMinor: 200_000n,
      currency: "INR",
      maxQuantity: 1,
      subscriptionsAllowed: false,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    },
    update: {
      agentId: ids.agent,
      status: AuthorizationStatus.ACTIVE,
      maxAmountMinor: 200_000n,
      maxQuantity: 1,
      subscriptionsAllowed: false,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      consumedAt: null,
    },
  });

  const policies = [
    {
      id: "pol_max_quantity",
      name: "Limit agent quantity",
      type: PolicyRuleType.MAX_QUANTITY,
      priority: 10,
      config: { maxQuantity: 3 },
    },
    {
      id: "pol_block_subscriptions",
      name: "Block subscriptions",
      type: PolicyRuleType.BLOCK_SUBSCRIPTION,
      priority: 20,
      config: { blocked: true },
    },
    {
      id: "pol_require_active_agent",
      name: "Require active agent",
      type: PolicyRuleType.REQUIRE_ACTIVE_AGENT,
      priority: 1,
      config: { requiredStatus: "ACTIVE" },
    },
  ] as const;

  for (const policy of policies) {
    await prisma.policyRule.upsert({
      where: { id: policy.id },
      create: { ...policy, merchantId: ids.merchant, enabled: true },
      update: {
        name: policy.name,
        type: policy.type,
        priority: policy.priority,
        config: policy.config,
        enabled: true,
      },
    });
  }

  process.stdout.write(
    [
      "Seeded ProtocolBridge P0 data.",
      "Buyer login: buyer@protocolbridge.local / DemoPass!2026",
      "Merchant login: owner@solekart.local / DemoPass!2026",
      "Super admin: admin@protocolbridge.local / DemoPass!2026",
      `Demo agent key: ${demoAgentKey}`,
    ].join("\n") + "\n",
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
