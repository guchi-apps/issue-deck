"use client";

import { AlertTriangle, ExternalLink, GitPullRequest, Loader2, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeDate } from "@/lib/format-relative-date";
import {
  countByFile,
  daysSinceJstDate,
  detectKnowledgeStall,
  groupKnowledgeByDate,
  type KnowledgeBoardData,
  type KnowledgeCandidate,
  type KnowledgeSection,
} from "@/lib/knowledge-board";
import { getRepoColor } from "@/lib/repo-color";
import { cn } from "@/lib/utils";

/**
 * 「共通知識」画面（#2912）。フリート各リポジトリのIssueに残った知見メモが、共有知識
 * （`guchi-apps/docs`の`knowledge/`）へどう採用されたかを1画面で追う。
 *
 * それまでは、知見メモは各Issueのコメントに散り、採用結果は`guchi-apps/docs`を開かないと
 * 分からなかった。**格上げ判定（`promote-knowledge.yml`・毎日05:00 JST）が止まっても誰も
 * 気付かない**という積み残しがあり（`docs/shared-knowledge.md`の未解決課題）、実際に188件が
 * 溜まったことがある（`guchi-apps/docs#92`）。滞留の警告はそのための合図。
 *
 * **PCとスマホで同じ部品を使う**（`compact`で縮めるだけ。`release-history-panel.tsx`と同じ）。
 * **読み取りだけの画面**で、判定させるボタンも共有知識を書き換えるボタンも置かない
 * （書き込めるのは`guchi-apps/docs`側のワークフローだけ、というガードを崩さないため）。
 */
