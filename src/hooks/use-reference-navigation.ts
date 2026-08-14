"use client";

import { useCallback } from "react";

import { useHistoryNavigation } from "@/hooks/use-history-navigation";

/**
 * 画面内のIssue・PRリンクから対応する詳細へ遷移するためのURL更新（#1260）。
 *
 * PC（`pane`・`pr`・`issue`）とスマホ（`mscreen`・`missue`）は現在地の持ち方が別々で、どちらの
 * レイアウトを見ているかはCSSのブレークポイントで決まるためJS側からは判別できない。
 * そこで**両方の現在地を1回の更新でまとめて進める**。`useIssueFilters`と
 * `useMobileScreen`を順に呼ぶと、どちらも同じ`searchParams`から次のクエリを組み立てるため、
 * 後の1回が前の1回の変更を落としてしまう。
 *
 * 詳細を開くのは現在地が進む操作なので履歴を積み、戻る操作で元の画面へ戻れるようにする（#1396）。
 */
export function useReferenceNavigation() {
  const { navigateParams } = useHistoryNavigation();

  const pushParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => navigateParams(mutate, { history: "push" }),
    [navigateParams],
  );

  /** PR詳細を開く。PCはPRペインへ、スマホはPR画面へ切り替える */
  const openPullRequest = useCallback(
    (pullRequestId: string) => {
      pushParams((params) => {
        params.set("pane", "pull-requests");
        params.set("pr", pullRequestId);
        params.set("mscreen", "pull-requests");
      });
    },
    [pushParams],
  );

  /**
   * Issue詳細を開く。PRペインを開いていればIssueへ戻し、スマホはIssue詳細画面へ進める。
   * 戻り先の文脈（`mrepo`＝リポジトリ別一覧）はリンク経由では引き継がないため落とす。
   */
  const openIssue = useCallback(
    (issueId: string) => {
      pushParams((params) => {
        params.delete("pane");
        params.delete("pr");
        params.delete("mrepo");
        params.set("issue", issueId);
        params.set("mscreen", "issue-detail");
        params.set("missue", issueId);
      });
    },
    [pushParams],
  );

  return { openIssue, openPullRequest };
}
