import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import {
  buildReleaseCheckIndex,
  countUncheckedReleases,
  type ReleaseCheckRecord,
} from "@/lib/release-check";
import { loadReleaseHistoryFromCache } from "@/lib/release-history-server";

/**
 * 左メニュー「リリース履歴」行・スマホのフッター「リリース」タブに出す未確認件数（#2951）。
 *
 * **「確認を追う対象」に選んだリポジトリ（`ReleaseCheckTarget`）だけを見る。** 全リポジトリを
 * 横断する`api/repositories/release-history`（画面を開いたときだけ取得）と違い、こちらは
 * 常時バックグラウンドでポーリングされる（`use-release-unchecked-count.ts`）ため、対象を
 * 選んでいないユーザーはGitHub APIを一切呼ばずに`0`を返す。
 *
 * **左メニューで非表示にしたリポジトリは除く**（計画レビューの指摘。#2951）。「リリース履歴」
 * バッジを押して開いた先（`release-history-panel.tsx`）のヘッダー「未確認 N件」は
 * `selectVisibleReleaseHistory`で非表示リポジトリを除いた母集団から数えており、含めると
 * バッジの件数と開いた先の件数が食い違う。母集団は`api/repositories/release-history`
 * （`archived: false`・インストールへのアクセス権）とも揃える。
 */
export function GET() {
  return withGithubApiFeature("release_unchecked_count", handleGET);
}

async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const targetRows = await db.releaseCheckTarget.findMany({
    where: {
      userId,
      repository: {
        archived: false,
        installation: { userInstallations: { some: { userId } } },
        hiddenBy: { none: { userId } },
      },
    },
    select: {
      createdAt: true,
      repository: {
        select: {
          id: true,
          fullName: true,
          ownerLogin: true,
          name: true,
          installation: { select: { installationId: true } },
        },
      },
    },
  });

  if (targetRows.length === 0) {
    return NextResponse.json({ count: 0 });
  }

  const checkRecordRows = await db.releaseCheck.findMany({
    where: { userId, repository: { fullName: { in: targetRows.map((row) => row.repository.fullName) } } },
    select: { tagName: true, checkedAt: true, repository: { select: { fullName: true } } },
  });
  const checkRecords: ReleaseCheckRecord[] = checkRecordRows.map((row) => ({
    repoFullName: row.repository.fullName,
    tagName: row.tagName,
    checkedAt: row.checkedAt.toISOString(),
  }));

  const checkIndex = buildReleaseCheckIndex(
    targetRows.map((row) => ({ repoFullName: row.repository.fullName, since: row.createdAt.toISOString() })),
    checkRecords,
  );

  // 写しが鮮度内ならGitHubを呼ばない（#5392）。常時ポーリングされるため、枠の消費を写しの更新時だけにする。
  // 取り直しに失敗したリポジトリは件数に含めない（従来と同じ）
  const { loaded } = await loadReleaseHistoryFromCache(
    targetRows.map((row) => row.repository),
    { refresh: false },
  );
  const perRepository: ReleaseHistoryItem[][] = loaded.map((row) => row.entries);

  const count = countUncheckedReleases(perRepository.flat(), checkIndex);
  return NextResponse.json({ count });
}
