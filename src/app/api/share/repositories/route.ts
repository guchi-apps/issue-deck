import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { authenticateShareToken } from "@/lib/share-token/auth";

/**
 * 共有画面のリポジトリ選択用一覧（#4298）。**共有トークンで呼ぶ。**
 * Issueを作れる連携リポジトリ（アーカイブ済みを除く）を返し、利用者が「Issue作成の対象外」に
 * したものは`disabledReason`つきで返す（選べない理由を画面に出すため）。
 */
export async function GET(request: NextRequest) {
  const user = await authenticateShareToken(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [repositories, excluded] = await Promise.all([
    db.repository.findMany({
      where: { archived: false, installation: { userInstallations: { some: { userId: user.id } } } },
      select: { id: true, fullName: true, private: true },
      orderBy: { fullName: "asc" },
    }),
    db.issueCreationExcludedRepository.findMany({ where: { userId: user.id }, select: { repositoryId: true } }),
  ]);
  const excludedIds = new Set(excluded.map((row) => row.repositoryId));

  return NextResponse.json(
    {
      repositories: repositories.map((repository) => ({
        fullName: repository.fullName,
        private: repository.private,
        disabledReason: excludedIds.has(repository.id) ? "Issue作成の対象外に設定されています" : null,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
