"use client";

import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePullRequestMergeMutation } from "@/hooks/use-pull-request-merge-mutation";
import { formatRelativeDate } from "@/lib/format-relative-date";
import {
  countByFile,
  daysSinceJstDate,
  detectKnowledgeStall,
  groupKnowledgeByDate,
  type KnowledgeBoardData,
  type KnowledgeCandidate,
  type KnowledgeSection,
  type OpenPromotionPullRequest,
  type PromotionKnowledgeFile,
  type PromotionKnowledgeItem,
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
 * 判定させるボタンも共有知識を書き換えるボタンも置かない（書き込めるのは`guchi-apps/docs`側の
 * ワークフローだけ、というガードを崩さないため）。**唯一の例外がマージ待ちの反映PRの
 * 「マージする」「マージしない」ボタン**（#2950。`PromotionPullRequestActions`）——共有知識自体は
 * 書き換えず、`promote-knowledge.yml`が既に作ったPRを人間の代わりにマージ・closeするだけなので
 * このガードには触れない。
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
    () =>
      data
        ? detectKnowledgeStall(data.candidates, data.sections, data.counts, data.collectLimit)
        : null,
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
            {/* **件数は検索の総数から出す**（#2912）。一覧は300件で打ち切っているので、
                そちらから数えると「表示範囲での下限」にしかならない。総数は本文で言及して
                いるだけのIssueも含む概算なので、単位に「およそ」と書いて役割を分ける */}
            <Stat
              label="未判定の候補"
              value={stall.pendingTotal !== null ? String(stall.pendingTotal) : `${stall.pendingCount}+`}
              unit={stall.pendingTotal !== null ? "件（およそ）" : "件"}
              warn={stall.shouldWarn || stall.collectWindowSaturated}
            />
            <Stat
              label="最後に反映された日"
              value={stall.lastPromotedOn ?? "—"}
              unit={lastPromotedDays === null ? "" : lastPromotedDays === 0 ? "今日" : `${lastPromotedDays}日前`}
            />
          </dl>

          {data.openPromotionPullRequests.length > 0 && (
            <PromotionPullRequestsSection
              pullRequests={data.openPromotionPullRequests}
              onResolved={onRefresh}
            />
          )}

          {/* 判定が進んでいないときの合図。**原因ごとに分けて出す**——落ちているのと、
              収集の窓が判定済みで埋まっているのとでは打つ手が違う。
              この画面で暖色を使うのはここだけ（`docs/code-map.md`の色の取り決め） */}
          {stall.collectWindowSaturated && (
            <Alert action={{ label: "実行履歴を開く", href: PROMOTE_WORKFLOW_URL }}>
              <span className="font-bold">
                格上げ判定が集める窓が、判定済みで埋まっています（判定済み{data.counts.judged}件 /
                収集の上限{data.collectLimit}件）。
              </span>{" "}
              <code className="font-mono">promote-knowledge.yml</code>
              は<strong>作成の古い順</strong>に{data.collectLimit}件だけを集めるため、これ以上
              新しい知見メモへ到達できません。ワークフローは毎晩<code className="font-mono">success</code>
              で終わりますが、判定は1件も行われていない可能性があります。
            </Alert>
          )}

          {stall.shouldWarn && (
            <Alert action={{ label: "実行履歴を開く", href: PROMOTE_WORKFLOW_URL }}>
              <span className="font-bold">
                未判定の候補が{stall.pendingTotal ?? stall.pendingCount}
                {stall.pendingTotal === null && data.truncated ? "件以上" : "件"}たまっています。
              </span>{" "}
              表示している中でいちばん古いものは{formatRelativeDate(stall.oldestPendingAt ?? "")}の
              投稿です。格上げ判定（<code className="font-mono">promote-knowledge.yml</code>・
              毎日05:00 JST）が失敗し続けていないか確かめてください。
            </Alert>
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

/** 格上げ判定ワークフローの実行履歴。滞留の原因を確かめる唯一の外部リンク */
const PROMOTE_WORKFLOW_URL =
  "https://github.com/guchi-apps/docs/actions/workflows/promote-knowledge.yml";

function Alert({
  children,
  action,
}: {
  children: React.ReactNode;
  action: { label: string; href: string };
}) {
  return (
    <div className="flex flex-wrap items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs leading-relaxed dark:border-amber-900 dark:bg-amber-950/40">
      <AlertTriangle
        className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden
      />
      <p className="min-w-0 flex-1">{children}</p>
      <a
        href={action.href}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-auto shrink-0 rounded-sm border border-amber-300 bg-background px-2 py-1 text-[11px] font-medium hover:bg-accent dark:border-amber-900"
      >
        {action.label}
      </a>
    </div>
  );
}

/** 共有知識リポジトリ（マージ待ちの反映PRが作られる先）。`knowledge-api.ts`と同じ値 */
const DOCS_REPO_OWNER = "guchi-apps";
const DOCS_REPO_NAME = "docs";

/**
 * 「マージ待ちの反映PR」（#2950）。格上げ判定が作った`guchi-apps/docs`へのPRのうち、
 * まだ人間がマージしていないものを一覧にする。未判定候補（青）・承認（緑）とは役割が違う
 * 「人がマージを判断する場所」であることを示すため、既存の警告色（amber）とも分けてindigoを使う。
 * マージ・close操作は既存のPRマージ機構（`pull-request-merge-button.tsx`）をそのまま使う
 * （`PromotionPullRequestActions`）。
 */
function PromotionPullRequestsSection({
  pullRequests,
  onResolved,
}: {
  pullRequests: OpenPromotionPullRequest[];
  onResolved: () => void;
}) {
  return (
    <section className="rounded-md border border-indigo-300 bg-indigo-50 p-2.5 dark:border-indigo-900 dark:bg-indigo-950/40">
      <h3 className="flex flex-wrap items-baseline gap-2 text-xs font-bold text-indigo-700 dark:text-indigo-300">
        <span className="inline-flex items-center gap-1.5">
          <GitMerge className="size-3.5" aria-hidden />
          マージ待ちの反映PR
        </span>
        <span className="rounded-full border border-indigo-300 bg-background px-1.5 font-mono text-[10px] font-normal text-indigo-700 dark:border-indigo-900 dark:text-indigo-300">
          {pullRequests.length}
        </span>
      </h3>
      <p className="mt-1 text-[11px] leading-relaxed text-indigo-900/70 dark:text-indigo-200/70">
        マージまたはcloseされるまで、次回の格上げ判定（
        <code className="font-mono">promote-knowledge.yml</code>）は見送られます。
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {pullRequests.map((pr) => (
          <PromotionPullRequestRow key={pr.number} pr={pr} onResolved={onResolved} />
        ))}
      </ul>
    </section>
  );
}

function PromotionPullRequestRow({
  pr,
  onResolved,
}: {
  pr: OpenPromotionPullRequest;
  onResolved: () => void;
}) {
  return (
    <li className="rounded-md border bg-card p-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[11px] text-muted-foreground">docs#{pr.number}</span>
        <span className="text-xs font-semibold">{pr.title}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {formatRelativeDate(pr.createdAt)}
        </span>
      </div>

      {pr.sourceIssues.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted-foreground">出典</span>
          {pr.sourceIssues.map((source) => (
            <a
              key={`${source.repoFullName}#${source.number}`}
              href={source.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-sm border bg-muted px-1 font-mono text-[10px] text-muted-foreground hover:text-foreground"
            >
              {source.repoFullName.split("/")[1] ?? source.repoFullName}#{source.number}
            </a>
          ))}
        </div>
      )}

      <PromotionKnowledgeList changes={pr.knowledgeChanges} />

      <div className="mt-1.5 flex items-center gap-3">
        <a
          href={pr.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-700 hover:underline dark:text-indigo-300"
        >
          <ExternalLink className="size-3" aria-hidden />
          PRを開いて確認する
        </a>
        <PromotionPullRequestActions pr={pr} onDone={onResolved} />
      </div>
    </li>
  );
}

/** 一覧に最初から出すファイル数。超えたぶんは「あとNファイルを表示」で開く */
const KNOWLEDGE_FILES_SHOWN = 5;

const KNOWLEDGE_KIND_LABEL: Record<PromotionKnowledgeItem["kind"], string> = {
  added: "追加",
  updated: "更新",
  removed: "削除",
};

/**
 * 暖色（amber）は「人の対応待ち」専用に空けてあるので使わない。追加は緑、更新は青、削除は赤。
 * 削除は反映PRではまず起きないが、起きたときに追加と見分けが付かないのは危険なので色を分ける。
 */
const KNOWLEDGE_KIND_CLASS: Record<PromotionKnowledgeItem["kind"], string> = {
  added: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  updated: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  removed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

/** 「追加3・更新1」のように、0件の種別は省いた内訳 */
function describeKnowledgeCounts(items: PromotionKnowledgeItem[]): string {
  return (["added", "updated", "removed"] as const)
    .map((kind) => [kind, items.filter((item) => item.kind === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${KNOWLEDGE_KIND_LABEL[kind]}${count}`)
    .join("・");
}

/**
 * 反映PRをマージすると共通知識へ何が入るかの一覧（#3107）。
 *
 * それまでは出典Issueの番号しか出ず、マージの可否を決める材料が「PRを開いて確認する」しか
 * なかった。PRの差分から取り出した`##`セクション（見出し＋結論）を、ファイルごとにまとめて出す。
 * **既定は開いた状態**にする——押さないと中身が読めない一覧では、マージ前に読まれない。
 * 長くなりうるので、ファイルは`KNOWLEDGE_FILES_SHOWN`件までにして残りを畳む。
 */
export function PromotionKnowledgeList({ changes }: { changes: PromotionKnowledgeFile[] }) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  if (changes.length === 0) return null;

  const items = changes.flatMap((file) => file.items);
  const shown = showAll ? changes : changes.slice(0, KNOWLEDGE_FILES_SHOWN);
  const hidden = changes.slice(KNOWLEDGE_FILES_SHOWN);
  const hiddenItemCount = hidden.reduce((n, file) => n + file.items.length, 0);

  return (
    <div className="mt-2.5 border-t pt-2" data-testid="promotion-knowledge-list">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-x-2 text-left text-xs font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown
          className={cn("size-3 text-muted-foreground transition-transform", !open && "-rotate-90")}
          aria-hidden
        />
        マージされる知識
        <span className="font-mono text-[11px] font-normal text-muted-foreground">
          {items.length > 0 ? `${items.length}件（${describeKnowledgeCounts(items)}）／` : ""}
          {changes.length}ファイル
        </span>
      </button>

      {open && (
        <div className="mt-1">
          {shown.map((file) => (
            <PromotionKnowledgeFileBlock key={file.path} file={file} />
          ))}
          {hidden.length > 0 && (
            <button
              type="button"
              className="mt-2 text-[11px] text-indigo-700 hover:underline dark:text-indigo-300"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll
                ? "折りたたむ"
                : `あと${hidden.length}ファイル${hiddenItemCount > 0 ? `（${hiddenItemCount}件）` : ""}を表示`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PromotionKnowledgeFileBlock({ file }: { file: PromotionKnowledgeFile }) {
  return (
    <div className="mt-2.5">
      <div className="flex items-baseline gap-1.5 border-b pb-0.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 break-all font-mono">{file.path}</span>
        {file.items.length > 0 && <span className="ml-auto shrink-0">{file.items.length}件</span>}
      </div>
      {file.items.length === 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          見出しの単位では取り出せませんでした（
          <span className="font-mono">
            +{file.additions} −{file.deletions}行
          </span>
          ）。PRを開いて確認してください。
        </p>
      ) : (
        <ul>
          {file.items.map((item, index) => (
            <li key={`${item.kind}-${index}-${item.title}`} className="border-b border-dashed py-1.5 last:border-b-0">
              <div className="flex items-start gap-1.5 text-xs font-semibold leading-snug">
                <span
                  className={cn(
                    "mt-px shrink-0 rounded-sm px-1.5 py-px text-[10px] font-bold",
                    KNOWLEDGE_KIND_CLASS[item.kind],
                  )}
                >
                  {KNOWLEDGE_KIND_LABEL[item.kind]}
                </span>
                <span className="min-w-0 break-words">{item.title}</span>
              </div>
              {item.summary && (
                <p className="mt-0.5 line-clamp-2 pl-9 text-[11px] leading-normal text-muted-foreground">
                  {item.summary}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 「マージする」「マージしない」ボタン。既存のPRマージ機構（`usePullRequestMergeMutation`・
 * `POST /api/issues/pull-request-merge`・`POST /api/issues/pull-request-close`）をそのまま
 * 再利用する（issue-deckのインストールトークンで実行、ユーザー個人のトークンは使わない）。
 *
 * **「マージしない」も置く**（計画レビューG1の指摘）。`promote-knowledge.yml`は
 * 「未マージの反映PRが**マージまたはclose**されるまで次回の判定を見送る」ため、マージしたくない
 * PRを画面からcloseできないと判定を再開する手段がGitHubを開くしかなくなる。`issue-merge-button.tsx`
 * と違い、対応するissue-deck上のIssueは無いため、PRのcloseだけを行いIssueのクローズは行わない。
 *
 * `PullRequestMergeButton`と違い、CI状態・自動レビュー判定・本番リリース内容の一覧は持たない
 * （反映PRにはそれらの情報が無いため）。確認ダイアログはPRタイトルと出典Issueだけを見せる簡易版。
 */
export function PromotionPullRequestActions({
  pr,
  onDone,
}: {
  pr: OpenPromotionPullRequest;
  onDone: () => void;
}) {
  const { mergePullRequest, closePullRequest, isSubmitting, error, setError } =
    usePullRequestMergeMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [declineConfirmOpen, setDeclineConfirmOpen] = useState(false);
  const [resolution, setResolution] = useState<"merged" | "declined" | null>(null);

  async function runMerge() {
    const merged = await mergePullRequest({
      owner: DOCS_REPO_OWNER,
      repo: DOCS_REPO_NAME,
      number: pr.number,
    });
    if (merged) {
      setConfirmOpen(false);
      setResolution("merged");
      onDone();
    }
  }

  async function runDecline() {
    const closed = await closePullRequest({
      owner: DOCS_REPO_OWNER,
      repo: DOCS_REPO_NAME,
      number: pr.number,
    });
    if (closed) {
      setDeclineConfirmOpen(false);
      setResolution("declined");
      onDone();
    }
  }

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      {resolution !== "merged" && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px] text-destructive hover:text-destructive"
          disabled={isSubmitting || resolution === "declined"}
          onClick={() => setDeclineConfirmOpen(true)}
        >
          {resolution === "declined" ? "マージしませんでした" : "マージしない"}
        </Button>
      )}
      {resolution !== "declined" && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          disabled={isSubmitting || resolution === "merged"}
          onClick={() => setConfirmOpen(true)}
        >
          {resolution === "merged" ? "マージ済み" : isSubmitting ? "マージ中..." : "マージする"}
        </Button>
      )}

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) setError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>このPRをマージしますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {DOCS_REPO_OWNER}/{DOCS_REPO_NAME} #{pr.number}（{pr.title}）をマージします。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pr.sourceIssues.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {pr.sourceIssues.map((source) => (
                <li
                  key={`${source.repoFullName}#${source.number}`}
                  className="rounded-sm border bg-muted px-1 font-mono text-[10px] text-muted-foreground"
                >
                  {source.repoFullName.split("/")[1] ?? source.repoFullName}#{source.number}
                </li>
              ))}
            </ul>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // 確認結果を待たずに閉じないよう、既定の閉じる動作を止めてから実行する。
                event.preventDefault();
                runMerge();
              }}
              disabled={isSubmitting}
            >
              {isSubmitting ? "マージ中..." : "マージする"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={declineConfirmOpen}
        onOpenChange={(open) => {
          setDeclineConfirmOpen(open);
          if (!open) setError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>このPRをマージせずに終了しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {DOCS_REPO_OWNER}/{DOCS_REPO_NAME} #{pr.number}（{pr.title}）をクローズします。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-xs text-muted-foreground">
            マージせずにcloseすると、次回の格上げ判定（
            <code className="font-mono">promote-knowledge.yml</code>）が再開します。
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                runDecline();
              }}
              disabled={isSubmitting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <GitPullRequestClosed className="size-3.5" aria-hidden />
              マージしない
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
