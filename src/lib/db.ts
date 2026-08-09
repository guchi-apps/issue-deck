import { PrismaClient } from "@prisma/client";

import { resolveDatabaseUrl } from "@/lib/db-url";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const log: ("error" | "warn")[] = process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"];

const databaseUrl = resolveDatabaseUrl(process.env.DATABASE_URL, {
  connectionLimit: process.env.DATABASE_CONNECTION_LIMIT,
  poolTimeout: process.env.DATABASE_POOL_TIMEOUT,
});

function createPrismaClient(): PrismaClient {
  // DATABASE_URLが未設定のときはPrismaの既定の解決（schema.prismaのenv()）に委ねる。
  // ここで空文字を渡すとインスタンス生成の時点で落ちるため、オプション自体を渡さない。
  return databaseUrl ? new PrismaClient({ datasourceUrl: databaseUrl, log }) : new PrismaClient({ log });
}

/**
 * PrismaClient（＝MySQLのコネクションプール）はプロセスに1つだけ持つ。
 *
 * 本番でもglobalThisへキャッシュする。Next.jsはRoute Handlerと`instrumentation.ts`を別々の
 * エントリとしてバンドルするため、同じモジュールが複数回評価されるとその数だけプールが作られ、
 * MySQLの`max_connections`（ERROR 1040: Too many connections）を圧迫する。globalThisは
 * バンドルの境界をまたいで共有されるため、ここでキャッシュすればプロセス内で1つに収まる。
 * 開発時のホットリロードによる作り直しを防ぐ従来の目的も、同じ仕組みで満たせる。
 */
export const db = globalForPrisma.prisma ?? createPrismaClient();

globalForPrisma.prisma = db;
