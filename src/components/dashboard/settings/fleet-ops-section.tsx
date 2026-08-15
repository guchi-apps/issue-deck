"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";

import { SecretsSyncSection } from "@/components/dashboard/secrets-sync-section";
import { FineGrainedTokensSection } from "@/components/dashboard/settings/fine-grained-tokens-section";
import { WorkflowTagStatusSection } from "@/components/dashboard/workflow-tag-status";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useIssueSync } from "@/hooks/use-issue-sync";
import { useRepositorySync } from "@/hooks/use-repository-sync";
import type { SettingsData } from "@/hooks/use-settings-data";

type FleetOpsSectionProps = {
  /** 表示中かどうか。中のセクションが自分でfetchする際のトリガーに使う */
  active: boolean;
  fineGrainedTokens: SettingsData["fineGrainedTokens"];
};

/**
 * 設定の「フリート運用」区分（#1539）。**押した瞬間に走る操作だけ**を置く。
 *
 * 保存ボタンは無い。ここに保存が要る設定値を混ぜると、元の「保存がどこまで効くのか
 * 分からない」状態に戻る。設定値は`ExecutionSettingsSection`へ置くこと。
 */
export function FleetOpsSection({ active, fineGrainedTokens }: FleetOpsSectionProps) {
  const { isSyncing: isIssueSyncing, handleSync: handleIssueSync } = useIssueSync();
  const { isSyncing: isRepositorySyncing, handleSync: handleRepositorySync } =
    useRepositorySync();
  const [issueSyncConfirmOpen, setIssueSyncConfirmOpen] = useState(false);
  const [repositorySyncConfirmOpen, setRepositorySyncConfirmOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">GitHubからの再取得</span>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            variant="outline"
            className="justify-start"
            disabled={isIssueSyncing}
            onClick={() => setIssueSyncConfirmOpen(true)}
          >
            <RefreshCw className={isIssueSyncing ? "animate-spin" : undefined} />
            {isIssueSyncing ? "Issueを再同期中..." : "Issueを再同期"}
          </Button>

          <Button
            variant="outline"
            className="justify-start"
            disabled={isRepositorySyncing}
            onClick={() => setRepositorySyncConfirmOpen(true)}
          >
            <RefreshCw className={isRepositorySyncing ? "animate-spin" : undefined} />
            {isRepositorySyncing ? "リポジトリを再同期中..." : "リポジトリを再同期"}
          </Button>
        </div>
      </div>

      <Separator />

      <WorkflowTagStatusSection open={active} />

      <Separator />

      <SecretsSyncSection open={active} />

      <Separator />

      <FineGrainedTokensSection
        data={fineGrainedTokens.data}
        isLoading={fineGrainedTokens.isLoading}
        error={fineGrainedTokens.error}
        onChanged={fineGrainedTokens.refetch}
      />

      <AlertDialog open={issueSyncConfirmOpen} onOpenChange={setIssueSyncConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Issueを再同期しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              GitHub上の最新のIssue情報を取得し直します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleIssueSync}>再同期する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={repositorySyncConfirmOpen} onOpenChange={setRepositorySyncConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>リポジトリを再同期しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              GitHub上の最新のリポジトリ情報（対応状況を含む）を取得し直します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleRepositorySync}>再同期する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
