import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const MIGRATION = "20261003090000_add_codex_weekly_floor";

export function shouldRollBackFailedMigration(rows, columnExists) {
  const failed = rows.filter((row) => row.finished_at === null && row.rolled_back_at === null);
  if (failed.length === 0) return false;
  if (failed.length !== 1 || rows.some((row) => row.finished_at !== null)) {
    throw new Error(`${MIGRATION}: unexpected migration history; manual inspection is required`);
  }
  if (columnExists) {
    throw new Error(`${MIGRATION}: column already exists; manual inspection is required`);
  }
  return true;
}

async function main() {
  const prisma = new PrismaClient();
  let shouldRollBack;
  try {
    const rows = await prisma.$queryRaw`
      SELECT finished_at, rolled_back_at
      FROM _prisma_migrations
      WHERE migration_name = ${MIGRATION}
    `;
    const columns = await prisma.$queryRaw`
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AppSetting'
        AND COLUMN_NAME = 'nextWindowRunCodexWeeklyFloorPercent'
    `;
    shouldRollBack = shouldRollBackFailedMigration(rows, columns.length > 0);
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
