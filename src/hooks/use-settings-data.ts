"use client";

import { useClaudeUsage } from "@/hooks/use-claude-usage";
import { useFineGrainedTokens } from "@/hooks/use-fine-grained-tokens";
import { useGithubActionsUsage } from "@/hooks/use-github-actions-usage";
import { useGithubApiUsage } from "@/hooks/use-github-api-usage";
import { useGithubRateLimit } from "@/hooks/use-github-rate-limit";
import { useGithubStatus } from "@/hooks/use-github-status";
import { useNow } from "@/hooks/use-now";
import { getFineGrainedTokenStatus } from "@/lib/fine-grained-tokens";

/**
 * 設定画面（PCのダイアログ・スマホの設定タブ）が読むデータをまとめて取る（#1539）。
 *
 * **なぜ1つのフックにまとめるか。** 以前はPCの`AccountMenuDialog`とスマホの
 * `MobileSettingsScreen`が同じ複数のフックを別々に呼び、同じ警告バッジの条件を
 * それぞれ書いていた。片方だけ直すとPCとスマホで表示が食い違うため、取得と判定を
 * ここへ寄せて、画面側は器（ダイアログか全画面か）だけを持つようにした。
 *
 * `enabled`は設定画面を開いているあいだ真になる。**それだけでは足りない**（#2022）——
 * 設定を開いた時点では、どの区分も選んでいないのに全部の取得が走っていた。そのうち
 * 使用量・レート制限（`StatusSection`でしか読まないもの。#2212で足したActionsの消費量も
 * ここに入る）は`statusActive`が真、つまり**「状態」区分を開いているあいだだけ**取りに行く。
 * 区分を離れて戻ると取り直すが、使用量は見るたびに新しいほうがよいので、そのままにしている。
 *
 * 残る2本（GitHubの障害状況・PATの一覧）は`enabled`のままにする。**どちらも区分を
 * 開かずに出す警告バッジの材料**で、遅らせるとバッジが出なくなる。
 */
export function useSettingsData(enabled: boolean, statusActive: boolean) {
  const {
    data: rateLimits,
    isLoading: rateLimitsLoading,
    error: rateLimitsError,
  } = useGithubRateLimit(enabled && statusActive);
  const {
    data: apiUsage,
    isLoading: apiUsageLoading,
    error: apiUsageError,
  } = useGithubApiUsage(enabled && statusActive);
  const {
    data: actionsUsage,
    isLoading: actionsUsageLoading,
    error: actionsUsageError,
    notConfigured: actionsUsageNotConfigured,
  } = useGithubActionsUsage(enabled && statusActive);
  const {
    data: claudeUsage,
    isLoading: claudeUsageLoading,
    error: claudeUsageError,
    notConfigured: claudeUsageNotConfigured,
  } = useClaudeUsage(enabled && statusActive);
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
    rateLimits: { data: rateLimits, isLoading: rateLimitsLoading, error: rateLimitsError },
    apiUsage: { data: apiUsage, isLoading: apiUsageLoading, error: apiUsageError },
    actionsUsage: {
      data: actionsUsage,
      isLoading: actionsUsageLoading,
      error: actionsUsageError,
      notConfigured: actionsUsageNotConfigured,
    },
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
    expiringFineGrainedTokenCount,
    hasGithubIncident,
  };
}

export type SettingsData = ReturnType<typeof useSettingsData>;
