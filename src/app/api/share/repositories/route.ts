import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { authenticateShareToken } from "@/lib/share-token/auth";

/**
 * 共有画面のリポジトリ選択用一覧（#4298）。**共有トークンで呼ぶ。**
 * 起案できる対象だけを返す（#5673）。起案画面（`/issues/new`）と同じく、非表示と
 * 「Issue作成の対象外」は出さない。アーカイブ済みも出さない。
 */
export async function GET(request: NextRequest) {
  const user = await authenticateShareToken(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const repositories = await db.repository.findMany({
    where: {
      archived: false,
      installation: { userInstallations: { some: { userId: user.id } } },
      hiddenBy: { none: { userId: user.id } },
      issueCreationExcludedBy: { none: { userId: user.id } },
    },
    select: { fullName: true, private: true },
    orderBy: { fullName: "asc" },
  });

  return NextResponse.json({ repositories }, { headers: { "Cache-Control": "no-store" } });
}
