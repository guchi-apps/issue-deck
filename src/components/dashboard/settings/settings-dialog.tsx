"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";

import { AccountSection } from "@/components/dashboard/settings/account-section";
import {
  ExecutionSettingsSection,
  type AppSettingsValues,
} from "@/components/dashboard/settings/execution-settings-section";
import { FleetOpsSection } from "@/components/dashboard/settings/fleet-ops-section";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  type SettingsSectionKey,
} from "@/components/dashboard/settings/settings-sections";
import { StatusSection } from "@/components/dashboard/settings/status-section";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSettingsData } from "@/hooks/use-settings-data";
import { cn } from "@/lib/utils";
import type { ClaudeModel } from "@/lib/app-settings";
import type { CurrentUser } from "@/types/user";

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUser: CurrentUser | null;
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  claudeModelAssist: ClaudeModel;
  dispatchConcurrency: number;
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
  dispatchConcurrency,
  onUpdated,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSectionKey>(DEFAULT_SETTINGS_SECTION);
  const data = useSettingsData(open);

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
          </nav>

          <div className="flex min-w-0 flex-col overflow-y-auto">
            <div className="border-b px-5 py-2.5">
              <p className="text-xs text-muted-foreground">{activeSection?.description}</p>
            </div>
            <div className="p-5">
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
                <FleetOpsSection active={open} fineGrainedTokens={data.fineGrainedTokens} />
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
