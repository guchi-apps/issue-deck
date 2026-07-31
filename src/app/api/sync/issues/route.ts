import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { syncRepositoryIssues } from "@/lib/github/sync-issues";

export async function POST() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const repositories = await db.repository.findMany({
    where: { installation: { userInstallations: { some: { userId } } } },
    include: { installation: true },
  });

  // 全リポジトリを並列実行するとMariaDBへの書き込みが競合しデッドロックするため、1件ずつ順番に処理する。
  const errors: { repo: string; message: string }[] = [];
  for (const repo of repositories) {
    try {
      await syncRepositoryIssues(repo);
    } catch (error) {
      errors.push({
        repo: repo.fullName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json({ synced: repositories.length - errors.length, errors });
}
