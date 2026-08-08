"use client";

import { Badge } from "@/components/ui/badge";
import type { GithubStatusSummary } from "@/lib/github/status";

type GithubStatusListProps = {
  data: GithubStatusSummary | null;
  isLoading: boolean;
  error: string | null;
};

const COMPONENT_STATUS_LABELS: Record<string, string> = {
  operational: "正常",
  degraded_performance: "性能低下",
  partial_outage: "一部障害",
  major_outage: "重大な障害",
  under_maintenance: "メンテナンス中",
};

export function GithubStatusList({ data, isLoading, error }: GithubStatusListProps) {
  return (
    <>
      {isLoading && <p className="text-xs text-muted-foreground">読み込み中...</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {data && (
        <div className="flex flex-col gap-3">
          <p
            className={
              data.indicator === "none"
                ? "text-sm text-muted-foreground"
                : "text-sm font-medium text-destructive"
            }
          >
            {data.description}
          </p>
          <ul className="flex flex-col gap-1.5">
            {data.components.map((component) => (
              <li
                key={component.id}
                className="flex items-center justify-between gap-2 rounded-lg border p-2 text-xs"
              >
                <span>{component.name}</span>
                <Badge variant={component.status === "operational" ? "outline" : "destructive"}>
                  {COMPONENT_STATUS_LABELS[component.status] ?? component.status}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
