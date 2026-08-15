"use client";

import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";
import {
  isLabelFilterPresetActive,
  LABEL_FILTER_PRESETS,
  resolveLabelFilterPresetSelection,
} from "@/lib/github/approval-labels";
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
  /**
   * 運用ラベルのプリセット（ユーザーの確認待ち・実行中など）を表示するか。
   * Issue一覧画面ではビュー（viewクエリ）として上部のチップで選べるため、
   * 二重の導線にならないよう非表示にする。
   */
  showLabelPresets?: boolean;
  /**
   * 「ユーザーの確認待ち」ビューでは並び順を確認が古い順に固定するため、
   * 並び順選択セクションを非表示にする。
   */
  sortLocked?: boolean;
  /**
   * リポジトリごとのグルーピング表示（#849）のON/OFF。onChangeGroupByRepoを
   * 指定した場合のみ「表示」セクションを出す（リポジトリ別一覧では対象外のため省略する）。
   */
  groupByRepo?: boolean;
  onChangeGroupByRepo?: (value: boolean) => void;
  /**
   * いま効いている絞り込み条件の数（`countActiveIssueFilters`）。1件以上のときだけ
   * 見出しの右に「すべて解除」を出す（#1645）。
   */
  activeFilterCount?: number;
  onClearFilters?: () => void;
};

const LABEL_COLLAPSE_THRESHOLD = 8;

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
        "flex h-11 items-center rounded-full bg-muted px-4 text-sm whitespace-nowrap text-muted-foreground",
        active && "bg-primary/10 text-primary",
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
  showLabelPresets = true,
  sortLocked = false,
  groupByRepo = false,
  onChangeGroupByRepo,
  activeFilterCount = 0,
  onClearFilters,
}: MobileIssueFilterSheetProps) {
  const [showAllLabels, setShowAllLabels] = useState(false);

  function toggleLabel(name: string) {
    const next = filters.labels.includes(name)
      ? filters.labels.filter((label) => label !== name)
      : [...filters.labels, name];
    onChange({ ...filters, labels: next });
  }

  const canCollapseLabels = labelOptions.length > LABEL_COLLAPSE_THRESHOLD;
  const visibleLabelOptions =
    canCollapseLabels && !showAllLabels
      ? labelOptions.filter(
          (label, index) => index < LABEL_COLLAPSE_THRESHOLD || filters.labels.includes(label.name),
        )
      : labelOptions;
  const hiddenLabelCount = labelOptions.length - visibleLabelOptions.length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto overscroll-contain">
        {/* mr-8はSheetContentが右上に出す閉じるボタンの逃げ */}
        <SheetHeader className="flex-row items-center justify-between gap-2">
          <SheetTitle>絞り込み・並び替え</SheetTitle>
          {activeFilterCount > 0 && onClearFilters && (
            <button
              type="button"
              onClick={onClearFilters}
              className="mr-8 shrink-0 text-sm text-primary"
            >
              すべて解除（{activeFilterCount}）
            </button>
          )}
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

          {showLabelPresets && (
            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted-foreground">絞り込み</h3>
              <div className="flex flex-wrap gap-2">
                {/* 進捗Status・excludeLabelsで定義されるプリセット（実行中・未着手等）は
                    labels配列のトグルでは表現できないため除外する。それらはビュー
                    （viewクエリ）側で選ぶ（#991 Phase 5でラベル配列マッチを廃止した） */}
                {LABEL_FILTER_PRESETS.filter((preset) => preset.labels.length > 0).map((preset) => {
                  const active = isLabelFilterPresetActive(filters.labels, preset);
                  return (
                    <Pill
                      key={preset.key}
                      active={active}
                      onClick={() =>
                        onChange({
                          ...filters,
                          ...resolveLabelFilterPresetSelection(preset, active),
                        })
                      }
                    >
                      {preset.label}
                    </Pill>
                  );
                })}
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground">ラベル</h3>
            {labelOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">ラベルがありません</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {visibleLabelOptions.map((label) => (
                    <Pill
                      key={label.name}
                      active={filters.labels.includes(label.name)}
                      onClick={() => toggleLabel(label.name)}
                    >
                      {label.name}
                    </Pill>
                  ))}
                </div>
                {canCollapseLabels && (
                  <button
                    type="button"
                    onClick={() => setShowAllLabels((prev) => !prev)}
                    className="mt-2 flex min-h-11 items-center text-sm text-primary hover:underline"
                  >
                    {showAllLabels ? "折りたたむ" : `すべて表示する（+${hiddenLabelCount}）`}
                  </button>
                )}
              </>
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

          {sortLocked ? (
            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted-foreground">並び順</h3>
              <p className="text-xs text-muted-foreground">
                確認待ちビューでは確認が古い順に固定されます
              </p>
            </section>
          ) : (
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
          )}

          {onChangeGroupByRepo && (
            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted-foreground">表示</h3>
              <div className="flex flex-wrap gap-2">
                <Pill active={!groupByRepo} onClick={() => onChangeGroupByRepo(false)}>
                  まとめて表示
                </Pill>
                <Pill active={groupByRepo} onClick={() => onChangeGroupByRepo(true)}>
                  リポジトリごとに分ける
                </Pill>
              </div>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
