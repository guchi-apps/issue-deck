"use client";

import { useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";

import { MobileDispatchStatusButton } from "@/components/dashboard/mobile/mobile-dispatch-status-button";
import { MobileNotificationButton } from "@/components/dashboard/mobile/mobile-notification-button";
import { UserAvatar } from "@/components/dashboard/user-avatar";
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
  SETTINGS_SECTIONS,
  type SettingsSectionKey,
} from "@/components/dashboard/settings/settings-sections";
import { StatusSection } from "@/components/dashboard/settings/status-section";
import { useSettingsData } from "@/hooks/use-settings-data";
import type { ClaudeModel } from "@/lib/app-settings";
import type { ConnectedRepository } from "@/types/repository";
import type { CurrentUser } from "@/types/user";

type MobileSettingsScreenProps = {
  /**
   * 設定の一覧から前の画面へ戻る（#1638）。フッターのタブから外し、ホームのヘッダーの
   * 歯車から開く画面になったため、区分の中だけでなくトップレベルにも戻る導線が要る。
   */
  onBack: () => void;
  currentUser: CurrentUser | null;
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  claudeModelAssist: ClaudeModel;
  dispatchConcurrency: number;
  repositories: ConnectedRepository[];
  onSetRepositoryHidden: (repository: ConnectedRepository, hidden: boolean) => void;
  onSetRepositoriesHidden: (repositories: ConnectedRepository[], hidden: boolean) => void;
  onUpdated: (values: AppSettingsValues) => void;
};

/**
 * スマホの設定画面（#1539）。PCの設定ダイアログと**同じ`SETTINGS_SECTIONS`**を一覧にし、
 * タップで各区分へ入る。中身のコンポーネントもPCと共有しているため、片方だけ直して
 * 表示が食い違うことがない。器（全画面かダイアログか）だけがPCと違う。
 */
export function MobileSettingsScreen({
  onBack,
  currentUser,
  autoRetryLimit,
  claudeModel,
  claudeModelAssist,
  dispatchConcurrency,
  repositories,
  onSetRepositoryHidden,
  onSetRepositoriesHidden,
  onUpdated,
}: MobileSettingsScreenProps) {
  const [section, setSection] = useState<SettingsSectionKey | null>(null);
  // 使用量・レート制限は「状態」を開いているあいだだけ取りに行く（#2022）
  const data = useSettingsData(true, section === "status");

  const alerts: Partial<Record<SettingsSectionKey, boolean>> = {
    fleet: data.hasExpiringFineGrainedToken,
    status: data.hasGithubIncident,
  };
  const activeSection = SETTINGS_SECTIONS.find((item) => item.key === section);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b py-2 pr-2 pl-4">
        {/* 区分の中では一覧へ、一覧では前の画面へ戻る（#1638。フッターにタブが無くなった） */}
        <button
          type="button"
          onClick={() => (activeSection ? setSection(null) : onBack())}
          className="-ml-2 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          aria-label="戻る"
        >
          <ChevronLeft className="size-5" />
        </button>
        <h1 className="flex-1 text-base font-semibold">{activeSection?.label ?? "設定"}</h1>
        <MobileDispatchStatusButton />
        {/* 通知ベル（#1772）。実行状況の右隣で全画面そろえる */}
        <MobileNotificationButton />
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">
        {activeSection === undefined && (
          <>
            <div className="flex items-center gap-3 rounded-lg border p-3">
              <UserAvatar
                login={currentUser?.login ?? "?"}
                image={currentUser?.image}
                className="size-10"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {currentUser?.name ?? currentUser?.login}
                </p>
                <p className="truncate text-xs text-muted-foreground">@{currentUser?.login}</p>
              </div>
            </div>

            <ul className="flex flex-col gap-2">
              {SETTINGS_SECTIONS.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      onClick={() => setSection(item.key)}
                      className="flex w-full items-center gap-3 rounded-lg border p-3 text-left hover:bg-accent"
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{item.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {item.description}
                        </span>
                      </span>
                      {alerts[item.key] ? (
                        <AlertTriangle className="ml-auto size-4 shrink-0 text-destructive" />
                      ) : (
                        <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* バージョンは区分の中ではなく一覧の最下部へ。設定を開けば必ず目に入り、
                押すと更新履歴へ入る（#1764） */}
            <div className="mt-auto border-t pt-3">
              <AppVersionButton onClick={() => setSection("changelog")} />
            </div>
          </>
        )}

        {section === "account" && <AccountSection currentUser={currentUser} />}
        {section === "display" && (
          <RepositoryVisibilitySection
            repositories={repositories}
            onSetRepositoryHidden={onSetRepositoryHidden}
            onSetRepositoriesHidden={onSetRepositoriesHidden}
          />
        )}
        {section === "notification" && <NotificationSettingsSection />}
        {section === "execution" && (
          <ExecutionSettingsSection
            autoRetryLimit={autoRetryLimit}
            claudeModel={claudeModel}
            claudeModelAssist={claudeModelAssist}
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
            claudeUsage={data.claudeUsage}
            codexUsage={data.codexUsage}
            claudeApiUsage={data.claudeApiUsage}
            githubStatus={data.githubStatus}
          />
        )}
        {section === "changelog" && <ChangelogSection />}
      </div>
    </div>
  );
}
