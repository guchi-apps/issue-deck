"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";

import { formatMonthDayTime } from "@/lib/format-date-time";
import {
  describeRebuildActor,
  REBUILD_EVENT_LABEL,
  REBUILD_TRIGGER_LABEL,
  shortSha,
  type RebuildEpisode,
  type RebuildEventPullRequest,
} from "@/lib/release-rebuild-history";
import { cn } from "@/lib/utils";

/**
 * リリース候補の作り直しの履歴（#4359）。後継候補がまだ無い間も、**元候補・承認した範囲・今回取り込むPR・
 * 含めないPR・後継候補**を読めるようにする。元PRが閉じられていても残る（記録はDBにあり、PRの状態に依存しない）。
 *
 * 取得はDBだけ（GitHub APIは叩かない）。記録が無い履歴は「操作経路不明」と出し、承認したとは見せない。
 * PCもスマホも同じ部品で、折り返して読める幅にしてある。
 */
export function ReleaseRebuildHistoryPanel({
  repositoryFullName,
  className,
}: {
  repositoryFullName: string;
  className?: string;
}) {
  const [owner, repo] = repositoryFullName.split("/");
  const [episodes, setEpisodes] = useState<RebuildEpisode[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/repositories/release/rebuild-history?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
      );
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as { episodes?: RebuildEpisode[] } | null;
      setEpisodes(Array.isArray(data?.episodes) ? data.episodes : []);
    } catch {
      // 履歴は補助。取れなければ出さない
    }
  }, [owner, repo]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 取得結果の反映（同期的なsetStateではない）
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (episodes.length === 0) return null;
  return (
    <section
      aria-label="リリース候補の作り直しの履歴"
      className={cn("flex min-w-0 flex-col gap-1.5 rounded-lg border bg-muted/20 p-2.5 text-xs", className)}
      data-testid="release-rebuild-history"
    >
      <p className="font-semibold">リリース候補の作り直しの履歴</p>
      <ul className="flex flex-col gap-1.5">
        {episodes.map((episode, index) => (
          <EpisodeItem key={episode.key} episode={episode} repositoryFullName={repositoryFullName} defaultOpen={index === 0} />
        ))}
      </ul>
    </section>
  );
}

function prUrl(repositoryFullName: string, number: number) {
  return `https://github.com/${repositoryFullName}/pull/${number}`;
}

function PrLink({ repositoryFullName, number, label }: { repositoryFullName: string; number: number; label?: string }) {
  return (
    <a
      href={prUrl(repositoryFullName, number)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 underline"
    >
      {label ?? ""}#{number}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}

function PrList({ repositoryFullName, prs }: { repositoryFullName: string; prs: RebuildEventPullRequest[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {prs.map((pr) => (
        <li key={pr.number} className="min-w-0 break-words">
          <PrLink repositoryFullName={repositoryFullName} number={pr.number} />
          {pr.title ? ` ${pr.title}` : ""}
          {pr.mergeSha && <span className="font-mono text-[10.5px] text-muted-foreground">（適用 {shortSha(pr.mergeSha)}）</span>}
        </li>
      ))}
    </ul>
  );
}

function EpisodeItem({
  episode,
  repositoryFullName,
  defaultOpen,
}: {
  episode: RebuildEpisode;
  repositoryFullName: string;
  defaultOpen: boolean;
}) {
  const problem = episode.phase === "failed" || episode.phase === "awaiting_decision" || episode.phase === "superseded";
  const approvedAll = episode.approvals.flatMap((a) => a.payload.approvedPrs ?? []);
  return (
    <li className="rounded bg-background/70" data-testid="release-rebuild-episode">
      <details open={defaultOpen} className="group">
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1.5">
          <span className="font-medium">元候補 #{episode.originPrNumber}</span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[11px]",
              problem
                ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"
                : episode.phase === "successor_created"
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                  : "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-300",
            )}
          >
            {episode.phaseLabel}
          </span>
          <span className="text-muted-foreground">{formatMonthDayTime(episode.updatedAt)}</span>
        </summary>
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          <p className="break-words font-mono text-[10.5px] text-muted-foreground">
            元候補 <PrLink repositoryFullName={repositoryFullName} number={episode.originPrNumber} /> release {shortSha(episode.originHeadSha)}
            {episode.successor && (
              <>
                {" → 後継候補 "}
                <PrLink repositoryFullName={repositoryFullName} number={episode.successor.number} />
                {` release ${shortSha(episode.successor.headSha)}`}
              </>
            )}
          </p>
          {episode.pathUnknown && (
            <p className="rounded border border-amber-300 bg-amber-50/60 px-2 py-1 dark:border-amber-800 dark:bg-amber-950/20">
              操作経路不明: この作り直しの操作記録がありません。承認の有無・操作者は確認できません。
            </p>
          )}
          {approvedAll.length > 0 && (
            <div>
              <p className="font-medium">承認した範囲（承認した時点のPR。後から入ったPRは含みません）</p>
              <PrList repositoryFullName={repositoryFullName} prs={approvedAll} />
            </div>
          )}
          {episode.pendingPrs.length > 0 && (
            <p className="break-words">
              判断待ちの原因: {episode.pendingPrs.map((n) => <span key={n} className="mr-1"><PrLink repositoryFullName={repositoryFullName} number={n} /></span>)}
            </p>
          )}
          {episode.selectedPrs.length > 0 && (
            <div>
              <p className="font-medium">今回の候補に含める（元候補へ追加）</p>
              <PrList repositoryFullName={repositoryFullName} prs={episode.selectedPrs} />
            </div>
          )}
          {episode.excludedPrs.length > 0 && (
            <p className="break-words">
              <span className="font-medium">今回は含めない</span>（developへはマージ済みですが、この本番候補には入りません）:{" "}
              {episode.excludedPrs.map((n) => (
                <span key={n} className="mr-1">
                  <PrLink repositoryFullName={repositoryFullName} number={n} />
                </span>
              ))}
            </p>
          )}
          <ol className="flex flex-col gap-1 border-l pl-2" aria-label="操作の経過">
            {episode.events.map((event) => (
              <li key={event.id} className="min-w-0 break-words">
                <span className="text-muted-foreground">{formatMonthDayTime(event.createdAt)}</span>{" "}
                <span className="font-medium">{REBUILD_EVENT_LABEL[event.kind]}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {describeRebuildActor(event)} · {REBUILD_TRIGGER_LABEL[event.trigger]}
                </span>
                {event.payload.approvalEventId && <span className="text-muted-foreground"> · 承認に基づく</span>}
                {event.reason && <p className="text-muted-foreground">{event.reason}</p>}
              </li>
            ))}
          </ol>
        </div>
      </details>
    </li>
  );
}
