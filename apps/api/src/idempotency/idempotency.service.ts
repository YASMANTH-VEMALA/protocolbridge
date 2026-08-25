import { ConflictException, HttpException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { IdempotencyStatus, Prisma } from "@protocolbridge/database";

import { PrismaService } from "../database/prisma.service";

export interface IdempotentResult<T extends object> {
  statusCode: number;
  body: T;
  replayed: boolean;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  return value;
}

export function hashIdempotencyRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalizeJson(value)), "utf8").digest("hex");
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly database: PrismaService) {}

  async execute<T extends object>(input: {
    merchantId: string;
    actorId: string;
    key: string;
    method: string;
    path: string;
    requestBody: unknown;
    operation: () => Promise<{ statusCode: number; body: T }>;
  }): Promise<IdempotentResult<T>> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.key)) {
      throw new ConflictException({
        code: "INVALID_IDEMPOTENCY_KEY",
        message: "Idempotency-Key must be 8-128 URL-safe characters.",
      });
    }
    const method = input.method.toUpperCase();
    const requestHash = hashIdempotencyRequest(input.requestBody);
    const now = new Date();
    const unique = {
      actorId_method_path_key: {
        actorId: input.actorId,
        method,
        path: input.path,
        key: input.key,
      },
    } as const;

    try {
      await this.database.idempotencyRecord.create({
        data: {
          merchantId: input.merchantId,
          actorId: input.actorId,
          key: input.key,
          method,
          path: input.path,
          requestHash,
          status: IdempotencyStatus.IN_PROGRESS,
          lockedAt: now,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
        },
      });
    } catch (error: unknown) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
      const existing = await this.database.idempotencyRecord.findUnique({ where: unique });
      if (!existing || existing.merchantId !== input.merchantId) {
        throw new ConflictException({
          code: "IDEMPOTENCY_TENANT_CONFLICT",
          message: "The idempotency key is not valid for this merchant context.",
        });
      }
      if (existing.requestHash !== requestHash) {
        throw new ConflictException({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "The same idempotency key cannot be used with a different request.",
        });
      }
      if (
        (existing.status === IdempotencyStatus.COMPLETED ||
          existing.status === IdempotencyStatus.FAILED) &&
        existing.responseStatus !== null &&
        existing.responseBody !== null
      ) {
        if (existing.status === IdempotencyStatus.FAILED) {
          const replayError =
            typeof existing.responseBody === "object" &&
            existing.responseBody !== null &&
            !Array.isArray(existing.responseBody)
              ? (existing.responseBody as Record<string, unknown>)
              : { code: "HTTP_ERROR", message: String(existing.responseBody) };
          throw new HttpException(replayError, existing.responseStatus);
        }
        return {
          statusCode: existing.responseStatus,
          body: existing.responseBody as unknown as T,
          replayed: true,
        };
      }

      const staleBefore = new Date(now.getTime() - 2 * 60_000);
      const reclaimed = await this.database.idempotencyRecord.updateMany({
        where: {
          id: existing.id,
          status: IdempotencyStatus.IN_PROGRESS,
          lockedAt: { lt: staleBefore },
        },
        data: { lockedAt: now },
      });
      if (reclaimed.count !== 1) {
        throw new ConflictException({
          code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
          message: "An identical request is already in progress; retry shortly.",
        });
      }
    }

    try {
      const result = await input.operation();
      await this.database.idempotencyRecord.update({
        where: unique,
        data: {
          status: IdempotencyStatus.COMPLETED,
          responseStatus: result.statusCode,
          responseBody: result.body as unknown as Prisma.InputJsonObject,
        },
      });
      return { ...result, replayed: false };
    } catch (error: unknown) {
      const statusCode = error instanceof HttpException ? error.getStatus() : 500;
      const response =
        error instanceof HttpException
          ? error.getResponse()
          : { code: "INTERNAL_ERROR", message: "An unexpected error occurred." };
      const responseBody: Prisma.InputJsonValue =
        typeof response === "string" ? { code: "HTTP_ERROR", message: response } : (response as Prisma.InputJsonObject);
      await this.database.idempotencyRecord.update({
        where: unique,
        data: {
          status: IdempotencyStatus.FAILED,
          responseStatus: statusCode,
          responseBody,
          errorCode:
            typeof response === "object" && response !== null && "code" in response
              ? String(response.code)
              : "INTERNAL_ERROR",
        },
      });
      throw error;
    }
  }
}
