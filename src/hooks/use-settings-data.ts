"use client";

import { useFineGrainedTokens } from "@/hooks/use-fine-grained-tokens";
import { useGithubStatus } from "@/hooks/use-github-status";
import { useNow } from "@/hooks/use-now";
import { useSharedTokens } from "@/hooks/use-shared-tokens";
import { getFineGrainedTokenStatus } from "@/lib/fine-grained-tokens";

/**
 * 設定画面（PCのダイアログ・スマホの設定タブ）が読むデータをまとめて取る（#1539）。
 *
 * **なぜ1つのフックにまとめるか。** 以前はPCの`AccountMenuDialog`とスマホの
 * `MobileSettingsScreen`が同じ複数のフックを別々に呼び、同じ警告バッジの条件を
 * それぞれ書いていた。片方だけ直すとPCとスマホで表示が食い違うため、取得と判定を
 * ここへ寄せて、画面側は器（ダイアログか全画面か）だけを持つようにした。
 *
 * `enabled`は設定画面を開いているあいだ真になる。GitHubの障害状況・PATの一覧は
 * **どちらも区分を開かずに出す警告バッジの材料**なので、`enabled`の間は先読みする。
 * GitHubの使用量（APIレート制限・Actions）はStatusHubへ移したため（#3827）、ここでは取らない。
 * AI側の使用量も#2631でAI使用量画面（`issue-deck-shell.tsx`）へ移っている。
 */
export function useSettingsData(enabled: boolean) {
  const {
    data: githubStatus,
    isLoading: githubStatusLoading,
    error: githubStatusError,
  } = useGithubStatus(enabled);
  const {
    data: fineGrainedTokens,
    isLoading: fineGrainedTokensLoading,
    error: fineGrainedTokensError,
    refetch: refetchFineGrainedTokens,
  } = useFineGrainedTokens(enabled);
  const {
    data: sharedTokens,
    isLoading: sharedTokensLoading,
    error: sharedTokensError,
    refetch: refetchSharedTokens,
  } = useSharedTokens(enabled);
  const now = useNow();

  // 期限切れ・期限が近いPATが1つでもあれば「フリート運用」に警告を出す。
  // **件数まで数えるのは、フリート運用のPATのカードが畳んであるため**（#2022）。
  // 開かなくても何件あるかが見出しに出る。判定はここ1か所に置く（PCとスマホで食い違わせない）。
  const expiringFineGrainedTokenCount =
    now === null
      ? 0
      : (fineGrainedTokens ?? []).filter(
          (token) => getFineGrainedTokenStatus(token.expiresAt, now) !== "active",
        ).length;
  const hasExpiringFineGrainedToken = expiringFineGrainedTokenCount > 0;
  const hasGithubIncident = githubStatus !== null && githubStatus.indicator !== "none";

  return {
    githubStatus: {
      data: githubStatus,
      isLoading: githubStatusLoading,
      error: githubStatusError,
    },
    fineGrainedTokens: {
      data: fineGrainedTokens,
      isLoading: fineGrainedTokensLoading,
      error: fineGrainedTokensError,
      refetch: refetchFineGrainedTokens,
    },
    sharedTokens: {
      data: sharedTokens,
      isLoading: sharedTokensLoading,
      error: sharedTokensError,
      refetch: refetchSharedTokens,
    },
    hasExpiringFineGrainedToken,
    expiringFineGrainedTokenCount,
    hasGithubIncident,
  };
}

export type SettingsData = ReturnType<typeof useSettingsData>;
