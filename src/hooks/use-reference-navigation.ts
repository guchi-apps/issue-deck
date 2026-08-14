"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * 画面内のIssue・PRリンクから対応する詳細へ遷移するためのURL更新（#1260）。
 *
 * PC（`pane`・`pr`）とスマホ（`mscreen`・`missue`）は現在地の持ち方が別々で、どちらの
 * レイアウトを見ているかはCSSのブレークポイントで決まるためJS側からは判別できない。
 * そこで**両方の現在地を1回の`router.replace`でまとめて進める**。`useIssueFilters`と
 * `useMobileScreen`を順に呼ぶと、どちらも同じ`searchParams`から次のクエリを組み立てるため、
 * 後の1回が前の1回の変更を落としてしまう。
 *
 * PCの選択中Issueだけは（URLではなく）Reactのstateで持っているため、ここでは扱わず
 * 呼び出し側（`IssueDeckShell`）が併せて更新する。
 */
export function useReferenceNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const replaceParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  /** PR詳細を開く。PCはPRペインへ、スマホはPR画面へ切り替える */
  const openPullRequest = useCallback(
    (pullRequestId: string) => {
      replaceParams((params) => {
        params.set("pane", "pull-requests");
        params.set("pr", pullRequestId);
        params.set("mscreen", "pull-requests");
      });
    },
    [replaceParams],
  );

  /**
   * Issue詳細を開く。PRペインを開いていればIssueへ戻し、スマホはIssue詳細画面へ進める。
   * 戻り先の文脈（`mrepo`＝リポジトリ別一覧）はリンク経由では引き継がないため落とす。
   */
  const openIssue = useCallback(
    (issueId: string) => {
      replaceParams((params) => {
        params.delete("pane");
        params.delete("pr");
        params.delete("mrepo");
        params.set("mscreen", "issue-detail");
        params.set("missue", issueId);
      });
    },
    [replaceParams],
  );

  return { openIssue, openPullRequest };
}
