"use client";

import { BranchFlowView } from "@/components/dashboard/branch-flow-view";
import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import type { BranchFlow } from "@/lib/branch-flow";

type MobileFlowScreenProps = {
  flow: BranchFlow;
  fetchedAt: string | null;
  isLoading: boolean;
  error: string | null;
  failedRepositories: string[];
  /** マージ済みPRまで取得できているか（#1711）。`BranchFlowView`へそのまま渡す */
  mergedPullRequestsLoaded: boolean;
  onRefresh: () => void;
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
      className="h-full"
      footerSpacing
      headerActions={<MobileDispatchStatusButton />}
    />
  );
}
