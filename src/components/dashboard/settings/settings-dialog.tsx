"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";

import { AccountSection } from "@/components/dashboard/settings/account-section";
import { AppVersionButton } from "@/components/dashboard/settings/app-version-button";
import { ChangelogSection } from "@/components/dashboard/settings/changelog-section";
import {
  ExecutionSettingsSection,
  type AppSettingsValues,
} from "@/components/dashboard/settings/execution-settings-section";
import { FleetOpsSection } from "@/components/dashboard/settings/fleet-ops-section";
import { ImagesSection } from "@/components/dashboard/settings/images-section";
import { KnowledgeSection } from "@/components/dashboard/settings/knowledge-section";
import { NotificationSettingsSection } from "@/components/dashboard/settings/notification-settings-section";
import { PostCreateDestinationSection } from "@/components/dashboard/settings/post-create-destination-section";
import { RepositoryVisibilitySection } from "@/components/dashboard/settings/repository-visibility-section";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_LIST_SECTIONS,
  SETTINGS_SECTIONS,
  type SettingsSectionKey,
} from "@/components/dashboard/settings/settings-sections";
import { StatusSection } from "@/components/dashboard/settings/status-section";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSettingsData } from "@/hooks/use-settings-data";
import { cn } from "@/lib/utils";
import type {
  AppAiModel,
  ClaudeLocalModelSetting,
  ClaudeModel,
  CodexModelSetting,
  DefaultDispatchAgent,
  ModelPickEngine,
} from "@/lib/app-settings";
import type { ConnectedRepository } from "@/types/repository";
import type { ReviewGateIssueDraft } from "@/lib/review-gate-issue-draft";
import type { CurrentUser } from "@/types/user";

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUser: CurrentUser | null;
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  claudeModelAssist: ClaudeModel;
  claudeLocalModel: ClaudeLocalModelSetting;
  codexModel: CodexModelSetting;
  defaultDispatchAgent?: DefaultDispatchAgent;
  dispatchFailoverEnabled?: boolean;
  dispatchFailoverThresholdPercent?: number;
  appAiModel: AppAiModel;
  appAiModelReasoning: AppAiModel;
  modelPickEngine: ModelPickEngine;
  dispatchConcurrency: number;
  repositories: ConnectedRepository[];
  onSetRepositoryHidden: (repository: ConnectedRepository, hidden: boolean) => void;
  onSetRepositoriesHidden: (repositories: ConnectedRepository[], hidden: boolean) => void;
  onSetRepositoryIssueCreationExcluded: (repository: ConnectedRepository, excluded: boolean) => void;
  onUpdated: (values: AppSettingsValues) => void;
  onDraftReviewGateIssue?: (draft: ReviewGateIssueDraft) => void;
  creatableRepositoryNames?: readonly string[];
};

/**
 * PCの設定画面（#1539）。右上のアバターから開く1枚のダイアログで、左のタブで区分を切り替える。
 *
 * **なぜ1枚にしたか。** 以前は「アカウントメニュー」から「アプリ設定」をさらに開く入れ子で、
 * 戻る導線が無く、内側のダイアログが幅384pxだったためリポジトリ一覧が読めなかった。
 * 区分の定義（`SETTINGS_SECTIONS`）はスマホの設定画面と共有している。
 */
