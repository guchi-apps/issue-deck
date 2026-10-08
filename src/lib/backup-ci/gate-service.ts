import type { CiGateState } from "@prisma/client";

import {
  type ActionsWorkflowRunInput,
  type ActionsWorkflowRunSummary,
  CI_WORKFLOW_PATH,
  type CiGateCandidate,
  backupRunCandidate,
  chooseCiGateCandidate,
  ciGatePublishKey,
  evaluateActionsRun,
  selectCiWorkflowRun,
} from "@/lib/backup-ci/gate";
import {
  BACKUP_CI_BASE_REFS,
  type PullRequestTarget,
  fetchDefinitionAt,
  fetchPullRequestTarget,
  installationTokenFor,
  isBackupCiBaseRef,
  listOpenPullRequestTargets,
  publishCiGate,
} from "@/lib/backup-ci/github";
import { db } from "@/lib/db";
import { fetchWorkflowRunJobs } from "@/lib/github/actions-api";
import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

/**
 * 共通チェック`issue-deck/ci-gate`の発行（#4113）。設計は docs/backup-ci.md「5. 必須チェックの移行」。
 *
 * - 通常時はGitHub Actions（ci.yml）の必須ジョブの結果を、バックアップCIを起動したPRではその結果を、
 *   **最後に始まった試行の方**から決めて発行する（`chooseCiGateCandidate`）
 * - どちらの経路を採用したかは`CiGateState`に残す。発行は経路・状態・baseが変わったときだけ
 * - Actionsの結果は、pollerの巡回（`sweepCiGateMirror`）と、GitHub Appが`workflow_run`を
 *   購読していればそのWebhookで取り込む。**Actions側の判定ジョブには依存しない**
 */

const STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** 合否が決まったPRを照合し直す間隔（再実行・baseの更新を拾う） */
const TERMINAL_RECHECK_MS = 3 * 60 * 1000;
const SWEEP_MAX_PULLS = 20;

export type CiGateSyncResult = {
  source: CiGateCandidate["source"];
  state: string;
  keptPrevious: boolean;
  published: string | null;
} | null;

/** 通常時もActionsの結果を写すリポジトリか */
export async function isActionsMirrored(repositoryFullName: string): Promise<boolean> {
  const setting = await db.backupCiSetting.findUnique({ where: { repositoryFullName } });
  return setting?.mirrorActionsToCiGate ?? false;
}

/**
 * PR1件の共通チェックを、両方の経路の最新の試行から決め直して発行する。
 * バックアップCIの起動・回収、Actionsの巡回・Webhookのすべてがここを通る。
 */
export async function syncPullRequestCiGate(input: {
  repositoryFullName: string;
  prNumber: number;
  pr: PullRequestTarget;
  token: string;
  now?: Date;
}): Promise<CiGateSyncResult> {
  const { repositoryFullName, prNumber, pr, token } = input;
  const now = input.now ?? new Date();
  const current = { headSha: pr.headSha, baseSha: pr.baseSha };
  const mirrored = isBackupCiBaseRef(pr.baseRef) && (await isActionsMirrored(repositoryFullName));

  const latestBackup = await db.backupCiRun.findFirst({
    where: { repositoryFullName, prNumber },
    orderBy: { attempt: "desc" },
  });
  const backup = backupRunCandidate(latestBackup, current, { actionsMirrored: mirrored });
  const actions = mirrored ? await evaluateActionsForPullRequest(repositoryFullName, prNumber, pr, token) : null;

  const previous = await db.ciGateState.findUnique({
    where: { repositoryFullName_prNumber: { repositoryFullName, prNumber } },
  });
  const choice = chooseCiGateCandidate([actions, backup], previous, current);
  if (!choice) return null;
  const { candidate } = choice;
  if (choice.keptPrevious && previous) {
    await db.ciGateState.update({ where: { id: previous.id }, data: { lastEvaluatedAt: now } });
    return { source: candidate.source, state: previous.state, keptPrevious: true, published: null };
  }

  const key = ciGatePublishKey(candidate.source, candidate.decision.state, pr.baseSha);
  const alreadyPublished = previous?.headSha === pr.headSha && previous.publishedState === key;
  let published: string | null = null;
  if (!alreadyPublished) {
    published = await publishCiGate(repositoryFullName, pr.headSha, candidate.decision, candidate.targetUrl, token);
  }
  const publishedState = alreadyPublished
    ? key
    : published === candidate.decision.state
      ? key
      : published;
  const data = {
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    source: candidate.source,
    sourceRef: candidate.sourceRef,
    sourceStartedAt: candidate.startedAt,
    state: candidate.decision.state,
    description: candidate.decision.description,
    targetUrl: candidate.targetUrl,
    publishedState,
    lastEvaluatedAt: now,
  };
  await db.ciGateState.upsert({
    where: { repositoryFullName_prNumber: { repositoryFullName, prNumber } },
    create: { repositoryFullName, prNumber, ...data },
    update: data,
  });
  // バックアップCIの欄は、その実行から共通チェックへ出した状態を表示している
  if (candidate.source === "backup" && latestBackup && !alreadyPublished) {
    await db.backupCiRun.update({
      where: { id: latestBackup.id },
      data: { gateState: published === candidate.decision.state ? `${published}:${pr.baseSha}` : published },
    });
  }
  return { source: candidate.source, state: candidate.decision.state, keptPrevious: false, published };
}

