import { loadReleaseCandidateFixes } from "@/lib/release-candidate-fix";
import { db } from "@/lib/db";
import {
  DISPATCH_HEARTBEAT_TIMEOUT_MS,
  isDispatchHostOnline,
  parseDispatchHostRepositories,
} from "@/lib/dispatch/dispatch-job";
import { compareBranches } from "@/lib/github/branches-api";
import type { ReleaseVerificationKind } from "@/lib/release-merge-gate";
import { describeReleaseReviewAssignee, resolveReleaseReviewAssignee } from "@/lib/release-review-assignee";
import { listReleaseMacRows } from "@/lib/release-mac-verification";
import { loadReleaseReviewDecisionSummary } from "@/lib/release-review-decision-store";
import {
  POLLER_REPOSITORY,
  findOpsRequest,
  opsRequestTexts,
  type ReleaseOpsContext,
  type ReleaseOpsHostFact,
} from "@/lib/release-review-ops-evidence";
import { applyReviewDecisionsToStage } from "@/lib/release-review-reevaluation";
import { reviewFindingId, reviewFindingIdAliases, type ReleaseReviewFinding } from "@/lib/release-review-result";
import { listReleaseVerificationDetails } from "@/lib/release-verification";
import { getReleaseVerificationConfig } from "@/lib/release-verification-config";
import {
  buildReleaseVerificationProgress,
  type ReleaseVerificationProgress,
} from "@/lib/release-verification-progress";
import {
  summarizeReleaseVerification,
  type ReleaseVerificationSummary,
} from "@/lib/release-verification-summary";

/**
 * リリースPRの統合検証・全体AIレビューの要約を、DBの記録から組み立てる（#4238）。
 * `GET /api/repositories/release`（スマホのシート）と`GET /api/repositories/release/verification`
 * （PCのPR詳細）が共有する。対象のSHAは呼び出し側がGitHubから取った現在値を渡す。
 */
export async function loadReleaseVerificationSummary(
  repoFullName: string,
  prNumber: number,
  current: { baseSha: string; headSha: string },
  /** GitHubのトークン。渡されたときだけ、運用状態の照合（候補の変更ファイル・稼働コミット）を行う（#4665） */
  options: { token?: string } = {},
): Promise<ReleaseVerificationSummary> {
  const setting = await db.appSetting.findUnique({
    where: { id: 1 },
    select: { appAiModelReasoning: true, aiExecutionProvider: true },
  });
  const summary = summarizeReleaseVerification({
    current,
    rows: await listReleaseVerificationDetails(repoFullName, prNumber),
    macRows: await listReleaseMacRows(repoFullName, prNumber),
    macConfigured: getReleaseVerificationConfig(repoFullName).macBuildCheck === true,
    enforced: getReleaseVerificationConfig(repoFullName).enforced,
    aiReviewAssignee: describeReleaseReviewAssignee(resolveReleaseReviewAssignee(setting)),
    progress: await loadReleaseVerificationProgress(repoFullName, prNumber, current),
  });
  const decided = await attachReleaseReviewDecisions(repoFullName, prNumber, current, summary);
  const withOps = await attachReleaseOpsContext(repoFullName, current, decided, options.token);
  // 修正系列の進み具合（#4972）。読めなくても検証の要約そのものは返す
  const fix = await loadReleaseCandidateFixes([{ repositoryFullName: repoFullName, number: prNumber }])
    .then((map) => map.get(`${repoFullName}#${prNumber}`) ?? null)
    .catch(() => null);
  return { ...withOps, fix };
}

/**
 * 全体レビューがpollerの更新・再起動を**要求したときだけ**、照合に使う稼働情報を添える（#4665）。
 * 要求が無ければ何も読まない（GitHub APIを5秒ごとのポーリングで叩かない）。読めなかった事実は`null`のまま渡し、
 * 画面側で「確認できない」にする
 */
