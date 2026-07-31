"use client";

import { ArrowLeft } from "lucide-react";

import { IssueList } from "@/components/dashboard/issue-list";
import type { Issue } from "@/types/issue";

type MobileViewIssuesScreenProps = {
  title: string;
  issues: Issue[];
  selectedIssueId: string | null;
  onSelectIssue: (issue: Issue) => void;
  onBack: () => void;
};

export function MobileViewIssuesScreen({
  title,
  issues,
  selectedIssueId,
  onSelectIssue,
  onBack,
}: MobileViewIssuesScreenProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b p-4">
        <button type="button" onClick={onBack}>
          <ArrowLeft className="size-5" />
        </button>
        <span className="text-sm font-semibold">{title}</span>
      </header>

      <IssueList
        title={title}
        issues={issues}
        selectedIssueId={selectedIssueId}
        onSelectIssue={onSelectIssue}
        showSearch={false}
        showHeader={false}
        className="flex-1"
      />
    </div>
  );
}
