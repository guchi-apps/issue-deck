"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Hourglass, RefreshCw, Send, XCircle } from "lucide-react";

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
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  describeDependencyWait,
  formatDependencyRef,
  type DependencyWaitNotice,
  type DependencyWaitView,
} from "@/lib/dispatch/dependency-wait";
import { formatDateTime, formatDateTimeFull } from "@/lib/format-date-time";
import { cn } from "@/lib/utils";

/**
 * 実装セッションの依存待ち（#4321）の表示と、スマホからもできる再確認・再開。
 *
 * **待機中に回転するアイコンは出さない**（待っているだけで動いてはいない）。`11.local`が付いて
 * いても「ローカルで対応中」とは別に、何を待っているのかをここで言う。ユーザー操作が要るのは
 * 「人の確認が必要」「再開に失敗」のときだけで、その2つだけ橙にする。
 */

const TONE_CLASS: Record<DependencyWaitNotice["tone"], string> = {
  pending: "bg-sky-500/10 text-sky-700 ring-sky-500/40 dark:text-sky-300",
  attention: "bg-amber-500/15 text-amber-700 ring-amber-500 dark:text-amber-400",
  progress: "bg-primary/10 text-primary ring-primary/40",
  done: "bg-muted text-muted-foreground ring-border",
};

function ToneIcon({ tone }: { tone: DependencyWaitNotice["tone"] }) {
  const className = "size-3.5";
  if (tone === "attention") return <AlertTriangle className={className} />;
  if (tone === "done") return <CheckCircle2 className={className} />;
  if (tone === "progress") return <Send className={className} />;
  return <Hourglass className={className} />;
}

/** 一覧の行に出す小さなバッジ。アニメーションは付けない */
export function DependencyWaitBadge({ wait }: { wait: DependencyWaitView }) {
  const notice = describeDependencyWait(wait);
  return (
    <span
      data-testid="dependency-wait-badge"
      title={`${wait.reason}（${formatDependencyRef(wait.dependency)}）`}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONE_CLASS[notice.tone],
      )}
    >
      <ToneIcon tone={notice.tone} />
      {notice.shortLabel}
    </span>
  );
}

