"use client";

import { useState } from "react";
import { LogOut, RefreshCw, ShieldCheck } from "lucide-react";

import packageJson from "../../../../package.json";
import { ClaudeUsageCard } from "@/components/dashboard/claude-usage-card";
import { GithubRateLimitList } from "@/components/dashboard/github-rate-limit-list";
import { ProfileDialog } from "@/components/dashboard/profile-dialog";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Button } from "@/components/ui/button";
import { useAccountActions } from "@/hooks/use-account-actions";
import { useClaudeUsage } from "@/hooks/use-claude-usage";
import { useGithubRateLimit } from "@/hooks/use-github-rate-limit";
import { useIssueSync } from "@/hooks/use-issue-sync";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "@/lib/legal-links";
import type { CurrentUser } from "@/types/user";

type MobileSettingsScreenProps = {
  currentUser: CurrentUser | null;
};

export function MobileSettingsScreen({ currentUser }: MobileSettingsScreenProps) {
  const { handleLogout } = useAccountActions();
  const { isSyncing, handleSync } = useIssueSync();
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const { data: rateLimits, isLoading: rateLimitsLoading, error: rateLimitsError } =
    useGithubRateLimit(true);
  const {
    data: claudeUsage,
    isLoading: claudeUsageLoading,
    error: claudeUsageError,
    notConfigured: claudeUsageNotConfigured,
  } = useClaudeUsage(true);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b p-4">
        <h1 className="text-base font-semibold">設定</h1>
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        <button
          type="button"
          onClick={() => setProfileDialogOpen(true)}
          className="flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-accent"
        >
          <UserAvatar
            login={currentUser?.login ?? "?"}
            image={currentUser?.image}
            className="size-10"
          />
          <div>
            <p className="text-sm font-medium">{currentUser?.name ?? currentUser?.login}</p>
            <p className="text-xs text-muted-foreground">@{currentUser?.login}</p>
          </div>
        </button>

        <div className="rounded-lg border p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">GitHub API使用量</p>
          <GithubRateLimitList
            data={rateLimits}
            isLoading={rateLimitsLoading}
            error={rateLimitsError}
          />
        </div>

        <div className="rounded-lg border p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Claudeプラン使用量</p>
          <ClaudeUsageCard
            data={claudeUsage}
            isLoading={claudeUsageLoading}
            error={claudeUsageError}
            notConfigured={claudeUsageNotConfigured}
          />
        </div>

        <Button
          variant="outline"
          className="justify-start"
          disabled={isSyncing}
          onClick={handleSync}
        >
          <RefreshCw className={isSyncing ? "animate-spin" : undefined} />
          {isSyncing ? "再同期中..." : "今すぐ再同期"}
        </Button>

        <Button variant="outline" className="justify-start" asChild>
          <a href={TERMS_OF_SERVICE_URL} target="_blank" rel="noopener noreferrer">
            <ShieldCheck />
            利用規約
          </a>
        </Button>

        <Button variant="outline" className="justify-start" asChild>
          <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
            <ShieldCheck />
            プライバシーポリシー
          </a>
        </Button>

        <Button variant="destructive" className="justify-start" onClick={handleLogout}>
          <LogOut />
          ログアウト
        </Button>

        <p className="text-center text-xs text-muted-foreground">
          Issue Deck v{packageJson.version}
        </p>
      </div>

      <ProfileDialog
        currentUser={currentUser}
        open={profileDialogOpen}
        onOpenChange={setProfileDialogOpen}
      />
    </div>
  );
}
