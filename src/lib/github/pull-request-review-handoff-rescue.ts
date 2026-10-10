import { db } from "@/lib/db";
import { fetchAllComments, selectReviewFixComments, trustedComment, type Comment } from "@/lib/dispatch/review-fix-jobs";
import { getInstallationToken } from "@/lib/github/app-auth";
import { startPullRequestAutoRepairLoop } from "@/lib/github/pull-request-auto-repair-start";
import { AUTO_REPAIR_MAX_ROUNDS } from "@/lib/github/pull-request-repair-loop";
import { supportsRepairKind, type RepairWorkflowState } from "@/lib/github/pull-request-repair";
import { fetchOpenPullRequests } from "@/lib/github/pull-requests-api";
import { parsePullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import { fetchRepairWorkflowAvailability } from "@/lib/github/repair-workflow-cache";

/**
 * レビュー要修正の自動修正（handoff）の取りこぼしを巡回で拾い直す（#4334）。
 *
 * handoffは`reusable-claude-review-develop.yml`が対応Issueへ`issue-deck-review-fix:handoff`の
 * コメントを残し、`claude-review-fix.yml`が`workflow_run`イベントで起動する作り。このイベントが
 * 届かない（未配送・遅延）と、**「自動修正へ渡しました」と言ったまま誰も修正を始めない**PRが残る。
 * 1回目の起動は系列（`PullRequestAutoRepairLoop`）も作らないため、既存の巡回も拾えない。
 *
 * ここではその状態を巡回で検出し、手動開始と同じ`startPullRequestAutoRepairLoop`で系列を始める。
 * 二重起動は、系列が動いている・修正ジョブや修復の記録がある・同じHEADで一度止まっている、の
 * いずれかなら見送ることで避ける（開始側も`running`/`dispatching`の系列には起動しない）。
 */

/** handoffコメントから、まだ修正が始まっていないと見なすまでの猶予。workflow_runの遅延を許す */
export const HANDOFF_RESCUE_GRACE_MS = 10 * 60 * 1000;
/** 巡回の間隔。pollerは30秒ごとに呼ぶが、PR一覧の取得をこの間隔に抑える */
export const HANDOFF_RESCUE_INTERVAL_MS = 3 * 60 * 1000;

/** 拾い直しを起動できなかったときに系列へ残す停止理由（画面が原因と次の操作を出す） */
export const HANDOFF_RESCUE_STOP_REASONS = ["handoff_workflow_missing", "handoff_unsupported"] as const;
export type HandoffRescueStopReason = (typeof HANDOFF_RESCUE_STOP_REASONS)[number];

export type HandoffRescueInput = {
  now: Date;
  pullRequest: { state: string; draft: boolean; baseRef: string; headRef: string; headSha: string };
  /** PR本文の検証結果から読んだ、判定とその時点のHEAD */
  verdict: { reviewKind: string; reviewedSha: string | null } | null;
  /** 現在のHEADに対する、人の判断が要らない要修正の判定が揃っているか（`selectReviewFixComments`） */
  autofixOk: boolean;
  /** 現在のHEADに対するhandoffコメントの投稿時刻。無ければnull */
  handoffAt: Date | null;
  loop: { status: string; headSha: string } | null;
  /** 同じHEADのREVIEW_FIXジョブ（Codex経路）が既にある */
  fixJobExists: boolean;
  /** handoff以降に始まった`review`の修復記録（Claude経路）がある */
  repairStartedAfterHandoff: boolean;
  /** 起動先workflowの有無。判定できなかったときはundefined（起動を試みる） */
  workflow: "available" | RepairWorkflowState | undefined;
};

export type HandoffRescueDecision =
  | { action: "skip"; reason: string }
  | { action: "start" }
  | { action: "stop"; reason: HandoffRescueStopReason };

export function decideHandoffRescue(input: HandoffRescueInput): HandoffRescueDecision {
  const { pullRequest: pr } = input;
  if (pr.state !== "open" || pr.draft) return { action: "skip", reason: "not_open" };
  if (pr.baseRef !== "develop" || !/^issue-\d+$/.test(pr.headRef)) return { action: "skip", reason: "unsupported_pull_request" };
  if (input.verdict?.reviewKind !== "changes-requested" || input.verdict.reviewedSha !== pr.headSha) {
    return { action: "skip", reason: "no_current_changes_requested" };
  }
  if (!input.autofixOk || input.handoffAt === null) return { action: "skip", reason: "no_handoff" };
  if (input.now.getTime() - input.handoffAt.getTime() < HANDOFF_RESCUE_GRACE_MS) return { action: "skip", reason: "within_grace" };
  if (input.loop?.status === "running" || input.loop?.status === "dispatching") return { action: "skip", reason: "loop_active" };
  // 同じHEADで止まった・終わった系列は、その表示を正とする（止めた理由を上書きして再起動しない）。
  if (input.loop && input.loop.headSha === pr.headSha) return { action: "skip", reason: "loop_settled" };
  if (input.fixJobExists || input.repairStartedAfterHandoff) return { action: "skip", reason: "fix_started" };
  if (input.workflow === "unsupported") return { action: "stop", reason: "handoff_unsupported" };
  if (input.workflow === "missing") return { action: "stop", reason: "handoff_workflow_missing" };
  return { action: "start" };
}

/** 現在のHEADのhandoffコメントのうち、信頼できるものの最新の投稿時刻 */
export function findHandoffAt(issueComments: Comment[], headSha: string): Date | null {
  const marker = `<!-- issue-deck-review-fix:handoff sha=${headSha} -->`;
  const times = issueComments
    .filter((comment) => trustedComment(comment) && comment.body.includes(marker))
    .map((comment) => new Date(comment.created_at).getTime());
  return times.length === 0 ? null : new Date(Math.max(...times));
}

export type HandoffRescueResult = {
  swept: boolean;
  started: { repositoryFullName: string; pullRequestNumber: number }[];
  stopped: { repositoryFullName: string; pullRequestNumber: number; reason: HandoffRescueStopReason }[];
};

let lastSweptAt: number | null = null;

/** テスト用。プロセスをまたがないので本番では呼ばない */
export function resetHandoffRescueIntervalForTest(): void {
  lastSweptAt = null;
}

export async function runReviewHandoffRescueSweep(options: { force?: boolean; now?: Date } = {}): Promise<HandoffRescueResult> {
  const now = options.now ?? new Date();
  const result: HandoffRescueResult = { swept: false, started: [], stopped: [] };
  if (!options.force && lastSweptAt !== null && now.getTime() - lastSweptAt < HANDOFF_RESCUE_INTERVAL_MS) return result;
  lastSweptAt = now.getTime();
  result.swept = true;

  const repositories = await db.repository.findMany({ where: { archived: false }, orderBy: { fullName: "asc" }, include: { installation: true } });
  for (const repository of repositories) {
    try {
      const token = await getInstallationToken(repository.installation.installationId);
      const pullRequests = await fetchOpenPullRequests(repository.ownerLogin, repository.name, token);
      for (const pullRequest of pullRequests) {
        // コメントを引く前に、本文の判定だけで絞る（GitHub APIの消費を要修正のPRに限る）。
        const verdict = parsePullRequestReviewVerdict(pullRequest.body);
        if (verdict?.reviewKind !== "changes-requested" || verdict.reviewedSha !== pullRequest.head.sha) continue;
        const issueNumber = /^issue-(\d+)$/.exec(pullRequest.head.ref)?.[1];
        if (!issueNumber || pullRequest.base.ref !== "develop" || pullRequest.draft) continue;
        const target = { repositoryFullName: repository.fullName, pullRequestNumber: pullRequest.number };
        try {
          const [reviews, issueComments, loop, fixJob, reviewRun] = await Promise.all([
            fetchAllComments(repository.fullName, pullRequest.number, token),
            fetchAllComments(repository.fullName, Number(issueNumber), token),
            db.pullRequestAutoRepairLoop.findUnique({
              where: { repositoryFullName_pullRequestNumber: target },
              select: { status: true, headSha: true },
            }),
            db.dispatchJob.findFirst({
              where: { kind: "REVIEW_FIX", repositoryFullName: repository.fullName, issueNumber: Number(issueNumber), headSha: pullRequest.head.sha },
              select: { id: true },
            }),
            db.pullRequestRepairRun.findUnique({
              where: { repositoryFullName_pullRequestNumber_kind: { ...target, kind: "review" } },
              select: { startedAt: true },
            }),
          ]);
          const handoffAt = findHandoffAt(issueComments, pullRequest.head.sha);
          const repairTarget = { number: pullRequest.number, baseRef: pullRequest.base.ref, headRef: pullRequest.head.ref };
          const preliminary = {
            now,
            pullRequest: { state: pullRequest.state, draft: pullRequest.draft, baseRef: pullRequest.base.ref, headRef: pullRequest.head.ref, headSha: pullRequest.head.sha },
            verdict,
            autofixOk: selectReviewFixComments(reviews, pullRequest.head.sha, false) !== null,
            handoffAt,
            loop,
            fixJobExists: fixJob !== null,
            repairStartedAfterHandoff: handoffAt !== null && reviewRun !== null && reviewRun.startedAt.getTime() >= handoffAt.getTime() - 60_000,
          };
          // workflowの有無は、拾い直す候補が残ったときだけ確かめる。
          let workflow: HandoffRescueInput["workflow"];
          if (decideHandoffRescue({ ...preliminary, workflow: "available" }).action === "start") {
            workflow = supportsRepairKind(repairTarget, "review")
              ? (await fetchRepairWorkflowAvailability(repository.ownerLogin, repository.name, repairTarget, ["review"], token)).review
              : "unsupported";
          }
          const decision = decideHandoffRescue({ ...preliminary, workflow });
          if (decision.action === "start") {
            const started = await startPullRequestAutoRepairLoop({
              owner: repository.ownerLogin,
              repo: repository.name,
              token,
              pullRequest: { number: pullRequest.number, headSha: pullRequest.head.sha, baseRef: pullRequest.base.ref, headRef: pullRequest.head.ref },
              kind: "review",
            });
            if (started.ok) result.started.push(target);
          } else if (decision.action === "stop") {
            await recordRescueStopped(target, pullRequest.head.sha, decision.reason);
            result.stopped.push({ ...target, reason: decision.reason });
          }
        } catch (error) {
          // 起動失敗は`startPullRequestAutoRepairLoop`が`dispatch_failed`で系列へ残している。
          console.error(`[review-handoff-rescue] ${target.repositoryFullName}#${target.pullRequestNumber}:`, error);
        }
      }
    } catch (error) {
      console.error(`[review-handoff-rescue] ${repository.fullName} のPR取得:`, error);
    }
  }
  return result;
}

/** 起動できない原因を系列の停止理由として残す。同じHEADでは次の巡回から見送られる */
async function recordRescueStopped(
  target: { repositoryFullName: string; pullRequestNumber: number },
  headSha: string,
  reason: HandoffRescueStopReason,
): Promise<void> {
  const state = {
    status: "stopped",
    headSha,
    round: 0,
    currentKind: null,
    lastFingerprint: null,
    stopReason: reason,
    lastSweepAt: null,
    waitStartedAt: null,
    maxRounds: AUTO_REPAIR_MAX_ROUNDS,
  };
  await db.pullRequestAutoRepairLoop.upsert({
    where: { repositoryFullName_pullRequestNumber: target },
    create: { ...target, ...state },
    update: state,
  });
}
