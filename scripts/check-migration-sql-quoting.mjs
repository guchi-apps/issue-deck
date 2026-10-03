import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationRoot = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
let invalid = false;

for (const migration of readdirSync(migrationRoot, { withFileTypes: true })) {
  if (!migration.isDirectory()) continue;
  const path = join(migrationRoot, migration.name, "migration.sql");
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    // このリポジトリのMySQL移行SQLでは文字列を'...'、識別子を`...`で引用する。
    // 二重引用符はMySQLのSQL modeに依存し、過去に本番移行を止めた（#3888・#3908）。
    if (line.trimStart().startsWith("--") || !line.includes('"')) return;
    console.error(`${path}:${index + 1}: MySQLの移行SQLで二重引用符を使わないでください`);
    invalid = true;
  });
}

if (invalid) process.exitCode = 1;
