"use client";

import { Check, CircleHelp, Clock, Dot } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import {
  formatManualStepReference,
  type ManualStepPrerequisite,
  type ManualStepPrerequisiteSummary,
} from "@/lib/manual-step-prerequisites";
import { cn } from "@/lib/utils";

/**
 * 手作業Issueが待っている相手（先に完了している必要があるIssue・PR）の状況（#1705）。
 *
 * `ManualStepPanel`の中に置く。**手作業パネルの外に出さない**——「あなたの手作業を待って
 * います」と「その前提がまだ揃っていない」は同じ判断のための材料で、離すと実行しようとした
 * 人が前提の行まで戻らない。
 *
 * 材料の作り方と「状態不明を待ちに数えない」理由は`lib/manual-step-prerequisites.ts`を参照。
 */
export function ManualStepPrerequisites({
  prerequisites,
  summary,
  repositoryFullName,
  className,
}: {
  prerequisites: ManualStepPrerequisite[];
  summary: ManualStepPrerequisiteSummary;
  /** 手作業Issue自身のリポジトリ。同じリポジトリの参照は`#123`と短く出す */
  repositoryFullName: string;
  className?: string;
}) {
  if (prerequisites.length === 0) return null;
  const ready = summary.blocking.length === 0;

  return (
    <section
      className={cn("rounded-md border bg-background p-2.5", className)}
      aria-labelledby="manual-step-prerequisites-title"
    >
      <div className="flex items-center justify-between gap-2">
        <p id="manual-step-prerequisites-title" className="text-xs font-medium">
          前提条件の状況
        </p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {summary.total}件中 {summary.satisfiedCount}件 完了
        </p>
      </div>

      <p
        className={cn(
          "mt-2 flex items-start gap-1.5 rounded-sm px-2 py-1.5 text-xs",
          ready
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        )}
      >
        {ready ? (
          <Check className="mt-0.5 size-3.5 shrink-0" />
        ) : (
          <Clock className="mt-0.5 size-3.5 shrink-0" />
        )}
        <span>{summary.message}</span>
      </p>

      <ul className="mt-2 space-y-2">
        {prerequisites.map((prerequisite) => (
          <li
            key={`${prerequisite.repositoryFullName}#${prerequisite.number}`}
            className="flex items-start gap-2"
          >
            <PrerequisiteMark prerequisite={prerequisite} />
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-1.5 text-xs">
                <PrerequisiteLink
                  prerequisite={prerequisite}
                  repositoryFullName={repositoryFullName}
                />
                {prerequisite.title !== null && (
                  <span className="truncate text-foreground">{prerequisite.title}</span>
                )}
                {prerequisite.origin && (
                  <span className="shrink-0 rounded-full border px-1.5 text-[10px] leading-4 text-muted-foreground">
                    起点
                  </span>
                )}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={cn(
                    "rounded-full px-2 py-px text-[11px] leading-4",
                    stageBadgeClassName(prerequisite),
                  )}
                >
                  {prerequisite.label}
                </span>
                <PrerequisiteSteps prerequisite={prerequisite} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PrerequisiteMark({ prerequisite }: { prerequisite: ManualStepPrerequisite }) {
  if (prerequisite.stage === "unknown") {
    return <CircleHelp className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (prerequisite.satisfied) {
    return <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />;
  }
  if (prerequisite.stage === "develop") {
    return <Clock className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />;
  }
  return <Dot className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
}

/**
 * 参照先へのリンク。`GithubReferenceLink`を通すことで、通常クリックはアプリ内で開き、
 * Ctrl/⌘クリックはGitHubを開く（#1260と同じ扱い）。
 */
function PrerequisiteLink({
  prerequisite,
  repositoryFullName,
}: {
  prerequisite: ManualStepPrerequisite;
  repositoryFullName: string;
}) {
  const label = formatManualStepReference(prerequisite, repositoryFullName);
  const path = prerequisite.kind === "pull-request" ? "pull" : "issues";
  const href =
    prerequisite.htmlUrl ??
    `https://github.com/${prerequisite.repositoryFullName}/${path}/${prerequisite.number}`;

  return (
    <GithubReferenceLink
      href={href}
      reference={{
        repositoryFullName: prerequisite.repositoryFullName,
        number: prerequisite.number,
        kind: prerequisite.kind === "pull-request" ? "pull" : "issue",
      }}
      className="shrink-0 font-mono text-violet-700 hover:underline dark:text-violet-300"
    >
      {prerequisite.kind === "pull-request" ? `PR ${label}` : label}
    </GithubReferenceLink>
  );
}

/**
 * 実装 → develop → main の3段階のうち現在地。PR・クローズ済み・状態不明では出さない
 * （マージ先を持たないPRを3段階に載せると、developまでなのかmainまで届いたのかを
 * 言っていないのに言ったように見える）。
 */
function PrerequisiteSteps({ prerequisite }: { prerequisite: ManualStepPrerequisite }) {
  const current = prerequisite.stepIndex;
  if (current === null) return null;

  return (
    <span
      className="flex items-center gap-1"
      role="img"
      aria-label={`実装・develop・mainの3段階のうち${current + 1}段階目`}
    >
      {[0, 1, 2].map((index) => (
        <span key={index} className="flex items-center gap-1">
          {index > 0 && (
            <span
              className={cn(
                "h-px w-3 rounded-full",
                index <= current ? "bg-emerald-500/70" : "bg-border",
              )}
            />
          )}
          <span
            className={cn(
              "size-1.5 rounded-full",
              index < current && "bg-emerald-500/70",
              index === current && (prerequisite.satisfied ? "bg-emerald-500" : "bg-amber-500"),
              index > current && "bg-border",
            )}
          />
        </span>
      ))}
      <span className="ml-0.5 text-[10px] text-muted-foreground">実装 → develop → main</span>
    </span>
  );
}

function stageBadgeClassName(prerequisite: ManualStepPrerequisite): string {
  if (prerequisite.stage === "unknown") return "border text-muted-foreground";
  if (prerequisite.satisfied) {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (prerequisite.stage === "develop") {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "bg-muted text-muted-foreground";
}
