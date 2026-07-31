"use client";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";
import { cn } from "@/lib/utils";
import type { LabelSummary } from "@/types/issue";

export type MobileIssueLocalFilters = {
  state: IssueStateFilter;
  labels: string[];
  assignee: string | null;
  sort: IssueSort;
};

type MobileIssueFilterSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: MobileIssueLocalFilters;
  onChange: (filters: MobileIssueLocalFilters) => void;
  labelOptions: LabelSummary[];
  assigneeOptions: string[];
};

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs whitespace-nowrap",
        active && "border-primary bg-primary/10 text-primary",
      )}
    >
      {children}
    </button>
  );
}

export function MobileIssueFilterSheet({
  open,
  onOpenChange,
  filters,
  onChange,
  labelOptions,
  assigneeOptions,
}: MobileIssueFilterSheetProps) {
  function toggleLabel(name: string) {
    const next = filters.labels.includes(name)
      ? filters.labels.filter((label) => label !== name)
      : [...filters.labels, name];
    onChange({ ...filters, labels: next });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>絞り込み・並び替え</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-6 p-4 pt-0">
          <section>
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground">状態</h3>
            <div className="flex flex-wrap gap-2">
              <Pill active={filters.state === "all"} onClick={() => onChange({ ...filters, state: "all" })}>
                すべて
              </Pill>
              <Pill active={filters.state === "open"} onClick={() => onChange({ ...filters, state: "open" })}>
                Open
              </Pill>
              <Pill
                active={filters.state === "closed"}
                onClick={() => onChange({ ...filters, state: "closed" })}
              >
                Closed
              </Pill>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground">ラベル</h3>
            {labelOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">ラベルがありません</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {labelOptions.map((label) => (
                  <Pill
                    key={label.name}
                    active={filters.labels.includes(label.name)}
                    onClick={() => toggleLabel(label.name)}
                  >
                    {label.name}
                  </Pill>
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground">担当者</h3>
            <div className="flex flex-wrap gap-2">
              <Pill
                active={filters.assignee === null}
                onClick={() => onChange({ ...filters, assignee: null })}
              >
                すべて
              </Pill>
              <Pill
                active={filters.assignee === "unassigned"}
                onClick={() => onChange({ ...filters, assignee: "unassigned" })}
              >
                未設定
              </Pill>
              {assigneeOptions.map((login) => (
                <Pill
                  key={login}
                  active={filters.assignee === login}
                  onClick={() => onChange({ ...filters, assignee: login })}
                >
                  {login}
                </Pill>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground">並び順</h3>
            <div className="flex flex-wrap gap-2">
              <Pill active={filters.sort === "updated"} onClick={() => onChange({ ...filters, sort: "updated" })}>
                更新日
              </Pill>
              <Pill active={filters.sort === "created"} onClick={() => onChange({ ...filters, sort: "created" })}>
                作成日
              </Pill>
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
