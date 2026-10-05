"use client";

import { useState } from "react";
import { Boxes, KeyRound, Link2, RefreshCw, ScanSearch, ShieldCheck } from "lucide-react";

import { SecretsSyncSection } from "@/components/dashboard/secrets-sync-section";
import { FineGrainedTokensSection } from "@/components/dashboard/settings/fine-grained-tokens-section";
import { LazyFleetPanel } from "@/components/dashboard/settings/lazy-fleet-panel";
import type { ReviewGateIssueDraft } from "@/lib/review-gate-issue-draft";
import { ReviewGateSection } from "@/components/dashboard/settings/review-gate-section";
import { SharedTokensSection } from "@/components/dashboard/settings/shared-tokens-section";
import { SupabaseRedirectUrlsSection } from "@/components/dashboard/settings/supabase-redirect-urls-section";
import { WorkflowTagSummaryBadge } from "@/components/dashboard/settings/workflow-tag-summary-badge";
import { WorkflowTagStatusView } from "@/components/dashboard/workflow-tag-status";
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
import { useWorkflowTags } from "@/hooks/use-workflow-tags";
import { useIssueSync } from "@/hooks/use-issue-sync";
import { useRepositorySync } from "@/hooks/use-repository-sync";
import type { SettingsData } from "@/hooks/use-settings-data";

type FleetOpsSectionProps = {
  fineGrainedTokens: SettingsData["fineGrainedTokens"];
  sharedTokens: SettingsData["sharedTokens"];
  /** 期限切れ・期限が近いPATの件数。**開かなくても気づけるように**見出しへ出す（#2022） */
  expiringFineGrainedTokenCount: number;
  /** 「Claudeレビューの実行条件」から条件変更Issueの下書きを開く（#3590） */
  onDraftReviewGateIssue?: (draft: ReviewGateIssueDraft) => void;
  creatableRepositoryNames?: readonly string[];
};

function GroupHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="border-b pb-1 text-xs font-semibold tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

/**
 * 設定の「フリート運用」区分（#1539）。押した瞬間に走る操作（再取得・配布・同期）と、
 * 保存ボタンを持たない認証情報の管理・閲覧（#3767で見出しを分けた）を置く。
 *
 * 保存ボタンは無い。ここに保存が要る設定値を混ぜると、元の「保存がどこまで効くのか
 * 分からない」状態に戻る。設定値は`ExecutionSettingsSection`へ置くこと。
 *
 * **中の3区画は`LazyFleetPanel`で畳む**（#2022）。この区分を開いただけで、共有ワークフローの
 * タグ照会（GitHubへの一括問い合わせ）とシークレット同期の履歴が走っていたのをやめるため。
 * 先頭の「GitHubからの再取得」は押すまで何も起こさないので、畳まないカードで置く。
 *
 * **PATのカードだけは畳んでも取得が減らない。** 一覧は設定画面が先に取っており
 * （`useSettingsData`。左タブの警告バッジの材料になる）、ここでは表示を畳むだけ。
 * 代わりに件数を見出しへ出し、開かなくても期限切れに気づけるようにしている。
 *
 * **共有ワークフローの配布だけは、この区分を開いた時点で取得する**（#4016）。配布忘れに開く前から
 * 気づけるよう、見出しへ状態バッジ（`summarizeWorkflowTags`）を出すため。取得は期限付きの共有
 * キャッシュ（`workflow-tags-store.ts`）に載り、開閉や複数表示で重ならない。
 */
export function FleetOpsSection({
  fineGrainedTokens,
  sharedTokens,
  expiringFineGrainedTokenCount,
  onDraftReviewGateIssue,
  creatableRepositoryNames,
}: FleetOpsSectionProps) {
  const { isSyncing: isIssueSyncing, handleSync: handleIssueSync } = useIssueSync();
  const { isSyncing: isRepositorySyncing, handleSync: handleRepositorySync } =
    useRepositorySync();
  // 設定画面を開いた時点で状態を取り、見出しのバッジと詳細で同じ取得を共有する（#4016）。
  // 取得は期限付きの共有キャッシュに載るため、開閉や複数表示で重ならない
  const workflowTags = useWorkflowTags(true);
  const [issueSyncConfirmOpen, setIssueSyncConfirmOpen] = useState(false);
  const [repositorySyncConfirmOpen, setRepositorySyncConfirmOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <GroupHeading>配布・同期</GroupHeading>

      {/* 畳まないカード。押すまで何も起こさないので、`LazyFleetPanel`にすると手数が増えるだけ */}
      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <RefreshCw className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">GitHubからの再取得</span>
        </div>
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

      {/* 参照タグの更新と自動修復の配布は**同じ`/api/workflow-tags`の1回の取得**から出している。
          Issueでは別項目だが、カードを分けると同じ取得が2回走るため1枚にまとめる（#2022） */}
      <LazyFleetPanel
        icon={Boxes}
        title="共有ワークフローの配布"
        description="参照タグの更新と、自動修復ワークフローの配布"
        status={(open) => <WorkflowTagSummaryBadge tags={workflowTags} onOpen={open} />}
      >
        <WorkflowTagStatusView tags={workflowTags} />
      </LazyFleetPanel>

      {/* 読み取りだけの区画だが、中身がcallerの設定値そのものなので配布の隣に置く（#2948）。
          PRのチェックまで読むぶん重く、配布カードの取得には相乗りさせない */}
      <LazyFleetPanel
        icon={ScanSearch}
        title="Claudeレビューの実行条件"
        description="develop向けPRでclaude-reviewが走る条件と、直近の実行状況"
        loadHint="開くと各リポジトリのcallerと直近のdevelop向けPRをGitHubへ問い合わせます"
      >
        <ReviewGateSection
          open
          onDraftIssue={onDraftReviewGateIssue}
          creatableRepositoryNames={creatableRepositoryNames}
        />
      </LazyFleetPanel>

      <GroupHeading>認証情報</GroupHeading>

      <LazyFleetPanel
        icon={KeyRound}
        title="1Password → GitHub のシークレット同期"
        description="値の正である1Passwordから、各リポジトリのsecret / variableへ写す"
        loadHint="開くと直近の実行結果を取得します（1Passwordの枠は消費しません）"
      >
        <SecretsSyncSection open />
      </LazyFleetPanel>

      <LazyFleetPanel
        icon={KeyRound}
        title="アプリ間共有トークン"
        description="1Passwordから移した認証値と利用状況を管理"
      >
        <SharedTokensSection
          data={sharedTokens.data}
          isLoading={sharedTokens.isLoading}
          error={sharedTokens.error}
          onChanged={sharedTokens.refetch}
        />
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

      <LazyFleetPanel
        icon={Link2}
        title="Supabase Redirect URLs"
        description="共有Supabaseプロジェクトの認証で許可するリダイレクト先"
        loadHint="開くとManagement APIから現在の登録内容を取得します"
      >
        <SupabaseRedirectUrlsSection open />
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
