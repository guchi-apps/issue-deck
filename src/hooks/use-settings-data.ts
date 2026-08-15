"use client";

import { useClaudeUsage } from "@/hooks/use-claude-usage";
import { useFineGrainedTokens } from "@/hooks/use-fine-grained-tokens";
import { useGithubApiUsage } from "@/hooks/use-github-api-usage";
import { useGithubRateLimit } from "@/hooks/use-github-rate-limit";
import { useGithubStatus } from "@/hooks/use-github-status";
import { useNow } from "@/hooks/use-now";
import { getFineGrainedTokenStatus } from "@/lib/fine-grained-tokens";

/**
 * 設定画面（PCのダイアログ・スマホの設定タブ）が読むデータをまとめて取る（#1539）。
 *
 * **なぜ1つのフックにまとめるか。** 以前はPCの`AccountMenuDialog`とスマホの
 * `MobileSettingsScreen`が同じ5本のフックを別々に呼び、同じ警告バッジの条件を
 * それぞれ書いていた。片方だけ直すとPCとスマホで表示が食い違うため、取得と判定を
 * ここへ寄せて、画面側は器（ダイアログか全画面か）だけを持つようにした。
 *
 * `enabled`は開いているときだけ取りに行くためのもので、各フックの引数にそのまま渡る。
 */
export function useSettingsData(enabled: boolean) {
  const {
    data: rateLimits,
    isLoading: rateLimitsLoading,
    error: rateLimitsError,
  } = useGithubRateLimit(enabled);
  const {
    data: apiUsage,
    isLoading: apiUsageLoading,
    error: apiUsageError,
  } = useGithubApiUsage(enabled);
  const {
    data: claudeUsage,
    isLoading: claudeUsageLoading,
    error: claudeUsageError,
    notConfigured: claudeUsageNotConfigured,
  } = useClaudeUsage(enabled);
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
  const now = useNow();

  // 期限切れ・期限が近いPATが1つでもあれば「フリート運用」に警告を出す。
  const hasExpiringFineGrainedToken =
    now !== null &&
    (fineGrainedTokens ?? []).some(
      (token) => getFineGrainedTokenStatus(token.expiresAt, now) !== "active",
    );
  const hasGithubIncident = githubStatus !== null && githubStatus.indicator !== "none";

  return {
    rateLimits: { data: rateLimits, isLoading: rateLimitsLoading, error: rateLimitsError },
    apiUsage: { data: apiUsage, isLoading: apiUsageLoading, error: apiUsageError },
    claudeUsage: {
      data: claudeUsage,
      isLoading: claudeUsageLoading,
      error: claudeUsageError,
      notConfigured: claudeUsageNotConfigured,
    },
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
    hasExpiringFineGrainedToken,
    hasGithubIncident,
  };
}

export type SettingsData = ReturnType<typeof useSettingsData>;
