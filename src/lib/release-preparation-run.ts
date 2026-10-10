import { db } from "@/lib/db";
import { fetchWorkflowJobLogs, fetchWorkflowRun, fetchWorkflowRunJobs } from "@/lib/github/actions-api";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchCommentsForIssue, fetchIssueLabelNames, removeIssueLabel } from "@/lib/github/issues-api";
import { fetchAllPages } from "@/lib/github/pagination";
import { queryIssuesByProgressStatus } from "@/lib/github/query-progress";
import { GITHUB_API } from "@/lib/github/request";
import {
  CHECK_USER,
  extractErrorExcerpt,
  findFailedStep,
  releaseFailureDerivedLabels,
  type IssueLabelEvent,
  type ReleasePreparationFailureView,
} from "@/lib/release-preparation";
import { markRebuildRequestFailed } from "@/lib/release-rebuild-selection-run";
import { parseRebuildSelection, serializeRebuildSelection } from "@/lib/release-rebuild-selection";
import { isBumpKind } from "@/lib/semver-bump";

/**
 * リリース準備の失敗記録（#4335）の外部操作。判断は`release-preparation.ts`の純関数が持つ。
 *
 * 報告はworkflow（`notify-failure`・`notify-prepared`）から共有シークレット付きで届くが、
 * **信用するのはリポジトリとrun番号だけ**。それが本当にリリースworkflowの失敗／成功かと、
 * 失敗した工程・エラー行は、サーバーがGitHubから取り直す。
 */

const RELEASE_WORKFLOW_PATH = /(^|\/)release-develop-to-main\.yml(@|$)/;

async function resolveRepository(repositoryFullName: string) {
  const repository = await db.repository.findFirst({
    where: { fullName: repositoryFullName },
    include: { installation: true },
  });
  if (!repository) return null;
  const token = await getInstallationToken(repository.installation.installationId);
  return { owner: repository.ownerLogin, repo: repository.name, token };
}

export type ReleasePreparationReportResult =
  | { ok: true; recorded?: string; resolved?: number; clearedIssues?: number[] }
  | { ok: false; reason: "unknown_repository" | "not_release_run" | "run_not_concluded" };

/** `release`ジョブの失敗を記録する。同じrunの報告は1行にまとめる（再実行の報告も同じ行を更新） */
export async function recordReleasePreparationFailure(input: {
  repositoryFullName: string;
  runId: number;
  event: string | null;
  bumpKind: string | null;
  /** 選んで作り直していたときの指定（workflowの`rebuild-selection`）。形が崩れていれば捨てる */
  rebuildSelection?: string | null;
}): Promise<ReleasePreparationReportResult> {
  const context = await resolveRepository(input.repositoryFullName);
  if (!context) return { ok: false, reason: "unknown_repository" };
  const { owner, repo, token } = context;

  const run = await fetchWorkflowRun(owner, repo, input.runId, token);
  if (!RELEASE_WORKFLOW_PATH.test(run.path ?? "")) return { ok: false, reason: "not_release_run" };

  let jobName: string | null = null;
  let stepName: string | null = null;
  let errorExcerpt: string | null = null;
  try {
    const jobs = await fetchWorkflowRunJobs(owner, repo, input.runId, token);
    ({ jobName, stepName } = findFailedStep(jobs));
    const failedJob = jobs.find((job) => job.name === jobName);
    if (failedJob?.id) {
      errorExcerpt = extractErrorExcerpt(await fetchWorkflowJobLogs(owner, repo, failedJob.id, token));
    }
  } catch (error) {
    // 内訳が取れなくても失敗そのものは記録する（画面は「工程を取得できませんでした」と出す）
    console.error(`[release-preparation] 失敗の内訳を取得できませんでした（${input.repositoryFullName} run ${input.runId}）`, error);
  }

  const runUrl = run.html_url ?? `https://github.com/${input.repositoryFullName}/actions/runs/${input.runId}`;
  const selection = parseRebuildSelection(input.rebuildSelection);
  if (selection) {
    // 同じ元の候補へやり直せるよう、進行中の依頼を終える。選択は失敗の記録に残し、再開時に検証し直す
    await markRebuildRequestFailed({
      repositoryFullName: input.repositoryFullName,
      originPrNumber: selection.origin.pr,
      originHeadSha: selection.origin.headSha,
      reason: errorExcerpt,
    });
  }
  const data = {
    runUrl,
    event: input.event?.slice(0, 32) ?? null,
    bumpKind: input.bumpKind && isBumpKind(input.bumpKind) ? input.bumpKind : null,
    jobName: jobName?.slice(0, 255) ?? null,
    stepName: stepName?.slice(0, 255) ?? null,
    errorExcerpt,
    rebuildSelection: selection ? serializeRebuildSelection(selection) : null,
    status: "open",
    resolvedAt: null,
    resolvedRunUrl: null,
  };
  const row = await db.releasePreparationFailure.upsert({
    where: { repositoryFullName_runId: { repositoryFullName: input.repositoryFullName, runId: String(input.runId) } },
    create: { repositoryFullName: input.repositoryFullName, runId: String(input.runId), ...data },
    update: data,
  });
  return { ok: true, recorded: row.id };
}

