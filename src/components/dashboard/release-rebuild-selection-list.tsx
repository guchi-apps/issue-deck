"use client";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { Checkbox } from "@/components/ui/checkbox";
import type { CiState } from "@/lib/github/release-api";
import type { RebuildSelectionOption } from "@/lib/release-rebuild-selection-run";
import { cn } from "@/lib/utils";

const CI_LABEL: Record<CiState, { text: string; className: string }> = {
  success: { text: "CI成功", className: "text-emerald-700 dark:text-emerald-400" },
  failure: { text: "CI失敗", className: "text-destructive" },
  pending: { text: "CI実行中", className: "text-amber-700 dark:text-amber-400" },
  unknown: { text: "CI不明", className: "text-muted-foreground" },
};

/**
 * 「修正を入れて作り直す」で元の候補へ足すPRの選択（#4335）。PC・スマホで同じ部品を使う。
 *
 * 既定で選ぶのは当該リリースの修正PRだけ（サーバーの`defaultSelected`）。未マージ・取り込み済みなど
 * 選べないPRは、理由を添えて押せない状態で並べる（選択を勝手に広げない・developのレビューを省かない）。
 */
export function ReleaseRebuildSelectionList({
  options,
  selected,
  onChange,
  disabled = false,
}: {
  options: RebuildSelectionOption[];
  selected: ReadonlySet<number>;
  onChange: (next: Set<number>) => void;
  disabled?: boolean;
}) {
  if (options.length === 0) {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-400">
        元の候補の後にdevelopへ入ったPRがありません。修正をdevelopへマージしてから押してください。
      </p>
    );
  }

  function toggle(number: number, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(number);
    else next.delete(number);
    onChange(next);
  }

  const chosen = options.filter((option) => selected.has(option.number));

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-md border" aria-label="元の候補へ足すPR">
        {options.map((option) => {
          const selectable = option.problem === null;
          const id = `rebuild-pr-${option.number}`;
          return (
            <li key={option.number} className={cn("flex min-w-0 items-start gap-2 p-2", !selectable && "opacity-70")}>
              <Checkbox
                id={id}
                className="mt-0.5"
                checked={selected.has(option.number)}
                disabled={disabled || !selectable}
                onCheckedChange={(value) => toggle(option.number, value === true)}
                aria-describedby={`${id}-state`}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
                <label htmlFor={id} className="break-words font-medium">
                  #{option.number} {option.title}
                </label>
                <p id={`${id}-state`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
                  {option.issueNumber !== null && <span>Issue #{option.issueNumber}</span>}
                  {option.relatedFix && (
                    <span className="rounded bg-purple-500/10 px-1 text-purple-700 dark:text-purple-300">このリリースの修正</span>
                  )}
                  <span>{option.merged ? "developへマージ済み" : "developへ未マージ"}</span>
                  {option.ciState && <span className={CI_LABEL[option.ciState].className}>{CI_LABEL[option.ciState].text}</span>}
                  {option.url && (
                    <GithubReferenceLink href={option.url} className="hover:underline">
                      PRを開く
                    </GithubReferenceLink>
                  )}
                </p>
                {option.problemLabel && <p className="text-amber-700 dark:text-amber-400">{option.problemLabel}</p>}
                {selectable && option.ciState === "failure" && (
                  <p className="text-amber-700 dark:text-amber-400">developでのCIが失敗しています。足すと後継の候補でも失敗する可能性があります。</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-xs">
        <span className="font-medium">追加される範囲:</span>{" "}
        {chosen.length === 0 ? "（未選択）" : chosen.map((option) => `#${option.number}`).join("、")}
        <span className="text-muted-foreground">
          {" "}
          — 選んだPRのdevelopへのマージ差分だけを元の候補へ足します。依存するPRが必要・競合するなどで当てられないときは、必要なPRを示して止まります（選択は自動では広げません）。
        </span>
      </p>
    </div>
  );
}
