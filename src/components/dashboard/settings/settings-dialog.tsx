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
import { NotificationSettingsSection } from "@/components/dashboard/settings/notification-settings-section";
import { RepositoryVisibilitySection } from "@/components/dashboard/settings/repository-visibility-section";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  type SettingsSectionKey,
} from "@/components/dashboard/settings/settings-sections";
import { StatusSection } from "@/components/dashboard/settings/status-section";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSettingsData } from "@/hooks/use-settings-data";
import { cn } from "@/lib/utils";
import type { AppAiModel, ClaudeModel, CodexModel } from "@/lib/app-settings";
import type { ConnectedRepository } from "@/types/repository";
import type { CurrentUser } from "@/types/user";

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUser: CurrentUser | null;
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  claudeModelAssist: ClaudeModel;
  claudeLocalModel: ClaudeModel;
  codexModel: CodexModel;
  appAiModel: AppAiModel;
  appAiModelReasoning: AppAiModel;
  dispatchConcurrency: number;
  repositories: ConnectedRepository[];
  onSetRepositoryHidden: (repository: ConnectedRepository, hidden: boolean) => void;
  onSetRepositoriesHidden: (repositories: ConnectedRepository[], hidden: boolean) => void;
  onSetRepositoryIssueCreationExcluded: (repository: ConnectedRepository, excluded: boolean) => void;
  onUpdated: (values: AppSettingsValues) => void;
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
  appAiModel,
  appAiModelReasoning,
  dispatchConcurrency,
  repositories,
  onSetRepositoryHidden,
  onSetRepositoriesHidden,
  onSetRepositoryIssueCreationExcluded,
  onUpdated,
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
            {SETTINGS_SECTIONS.map((item) => {
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
                <RepositoryVisibilitySection
                  repositories={repositories}
                  onSetRepositoryHidden={onSetRepositoryHidden}
                  onSetRepositoriesHidden={onSetRepositoriesHidden}
                  onSetRepositoryIssueCreationExcluded={onSetRepositoryIssueCreationExcluded}
                />
              )}
              {section === "notification" && <NotificationSettingsSection />}
              {section === "execution" && (
                <ExecutionSettingsSection
                  autoRetryLimit={autoRetryLimit}
                  claudeModel={claudeModel}
                  claudeModelAssist={claudeModelAssist}
                  claudeLocalModel={claudeLocalModel}
                  codexModel={codexModel}
                  appAiModel={appAiModel}
                  appAiModelReasoning={appAiModelReasoning}
                  dispatchConcurrency={dispatchConcurrency}
                  onUpdated={onUpdated}
                />
              )}
              {section === "fleet" && (
                <FleetOpsSection
                  fineGrainedTokens={data.fineGrainedTokens}
                  expiringFineGrainedTokenCount={data.expiringFineGrainedTokenCount}
                />
              )}
              {section === "images" && <ImagesSection />}
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
