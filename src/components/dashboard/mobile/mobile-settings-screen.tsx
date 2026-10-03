"use client";

import { useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, X } from "lucide-react";

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
import { KnowledgeSection } from "@/components/dashboard/settings/knowledge-section";
import { NotificationSettingsSection } from "@/components/dashboard/settings/notification-settings-section";
import { PostCreateDestinationSection } from "@/components/dashboard/settings/post-create-destination-section";
import { RepositoryVisibilitySection } from "@/components/dashboard/settings/repository-visibility-section";
import {
  SETTINGS_LIST_SECTIONS,
  SETTINGS_SECTIONS,
  type SettingsSectionKey,
} from "@/components/dashboard/settings/settings-sections";
import { StatusSection } from "@/components/dashboard/settings/status-section";
import { useSettingsData } from "@/hooks/use-settings-data";
import type {
  AppAiModel,
  ClaudeLocalModelSetting,
  ClaudeLocalModel,
  ClaudeModel,
  CodexModelSetting,
  CodexLocalModel,
  DefaultDispatchAgent,
  GithubActionsAgent,
  ModelPickEngine,
  PlanReviewAgent,
} from "@/lib/app-settings";
import type { ConnectedRepository } from "@/types/repository";
import type { ReviewGateIssueDraft } from "@/lib/review-gate-issue-draft";
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
  githubActionsAgent?: GithubActionsAgent;
  githubActionsCodexModel?: CodexLocalModel;
  claudeModelAssist: ClaudeModel;
  claudeLocalModel: ClaudeLocalModelSetting;
  codexModel: CodexModelSetting;
  defaultDispatchAgent?: DefaultDispatchAgent;
  planReviewAgentForClaude?: PlanReviewAgent;
  planReviewAgentForCodex?: PlanReviewAgent;
  planReviewClaudeModel?: ClaudeLocalModel;
  planReviewCodexModel?: CodexLocalModel;
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
 * スマホの設定画面（#1539）。PCの設定ダイアログと**同じ`SETTINGS_SECTIONS`**を一覧にし、
 * タップで各区分へ入る。中身のコンポーネントもPCと共有しているため、片方だけ直して
 * 表示が食い違うことがない。器（全画面かダイアログか）だけがPCと違う。
 */
export function MobileSettingsScreen({
  onBack,
  currentUser,
  autoRetryLimit,
  claudeModel,
  githubActionsAgent = "claude",
  githubActionsCodexModel = "gpt-5.6-terra",
  claudeModelAssist,
  claudeLocalModel,
  codexModel,
  defaultDispatchAgent = "claude",
  planReviewAgentForClaude = "claude",
  planReviewAgentForCodex = "codex",
  planReviewClaudeModel = "sonnet",
  planReviewCodexModel = "gpt-5.6-terra",
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
}: MobileSettingsScreenProps) {
  const [section, setSection] = useState<SettingsSectionKey | null>(null);
  // 使用量・レート制限は「状態」を開いているあいだだけ取りに行く（#2022）
  const data = useSettingsData(true);

  const alerts: Partial<Record<SettingsSectionKey, boolean>> = {
    fleet: data.hasExpiringFineGrainedToken,
    status: data.hasGithubIncident,
  };
  const activeSection = SETTINGS_SECTIONS.find((item) => item.key === section);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b py-2 pr-2 pl-4">
        {/* 区分の中では一覧へ戻り、一覧ではモーダルを閉じる（#1638・#3744）。
            戻る判定は選択中のキーで行う（見出しは全区分の定義から引く） */}
        <button
          type="button"
          onClick={() => (section !== null ? setSection(null) : onBack())}
          className="-ml-2 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          aria-label={section !== null ? "戻る" : "閉じる"}
        >
          {section !== null ? <ChevronLeft className="size-5" /> : <X className="size-5" />}
        </button>
        <h1 className="flex-1 text-base font-semibold">{activeSection?.label ?? "設定"}</h1>
        <MobileDispatchStatusButton />
        {/* 通知ベル（#1772）。実行状況の右隣で全画面そろえる */}
        <MobileNotificationButton />
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">
        {section === null && (
          <>
            {/* アカウント設定はアカウント名のカードを押して開く（#3744） */}
            <button
              type="button"
              onClick={() => setSection("account")}
              aria-label="アカウント設定"
              className="flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-accent"
            >
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
              <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
            </button>

            <ul className="flex flex-col gap-2">
              {SETTINGS_LIST_SECTIONS.map((item) => {
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
            githubActionsAgent={githubActionsAgent}
            githubActionsCodexModel={githubActionsCodexModel}
            claudeModelAssist={claudeModelAssist}
            claudeLocalModel={claudeLocalModel}
            codexModel={codexModel}
            defaultDispatchAgent={defaultDispatchAgent}
            planReviewAgentForClaude={planReviewAgentForClaude}
            planReviewAgentForCodex={planReviewAgentForCodex}
            planReviewClaudeModel={planReviewClaudeModel}
            planReviewCodexModel={planReviewCodexModel}
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
        {section === "knowledge" && <KnowledgeSection compact />}
        {section === "status" && (
          <StatusSection
            githubStatus={data.githubStatus}
          />
        )}
        {section === "changelog" && <ChangelogSection />}
      </div>
    </div>
  );
}
