import {
  isActiveDispatchJobStatus,
  resolvePlanReviewJobPhase,
  type DispatchHostView,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import { formatLaunchHoldMetric } from "@/lib/dispatch/host-metrics";
import type { DispatchPlanReviewSession } from "@/lib/dispatch/plan-review-session";

/**
 * 実行状況のホストカードに出す、計画レビュー（G1）の1行（#5655）。
 *
 * - `queued`: そのホスト宛てに積まれ、まだpollerが取りに来ていない
 * - `reviewing`: 起動済みで、指摘コメントがまだ届いていない
 */
export type PlanReviewHostRow = {
  key: string;
  repositoryFullName: string;
  issueNumber: number;
  issueTitle: string | null;
  issueId: string | null;
  state: "queued" | "reviewing";
  /** 行のもとになったジョブ。tmuxの写しにしか無い（ジョブが一覧に無い）ときは`null` */
  job: DispatchJobView | null;
  /** 起動待ちは積んだ時刻、レビュー中は起動した時刻。分からなければ`null` */
  since: string | null;
};

function rowKey(repositoryFullName: string, issueNumber: number): string {
  return `${repositoryFullName}#${issueNumber}`;
}

function reviewStartedAt(job: DispatchJobView): string | null {
  return job.startedAt ?? job.claimedAt ?? job.finishedAt;
}

/**
 * そのホストの計画レビューの行を組む（#5655）。
 *
 * **行はジョブの状態から作り、pollerが申告するtmuxの写し（`planReviewSessions`）は補助にする。**
 * 写しはpollerの申告周期（約1分45秒）でしか更新されないため、1分足らずで終わるレビューは
 * 一度も写しに載らず、実行状況に何も出なかった。起動待ち（`QUEUED`）も写しには載らない。
 *
 * - 起動待ちは`status === "QUEUED"`で選び、**経過時間では外さない**。10分を超えた起動待ち
 *   （`queued_overdue`）もまだ起動していないレビューで、消すとどこにも出なくなる
 * - レビュー中は`resolvePlanReviewJobPhase`が`creating`を返し、指摘（`reviewPostedAt`）が
 *   まだ届いていないもの。届いたら、採否の判定を待たずにこの行は外す（もう書き終えている）
 * - 同じIssueのジョブが複数あれば新しいものだけを見る（古いジョブの残りで行を出さない）
 * - 写しにだけあるもの（ジョブが一覧から落ちた・古いpoller）も「レビュー中」として足す
 */
export function selectHostPlanReviewRows(params: {
  host: Pick<DispatchHostView, "name" | "planReviewSessions">;
  jobs: readonly DispatchJobView[];
  now: Date;
}): PlanReviewHostRow[] {
  const { host, jobs, now } = params;
  const latest = new Map<string, DispatchJobView>();
  for (const job of jobs) {
    if (job.kind !== "PLAN_REVIEW" || job.targetHost !== host.name) continue;
    const key = rowKey(job.repositoryFullName, job.issueNumber);
    const current = latest.get(key);
    if (!current || job.createdAt > current.createdAt) latest.set(key, job);
  }

  const rows = new Map<string, PlanReviewHostRow>();
  for (const [key, job] of latest) {
    const base = {
      key,
      repositoryFullName: job.repositoryFullName,
      issueNumber: job.issueNumber,
      issueTitle: job.issueTitle,
      issueId: job.issueId,
      job,
    };
    if (job.status === "QUEUED") {
      rows.set(key, { ...base, state: "queued", since: job.createdAt });
      continue;
    }
    if (job.reviewPostedAt) continue;
    if (
      isActiveDispatchJobStatus(job.status) ||
      resolvePlanReviewJobPhase(job, now) === "creating"
    ) {
      rows.set(key, { ...base, state: "reviewing", since: reviewStartedAt(job) });
    }
  }

  for (const session of host.planReviewSessions ?? []) {
    const key = rowKey(session.repositoryFullName, session.issueNumber);
    const existing = rows.get(key);
    if (existing) {
      // 写しに出ている＝実際に走っている。ジョブ側の題名が引けていなければ写しの方で補う
      rows.set(key, {
        ...existing,
        state: "reviewing",
        issueTitle: existing.issueTitle ?? session.issueTitle,
        issueId: existing.issueId ?? session.issueId,
      });
      continue;
    }
    rows.set(key, fromSession(key, session, latest.get(key) ?? null));
  }

  // レビュー中を上に、それぞれ古い順（起動待ちは積んだ順＝取りに来る順）
  return [...rows.values()].sort(
    (a, b) =>
      (a.state === b.state ? 0 : a.state === "reviewing" ? -1 : 1) ||
      (a.since ?? "").localeCompare(b.since ?? ""),
  );
}

function fromSession(
  key: string,
  session: DispatchPlanReviewSession,
  job: DispatchJobView | null,
): PlanReviewHostRow {
  return {
    key,
    repositoryFullName: session.repositoryFullName,
    issueNumber: session.issueNumber,
    issueTitle: session.issueTitle ?? job?.issueTitle ?? null,
    issueId: session.issueId ?? job?.issueId ?? null,
    state: "reviewing",
    job,
    since: job ? reviewStartedAt(job) : null,
  };
}

/**
 * 起動待ちの計画レビューが進まない理由（#5655）。分からなければ`null`。
 *
 * **実装の順番待ちの`describeDispatchJobWaitReason`は使わない。** 計画レビューはセッション本数の
 * 上限（`liveSessions/maxSessions`）に数えない別枠なので、そちらの「上限に達しているため」は
 * 当てはまらない。pollerが起動ジョブそのものを取りに行かない`launchHold`だけを理由に出す。
 */
export function describePlanReviewWaitReason(
  host: Pick<DispatchHostView, "online" | "launchHold">,
): string | null {
  if (!host.online) return "ホストが応答していないため";
  if (host.launchHold) return `${formatLaunchHoldMetric(host.launchHold)}のため`;
  return null;
}

/** 宛先ホストが一覧に無い計画レビュー（どのホストのカードにも載らないもの。#5655） */
export function selectPlanReviewsWithoutHost(
  planReviews: readonly DispatchJobView[],
  hosts: readonly Pick<DispatchHostView, "name">[],
): DispatchJobView[] {
  const names = new Set(hosts.map((host) => host.name));
  return planReviews.filter((job) => !names.has(job.targetHost));
}