export function KnowledgeBoardPanel({
  data,
  isLoading,
  error,
  onRefresh,
  compact = false,
  className,
}: {
  data: KnowledgeBoardData | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** スマホ向けに縮める。見出しの説明文を落とす */
  compact?: boolean;
  className?: string;
}) {
  const [tab, setTab] = useState<"candidates" | "knowledge">("candidates");
  const [filePath, setFilePath] = useState<string | null>(null);

  const stall = useMemo(
    () => (data ? detectKnowledgeStall(data.candidates, data.sections) : null),
    [data],
  );
  const files = useMemo(() => (data ? countByFile(data.sections) : []), [data]);
  const visibleSections = useMemo(
    () => (data ? data.sections.filter((s) => !filePath || s.path === filePath) : []),
    [data, filePath],
  );
  const groups = useMemo(() => groupKnowledgeByDate(visibleSections), [visibleSections]);

  const lastPromotedDays = stall?.lastPromotedOn ? daysSinceJstDate(stall.lastPromotedOn) : null;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <header className="flex items-start gap-2">
        <div className="mr-auto">
          <h2 className="text-sm font-bold">共通知識</h2>
          {!compact && (
            <p className="text-[11px] text-muted-foreground">
              フリートの知見メモが、共有知識（<code className="font-mono">guchi-apps/docs</code>）へ
              どう採用されたかを追います
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="icon"
          className="size-7 shrink-0"
          onClick={onRefresh}
          title="更新"
        >
          {isLoading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          <span className="sr-only">更新</span>
        </Button>
      </header>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {isLoading && !data && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {data && stall && (
        <>
          {/* 状態の要約。数字が主役の画面ではないので、大きなタイルにはしない */}
          <dl className="flex overflow-hidden rounded-md border bg-card">
            <Stat label="たまった共通知識" value={String(data.sections.length)} unit={`件 / ${data.fileCount}ファイル`} />
            <Stat
              label="未判定の候補"
              /* 検索を打ち切っている間は下限でしかないので、数字にそう書く（#2912） */
              value={`${stall.pendingCount}${data.truncated ? "+" : ""}`}
              unit="件"
              warn={stall.shouldWarn}
            />
            <Stat
              label="最後に反映された日"
              value={stall.lastPromotedOn ?? "—"}
              unit={lastPromotedDays === null ? "" : lastPromotedDays === 0 ? "今日" : `${lastPromotedDays}日前`}
            />
          </dl>

          {/* 判定エージェントが止まっているかもしれない、という唯一の要対応の合図。
              この画面で暖色を使うのはここだけ（`docs/code-map.md`の色の取り決め） */}
          {stall.shouldWarn && (
            <div className="flex flex-wrap items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs leading-relaxed dark:border-amber-900 dark:bg-amber-950/40">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              <p className="min-w-0 flex-1">
                <span className="font-bold">
                  未判定の候補が{stall.pendingCount}
                  {data.truncated ? "件以上" : "件"}たまっています。
                </span>{" "}
                表示している中でいちばん古いものは{formatRelativeDate(stall.oldestPendingAt ?? "")}の
                投稿です。格上げ判定（<code className="font-mono">promote-knowledge.yml</code>・
                毎日05:00 JST）が失敗し続けていないか確かめてください。
              </p>
              <a
                href="https://github.com/guchi-apps/docs/actions/workflows/promote-knowledge.yml"
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto shrink-0 rounded-sm border border-amber-300 bg-background px-2 py-1 text-[11px] font-medium hover:bg-accent dark:border-amber-900"
              >
                実行履歴を開く
              </a>
            </div>
          )}

          <nav className="flex gap-0.5 border-b" aria-label="表示する内容">
            <TabButton
              active={tab === "candidates"}
              onClick={() => setTab("candidates")}
              label="知見の候補"
              count={data.candidates.length}
            />
            <TabButton
              active={tab === "knowledge"}
              onClick={() => setTab("knowledge")}
              label="たまった共通知識"
              count={data.sections.length}
            />
          </nav>

          {tab === "candidates" ? (
            <CandidateList data={data} />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-1">
                <FileChip
                  label={`すべて ${data.sections.length}`}
                  active={filePath === null}
                  onClick={() => setFilePath(null)}
                />
                {files.map((file) => (
                  <FileChip
                    key={file.path}
                    label={`${fileLabel(file.path)} ${file.count}`}
                    active={filePath === file.path}
                    onClick={() => setFilePath(file.path)}
                  />
                ))}
              </div>

              {groups.length === 0 ? (
                <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  共有知識をまだ読み込めていません。
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  {groups.map((group) => (
                    <section key={group.date ?? "unknown"}>
                      <h3 className="mb-1.5 flex items-baseline gap-2 text-xs font-bold">
                        <span className="font-mono">{group.date ?? "確認日なし"}</span>
                        <span className="text-[11px] font-normal text-muted-foreground">
                          {group.sections.length}件
                        </span>
                      </h3>
                      <ul className="flex flex-col gap-1.5">
                        {group.sections.map((section) => (
                          <KnowledgeRow
                            key={`${section.path}-${section.title}`}
                            section={section}
                            docsRepoUrl={data.docsRepoUrl}
                          />
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  warn = false,
}: {
  label: string;
  value: string;
  unit: string;
  warn?: boolean;
}) {
  return (
    <div className="min-w-0 flex-1 border-l px-3 py-2 first:border-l-0">
      <dt className="text-[10px] font-semibold tracking-wide text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "truncate font-mono text-lg leading-tight tabular-nums",
          warn && "text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
        {unit && <span className="ml-1 font-sans text-[11px] font-medium text-muted-foreground">{unit}</span>}
      </dd>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-semibold",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      <span className="rounded-full border bg-muted px-1.5 font-mono text-[10px] font-normal tabular-nums">
        {count}
      </span>
    </button>
  );
}

function FileChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2 py-0.5 font-mono text-[10px]",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent",
      )}
    >
      {label}
    </button>
  );
}

/** `knowledge/github-actions.md` -> `github-actions` */
function fileLabel(path: string): string {
  return path.replace(/^knowledge\//, "").replace(/\.md$/, "");
}

function CandidateList({ data }: { data: KnowledgeBoardData }) {
  const pending = data.candidates.filter((c) => c.verdict === "pending");
  const judged = data.candidates.filter((c) => c.verdict !== "pending");

  return (
    <div className="flex flex-col gap-4">
      {data.candidates.length === 0 && (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          知見メモがまだありません。
        </p>
      )}

      {pending.length > 0 && (
        <section>
          <h3 className="mb-1.5 flex items-baseline gap-2 text-xs font-bold">
            未判定
            <span className="text-[11px] font-normal text-muted-foreground">
                {pending.length}件 · 古い順。実装が未マージのものは仕様として判定対象外です
            </span>
          </h3>
          <ul className="flex flex-col gap-1.5">
            {pending.map((candidate) => (
              <CandidateRow key={`${candidate.repoFullName}#${candidate.number}`} candidate={candidate} />
            ))}
          </ul>
        </section>
      )}

      {judged.length > 0 && (
        <section>
          <h3 className="mb-1.5 flex items-baseline gap-2 text-xs font-bold">
            判定済み
            <span className="text-[11px] font-normal text-muted-foreground">
              {judged.length}件 · 新しい順
            </span>
          </h3>
          <ul className="flex flex-col gap-1.5">
            {judged.map((candidate) => (
              <CandidateRow key={`${candidate.repoFullName}#${candidate.number}`} candidate={candidate} />
            ))}
          </ul>
        </section>
      )}

      {data.truncated && (
        <p className="text-[11px] text-muted-foreground">
          Issueの検索結果が多いため、更新の新しい順に300件までを見ています。それより古いIssueの
          知見メモはここに出ません。
        </p>
      )}
    </div>
  );
}

function CandidateRow({ candidate }: { candidate: KnowledgeCandidate }) {
  const repoName = candidate.repoFullName.split("/")[1] ?? candidate.repoFullName;
  // 判定の状態は左端の帯で表す。承認だけ色を当て、却下には当てない（失敗ではないため）
  const stripe =
    candidate.verdict === "pending"
      ? "border-l-blue-500"
      : candidate.verdict === "approved"
        ? "border-l-emerald-600"
        : "border-l-border";

  return (
    <li className={cn("rounded-md border border-l-[3px] bg-card p-2.5", stripe)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-[2px]"
          style={{ backgroundColor: getRepoColor(candidate.repoFullName) }}
        />
        <span className="text-xs font-semibold">{repoName}</span>
        <span className="font-mono text-[11px] text-muted-foreground">#{candidate.number}</span>
        <VerdictPill candidate={candidate} />
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {formatRelativeDate(candidate.at)}
        </span>
      </div>

      <p className="mt-1 text-xs leading-relaxed font-medium">{candidate.title}</p>

      <ul className="mt-1.5 flex flex-col gap-0.5">
        {candidate.notes.length > 0
          ? candidate.notes.map((note, index) => (
              <li key={index} className="flex gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                <span
                  aria-hidden
                  className={cn(
                    "w-3 shrink-0 text-center font-mono",
                    note.verdict === "approved" ? "text-emerald-600 dark:text-emerald-400" : "",
                  )}
                >
                  {note.verdict === "approved" ? "✓" : "×"}
                </span>
                <span className="min-w-0">
                  {note.title}
                  {note.destination && (
                    <span className="ml-1 rounded-sm border bg-muted px-1 font-mono text-[10px] whitespace-nowrap">
                      {note.destination}
                    </span>
                  )}
                  {note.reason && <span className="block opacity-80">{note.reason}</span>}
                </span>
              </li>
            ))
          : candidate.memos.map((memo, index) => (
              <li key={index} className="flex gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                <span aria-hidden className="w-3 shrink-0 text-center font-mono">
                  ·
                </span>
                <span className="min-w-0">{memo.title}</span>
              </li>
            ))}
      </ul>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <a
          href={candidate.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3" aria-hidden />
          Issueを開く
        </a>
        {candidate.promotionPullRequestUrl && (
          <a
            href={candidate.promotionPullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            <GitPullRequest className="size-3" aria-hidden />
            反映PR
          </a>
        )}
      </div>
    </li>
  );
}

function VerdictPill({ candidate }: { candidate: KnowledgeCandidate }) {
  if (candidate.verdict === "pending") {
    return (
      <span className="rounded-full border border-blue-300 bg-blue-50 px-1.5 text-[10px] font-bold text-blue-700 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-300">
        未判定
      </span>
    );
  }

  // 内訳が取れなかった判定済み（書式崩れ）は、件数を出さず「判定済み」とだけ言う
  if (candidate.notes.length === 0) {
    return (
      <span className="rounded-full border bg-muted px-1.5 text-[10px] font-bold text-muted-foreground">
        判定済み
      </span>
    );
  }

  const label =
    candidate.rejectedCount === 0
      ? `承認 ${candidate.approvedCount}`
      : candidate.approvedCount === 0
        ? `却下 ${candidate.rejectedCount}`
        : `承認 ${candidate.approvedCount} / 却下 ${candidate.rejectedCount}`;

  return (
    <span
      className={cn(
        "rounded-full border px-1.5 text-[10px] font-bold",
        candidate.approvedCount > 0
          ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300"
          : "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function KnowledgeRow({
  section,
  docsRepoUrl,
}: {
  section: KnowledgeSection;
  docsRepoUrl: string;
}) {
  return (
    <li className="rounded-md border bg-card p-2.5">
      <a
        href={`${docsRepoUrl}/blob/HEAD/${section.path}`}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-[10px] text-muted-foreground hover:text-foreground hover:underline"
      >
        {section.path}
      </a>
      <p className="mt-0.5 text-xs leading-relaxed font-semibold">{section.title}</p>
      {section.summary && (
        <p className="mt-0.5 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
          {section.summary}
        </p>
      )}
      {section.source && (
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">出典 {section.source}</p>
      )}
    </li>
  );
}