/**
 * リリース準備が進んだ（バンプPRかリリースPRを作れた）runの報告。未解決の失敗を解決にし、
 * 旧`notify-failure`が付けたと確認できる確認待ちラベルだけを外す。
 */
export async function resolveReleasePreparation(input: {
  repositoryFullName: string;
  runId: number;
}): Promise<ReleasePreparationReportResult> {
  const context = await resolveRepository(input.repositoryFullName);
  if (!context) return { ok: false, reason: "unknown_repository" };
  const { owner, repo, token } = context;

  const run = await fetchWorkflowRun(owner, repo, input.runId, token);
  if (!RELEASE_WORKFLOW_PATH.test(run.path ?? "")) return { ok: false, reason: "not_release_run" };
  // 報告は`release`ジョブが成功した後の別ジョブから届くので、run全体はまだ完了していないことがある。
  // `release`ジョブ自体の成功をジョブ一覧で確かめる
  const jobs = await fetchWorkflowRunJobs(owner, repo, input.runId, token);
  const releaseJob = jobs.find((job) => job.name === "release" || (job.name ?? "").endsWith("/ release"));
  if (!releaseJob || releaseJob.conclusion !== "success") return { ok: false, reason: "run_not_concluded" };

  const clearedIssues = await clearReleaseFailureLabels(owner, repo, input.repositoryFullName, token);
  const runUrl = run.html_url ?? null;
  const { count } = await db.releasePreparationFailure.updateMany({
    where: { repositoryFullName: input.repositoryFullName, status: "open" },
    data: { status: "resolved", resolvedAt: new Date(), resolvedRunUrl: runUrl, clearedIssues },
  });
  return { ok: true, resolved: count, clearedIssues };
}

type GithubIssueEvent = {
  event?: string;
  label?: { name?: string } | null;
  actor?: { login?: string } | null;
  created_at?: string;
};

async function clearReleaseFailureLabels(
  owner: string,
  repo: string,
  repositoryFullName: string,
  token: string,
): Promise<number[]> {
  const listed = await queryIssuesByProgressStatus({ repositoryFullName, statuses: ["develop", "release"] }).catch(
    (error) => {
      console.error(`[release-preparation] 対象Issueを取得できませんでした（${repositoryFullName}）`, error);
      return null;
    },
  );
  if (!listed?.available) return [];

  const cleared: number[] = [];
  for (const number of listed.issues) {
    try {
      const labels = await fetchIssueLabelNames(owner, repo, number, token);
      if (!labels.includes(CHECK_USER)) continue;
      const [rawEvents, rawComments] = await Promise.all([
        fetchAllPages<GithubIssueEvent>(`${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/events?per_page=100`, token),
        fetchCommentsForIssue(owner, repo, number, token),
      ]);
      const events: IssueLabelEvent[] = rawEvents.map((event) => ({
        event: event.event ?? "",
        label: event.label?.name ?? null,
        actorLogin: event.actor?.login ?? null,
        createdAt: event.created_at ?? "",
      }));
      const comments = rawComments.map((comment) => ({
        body: comment.body ?? "",
        authorLogin: comment.user?.login ?? null,
        createdAt: comment.created_at,
      }));
      const removable = releaseFailureDerivedLabels({ labels, events, comments });
      if (removable.length === 0) continue;
      for (const label of removable) await removeIssueLabel(owner, repo, number, token, label);
      cleared.push(number);
    } catch (error) {
      // 1件の失敗で他のIssueの整理を止めない。外せなかったものは付いたまま（安全側）
      console.error(`[release-preparation] 確認待ちラベルを整理できませんでした（${repositoryFullName}#${number}）`, error);
    }
  }
  return cleared;
}

/** 画面に出す未解決の失敗（新しい順の先頭1件） */
export async function findOpenReleasePreparationFailure(
  repositoryFullName: string,
): Promise<ReleasePreparationFailureView | null> {
  const row = await db.releasePreparationFailure.findFirst({
    where: { repositoryFullName, status: "open" },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  return {
    id: row.id,
    runUrl: row.runUrl,
    event: row.event,
    bumpKind: row.bumpKind,
    jobName: row.jobName,
    stepName: row.stepName,
    errorExcerpt: row.errorExcerpt,
    rebuildSelection: parseRebuildSelection(row.rebuildSelection),
    createdAt: row.createdAt.toISOString(),
  };
}
