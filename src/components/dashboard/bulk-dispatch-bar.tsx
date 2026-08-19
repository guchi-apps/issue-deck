"use client";

import { useMemo, useState } from "react";
import { Loader2, Server } from "lucide-react";

import { StartOptionChip, START_OPTION_ICONS } from "@/components/dashboard/start-option-chip";
import { Button } from "@/components/ui/button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useRepositoryLabelNames } from "@/hooks/use-repository-label-names";
import { bulkDispatchableIssues, resolveBulkDispatchHost } from "@/lib/dispatch/bulk-dispatch";
import { enqueueIssueToDefaultHost } from "@/lib/dispatch/enqueue-issue";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  commonStartImplementationOptions,
  START_IMPLEMENTATION_DEFAULT_OPTIONS,
  type StartImplementationOptionKey,
} from "@/lib/github/start-implementation";
import type { Issue } from "@/types/issue";

/**
 * 選んだIssueをまとめてサブPCへ積むバー（#1266・#1993）。
 *
 * GitHub Actionsで並列に一括で流す使い方をやめた代わりに、**夜にまとめて積んで順に流す**
 * 手段が要る（#1261）。積んだぶんは`claimDispatchJob`が`createdAt`の昇順で払い出すので、
 * **選んだ順ではなく積んだ順に流れる**。
 *
 * **オプション（`21.plan-required`等）は1回だけ選び、選んだIssueすべてへ同じように付ける**
 * （#1993）。まとめて実行したいのは「同じ条件で流したいIssueが複数ある」ときで、条件を
 * Issueごとに選び直せる必要は無い。事故を減らすための縛りは3つ。
 *
 * - **既定は全部OFF。** 種別ラベルからの既定（`startImplementationOptionsFromLabels`）は
 *   Issueごとに違うため、一括では当てない。押したものだけが付く
 * - **既に付いているラベルは外さない**（`labelNamesWithLocal`は足すだけ）
 * - **選んだIssueで共通して選べるものしか出さない**（`commonStartImplementationOptions`）
 */
export function BulkDispatchBar({
  issues,
  dispatch,
  onClose,
}: {
  /** 選択中のIssue */
  issues: Issue[];
  dispatch: DispatchStateHandle;
  /** 選択モードを抜ける（積み終えたときと「やめる」を押したときの両方） */
  onClose: () => void;
}) {
  const { updateIssue } = useIssueMutations();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [options, setOptions] = useState(START_IMPLEMENTATION_DEFAULT_OPTIONS);

  const context = {
    hosts: dispatch.hosts,
    jobs: dispatch.jobs,
    sessions: dispatch.sessions,
  };
  // **選んだうち1件でも積めれば押せる。** 先頭のIssueだけで判定すると、そのリポジトリが
  // cloneされていないだけで、他のIssueまで積めなくなる
  const dispatchable = bulkDispatchableIssues(issues, context);
  const hostName = dispatchable[0] ? resolveBulkDispatchHost(dispatchable[0], context) : null;

  const repositoryFullNames = useMemo(
    () => [...new Set(issues.map((issue) => issue.repositoryFullName))],
    [issues],
  );
  const { labelNamesByRepository, isLoading: isLoadingLabels } =
    useRepositoryLabelNames(repositoryFullNames);
  const visibleOptions = commonStartImplementationOptions(labelNamesByRepository);
  // 出していないチップのぶんは付けない（選択したあとにリポジトリを足して消えた場合）
  const labelsToAdd = visibleOptions
    .filter((option) => options[option.key])
    .map((option) => option.githubLabel);

  function toggleOption(key: StartImplementationOptionKey) {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function enqueueAll() {
    if (!hostName) return;
    setIsSubmitting(true);
    setResult(null);
    let queued = 0;
    const skipped: string[] = [];

    // **1件ずつ順に投げる。** まとめて投げると、拒否された理由がどのIssueのものか分からない。
    // 積む順がそのまま実行順になるので、選択の並び（＝一覧の並び）のまま送る。
    // 1件ぶんの手順は「次にやること」の自動開始（#1853）と共有する
    for (const issue of issues) {
      const outcome = await enqueueIssueToDefaultHost(
        issue,
        {
          hosts: dispatch.hosts,
          sessions: dispatch.sessions,
          enqueue: dispatch.enqueue,
          enqueueError: dispatch.error,
          updateIssue,
        },
        labelsToAdd,
      );
      if (!outcome.ok) {
        skipped.push(`#${issue.number}: ${outcome.reason}`);
        continue;
      }
      queued += 1;
    }

    setIsSubmitting(false);
    if (skipped.length === 0) {
      onClose();
      return;
    }
    // **積めなかったぶんは黙って消さない。** 選択モードも維持して、何が残ったか分かるようにする
    setResult([`${queued}件を積みました。積めなかったもの:`, ...skipped].join("\n"));
  }

  return (
    <div className="flex flex-col gap-2 border-b bg-muted/40 px-4 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {issues.length === 0 ? "積むIssueを選んでください" : `${issues.length}件を選択中`}
        </p>
        <Button size="xs" variant="ghost" onClick={onClose} disabled={isSubmitting}>
          やめる
        </Button>
      </div>

      {/* オプション（#1993）。**選んだIssueで共通して選べるものが確定してから出す** —
          取得の途中で出すと、押そうとしたチップが指の下で入れ替わる（#1666と同じ理由） */}
      {issues.length > 0 && !isLoadingLabels && visibleOptions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-muted-foreground">
            選んだ条件は、選んだIssueすべてに同じように付きます（既に付いているラベルは外しません）。
          </p>
          <div className="grid grid-cols-2 gap-2">
            {visibleOptions.map((option) => (
              <StartOptionChip
                key={option.key}
                icon={START_OPTION_ICONS[option.key]}
                label={option.label}
                description={option.description}
                checked={options[option.key]}
                onToggle={() => toggleOption(option.key)}
              />
            ))}
          </div>
          <ul className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            {visibleOptions
              .filter((option) => options[option.key])
              .map((option) => (
                <li key={option.key}>
                  <span className="font-medium text-foreground">{option.label}</span>:{" "}
                  {option.description}
                </li>
              ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-end">
        <Button
          size="sm"
          disabled={dispatchable.length === 0 || !hostName || isSubmitting}
          title={hostName ? undefined : "積める起動先がありません"}
          onClick={() => void enqueueAll()}
        >
          {isSubmitting ? <Loader2 className="animate-spin" /> : <Server />}
          {hostName ? `${formatDispatchHostName(hostName)}へ順に積む` : "積める起動先がありません"}
        </Button>
      </div>
      {result && <p className="whitespace-pre-wrap text-xs text-destructive">{result}</p>}
    </div>
  );
}