// ---------------------------------------------------------------------------
// GitHub Actions

/** baseのSHAごとの必須グループ。定義はコミットに対して不変なので、プロセス内で覚えておく */
const groupsByBaseSha = new Map<string, string[]>();

async function requiredGroupsAt(repositoryFullName: string, baseSha: string, token: string): Promise<string[]> {
  const cacheKey = `${repositoryFullName}@${baseSha}`;
  const cached = groupsByBaseSha.get(cacheKey);
  if (cached) return cached;
  const definition = await fetchDefinitionAt(repositoryFullName, baseSha, token);
  const groups = [...new Set(definition.checks.map((check) => check.group))];
  if (groupsByBaseSha.size >= 200) groupsByBaseSha.clear();
  groupsByBaseSha.set(cacheKey, groups);
  return groups;
}

type GithubWorkflowRun = {
  id: number;
  path?: string;
  event?: string;
  head_sha?: string;
  head_branch?: string | null;
  status?: string;
  run_attempt?: number;
  run_started_at?: string | null;
  created_at?: string;
  html_url?: string;
  pull_requests?: { number: number }[];
};

/** PRの現在のheadに対するActions（ci.yml）の必須ジョブの合否 */
export async function evaluateActionsForPullRequest(
  repositoryFullName: string,
  prNumber: number,
  pr: PullRequestTarget,
  token: string,
): Promise<CiGateCandidate> {
  const groups = await requiredGroupsAt(repositoryFullName, pr.baseSha, token);
  const url = `${GITHUB_API}/repos/${repositoryFullName}/actions/runs?head_sha=${pr.headSha}&event=pull_request&per_page=50`;
  const res = await githubFetch(url, token);
  if (!res.ok) throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url}`);
  const { workflow_runs: runs = [] } = (await res.json()) as { workflow_runs?: GithubWorkflowRun[] };
  const summaries: ActionsWorkflowRunSummary[] = runs.map((run) => ({
    id: run.id,
    path: run.path ?? "",
    event: run.event ?? "",
    headSha: run.head_sha ?? "",
    headBranch: run.head_branch ?? null,
    pullRequestNumbers: (run.pull_requests ?? []).map((p) => p.number),
  }));
  const selected = selectCiWorkflowRun(summaries, { number: prNumber, headSha: pr.headSha, headRef: pr.headRef });
  if (!selected) return evaluateActionsRun(null, groups);
  const raw = runs.find((run) => run.id === selected.id)!;
  const [owner, repo] = repositoryFullName.split("/");
  const jobs = await fetchWorkflowRunJobs(owner, repo, selected.id, token);
  const input: ActionsWorkflowRunInput = {
    id: selected.id,
    runAttempt: raw.run_attempt ?? 1,
    status: raw.status ?? "",
    startedAt: raw.run_started_at ?? raw.created_at ?? null,
    htmlUrl: raw.html_url ?? null,
    jobs: jobs.map((job) => ({ name: job.name ?? "", status: job.status, conclusion: job.conclusion })),
  };
  return evaluateActionsRun(input, groups);
}

// ---------------------------------------------------------------------------
// 巡回・Webhook

let sweepInFlight = false;

/**
 * pollerの巡回で呼ぶ。通常時もActionsの結果を写すリポジトリの、develop向けのopenなPRすべてについて
 * 共通チェックを決め直す。合否が決まったPRは数分おきにだけ照合する（GitHub APIを無駄に使わない）。
 */
export async function sweepCiGateMirror(now = new Date()): Promise<{ checked: number; errors: number }> {
  if (sweepInFlight) return { checked: 0, errors: 0 };
  sweepInFlight = true;
  try {
    return await sweepOnce(now);
  } finally {
    sweepInFlight = false;
  }
}

async function sweepOnce(now: Date): Promise<{ checked: number; errors: number }> {
  const settings = await db.backupCiSetting.findMany({ where: { mirrorActionsToCiGate: true } });
  let checked = 0;
  let errors = 0;
  for (const setting of settings) {
    const repositoryFullName = setting.repositoryFullName;
    try {
      const token = await installationTokenFor(repositoryFullName);
      for (const baseRef of BACKUP_CI_BASE_REFS) {
        const pulls = await listOpenPullRequestTargets(repositoryFullName, baseRef, token);
        const states = await db.ciGateState.findMany({
          where: { repositoryFullName, prNumber: { in: pulls.map((p) => p.number) } },
        });
        const due = pulls.filter((pr) => needsSync(states.find((s) => s.prNumber === pr.number) ?? null, pr, now));
        for (const pr of due) {
          if (checked >= SWEEP_MAX_PULLS) break;
          checked += 1;
          try {
            await syncPullRequestCiGate({ repositoryFullName, prNumber: pr.number, pr, token, now });
          } catch (error) {
            errors += 1;
            console.error(`[ci-gate] 共通チェックの照合に失敗しました ${repositoryFullName}#${pr.number}:`, error);
          }
        }
      }
    } catch (error) {
      errors += 1;
      console.error(`[ci-gate] ${repositoryFullName} のPR一覧を取得できませんでした:`, error);
    }
  }
  await db.ciGateState
    .deleteMany({ where: { lastEvaluatedAt: { lt: new Date(now.getTime() - STATE_RETENTION_MS) } } })
    .catch(() => undefined);
  return { checked, errors };
}

