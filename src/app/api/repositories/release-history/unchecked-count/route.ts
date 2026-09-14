import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchReleasesBackTo, type ReleaseHistoryItem } from "@/lib/github/release-api";
import {
  buildReleaseCheckIndex,
  countUncheckedReleases,
  hasReachedReleaseCheckSince,
  type ReleaseCheckRecord,
} from "@/lib/release-check";

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

  // 同一installationのリポジトリ間でトークン取得を使い回す（`release-history`と同じ）。
  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  const perRepository = await Promise.all(
    targetRows.map(async (row): Promise<ReleaseHistoryItem[]> => {
      try {
        const token = await tokenFor(row.repository.installation.installationId);
        return await fetchReleasesBackTo(
          row.repository.ownerLogin,
          row.repository.name,
          token,
          row.createdAt.getTime(),
          hasReachedReleaseCheckSince,
        );
      } catch (error) {
        // 1リポジトリの取得失敗で他リポジトリの件数まで巻き込まない（`release-history`と同じ）。
        console.error(
          `[GET /api/repositories/release-history/unchecked-count] ${row.repository.fullName}:`,
          error,
        );
        return [];
      }
    }),
  );

  const count = countUncheckedReleases(perRepository.flat(), checkIndex);
  return NextResponse.json({ count });
}
