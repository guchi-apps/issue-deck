import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { buildCheckLineRecordsFromBodies } from "@/lib/release-body-tasks";
import { mergeReleaseHistory } from "@/lib/release-history";
import { isInReleaseHistoryScope, parseReleaseHistoryScope } from "@/lib/release-history-cache";
import {
  attachReleaseCandidates,
  findReleaseHistoryRepositories,
  loadReleaseCheckMaterials,
  loadReleaseHistoryFromCache,
} from "@/lib/release-history-server";

export function GET(request: Request) {
  return withGithubApiFeature("release_history", () => handleGET(request));
}

/**
 * リリース履歴を返す。**写し（`ReleaseHistoryCache`）を正とし、鮮度（TTL）内のリポジトリはGitHubを呼ばない**（#5392）。
 * 写しが無い・古いリポジトリと、`?refresh=1`（更新ボタン）の全リポジトリだけGitHubから取り直して写しへ保存する。
 *
 * `?scope=targets|others`で母集団を「動作確認の対象にしたリポジトリ」と「それ以外」に分けられる（#5230）。
 * 画面は2本を並行して呼び、初期表示（未確認のリリース）に要る`targets`を先に描く。scopeを付けなければ
 * 従来どおり全部を返す。`release-history/cached`は画面を開いた直後の即時表示用に写しをそのまま返す。
 *
 * `repositories`はこの応答が受け持ったリポジトリ（取得に失敗したものは含めない）。画面は
 * ここに含まれるリポジトリの分だけを差し替え、失敗したリポジトリは前回の値を残す。失敗したリポジトリは
 * `failedRepositories`で明示する（最新を取れていないものを最新として確認させないため）。
 */
async function handleGET(request: Request) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = performance.now();
  const scope = parseReleaseHistoryScope(new URL(request.url).searchParams.get("scope"));
  const allRepositories = await findReleaseHistoryRepositories(userId);

  if (allRepositories.length === 0) {
    return NextResponse.json({
      repositories: [],
      failedRepositories: [],
      entries: [],
      checkRecords: [],
      checkLineRecords: [],
    });
  }

  const { checkSinceMsByFullName, checkRecords, legacyCheckLineRecords } = await loadReleaseCheckMaterials(
    userId,
    allRepositories.map((repository) => repository.id),
  );
  const repositories = allRepositories.filter((repository) =>
    isInReleaseHistoryScope(scope, checkSinceMsByFullName.has(repository.fullName)),
  );

  // 写しが鮮度内のリポジトリはGitHubを呼ばない。無い・古い・`refresh=1`のものだけ取り直す（#5392）
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const { loaded: succeeded, failed, durations } = await loadReleaseHistoryFromCache(repositories, { refresh });
  const failedReasons: Record<string, string> = Object.fromEntries(failed.map((row) => [row.fullName, row.reason]));
  const githubMs = Math.round(performance.now() - startedAt);

  const entries = await attachReleaseCandidates(mergeReleaseHistory(succeeded.map((row) => row.entries)));
  const totalMs = Math.round(performance.now() - startedAt);
  const refreshedCount = succeeded.filter((row) => row.refreshed).length;

  // どのリポジトリが遅いかを本番で見られるようにする（#5230。手元の開発DBには接続先が無く測れない）
  const slowest = [...durations].sort((a, b) => b.ms - a.ms).slice(0, 3);
  console.info(
    `[GET /api/repositories/release-history] scope=${scope} repos=${repositories.length} refreshed=${refreshedCount} total=${totalMs}ms slowest=${slowest.map((d) => `${d.fullName}:${d.ms}ms`).join(",")}`,
  );

  return NextResponse.json(
    {
      repositories: succeeded.map((row) => row.fullName),
      // 取得に失敗したリポジトリ。画面は確認対象にこれが残る間、最新とみなさず確認操作をロックする
      failedReasons: Object.fromEntries(Object.entries(failedReasons).filter(([, reason]) => reason)),
      failedRepositories: repositories
        .map((repository) => repository.fullName)
        .filter((fullName) => !succeeded.some((row) => row.fullName === fullName)),
      entries,
      checkRecords,
      // 項目ごとの確認状態はGitHub Release本文のタスクリストが正（#4374）。取得のたびに本文から組み直す
      checkLineRecords: buildCheckLineRecordsFromBodies(entries, legacyCheckLineRecords),
      fetchedAt: new Date().toISOString(),
    },
    { headers: { "Server-Timing": `github;dur=${githubMs}, total;dur=${totalMs}` } },
  );
}
