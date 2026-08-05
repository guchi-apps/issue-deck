"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DeployCheckStatus, Issue } from "@/types/issue";

const UNCHECKED_VALUE = "unchecked";

const DEPLOY_CHECK_OPTIONS: { value: DeployCheckStatus; label: string }[] = [
  { value: "ok", label: "✅ OK" },
  { value: "ng", label: "⚠️ NG" },
  { value: "skip", label: "— スキップ" },
];

type ReleaseDeployChecklistProps = {
  issues: Issue[];
  onSetDeployCheck: (issue: Issue, status: DeployCheckStatus | null) => void;
};

/**
 * 直近リリースでmainへ反映されたIssueを一覧表示し、Issueごとに本番での反映確認状況
 * （未確認／OK／NG／スキップ）を選択できるチェックリスト（#534）。
 */
export function ReleaseDeployChecklist({ issues, onSetDeployCheck }: ReleaseDeployChecklistProps) {
  if (issues.length === 0) return null;

  const uncheckedCount = issues.filter((issue) => issue.deployCheckStatus === null).length;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-2">
      <p className="text-xs font-medium text-muted-foreground">本番反映の確認</p>
      <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto text-xs">
        {issues.map((issue) => (
          <li key={issue.id} className="flex items-center justify-between gap-2">
            <a
              href={issue.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate hover:underline"
              title={issue.title}
            >
              #{issue.number} {issue.title}
            </a>
            <Select
              value={issue.deployCheckStatus ?? UNCHECKED_VALUE}
              onValueChange={(value) =>
                onSetDeployCheck(issue, value === UNCHECKED_VALUE ? null : (value as DeployCheckStatus))
              }
            >
              <SelectTrigger size="sm" className="w-28 shrink-0 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNCHECKED_VALUE}>未確認</SelectItem>
                {DEPLOY_CHECK_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </li>
        ))}
      </ul>
      {uncheckedCount === 0 && <p className="text-xs text-muted-foreground">すべて確認済みです。</p>}
    </div>
  );
}
