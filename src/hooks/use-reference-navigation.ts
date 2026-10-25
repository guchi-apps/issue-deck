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
        // 前に見ていた状態別ビュー（「実行中」など）を引き継がない。開いたPRが一覧に出なく
        // なるため。ビューを落とすと、画面側が開いたPRの載るビュー（本番リリースPRなら
        // 「PR：本番リリース」、それ以外は「PR一覧」）を選ぶ（#5024。`resolvePullRequestViewFor`）。
        // PR一覧の中のリンクも同じ扱いにする——本番リリース↔通常PRのように種類をまたぐと、
        // 今のビューのままでは左の一覧に出ない。一覧の行を押す操作はここを通らずビューを保つ。
        params.delete("prview");
        params.set("pane", "pull-requests");
        params.set("pr", pullRequestId);
        params.set("mscreen", "pull-requests");
        // 重ねて開いていたPR詳細は畳む（#2149）。リンクは重ね表示の中にも出るので、
        // 残すと下の画面だけが遷移し、閉じた先が押したときの一覧ではなくなる。
        params.delete("prmodal");
      });
    },
    [pushParams],
  );

  /**
   * Issue詳細を開く。PRペインを開いていればIssueへ戻し、スマホはIssue詳細画面へ進める。
   * 戻り先の文脈（`mrepo`＝リポジトリ別一覧）はリンク経由では引き継がないため落とす。
   *
   * `resetList`を渡すと、PCの左の一覧の絞り込み（ビュー・状態・検索・ラベル・担当・リポジトリ）を
   * 既定の「すべて」へ戻す（#5024）。開くIssueが今の一覧に含まれないときに呼び出し側が渡す——
   * 戻さないと右に詳細が出ても左の一覧とメニューの選択が別のものを指したままになる。
   * `includeClosed`は閉じたIssueを開くときで、状態を「すべて」にする（既定は「open」）。
   */
  const openIssue = useCallback(
    (issueId: string, options?: { resetList?: { includeClosed: boolean } }) => {
      pushParams((params) => {
        if (options?.resetList) {
          for (const key of ["view", "state", "q", "labels", "assignee", "repos"]) {
            params.delete(key);
          }
          if (options.resetList.includeClosed) params.set("state", "all");
        }
        params.delete("pane");
        params.delete("pr");
        // 重ねて開いていたPR詳細は畳む（#2149。`openPullRequest`と同じ理由）
        params.delete("prmodal");
        params.delete("mrepo");
        params.set("issue", issueId);
        params.set("mscreen", "issue-detail");
        params.set("missue", issueId);
      });
    },
    [pushParams],
  );

  /**
   * リモートセッション画面を開く（#4836）。実行状況のホストカードから、並んでいるセッションを
   * 終了・起動しに行く導線。PCは左メニューと同じ`pane`、スマホは`mscreen`へ切り替える
   */
  const openRemoteSessions = useCallback(() => {
    pushParams((params) => {
      // 左メニューの遷移（`selectRemoteSessionsPane`）と同じく、PRの選択状態だけを落とす
      params.delete("pr");
      params.delete("prmodal");
      params.set("pane", "remote-sessions");
      params.set("mscreen", "remote-sessions");
    });
  }, [pushParams]);

  return { openIssue, openPullRequest, openRemoteSessions };
}