async function attachReleaseOpsContext(
  repoFullName: string,
  current: { baseSha: string; headSha: string },
  summary: ReleaseVerificationSummary,
  token: string | undefined,
): Promise<ReleaseVerificationSummary> {
  const aiReview = summary.aiReview;
  if (aiReview.state !== "needs_check" || !findOpsRequest(opsRequestTexts(aiReview))) return summary;
  let opsContext: ReleaseOpsContext | null = null;
  try {
    opsContext = await loadReleaseOpsContext(repoFullName, current, token);
  } catch (error) {
    console.error(`[release-verification] 運用状態を読めませんでした ${repoFullName}:`, error);
  }
  return { ...summary, aiReview: { ...aiReview, opsContext } };
}

/** compareは最大300ファイルまでしか返さない。上限に達したら一覧は不完全なので使わない */
const COMPARE_FILE_LIMIT = 300;

async function loadReleaseOpsContext(
  repoFullName: string,
  current: { baseSha: string; headSha: string },
  token: string | undefined,
  now = new Date(),
): Promise<ReleaseOpsContext> {
  const rows = await db.dispatchHost.findMany({
    select: {
      name: true,
      lastSeenAt: true,
      repositories: true,
      checkoutCommit: true,
      checkoutStartedCommit: true,
      releaseVerifyCapable: true,
      releaseReviewCapable: true,
    },
  });
  const declared = rows.filter((row) => parseDispatchHostRepositories(row.repositories).includes(repoFullName));
  const updates = declared.length
    ? await db.dispatchJob.findMany({
        where: { kind: "SELF_UPDATE", status: "SUCCEEDED", targetHost: { in: declared.map((row) => row.name) } },
        orderBy: { finishedAt: "desc" },
        select: { targetHost: true, finishedAt: true },
      })
    : [];
  const lastUpdate = new Map<string, string>();
  for (const job of updates) {
    if (job.finishedAt && !lastUpdate.has(job.targetHost)) lastUpdate.set(job.targetHost, job.finishedAt.toISOString());
  }

  const [owner, repo] = repoFullName.split("/");
  const isPollerRepo = repoFullName === POLLER_REPOSITORY;
  let changedFiles: string[] | null = null;
  if (isPollerRepo && token) {
    const compare = await compareBranches(owner, repo, current.baseSha, current.headSha, token);
    if (compare?.files && compare.files.length < COMPARE_FILE_LIMIT) changedFiles = compare.files.map((file) => file.filename);
  }

  const hosts: ReleaseOpsHostFact[] = [];
  for (const row of declared) {
    const online = isDispatchHostOnline(row.lastSeenAt, now);
    let includesCandidate: boolean | null = null;
    // 起動時コミット（いま走っているコード）が候補headを含むか。headから見て進んでいるか同じなら含む
    if (isPollerRepo && token && online && row.checkoutStartedCommit) {
      const compare = await compareBranches(owner, repo, current.headSha, row.checkoutStartedCommit, token);
      if (compare) includesCandidate = compare.behindBy === 0;
    }
    hosts.push({
      name: row.name,
      online,
      startedCommit: row.checkoutStartedCommit,
      commit: row.checkoutCommit,
      releaseVerifyCapable: row.releaseVerifyCapable === true,
      releaseReviewCapable: row.releaseReviewCapable === true,
      lastSelfUpdateAt: lastUpdate.get(row.name) ?? null,
      includesCandidate,
    });
  }
  return { repositoryFullName: repoFullName, changedFiles, hosts };
}

/**
 * 全体レビューの指摘に、ユーザーの判断（#4657）を添える。旧形式の指摘にはIDが無いので、判断・修正系列と
 * 同じ導出（`reviewFindingId`）で補う。判断はAIの`state`・`findings`を書き換えない
 */
