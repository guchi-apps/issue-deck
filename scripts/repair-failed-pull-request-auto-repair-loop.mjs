import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATION = "20261003235900_add_pull_request_auto_repair_loop";

export function shouldRollBackFailedMigration(rows, tableExists) {
  const failed = rows.filter((row) => row.finished_at === null && row.rolled_back_at === null);
  if (failed.length === 0) return false;
  if (failed.length !== 1 || rows.some((row) => row.finished_at !== null)) {
    throw new Error(`${MIGRATION}: unexpected migration history; manual inspection is required`);
  }
  if (tableExists) {
    throw new Error(`${MIGRATION}: table already exists; manual inspection is required`);
  }
  return true;
}

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  let shouldRollBack;
  try {
    const rows = await prisma.$queryRaw`
      SELECT finished_at, rolled_back_at
      FROM _prisma_migrations
      WHERE migration_name = ${MIGRATION}
    `;
    const tables = await prisma.$queryRaw`
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'PullRequestAutoRepairLoop'
    `;
    shouldRollBack = shouldRollBackFailedMigration(rows, tables.length > 0);
  } finally {
    await prisma.$disconnect();
  }

  if (!shouldRollBack) return;
  console.log(`Marking failed ${MIGRATION} attempt as rolled back before retry`);
  const result = spawnSync(
    "pnpm",
    ["exec", "prisma", "migrate", "resolve", "--rolled-back", MIGRATION],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
