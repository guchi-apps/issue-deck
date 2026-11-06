import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchReleasesBackTo, type ReleaseHistoryItem } from "@/lib/github/release-api";
import { appendUnreleasedVersions } from "@/lib/github/unreleased-versions";
import { hasReachedReleaseCheckSince } from "@/lib/release-check";
import { buildCheckLineRecordsFromBodies } from "@/lib/release-body-tasks";
import { mergeReleaseHistory } from "@/lib/release-history";
import { isInReleaseHistoryScope, parseReleaseHistoryScope } from "@/lib/release-history-cache";
import {
  attachReleaseCandidates,
  findReleaseHistoryRepositories,
  loadReleaseCheckMaterials,
  saveReleaseHistoryCache,
} from "@/lib/release-history-server";

export function GET(request: Request) {
  return withGithubApiFeature("release_history", () => handleGET(request));
}

/**
 * リリース履歴の最新をGitHubから取る。
 *
 * `?scope=targets|others`で母集団を「動作確認の対象にしたリポジトリ」と「それ以外」に分けられる（#5230）。
 * 画面は2本を並行して呼び、初期表示（未確認のリリース）に要る`targets`を先に描く。scopeを付けなければ
 * 従来どおり全部を返す。取得できたリポジトリぶんは前回の取得結果（`ReleaseHistoryCache`）として残し、
 * 次に画面を開いたときは`release-history/cached`がそれを即座に返す。
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

  // 同一installationのリポジトリ間でトークン取得を使い回す（`release-pending-merges`と同じ）。
  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  const durations: { fullName: string; ms: number }[] = [];
  const perRepository = await Promise.all(
    repositories.map(async (repository): Promise<{ repositoryId: string; fullName: string; entries: ReleaseHistoryItem[] } | null> => {
      const repoStartedAt = performance.now();
      try {
        const token = await tokenFor(repository.installation.installationId);
        const sinceMs = checkSinceMsByFullName.get(repository.fullName);
        const releases = await fetchReleasesBackTo(
          repository.ownerLogin,
          repository.name,
          token,
          sinceMs,
          hasReachedReleaseCheckSince,
        );
        // GitHub Releaseが無い版（本番デプロイの失敗など）をタグから補い、修正版と紐付ける（#4003）
        // iOS配布の状況はここで待たない。1回約1MB・約3秒かかるため、`release-history/ios-status`で後から重ねる（#5214）
        const entries = await appendUnreleasedVersions(repository.ownerLogin, repository.name, token, releases);
        return { repositoryId: repository.id, fullName: repository.fullName, entries };
      } catch (error) {
        // 1リポジトリの取得失敗で他リポジトリの表示まで巻き込まない（`release-pending-merges`と同じ）。
        // 受け持ちからも外し、画面には前回の値を残させる
        console.error(`[GET /api/repositories/release-history] ${repository.fullName}:`, error);
        return null;
      } finally {
        durations.push({ fullName: repository.fullName, ms: Math.round(performance.now() - repoStartedAt) });
      }
    }),
  );
  const succeeded = perRepository.filter((row) => row !== null);
  const githubMs = Math.round(performance.now() - startedAt);

  await saveReleaseHistoryCache(succeeded);

  const entries = await attachReleaseCandidates(mergeReleaseHistory(succeeded.map((row) => row.entries)));
  const totalMs = Math.round(performance.now() - startedAt);

  // どのリポジトリが遅いかを本番で見られるようにする（#5230。手元の開発DBには接続先が無く測れない）
  const slowest = [...durations].sort((a, b) => b.ms - a.ms).slice(0, 3);
  console.info(
    `[GET /api/repositories/release-history] scope=${scope} repos=${repositories.length} total=${totalMs}ms slowest=${slowest.map((d) => `${d.fullName}:${d.ms}ms`).join(",")}`,
  );

  return NextResponse.json(
    {
      repositories: succeeded.map((row) => row.fullName),
      // 取得に失敗したリポジトリ。画面は確認対象にこれが残る間、最新とみなさず確認操作をロックする
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
