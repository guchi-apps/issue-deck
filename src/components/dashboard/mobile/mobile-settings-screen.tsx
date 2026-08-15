"use client";

import { useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";

import { UserAvatar } from "@/components/dashboard/user-avatar";
import { AccountSection } from "@/components/dashboard/settings/account-section";
import {
  ExecutionSettingsSection,
  type AppSettingsValues,
} from "@/components/dashboard/settings/execution-settings-section";
import { FleetOpsSection } from "@/components/dashboard/settings/fleet-ops-section";
import {
  SETTINGS_SECTIONS,
  type SettingsSectionKey,
} from "@/components/dashboard/settings/settings-sections";
import { StatusSection } from "@/components/dashboard/settings/status-section";
import { useSettingsData } from "@/hooks/use-settings-data";
import type { ClaudeModel } from "@/lib/app-settings";
import type { CurrentUser } from "@/types/user";

type MobileSettingsScreenProps = {
  currentUser: CurrentUser | null;
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  claudeModelAssist: ClaudeModel;
  dispatchConcurrency: number;
  onUpdated: (values: AppSettingsValues) => void;
};

/**
 * スマホの設定画面（#1539）。PCの設定ダイアログと**同じ`SETTINGS_SECTIONS`**を一覧にし、
 * タップで各区分へ入る。中身のコンポーネントもPCと共有しているため、片方だけ直して
 * 表示が食い違うことがない。器（全画面かダイアログか）だけがPCと違う。
 */
export function MobileSettingsScreen({
  currentUser,
  autoRetryLimit,
  claudeModel,
  claudeModelAssist,
  dispatchConcurrency,
  onUpdated,
}: MobileSettingsScreenProps) {
  const [section, setSection] = useState<SettingsSectionKey | null>(null);
  const data = useSettingsData(true);

  const alerts: Partial<Record<SettingsSectionKey, boolean>> = {
    fleet: data.hasExpiringFineGrainedToken,
    status: data.hasGithubIncident,
  };
  const activeSection = SETTINGS_SECTIONS.find((item) => item.key === section);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b p-4">
        {activeSection && (
          <button
            type="button"
            onClick={() => setSection(null)}
            className="-ml-2 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            aria-label="戻る"
          >
            <ChevronLeft className="size-5" />
          </button>
        )}
        <h1 className="text-base font-semibold">{activeSection?.label ?? "設定"}</h1>
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
          </>
        )}

        {section === "account" && <AccountSection currentUser={currentUser} />}
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
          <FleetOpsSection active fineGrainedTokens={data.fineGrainedTokens} />
        )}
        {section === "status" && (
          <StatusSection
            rateLimits={data.rateLimits}
            apiUsage={data.apiUsage}
            claudeUsage={data.claudeUsage}
            githubStatus={data.githubStatus}
          />
        )}
      </div>
    </div>
  );
}
