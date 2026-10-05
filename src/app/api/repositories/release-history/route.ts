import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchWorkflowRunJobs } from "@/lib/github/actions-api";
import { fetchReleasesBackTo, fetchTagRefs, type ReleaseHistoryItem } from "@/lib/github/release-api";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import { appendUnreleasedVersions } from "@/lib/github/unreleased-versions";
import {
  IOS_TESTFLIGHT_TAG_PREFIX,
  IOS_TESTFLIGHT_WORKFLOW_FILE,
  iosDeliveryForReleases,
  iosFailuresForReleases,
  judgeIosRun,
  summarizeIosStages,
} from "@/lib/ios-testflight-status";
import { getWebviewIosRepository } from "@/lib/webview-ios-repos";
import {
  hasReachedReleaseCheckSince,
  type ReleaseCheckLineRecord,
  type ReleaseCheckRecord,
} from "@/lib/release-check";
import { mergeReleaseHistory } from "@/lib/release-history";

export function GET() {
  return withGithubApiFeature("release_history", handleGET);
}

async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 母集団は「ブランチ」画面・リリース状況の取得（`release-pending-merges/route.ts`）と揃え、
  // アーカイブ済みを除いたユーザーの接続先すべてにする。**非表示リポジトリも含める**——
  // 除くのは`selectVisibleReleaseHistory`でクライアント側が行う（`release-activity.ts`と同じ方針）。
  const repositories = await db.repository.findMany({
    where: {
      archived: false,
      installation: { userInstallations: { some: { userId } } },
    },
    orderBy: { fullName: "asc" },
    include: { installation: true },
  });

  if (repositories.length === 0) {
    return NextResponse.json({ entries: [], checkTargets: [], checkRecords: [], checkLineRecords: [] });
  }

  // 動作確認のフラグ（#2930）の材料。**状態へ畳まずそのまま返す**——判定は
  // `lib/release-check.ts`の純粋関数が行い、画面は「確認済みにする」を押した直後も
  // 同じ関数で描き直す（サーバーの応答を待たない楽観的更新のため）。
  // 箇条書き行ごとの確認記録（#2982）も同じ材料の一つとして返す。
  const [checkTargetRows, checkRecordRows, checkLineRecordRows] = await Promise.all([
    db.releaseCheckTarget.findMany({
      where: { userId },
      select: { createdAt: true, repository: { select: { fullName: true } } },
    }),
    db.releaseCheck.findMany({
      where: { userId },
      select: { tagName: true, checkedAt: true, repository: { select: { fullName: true } } },
    }),
    db.releaseCheckLine.findMany({
      where: { userId },
      select: {
        tagName: true,
        lineKey: true,
        checkedAt: true,
        repository: { select: { fullName: true } },
      },
    }),
  ]);

  // repoFullName → 対象に加えた時刻（この時点まで遡って取る）
  const checkSinceMsByFullName = new Map(
    checkTargetRows.map((row) => [row.repository.fullName, row.createdAt.getTime()]),
  );
  const checkRecords: ReleaseCheckRecord[] = checkRecordRows.map((row) => ({
    repoFullName: row.repository.fullName,
    tagName: row.tagName,
    checkedAt: row.checkedAt.toISOString(),
  }));
  const checkLineRecords: ReleaseCheckLineRecord[] = checkLineRecordRows.map((row) => ({
    repoFullName: row.repository.fullName,
    tagName: row.tagName,
    lineKey: row.lineKey,
    checkedAt: row.checkedAt.toISOString(),
  }));

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

  const perRepository = await Promise.all(
    repositories.map(async (repository): Promise<ReleaseHistoryItem[]> => {
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
        const withUnreleased = await appendUnreleasedVersions(
          repository.ownerLogin,
          repository.name,
          token,
          releases,
        );
        // TestFlight配布対象のリポジトリだけ、配布済みのビルド番号を付ける（#3800）
        if (getWebviewIosRepository(repository.fullName) === null || releases.length === 0) {
          return withUnreleased;
        }
        const [versionRefs, deliveredRefs, iosRuns] = await Promise.all([
          fetchTagRefs(repository.ownerLogin, repository.name, token, "v"),
          fetchTagRefs(repository.ownerLogin, repository.name, token, IOS_TESTFLIGHT_TAG_PREFIX),
          fetchIosTestflightRuns(repository.ownerLogin, repository.name, token),
        ]);
        const delivered = iosDeliveryForReleases(
          releases.map((release) => release.tagName),
          versionRefs,
          deliveredRefs,
        );
        const releaseShas = new Set(
          versionRefs
            .filter((ref) => releases.some((release) => release.tagName === ref.ref.replace(/^refs\/tags\//, "")))
            .map((ref) => ref.sha),
        );
        // run一覧は新しい順。リリースごとの最新runが失敗しているときだけ、段階名を取る。
        const latestRunsBySha = new Map<string, (typeof iosRuns)[number]>();
        for (const run of iosRuns) {
          if (run.status === "completed" && !latestRunsBySha.has(run.headSha) && releaseShas.has(run.headSha)) {
            latestRunsBySha.set(run.headSha, run);
          }
        }
        const failureStages = await Promise.all(
          [...latestRunsBySha.values()].map(async (run) => {
            if (["success", "neutral", "skipped", null].includes(run.conclusion)) return { ...run, failedStage: null };
            try {
              const jobs = await fetchWorkflowRunJobs(repository.ownerLogin, repository.name, run.id, token);
              const verdict = judgeIosRun(run, summarizeIosStages(jobs));
              return { ...run, failedStage: verdict.kind === "failed" ? verdict.failedStage : null };
            } catch {
              return { ...run, failedStage: null };
            }
          }),
        );
        const failures = iosFailuresForReleases(releases.map((release) => release.tagName), versionRefs, failureStages);
        const hasActiveRun = iosRuns.some((run) => run.status !== "completed");
        return withUnreleased.map((release) => {
          const build = delivered.get(release.tagName);
          // 成功を示す配布済みタグがある版は、過去の失敗runより成功を優先する。
          if (build !== undefined) return { ...release, iosDeliveredBuild: build };
          const failedStage = failures.get(release.tagName);
          if (failedStage !== undefined) return { ...release, iosFailureStage: failedStage };
          // 配布済みでも失敗でもない版は「自動配布なし」として示す（更新不要と判定された版を含む）。
          // runのhead_shaは版のコミットと一致しないため、版とは突き合わせず、
          // 配布が実行中のリポジトリでは途中の版を誤ってなしと示さないよう出さない。
          return hasActiveRun ? release : { ...release, iosNotDistributed: true };
        });
      } catch (error) {
        // 1リポジトリの取得失敗で他リポジトリの表示まで巻き込まない（`release-pending-merges`と同じ）。
        console.error(`[GET /api/repositories/release-history] ${repository.fullName}:`, error);
        return [];
      }
    }),
  );

  return NextResponse.json({
    entries: mergeReleaseHistory(perRepository),
    checkRecords,
    checkLineRecords,
  });
}

type IosTestflightRun = {
  id: number;
  headSha: string;
  status: string;
  conclusion: string | null;
};

/** リリースのコミットと照合するiOS配布runを新しい順に取る。ワークフロー未導入は空配列へ縮退する。 */
async function fetchIosTestflightRuns(owner: string, repo: string, token: string): Promise<IosTestflightRun[]> {
  const res = await githubFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${IOS_TESTFLIGHT_WORKFLOW_FILE}/runs?per_page=100`,
    token,
  );
  if (!res.ok) return [];
  const body: {
    workflow_runs?: Array<{ id?: number; head_sha?: string; status?: string; conclusion?: string | null }>;
  } = await res.json().catch(() => ({}));
  return (body.workflow_runs ?? []).flatMap((run) =>
    typeof run.id === "number" && typeof run.head_sha === "string" && typeof run.status === "string"
      ? [{ id: run.id, headSha: run.head_sha, status: run.status, conclusion: run.conclusion ?? null }]
      : [],
  );
}
