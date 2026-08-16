"use client";

import { BranchFlowView } from "@/components/dashboard/branch-flow-view";
import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import { MobileNotificationButton } from "@/components/dashboard/mobile/mobile-notification-button";
import type { BranchFlow } from "@/lib/branch-flow";
import type { PullRequestSummary } from "@/types/pull-request";

type MobileFlowScreenProps = {
  flow: BranchFlow;
  fetchedAt: string | null;
  isLoading: boolean;
  error: string | null;
  failedRepositories: string[];
  /** マージ済みPRまで取得できているか（#1711）。`BranchFlowView`へそのまま渡す */
  mergedPullRequestsLoaded: boolean;
  onRefresh: () => void;
  /** PRをこの画面からマージできたとき（#1756）。`BranchFlowView`へそのまま渡す */
  onMerged: (pullRequest: PullRequestSummary) => void;
};

/**
 * スマホの「ブランチ」画面（#1455）。
 *
 * PC版と同じ`BranchFlowView`をそのまま使い、ヘッダー右の実行状況とボトムナビぶんの余白だけを
 * 差し込む（`mobile-pull-requests-screen.tsx`と同じ形）。
 *
 * **#1638でボトムナビのタブになった**（旧「設定」の枠）。タブから直接開く画面になったため、
 * 戻るボタンは出さない——出しても戻り先が「さっきまで見ていたタブ」で、フッターを押すのと
 * 変わらないため。
 */
export function MobileFlowScreen({
  flow,
  fetchedAt,
  isLoading,
  error,
  failedRepositories,
  mergedPullRequestsLoaded,
  onRefresh,
  onMerged,
}: MobileFlowScreenProps) {
  return (
    <BranchFlowView
      flow={flow}
      fetchedAt={fetchedAt}
      isLoading={isLoading}
      error={error}
      failedRepositories={failedRepositories}
      mergedPullRequestsLoaded={mergedPullRequestsLoaded}
      onRefresh={onRefresh}
      onMerged={onMerged}
      className="h-full"
      footerSpacing
      headerActions={
        <>
          <MobileDispatchStatusButton />
          {/* 通知ベル（#1772）。実行状況の右隣で全画面そろえる */}
          <MobileNotificationButton />
        </>
      }
    />
  );
}
