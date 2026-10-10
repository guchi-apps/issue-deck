"use client";

import { PullRequestMergeChanges } from "@/components/dashboard/pull-request-merge-changes";
import {
  MergePrecheckInlineRows,
  PullRequestMergePrecheck,
} from "@/components/dashboard/pull-request-merge-precheck";
import { PullRequestMergeVersion } from "@/components/dashboard/pull-request-merge-version";
import { ConnectedReleaseReviewSections } from "@/components/dashboard/release-review-sections";
import { useReferenceNavigation } from "@/hooks/use-reference-navigation";
import { usePullRequestChanges } from "@/hooks/use-pull-request-changes";
import { releaseVersionFromTitle } from "@/lib/branch-flow";
import type { ReviewVerdictKind } from "@/lib/github/release-verification";
import { applyReviewVerdicts } from "@/lib/pull-request-changes";
import { RELEASE_BRANCH_PREFIX } from "@/lib/pull-request-list";
import {
  buildCiConflictRows,
  buildMergePrecheck,
  type MergePrecheckReviews,
} from "@/lib/pull-request-merge-precheck";
import type { PullRequestSummary, ReleaseChangeListResponse } from "@/types/pull-request";

/**
 * mainへのPRの確認ダイアログの中身（#3093）。先頭には「どの版からどの版へ上げるか」を独立して置く
 * （#3260。`PullRequestMergeVersion`。前の版は変更点と同じ取得で受け取る）。
 *
 * **凍結ブランチのリリースPR（`release-main/*`）では、確認の材料を「リリースの検証」1枚にまとめる**
 * （#4277）。全体レビュー → 統合検証 → 個別PRレビュー → CI・コンフリクトの順で、リリース詳細・
 * スマホのリリースシートと同じ部品（`ConnectedReleaseReviewSections`）・同じ取得を使うので、判定が
 * 画面ごとに食い違わない。旧「Claudeのレビュー」行は個別PRレビューの区分へ統合し、変更一覧は
 * 個別PRレビューを開いた中に置く（スマホで閉じたまま1画面に収めるため）。旧世代のリリースPR
 * （head=develop）は検証の対象外なので、従来どおり「マージ前の確認」と変更一覧を並べる。
 *
 * **ダイアログの中に置く**（開いているあいだだけマウントされる）。閉じると取得結果も消えるので、
 * 開き直すたびに取り直す——developは開いているあいだも動くため、確認のたびに最新を見せる方が
 * 正しく、同じ内容ならETagの304になりレート制限を消費しない（`usePullRequestChanges`）。
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
  const frozen = pullRequest.headRef.startsWith(RELEASE_BRANCH_PREFIX);

  // 変更一覧のPRはリリースPRと同じリポジトリのもの。IDは`<owner>/<repo>#<番号>`
  const openChange = (number: number) => {
    onNavigate?.();
    openPullRequest(`${pullRequest.repositoryFullName}#${number}`);
  };
  const version = (
    <PullRequestMergeVersion
      from={state.previousVersion}
      to={releaseVersionFromTitle(pullRequest.title)}
      isLoading={state.isLoading || (state.changes === null && state.error === null)}
    />
  );

  if (frozen) {
    // 一覧の各行の判定は、区分の集計と同じ取得（各PR本文の判定）から引く
    const renderList = (data: ReleaseChangeListResponse) => {
      const byNumber = new Map(data.pullRequests.map((pr) => [pr.number, pr]));
      const reviewKinds = new Map<string, ReviewVerdictKind>();
      for (const change of state.changes ?? []) {
        const pr = change.pullRequestNumber !== null ? byNumber.get(change.pullRequestNumber) : undefined;
        if (pr && !pr.isVersionBump && !pr.reviewUnavailable) {
          reviewKinds.set(change.id, pr.review?.reviewKind ?? "unknown");
        }
      }
      return (
        <PullRequestMergeChanges
          pullRequest={pullRequest}
          state={state}
          reviewKinds={reviewKinds}
          onOpenPullRequest={openChange}
        />
      );
    };
    return (
      <>
        {version}
        <ConnectedReleaseReviewSections
          repositoryFullName={pullRequest.repositoryFullName}
          pullRequestNumber={pullRequest.number}
          headRef={pullRequest.headRef}
          enabled={open}
          renderIndividualList={renderList}
          onOpenPullRequest={openChange}
          extraRows={<MergePrecheckInlineRows rows={buildCiConflictRows(pullRequest)} />}
        />
      </>
    );
  }

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

  return (
    <>
      {version}
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
