import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchPullRequestRollups, pullRequestRollupKey } from "@/lib/github/check-rollup";
import { rerunPullRequestReview } from "@/lib/github/pull-request-review-rerun-run";
import { parsePullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import { fetchOpenPullRequests } from "@/lib/github/pull-requests-api";
import { isReviewNotRun, type ReviewStopped } from "@/lib/github/review-verdict-freshness";
import { buildPullRequestId } from "@/lib/github-reference";
import { sendPushNotification, type PushNotificationPayload } from "@/lib/notifications/push";
import { notMutedWhere } from "@/lib/notifications/push-kinds";

/**
 * 実行機待ちで取り残された自動レビューを巡回で見つけ、1回だけやり直し、直らなければPushで知らせる（#5215）。
 *
 * ジョブが`queued`のままrunだけ終わると、ワークフロー自身は動けないので誰も検知できない。#5212で画面の
 * 表示とやり直しの操作は入ったが、PRを開くか一覧を見るまで気付けなかった。
 *
 * **やり直しまで無人で行うのは、この状態が原因を調べても人にできることが無いため。** 実行機に割り当て
 * られなかっただけで、差分にもワークフローにも問題が無い。下書きへ戻す往復もGitHubが再実行を断ったとき
 * だけで、CIは走り直さない。ジョブが失敗した（`failed`）ものは原因の確認が先なので対象にしない。
 *
 * やり直しが効いたかの判定はせず、止まったままなら通知する、という形にしてある。起動の失敗も、動き出した
 * レビューがまた止まったのも、同じ経路で人へ渡る。
 */

/** 同じコミットで無人のやり直しを行う回数 */
export const REVIEW_STALL_MAX_ATTEMPTS_PER_HEAD = 1;
/** 1つのPRで無人のやり直しを行う回数。push毎に止まる場合に起動し続けない */
export const REVIEW_STALL_MAX_ATTEMPTS_PER_PULL_REQUEST = 3;
/** やり直しが画面に現れるのを待つ猶予。これを過ぎても止まったままなら通知する */
export const REVIEW_STALL_NOTIFY_GRACE_MS = 10 * 60 * 1000;
/** 巡回の間隔。pollerは30秒ごとに呼ぶが、GraphQLをこの間隔に抑える */
export const REVIEW_STALL_SWEEP_INTERVAL_MS = 3 * 60 * 1000;

export type ReviewStallRecord = {
  headSha: string;
  headAttempts: number;
  totalAttempts: number;
  lastAttemptAt: Date | null;
  notifiedHeadSha: string | null;
};

export type ReviewStallInput = {
  now: Date;
  pullRequest: { draft: boolean; baseRef: string; headSha: string };
  reviewStopped: ReviewStopped | null | undefined;
  /** PR本文の判定が指すコミット。無ければnull */
  reviewedSha: string | null;
  record: ReviewStallRecord | null;
};

export type ReviewStallDecision = { action: "skip"; reason: string } | { action: "retry" } | { action: "notify" };

export function decideReviewStallRescue(input: ReviewStallInput): ReviewStallDecision {
  const { pullRequest: pr, record } = input;
  if (pr.draft || pr.baseRef !== "develop") return { action: "skip", reason: "not_target" };
  if (input.reviewStopped?.reason !== "stalled") return { action: "skip", reason: "not_stalled" };
  // ローカルのレビューなどで今のコミットの判定があれば、止まったrunは問題にならない
  if (!isReviewNotRun({ reviewStopped: input.reviewStopped, reviewedSha: input.reviewedSha, headSha: pr.headSha })) {
    return { action: "skip", reason: "already_reviewed" };
  }
  const headAttempts = record?.headSha === pr.headSha ? record.headAttempts : 0;
  if (headAttempts < REVIEW_STALL_MAX_ATTEMPTS_PER_HEAD && (record?.totalAttempts ?? 0) < REVIEW_STALL_MAX_ATTEMPTS_PER_PULL_REQUEST) {
    return { action: "retry" };
  }
  if (record?.notifiedHeadSha === pr.headSha) return { action: "skip", reason: "already_notified" };
  if (
    headAttempts > 0 &&
    record?.lastAttemptAt &&
    input.now.getTime() - record.lastAttemptAt.getTime() < REVIEW_STALL_NOTIFY_GRACE_MS
  ) {
    return { action: "skip", reason: "within_grace" };
  }
  return { action: "notify" };
}

/** 通知の中身。タップ先は通知ベルの行と同じPR詳細で、「AIレビューを再実行」がそこにある */
export function buildReviewStallPushPayload(params: {
  repositoryFullName: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  /** レビュー可能へ戻せず、PRが下書きのまま残っている */
  leftAsDraft: boolean;
}): PushNotificationPayload {
  const repositoryName = params.repositoryFullName.split("/")[1] ?? params.repositoryFullName;
  const pullRequestId = buildPullRequestId(params.repositoryFullName, params.pullRequestNumber);
  return {
    title: `${repositoryName} ・ ${params.leftAsDraft ? "PRが下書きのままです" : "自動レビューが止まっています"}`,
    body: `#${params.pullRequestNumber} ${params.pullRequestTitle}`,
    url: `/dashboard?pane=pull-requests&pr=${encodeURIComponent(pullRequestId)}&mscreen=pull-requests`,
    tag: `review-stalled:${pullRequestId}`,
  };
}

export type ReviewStallTarget = { repositoryFullName: string; pullRequestNumber: number };

export type ReviewStallSweepResult = {
  swept: boolean;
  retried: ReviewStallTarget[];
  notified: ReviewStallTarget[];
};

let lastSweptAt: number | null = null;

/** テスト用。プロセスをまたがないので本番では呼ばない */
export function resetReviewStallRescueIntervalForTest(): void {
  lastSweptAt = null;
}

/**
 * やり直す前に回数を記録して席を取る。取れたらtrue。**起動の前に数える**ので、途中で落ちても
 * 同じコミットで二度起動せず、次の巡回からは通知へ進む。
 */
async function claimAttempt(
  target: ReviewStallTarget,
  headSha: string,
  record: ReviewStallRecord | null,
  now: Date,
): Promise<boolean> {
  if (!record) {
    try {
      await db.pullRequestReviewStallRescue.create({
        data: { ...target, headSha, headAttempts: 1, totalAttempts: 1, lastAttemptAt: now },
      });
      return true;
    } catch {
      // 別の巡回が先に作った。次の巡回で読み直す
      return false;
    }
  }
  const claimed = await db.pullRequestReviewStallRescue.updateMany({
    where: { ...target, headSha: record.headSha, headAttempts: record.headAttempts, totalAttempts: record.totalAttempts },
    data: {
      headSha,
      headAttempts: record.headSha === headSha ? { increment: 1 } : 1,
      totalAttempts: { increment: 1 },
      lastAttemptAt: now,
    },
  });
  return claimed.count === 1;
}

/** 送る前に席を取り、同じコミットで鳴らし直さない（送信の成否では戻さない。#2300と同じ） */
async function notifyOnce(
  repository: { id: string; installationId: string; fullName: string },
  target: ReviewStallTarget,
  headSha: string,
  payload: PushNotificationPayload,
): Promise<boolean> {
  const reserved = await db.pullRequestReviewStallRescue.updateMany({
    where: { ...target, OR: [{ notifiedHeadSha: null }, { notifiedHeadSha: { not: headSha } }] },
    data: { notifiedHeadSha: headSha },
  });
  if (reserved.count !== 1) return false;
  const targets = await db.pushSubscription.findMany({
    where: {
      user: {
        userInstallations: { some: { installationId: repository.installationId } },
        hiddenRepositories: { none: { repositoryId: repository.id } },
        ...notMutedWhere("review-stalled"),
      },
    },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  await sendPushNotification(targets, payload);
  return true;
}

export async function runReviewStallRescueSweep(options: { force?: boolean; now?: Date } = {}): Promise<ReviewStallSweepResult> {
  const now = options.now ?? new Date();
  const result: ReviewStallSweepResult = { swept: false, retried: [], notified: [] };
  if (!options.force && lastSweptAt !== null && now.getTime() - lastSweptAt < REVIEW_STALL_SWEEP_INTERVAL_MS) return result;
  lastSweptAt = now.getTime();
  result.swept = true;

  const repositories = await db.repository.findMany({ where: { archived: false }, orderBy: { fullName: "asc" }, include: { installation: true } });
  for (const repository of repositories) {
    try {
      const token = await getInstallationToken(repository.installation.installationId);
      const pullRequests = await fetchOpenPullRequests(repository.ownerLogin, repository.name, token);
      // 開いていないPRの記録は要らない。止まったPRが無いリポジトリでは行が無く何も起きない
      await db.pullRequestReviewStallRescue.deleteMany({
        where: { repositoryFullName: repository.fullName, pullRequestNumber: { notIn: pullRequests.map((pr) => pr.number) } },
      });
      const candidates = pullRequests.filter((pr) => !pr.draft && pr.base.ref === "develop");
      if (candidates.length === 0) continue;

      const rollups = await fetchPullRequestRollups(
        candidates.map((pr) => ({ owner: repository.ownerLogin, repo: repository.name, number: pr.number })),
        token,
      );
      for (const pullRequest of candidates) {
        const reviewStopped = rollups.get(pullRequestRollupKey(repository.ownerLogin, repository.name, pullRequest.number))?.rollup?.mergeJudgement.reviewStopped;
        if (reviewStopped?.reason !== "stalled") continue;

        const target = { repositoryFullName: repository.fullName, pullRequestNumber: pullRequest.number };
        try {
          const record = await db.pullRequestReviewStallRescue.findUnique({
            where: { repositoryFullName_pullRequestNumber: target },
            select: { headSha: true, headAttempts: true, totalAttempts: true, lastAttemptAt: true, notifiedHeadSha: true },
          });
          const headSha = pullRequest.head.sha;
          const decision = decideReviewStallRescue({
            now,
            pullRequest: { draft: pullRequest.draft, baseRef: pullRequest.base.ref, headSha },
            reviewStopped,
            reviewedSha: parsePullRequestReviewVerdict(pullRequest.body)?.reviewedSha ?? null,
            record,
          });
          const push = (leftAsDraft: boolean) =>
            notifyOnce(
              repository,
              target,
              headSha,
              buildReviewStallPushPayload({ ...target, pullRequestTitle: pullRequest.title, leftAsDraft }),
            );
          if (decision.action === "notify") {
            if (await push(false)) result.notified.push(target);
            continue;
          }
          if (decision.action !== "retry" || !(await claimAttempt(target, headSha, record, now))) continue;

          const outcome = await rerunPullRequestReview({ owner: repository.ownerLogin, repo: repository.name, number: pullRequest.number, headSha, token });
          if (outcome.ok) {
            result.retried.push(target);
          } else if (outcome.code === "ready_failed") {
            // 下書きのPRは次の巡回の対象から外れるので、ここで知らせないと誰も気付かない
            if (await push(true)) result.notified.push(target);
          } else {
            console.warn(`[review-stall-rescue] ${target.repositoryFullName}#${target.pullRequestNumber} をやり直せませんでした: ${outcome.code}`);
          }
        } catch (error) {
          // 回数は消費済みなので、止まったままなら猶予の後に通知へ進む
          console.error(`[review-stall-rescue] ${target.repositoryFullName}#${target.pullRequestNumber}:`, error);
        }
      }
    } catch (error) {
      console.error(`[review-stall-rescue] ${repository.fullName}:`, error);
    }
  }
  return result;
}
