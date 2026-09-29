"use client";

import { PullRequestMergeChanges } from "@/components/dashboard/pull-request-merge-changes";
import { PullRequestMergePrecheck } from "@/components/dashboard/pull-request-merge-precheck";
import { PullRequestMergeVersion } from "@/components/dashboard/pull-request-merge-version";
import { useReferenceNavigation } from "@/hooks/use-reference-navigation";
import { usePullRequestChanges } from "@/hooks/use-pull-request-changes";
import { releaseVersionFromTitle } from "@/lib/branch-flow";
import { applyReviewVerdicts } from "@/lib/pull-request-changes";
import {
  buildMergePrecheck,
  type MergePrecheckReviews,
} from "@/lib/pull-request-merge-precheck";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * mainへのPRの確認ダイアログの中身（#3093）。「マージ前の確認」と「このリリースに含まれる変更」を
 * 並べる。先頭には「どの版からどの版へ上げるか」を独立して置く（#3260。
 * `PullRequestMergeVersion`。前の版は変更点と同じ取得で受け取る）。
 *
 * **変更点の取得はここで1回だけ行い、2つの表示で共有する。** レビューの行の材料（各PRの判定）は
 * 変更点の一覧を読んでから突き合わせるため、別々に取ると同じAPIを2回叩くことになる。
 *
 * **ダイアログの中に置く**（開いているあいだだけマウントされる）。閉じると取得結果も消えるので、
 * 開き直すたびに取り直す——developは開いているあいだも動くため、確認のたびに最新を見せる方が
 * 正しく、同じ内容ならETagの304になりレート制限を消費しない（`usePullRequestChanges`）。
 * 親（`PullRequestMergeButton`）に置くと結果が残り続けて、古い変更点を見せてしまう。
 */
export function PullRequestMergeProduction({
  pullRequest,
  open,
  onNavigate,
}: {
  pullRequest: PullRequestSummary;
  /** 確認ダイアログが開いているか。開いているあいだだけ取得する */
  open: boolean;
  /** 変更一覧の行からPR詳細へ移るとき、開く前に呼ぶ（確認ダイアログを閉じる。#3592） */
  onNavigate?: () => void;
}) {
  const state = usePullRequestChanges(pullRequest.id, open);
  const { openPullRequest } = useReferenceNavigation();

  // 判定はリリースPRの本文に載っていて、一覧の取得時点で読み終わっている（#2843）。
  // 変更点の取得を待つのは突き合わせる相手の一覧だけ。
  const reviews: MergePrecheckReviews = state.error
    ? { status: "error" }
    : state.changes === null
      ? { status: "loading" }
      : {
          status: "loaded",
          reviewed: applyReviewVerdicts(state.changes, pullRequest.releaseVerification),
        };

  const reviewKinds =
    reviews.status === "loaded"
      ? new Map(reviews.reviewed.map((change) => [change.id, change.reviewKind]))
      : undefined;
  // 変更一覧のPRはリリースPRと同じリポジトリのもの。IDは`<owner>/<repo>#<番号>`
  const openChange = (number: number) => {
    onNavigate?.();
    openPullRequest(`${pullRequest.repositoryFullName}#${number}`);
  };

  return (
    <>
      <PullRequestMergeVersion
        from={state.previousVersion}
        to={releaseVersionFromTitle(pullRequest.title)}
        isLoading={state.isLoading || (state.changes === null && state.error === null)}
      />
      <PullRequestMergePrecheck precheck={buildMergePrecheck(pullRequest, reviews)} />
      <PullRequestMergeChanges
        pullRequest={pullRequest}
        state={state}
        reviewKinds={reviewKinds}
        onOpenPullRequest={openChange}
      />
    </>
  );
}