export async function attachReleaseReviewDecisions(
  repoFullName: string,
  prNumber: number,
  current: { baseSha: string; headSha: string },
  summary: ReleaseVerificationSummary,
): Promise<ReleaseVerificationSummary> {
  const withId = (f: ReleaseReviewFinding): ReleaseReviewFinding => (f.id ? f : { ...f, id: reviewFindingId(f) });
  const aiReview = { ...summary.aiReview, findings: summary.aiReview.findings.map(withId), suggestions: summary.aiReview.suggestions.map(withId) };
  const target = (blocking: boolean) => (f: ReleaseReviewFinding) => ({
    id: f.id as string,
    title: f.title,
    severity: f.severity,
    blocking,
    premiseChanged: f.premiseChanged ?? null,
    file: f.file,
    // 保存済みの結果・判断に残る旧ID（題・ファイル・行の導出）でも同じ指摘として読む（#4766）
    aliasIds: reviewFindingIdAliases(f).filter((id) => id !== f.id),
  });
  if (aiReview.state === "needs_check" || aiReview.state === "passed") {
    aiReview.decisions = await loadReleaseReviewDecisionSummary({
      repoFullName,
      prNumber,
      current,
      findings: aiReview.findings.map(target(true)),
      suggestions: aiReview.suggestions.map(target(false)),
      state: aiReview.state,
      unverifiedScope: aiReview.unverifiedScope ?? null,
    });
    // 止める指摘がすべて非修正の判断済みなら、段階にも反映する（#4814。合否は変えない）
    aiReview.stage = applyReviewDecisionsToStage(aiReview.stage, aiReview.decisions);
  }
  return { ...summary, aiReview };
}

const JOB_KIND_TO_SECTION = { RELEASE_VERIFY: "integration", RELEASE_REVIEW: "ai_review" } as const;

/**
 * 区分ごとに、**現在の対象（base・head）の**最新ジョブから進捗を作る（#4277）。
 * 対象の違うジョブ（作り直す前のSHA）は見ない——古い実行の工程や成功を現在の進捗に見せない。
 * 実行先の生死は`DispatchHost.lastSeenAt`で読み、ホストの記録が無ければ「未取得」にする。
 */
export async function loadReleaseVerificationProgress(
  repoFullName: string,
  prNumber: number,
  current: { baseSha: string; headSha: string },
  now = new Date(),
): Promise<Partial<Record<ReleaseVerificationKind, ReleaseVerificationProgress | null>>> {
  const jobs = await db.dispatchJob.findMany({
    where: {
      repositoryFullName: repoFullName,
      prNumber,
      baseSha: current.baseSha,
      headSha: current.headSha,
      kind: { in: ["RELEASE_VERIFY", "RELEASE_REVIEW"] },
    },
    orderBy: { createdAt: "desc" },
    select: {
      kind: true,
      status: true,
      targetHost: true,
      claimedByHost: true,
      createdAt: true,
      claimedAt: true,
      startedAt: true,
      heartbeatAt: true,
      finishedAt: true,
      message: true,
      progress: true,
      agent: true,
      claudeModel: true,
      codexModel: true,
    },
  });
  const latest = new Map<ReleaseVerificationKind, (typeof jobs)[number]>();
  for (const job of jobs) {
    const kind = JOB_KIND_TO_SECTION[job.kind as keyof typeof JOB_KIND_TO_SECTION];
    if (kind && !latest.has(kind)) latest.set(kind, job);
  }
  const hostNames = [...new Set([...latest.values()].map((job) => job.claimedByHost ?? job.targetHost))];
  const hosts = hostNames.length
    ? await db.dispatchHost.findMany({ where: { name: { in: hostNames } }, select: { name: true, lastSeenAt: true } })
    : [];
  const online = new Map(hosts.map((host) => [host.name, isDispatchHostOnline(host.lastSeenAt, now)]));

  const result: Partial<Record<ReleaseVerificationKind, ReleaseVerificationProgress | null>> = {};
  for (const [kind, job] of latest) {
    result[kind] = buildReleaseVerificationProgress({
      kind,
      job,
      hostOnline: online.get(job.claimedByHost ?? job.targetHost) ?? null,
      stalledAfterMs: DISPATCH_HEARTBEAT_TIMEOUT_MS,
    });
  }
  return result;
}