export function needsSync(
  state: Pick<CiGateState, "headSha" | "baseSha" | "state" | "publishedState" | "lastEvaluatedAt"> | null,
  pr: { headSha: string; baseSha: string },
  now: Date,
): boolean {
  if (!state || state.headSha !== pr.headSha || state.baseSha !== pr.baseSha) return true;
  // 発行に失敗したもの・検査中のものは毎回照合する
  if (state.state === "pending" || !state.publishedState || state.publishedState.startsWith("publish_failed")) return true;
  return now.getTime() - state.lastEvaluatedAt.getTime() >= TERMINAL_RECHECK_MS;
}

/**
 * GitHubの`workflow_run`イベント（GitHub Appが購読している場合）。ci.ymlの実行が動いたPRの共通チェックを
 * すぐ決め直す。**本文の結論は使わず**、APIで読み直す（巡回と同じ判定を通す）。
 */
export async function handleWorkflowRunEventForCiGate(payload: unknown): Promise<number> {
  if (!isRecord(payload) || !isRecord(payload.workflow_run) || !isRecord(payload.repository)) return 0;
  const run = payload.workflow_run;
  const repositoryFullName = payload.repository.full_name;
  if (typeof repositoryFullName !== "string" || run.path !== CI_WORKFLOW_PATH || run.event !== "pull_request") return 0;
  const numbers = (Array.isArray(run.pull_requests) ? run.pull_requests : [])
    .filter(isRecord)
    .filter((p) => isRecord(p.base) && typeof p.base.ref === "string" && isBackupCiBaseRef(p.base.ref))
    .map((p) => p.number)
    .filter((n): n is number => typeof n === "number");
  if (numbers.length === 0 || !(await isActionsMirrored(repositoryFullName))) return 0;
  const token = await installationTokenFor(repositoryFullName);
  let synced = 0;
  for (const prNumber of numbers) {
    const pr = await fetchPullRequestTarget(repositoryFullName, prNumber, token);
    if (pr.state !== "open") continue;
    await syncPullRequestCiGate({ repositoryFullName, prNumber, pr, token });
    synced += 1;
  }
  return synced;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
