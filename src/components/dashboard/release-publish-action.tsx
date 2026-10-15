"use client";

import { PullRequestMergeButton } from "@/components/dashboard/pull-request-merge-button";
import type { RcOverviewWithFinalization } from "@/hooks/use-release-rc";
import { canMergeFromDeck } from "@/lib/pull-request-list";
import { isRcReleaseCandidateHeadRef } from "@/lib/release-branch";
import { parseRcPhase } from "@/lib/release-rc";
import { decideRcPublish, type RcPublishDecision } from "@/lib/release-rc-action";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 新方式の候補で、いま本番公開へ進めるか（#4635）。サーバーのマージAPIと同じ`decideRcPublish`を使う。
 * 候補の状況を取得できていない間は`null`（推測で公開可にしない）。旧方式・候補以外は`undefined`（従来どおり）
 */
export function decidePublishForPullRequest(
  pullRequest: PullRequestSummary,
  overview: RcOverviewWithFinalization | null,
): RcPublishDecision | null | undefined {
  if (!isRcReleaseCandidateHeadRef(pullRequest.headRef)) return undefined;
  if (overview === null) return null;
  const candidate = overview.candidate;
  const final = overview.finalization?.current ?? null;
  return decideRcPublish({
    phase: candidate ? parseRcPhase(candidate.phase) : null,
    draft: pullRequest.draft,
    headMatchesFinalization: final !== null && final.status === "applied" && final.finalHeadSha === pullRequest.headSha,
    publishApproved: overview.finalization?.approval?.status === "active" || overview.finalization?.approval?.status === "merging",
  });
}

/**
 * 「本番公開へ進む」。**公開できる工程のときだけ**ボタンを出し、それ以外は理由を1行で示す。
 * 旧方式の候補は従来どおり`PullRequestMergeButton`（確認・ゲートはその中とサーバーが持つ）
 */
export function ReleasePublishAction({
  pullRequest,
  decision,
  onMerged,
  variant = "default",
  className,
}: {
  pullRequest: PullRequestSummary;
  /** `decidePublishForPullRequest`の結果 */
  decision: RcPublishDecision | null | undefined;
  onMerged: () => void;
  variant?: "default" | "outline";
  className?: string;
}) {
  if (decision === undefined) {
    return canMergeFromDeck(pullRequest) ? (
      <PullRequestMergeButton pullRequest={pullRequest} onMerged={onMerged} variant={variant} label="本番公開へ進む" className={className} />
    ) : null;
  }
  if (decision === null) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="release-publish-pending">
        候補の状態を確認しています。確認できるまで本番公開の操作は出しません。
      </p>
    );
  }
  if (!decision.ok) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="release-publish-blocked">
        {decision.message}
      </p>
    );
  }
  return canMergeFromDeck(pullRequest) ? (
    <PullRequestMergeButton pullRequest={pullRequest} onMerged={onMerged} variant={variant} label="本番公開へ進む" className={className} />
  ) : null;
}