export function DependencyWaitPanel({
  wait,
  dispatch,
}: {
  wait: DependencyWaitView;
  dispatch: DispatchStateHandle;
}) {
  const notice = describeDependencyWait(wait);
  const [message, setMessage] = useState<string | null>(null);
  const active = wait.status !== "RESUMED" && wait.status !== "CANCELLED";
  const canResume =
    wait.status === "WAITING" || wait.status === "NEEDS_CONFIRM" || wait.status === "RESUME_FAILED";

  const [confirmingCancel, setConfirmingCancel] = useState(false);

  async function run(action: "recheck" | "resume" | "cancel") {
    setMessage(null);
    const result = await dispatch.controlDependencyWait({ id: wait.id, action });
    if (!result.ok) setMessage(result.message);
  }

  return (
    <div
      data-testid="dependency-wait-panel"
      className="flex flex-col gap-2 rounded-md border bg-card p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
            TONE_CLASS[notice.tone],
          )}
        >
          <ToneIcon tone={notice.tone} />
          {notice.label}
        </span>
        <a
          href={wait.dependencyUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
        >
          {formatDependencyRef(wait.dependency)}
          <ExternalLink className="size-3" />
        </a>
      </div>

      <p className="text-sm">{wait.reason}</p>

      {wait.results.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs">
          {wait.results.map((r) => (
            <li key={r.condition} className="flex items-start gap-1.5">
              <span aria-hidden>{r.satisfied === true ? "✅" : r.satisfied === false ? "⏳" : "❓"}</span>
              <span>
                {r.detail}
                <span className="text-muted-foreground">（{r.condition}）</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">次に起きること: {notice.nextStep}</p>

      {wait.lastError && (
        <p className="text-xs text-destructive">依存先の状態を取得できませんでした: {wait.lastError}</p>
      )}

      <p className="text-xs text-muted-foreground">
        最終確認:{" "}
        {wait.lastCheckedAt ? (
          <time dateTime={wait.lastCheckedAt} title={formatDateTimeFull(wait.lastCheckedAt)}>
            {formatDateTime(wait.lastCheckedAt)}
          </time>
        ) : (
          "未確認"
        )}
      </p>

      {active && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={dispatch.isSubmitting}
            onClick={() => void run("recheck")}
          >
            <RefreshCw className="size-3.5" />
            条件を再確認
          </Button>
          {canResume && (
            <Button
              type="button"
              size="sm"
              disabled={dispatch.isSubmitting}
              onClick={() => void run("resume")}
            >
              <Send className="size-3.5" />
              作業を再開
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={dispatch.isSubmitting}
            onClick={() => setConfirmingCancel(true)}
          >
            <XCircle className="size-3.5" />
            待機を解除
          </Button>
        </div>
      )}
      {message && <p className="text-xs text-destructive">{message}</p>}

      <AlertDialog open={confirmingCancel} onOpenChange={setConfirmingCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>依存待ちを解除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {formatDependencyRef(wait.dependency)}の待機を取り消します。条件が成立しても、このセッションへ
              再開の指示は送られなくなります。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dispatch.isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={dispatch.isSubmitting}
              onClick={(event) => {
                event.preventDefault();
                void run("cancel").finally(() => setConfirmingCancel(false));
              }}
            >
              解除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * 「保留コメントと`11.local`だけが残る」既存の保留（#687相当）の回収口。コメントから依存先の
 * **候補**を拾って見せるだけで、人が条件を選んで確定するまで登録も再開もしない。
 * 依存先を特定できなければ何も出さない（推定で待機を作らない）。
 */
export function LegacyHoldNotice({
  repositoryFullName,
  issueNumber,
  dispatch,
}: {
  repositoryFullName: string;
  issueNumber: number;
  dispatch: DispatchStateHandle;
}) {
  const [candidate, setCandidate] = useState<{
    dependency: { repository: string; number: number; kind: "issue" | "pr" };
    excerpt: string;
  } | null>(null);
  const [kind, setKind] = useState<"closed" | "released">("closed");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ repository: repositoryFullName, issue: String(issueNumber) });
    void fetch(`/api/dispatch/dependency-wait?${params}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { candidate?: typeof candidate } | null) => {
        if (!cancelled) setCandidate(json?.candidate ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repositoryFullName, issueNumber]);

  if (!candidate) return null;

  async function register() {
    if (!candidate) return;
    setMessage(null);
    try {
      const res = await fetch("/api/dispatch/dependency-wait", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "register",
          repository: repositoryFullName,
          issue: issueNumber,
          dependency: candidate.dependency,
          conditions: [kind],
          reason: `${formatDependencyRef(candidate.dependency)}の完了待ち（保留コメントから登録）`,
        }),
      });
      if (!res.ok) throw new Error(`登録に失敗しました (${res.status})`);
      setCandidate(null);
      dispatch.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div
      data-testid="legacy-hold-notice"
      className="flex flex-col gap-2 rounded-md border border-amber-500/60 bg-amber-500/10 p-3 text-sm"
    >
      <p className="font-medium">保留中の可能性があります（要確認）</p>
      <p className="text-xs text-muted-foreground">
        コメントから依存先の候補を見つけました: {formatDependencyRef(candidate.dependency)}「{candidate.excerpt}」。
        自動では待機を登録していません。待つ条件を選んで登録すると、成立後に自動で再開します。
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          条件
          <select
            className="rounded border bg-background px-1 py-0.5"
            value={kind}
            onChange={(e) => setKind(e.target.value === "released" ? "released" : "closed")}
          >
            <option value="closed">依存先のクローズ</option>
            <option value="released">本番（main）への反映</option>
          </select>
        </label>
        <Button type="button" size="sm" disabled={dispatch.isSubmitting} onClick={() => void register()}>
          この依存で待機を登録
        </Button>
      </div>
      {message && <p className="text-xs text-destructive">{message}</p>}
    </div>
  );
}
