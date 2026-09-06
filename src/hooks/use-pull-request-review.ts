"use client";

import { useEffect, useState } from "react";

import type { PullRequestReviewCommentContent } from "@/lib/github/pull-request-review-comment";

type UsePullRequestReviewResult = {
  /** 読み取れたレビュー。取得前・記録が無い場合はnull */
  review: PullRequestReviewCommentContent | null;
  /** いま表示している対象について、まだ一度も取得が終わっていないか */
  isLoading: boolean;
};

/**
 * develop向けPRの自動レビュー本文を1回だけ取りに行く（#2849）。
 *
 * **取りに行くのは`enabled`（＝マージ待ちの承認カードを出すとき）だけ。** 1回で2リクエストを
 * 消費するため、Issueを開いているだけの間は取らない。**ポーリングもしない**——レビューが
 * 動くのは追いコミットをpushしたときで、そのときは画面側の対応PRの状態が先に変わる。
 *
 * **取得に失敗しても何も出さない。** レビューはマージの判断材料の1つで、読めなかったことを
 * 赤字で出すと、本当に読むべき指摘と同じ強さで並ぶ。判定そのものはPR本文から読めており
 * （`parsePullRequestReviewVerdict`・#2843）、そちらは別経路で出ている。
 *
 * **取得済みの中身は「どの対象のものか」と一緒に持つ。** 別のIssueへ切り替えた瞬間に前の
 * PRの指摘が残っていると、取り直しが終わるまでの数百ミリ秒、無関係な指摘を読んで修正依頼へ
 * 取り込めてしまう。
 */
export function usePullRequestReview(
  repositoryFullName: string | null,
  pullRequestNumber: number | null,
  enabled: boolean,
): UsePullRequestReviewResult {
  const [loaded, setLoaded] = useState<{
    key: string;
    review: PullRequestReviewCommentContent | null;
  } | null>(null);

  const [owner, repo] = repositoryFullName ? repositoryFullName.split("/") : [null, null];
  const loadKey =
    enabled && owner && repo && pullRequestNumber ? `${owner}/${repo}#${pullRequestNumber}` : null;

  useEffect(() => {
    if (!loadKey || !owner || !repo || !pullRequestNumber) return;

    // 効果の中の非同期関数からは絞り込みが効かないため、確定した値を取り出しておく
    const key = loadKey;
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      let review: PullRequestReviewCommentContent | null = null;
      try {
        const res = await fetch(
          `/api/pull-requests/review?owner=${owner}&repo=${repo}&number=${pullRequestNumber}`,
          { signal: controller.signal },
        );
        if (res.ok) {
          const data: { review: PullRequestReviewCommentContent | null } = await res.json();
          review = data.review;
        }
      } catch {
        // 取得できなければ何も出さない（上のコメント）
      }
      // 中断された取得で「取得済み」にしない（次の対象の取得が始まっている）
      if (cancelled) return;
      setLoaded({ key, review });
    }

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [loadKey, owner, repo, pullRequestNumber]);

  const matched = loadKey !== null && loaded?.key === loadKey;
  return {
    review: matched ? (loaded?.review ?? null) : null,
    isLoading: loadKey !== null && !matched,
  };
}
