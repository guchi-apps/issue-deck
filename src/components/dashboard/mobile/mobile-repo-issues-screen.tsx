"use client";

import { useState } from "react";
import { ArrowLeft, ChevronDown, FolderGit2, MoreHorizontal, SlidersHorizontal } from "lucide-react";

import { IssueList } from "@/components/dashboard/issue-list";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";
import type { IssueState, MockIssue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type MobileRepoIssuesScreenProps = {
  repository: ConnectedRepository;
  issues: MockIssue[];
  selectedIssueId: string | null;
  onSelectIssue: (issue: MockIssue) => void;
  onBack: () => void;
};

export function MobileRepoIssuesScreen({
  repository,
  issues,
  selectedIssueId,
  onSelectIssue,
  onBack,
}: MobileRepoIssuesScreenProps) {
  const [stateFilter, setStateFilter] = useState<IssueState>("open");

  const repoIssues = issues.filter(
    (issue) => issue.repositoryFullName === repository.fullName && issue.state === stateFilter,
  );
  const color = getRepoColor(repository.fullName);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b p-4">
        <button type="button" onClick={onBack}>
          <ArrowLeft className="size-5" />
        </button>
        <span className="text-sm text-muted-foreground">リポジトリ</span>
      </header>

      <div className="flex items-center justify-between border-b p-4">
        <div className="flex items-center gap-2">
          <span
            className="flex size-9 items-center justify-center rounded"
            style={{ backgroundColor: `${color}20`, color }}
          >
            <FolderGit2 className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">{repository.name}</h1>
            <p className="text-xs text-muted-foreground">
              {repository.private ? "Private" : "Public"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className="rounded-md border p-1.5">
            <SlidersHorizontal className="size-4" />
          </button>
          <button type="button" className="rounded-md border p-1.5">
            <MoreHorizontal className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto border-b p-3">
        <button
          type="button"
          onClick={() => setStateFilter("open")}
          className={cn(
            "rounded-full border px-3 py-1 text-xs whitespace-nowrap",
            stateFilter === "open" && "border-primary bg-primary/10 text-primary",
          )}
        >
          オープン
        </button>
        <button
          type="button"
          onClick={() => setStateFilter("closed")}
          className={cn(
            "rounded-full border px-3 py-1 text-xs whitespace-nowrap",
            stateFilter === "closed" && "border-primary bg-primary/10 text-primary",
          )}
        >
          クローズ
        </button>
        <button type="button" className="flex items-center gap-1 rounded-full border px-3 py-1 text-xs whitespace-nowrap">
          ラベル
          <ChevronDown className="size-3" />
        </button>
        <button type="button" className="flex items-center gap-1 rounded-full border px-3 py-1 text-xs whitespace-nowrap">
          担当者
          <ChevronDown className="size-3" />
        </button>
      </div>

      <IssueList
        title={repository.name}
        issues={repoIssues}
        selectedIssueId={selectedIssueId}
        onSelectIssue={onSelectIssue}
        showSearch={false}
        showHeader={false}
        className="flex-1"
      />
    </div>
  );
}
