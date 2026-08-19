"use client";

import { ArrowRight, CircleDot, Wrench } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { summarizeIssueDependents, type IssueDependent } from "@/lib/issue-dependents";
import { cn } from "@/lib/utils";

/**
 * このIssueの完了を待っているIssue（#2003）。前提条件（`manual-step-prerequisites.tsx`）の
 * 逆向きで、材料は同じ本文テキスト。
 *
 * **前提条件のブロックのすぐ下に置く。** 「自分が何を待つか」と「自分を何が待つか」は、
 * どちらも実施順序という1つの問いへの答えで、離して置くと順番を確かめるのに画面を往復させる。
 *
 * 配色は前提条件と揃えるが、**進捗の3段階ドットは出さない**。ここに並ぶのは待たせている側で、
 * 見たいのは「どれだけ先へ進めずにいるか」であって、その相手自身の進み具合ではない。
 */
export function IssueDependents({
  dependents,
  repositoryFullName,
  titleId = "issue-dependents-title",
  className,
}: {
  dependents: IssueDependent[];
  /** いま開いているIssueのリポジトリ。同じリポジトリの相手は`#123`と短く出す */
  repositoryFullName: string;
  /**
   * 見出しのid。PC・スマホの両方の詳細から同時にDOMへ載る場合があるため、
   * 呼び出し側が別のidを渡してidの重複を避けられるようにする
   */
  titleId?: string;
  className?: string;
}) {
  if (dependents.length === 0) return null;

  return (
    <section
      className={cn("rounded-md border bg-background p-2.5", className)}
      aria-labelledby={titleId}
    >
      <div className="flex items-center justify-between gap-2">
        <p id={titleId} className="text-xs font-medium">
          このIssueの完了を待っているIssue
        </p>
        <p className="text-xs tabular-nums text-muted-foreground">{dependents.length}件</p>
      </div>

      <p className="mt-2 flex items-start gap-1.5 rounded-sm bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
        <ArrowRight className="mt-0.5 size-3.5 shrink-0" />
        <span>{summarizeIssueDependents(dependents, repositoryFullName)}</span>
      </p>

      <ul className="mt-2 space-y-2">
        {dependents.map((dependent) => (
          <li
            key={`${dependent.repositoryFullName}#${dependent.number}`}
            className="flex items-start gap-2"
          >
            {dependent.manualStep ? (
              <Wrench className="mt-0.5 size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
            ) : (
              <CircleDot className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-1.5 text-xs">
                <DependentLink dependent={dependent} repositoryFullName={repositoryFullName} />
                <span className="truncate text-foreground">{dependent.title}</span>
              </p>
              <div className="mt-1">
                <span className="rounded-full bg-muted px-2 py-px text-[11px] leading-4 text-muted-foreground">
                  {dependent.label}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 相手へのリンク。`GithubReferenceLink`を通すことで、通常クリックはアプリ内で開き、
 * Ctrl/⌘クリックはGitHubを開く（前提条件の行と同じ扱い）。
 */
function DependentLink({
  dependent,
  repositoryFullName,
}: {
  dependent: IssueDependent;
  repositoryFullName: string;
}) {
  const prefix =
    dependent.repositoryFullName === repositoryFullName ? "" : dependent.repositoryFullName;

  return (
    <GithubReferenceLink
      href={dependent.htmlUrl}
      reference={{
        repositoryFullName: dependent.repositoryFullName,
        number: dependent.number,
        kind: "issue",
      }}
      className="shrink-0 font-mono text-violet-700 hover:underline dark:text-violet-300"
    >
      {`${prefix}#${dependent.number}`}
    </GithubReferenceLink>
  );
}