export function SettingsDialog({
  open,
  onOpenChange,
  currentUser,
  autoRetryLimit,
  claudeModel,
  claudeModelAssist,
  claudeLocalModel,
  codexModel,
  defaultDispatchAgent = "claude",
  dispatchFailoverEnabled = true,
  dispatchFailoverThresholdPercent = 90,
  appAiModel,
  appAiModelReasoning,
  modelPickEngine,
  dispatchConcurrency,
  repositories,
  onSetRepositoryHidden,
  onSetRepositoriesHidden,
  onSetRepositoryIssueCreationExcluded,
  onUpdated,
  onDraftReviewGateIssue,
  creatableRepositoryNames,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSectionKey>(DEFAULT_SETTINGS_SECTION);
  // 使用量・レート制限は「状態」を開いているあいだだけ取りに行く（#2022）
  const data = useSettingsData(open, section === "status");

  const alerts: Partial<Record<SettingsSectionKey, boolean>> = {
    fleet: data.hasExpiringFineGrainedToken,
    status: data.hasGithubIncident,
  };
  const activeSection = SETTINGS_SECTIONS.find((item) => item.key === section);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(40rem,calc(100%-2rem))] grid-rows-[auto_1fr] gap-0 overflow-x-hidden overflow-y-hidden p-0 sm:max-w-3xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>設定</DialogTitle>
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-[10rem_1fr]">
          <nav className="flex flex-col gap-0.5 overflow-y-auto border-r bg-muted/30 p-2">
            {/* アカウント設定は区分の一覧に並べず、アカウント名の行から開く（#3744） */}
            <button
              type="button"
              onClick={() => setSection("account")}
              aria-current={section === "account" ? "page" : undefined}
              aria-label="アカウント設定"
              className={cn(
                "mb-1.5 flex items-center gap-2 rounded-md border bg-background px-2 py-2 text-left",
                section === "account"
                  ? "border-primary ring-1 ring-primary"
                  : "hover:bg-accent",
              )}
            >
              <UserAvatar
                login={currentUser?.login ?? "?"}
                image={currentUser?.image}
                className="size-7 shrink-0"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {currentUser?.name ?? currentUser?.login}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  アカウント設定
                </span>
              </span>
            </button>
            {SETTINGS_LIST_SECTIONS.map((item) => {
              const Icon = item.icon;
              const isActive = item.key === section;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setSection(item.key)}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm",
                    isActive
                      ? "bg-background font-medium shadow-xs ring-1 ring-foreground/10"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                  {alerts[item.key] && (
                    <AlertTriangle className="ml-auto size-4 shrink-0 text-destructive" />
                  )}
                </button>
              );
            })}

            {/* バージョンは区分の外（左タブの最下部）に常設する。どの区分を開いていても
                目に入り、押すと更新履歴へ入る（#1764） */}
            <div className="mt-auto border-t pt-1.5">
              <AppVersionButton onClick={() => setSection("changelog")} />
            </div>
          </nav>

          <div className="flex min-w-0 flex-col overflow-y-auto">
            <div className="border-b px-5 py-2.5">
              <p className="text-xs text-muted-foreground">{activeSection?.description}</p>
            </div>
            <div className="p-5">
              {section === "account" && <AccountSection currentUser={currentUser} />}
              {section === "display" && (
                <div className="flex flex-col gap-5">
                  <PostCreateDestinationSection />
                  <RepositoryVisibilitySection
                    repositories={repositories}
                    onSetRepositoryHidden={onSetRepositoryHidden}
                    onSetRepositoriesHidden={onSetRepositoriesHidden}
                    onSetRepositoryIssueCreationExcluded={onSetRepositoryIssueCreationExcluded}
                  />
                </div>
              )}
              {section === "notification" && <NotificationSettingsSection />}
              {section === "execution" && (
                <ExecutionSettingsSection
                  autoRetryLimit={autoRetryLimit}
                  claudeModel={claudeModel}
                  claudeModelAssist={claudeModelAssist}
                  claudeLocalModel={claudeLocalModel}
                  codexModel={codexModel}
                  defaultDispatchAgent={defaultDispatchAgent}
                  dispatchFailoverEnabled={dispatchFailoverEnabled}
                  dispatchFailoverThresholdPercent={dispatchFailoverThresholdPercent}
                  appAiModel={appAiModel}
                  appAiModelReasoning={appAiModelReasoning}
                  modelPickEngine={modelPickEngine}
                  dispatchConcurrency={dispatchConcurrency}
                  onUpdated={onUpdated}
                />
              )}
              {section === "fleet" && (
                <FleetOpsSection
                  fineGrainedTokens={data.fineGrainedTokens}
                  sharedTokens={data.sharedTokens}
                  expiringFineGrainedTokenCount={data.expiringFineGrainedTokenCount}
                  onDraftReviewGateIssue={onDraftReviewGateIssue}
                  creatableRepositoryNames={creatableRepositoryNames}
                />
              )}
              {section === "images" && <ImagesSection />}
              {section === "knowledge" && <KnowledgeSection />}
        {section === "status" && (
                <StatusSection
                  rateLimits={data.rateLimits}
                  apiUsage={data.apiUsage}
                  actionsUsage={data.actionsUsage}
                  githubStatus={data.githubStatus}
                />
              )}
              {section === "changelog" && <ChangelogSection />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
