"use client";

import { useState } from "react";
import { Boxes, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";

import { SecretsSyncSection } from "@/components/dashboard/secrets-sync-section";
import { FineGrainedTokensSection } from "@/components/dashboard/settings/fine-grained-tokens-section";
import { LazyFleetPanel } from "@/components/dashboard/settings/lazy-fleet-panel";
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
  fineGrainedTokens: SettingsData["fineGrainedTokens"];
  /** 期限切れ・期限が近いPATの件数。**開かなくても気づけるように**見出しへ出す（#2022） */
  expiringFineGrainedTokenCount: number;
};

/**
 * 設定の「フリート運用」区分（#1539）。**押した瞬間に走る操作だけ**を置く。
 *
 * 保存ボタンは無い。ここに保存が要る設定値を混ぜると、元の「保存がどこまで効くのか
 * 分からない」状態に戻る。設定値は`ExecutionSettingsSection`へ置くこと。
 *
 * **中の3区画は`LazyFleetPanel`で畳む**（#2022）。この区分を開いただけで、共有ワークフローの
 * タグ照会（GitHubへの一括問い合わせ）とシークレット同期の履歴が走っていたのをやめるため。
 * 上の「GitHubからの再取得」は押すまで何も起こさないので、畳まずそのまま置く。
 *
 * **PATのカードだけは畳んでも取得が減らない。** 一覧は設定画面が先に取っており
 * （`useSettingsData`。左タブの警告バッジの材料になる）、ここでは表示を畳むだけ。
 * 代わりに件数を見出しへ出し、開かなくても期限切れに気づけるようにしている。
 */
export function FleetOpsSection({
  fineGrainedTokens,
  expiringFineGrainedTokenCount,
}: FleetOpsSectionProps) {
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

      {/* 参照タグの更新と自動修復の配布は**同じ`/api/workflow-tags`の1回の取得**から出している。
          Issueでは別項目だが、カードを分けると同じ取得が2回走るため1枚にまとめる（#2022） */}
      <LazyFleetPanel
        icon={Boxes}
        title="共有ワークフローの配布"
        description="参照タグの更新と、自動修復ワークフローの配布"
        loadHint="開くと各リポジトリの参照状況をGitHubへ問い合わせます"
      >
        <WorkflowTagStatusSection open />
      </LazyFleetPanel>

      <LazyFleetPanel
        icon={KeyRound}
        title="1Password → GitHub のシークレット同期"
        description="値の正である1Passwordから、各リポジトリのsecret / variableへ写す"
        loadHint="開くと直近の実行結果を取得します（1Passwordの枠は消費しません）"
      >
        <SecretsSyncSection open />
      </LazyFleetPanel>

      <LazyFleetPanel
        icon={ShieldCheck}
        title="Fine-grained PATの有効期限"
        description="期限を管理しているPATの一覧"
        badge={
          expiringFineGrainedTokenCount > 0 ? (
            <span className="shrink-0 self-center rounded-full border border-destructive/40 px-2 py-0.5 text-[11px] text-destructive tabular-nums">
              期限切れ間近 {expiringFineGrainedTokenCount}
            </span>
          ) : null
        }
      >
        <FineGrainedTokensSection
          data={fineGrainedTokens.data}
          isLoading={fineGrainedTokens.isLoading}
          error={fineGrainedTokens.error}
          onChanged={fineGrainedTokens.refetch}
        />
      </LazyFleetPanel>

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
