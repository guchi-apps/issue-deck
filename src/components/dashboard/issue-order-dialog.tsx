"use client";

import {
  ArrowRight,
  CircleMinus,
  Compass,
  Loader2,
  PartyPopper,
  RotateCw,
  Server,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useDispatchState, type DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { IssueOrderGuideHandle } from "@/hooks/use-issue-order-guide";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { enqueueIssueToDefaultHost } from "@/lib/dispatch/enqueue-issue";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { buildIssueOrderKey, type IssueOrderEntry } from "@/lib/issue-order-view";
import { getLabelBadgeStyle } from "@/lib/label-color";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";

/**
 * 「次にやること」（#1853）。未着手のIssueの着手順をClaudeに決めさせ、理由を添えて出す。
 *
 * 未着手ビューは`Ready`のIssueを更新の新しい順に並べるだけで、どれから手を付けるかを決めるには
 * Issueを1件ずつ開き直すしかなかった。ここでは**順位そのものより「なぜその順なのか」**を読める
 * ようにし、1位からそのまま着手できるようにする。あわせて、**実施しない方がよさそうなもの**
 * （重複・陳腐化）も理由付きで挙げる。
 *
 * **PC・スマホで同じコンポーネントを使う**（`manual-step-guide-dialog.tsx`と同じ方針）。
 *
 * 判定結果は保存しない。未着手の顔ぶれが変われば順番も変わるもので、保存すると古い順位が
 * 正しく見えてしまう。閉じれば消え、必要なときに「決め直す」で取り直す。
 */
export function IssueOrderDialog({
  guide,
  onSelectIssue,
  dispatch: injectedDispatch,
}: {
  guide: IssueOrderGuideHandle;
  /** 行を押したときにそのIssueを開く。ダイアログは閉じる */
  onSelectIssue: (issue: Issue) => void;
  /**
   * ディスパッチの状態（自動開始が使う）。**テストから差し込むためだけの口**で、
   * 通常は開いている間だけ自前で取得する（閉じているダイアログのためにポーリングを増やさない）。
   */
  dispatch?: DispatchStateHandle;
}) {
  const ownDispatch = useDispatchState(injectedDispatch === undefined && guide.open);
  const dispatch = injectedDispatch ?? ownDispatch;

  return (
    <Dialog open={guide.open} onOpenChange={guide.setOpen}>
      {/* ヘッダー・本文・フッターの3段。本文だけをスクロールさせるため、既定の
          `overflow-y-auto`と`gap-4`／`p-4`を打ち消して自前で持つ */}
      <DialogContent
        className="grid max-h-[calc(100%-1rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-2xl"
        showCloseButton={false}
      >
        {/* 閉じるとDialogごと外れるので、自動開始を試した記録は自然に捨てられる */}
        <OrderSession guide={guide} dispatch={dispatch} onSelectIssue={onSelectIssue} />
      </DialogContent>
    </Dialog>
  );
}

/** 自動開始の結果。行の下に出す */
type StartOutcome = { ok: boolean; message: string };

function OrderSession({
  guide,
  dispatch,
  onSelectIssue,
}: {
  guide: IssueOrderGuideHandle;
  dispatch: DispatchStateHandle;
  onSelectIssue: (issue: Issue) => void;
}) {
  const { updateIssue } = useIssueMutations();
  const [startingKey, setStartingKey] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, StartOutcome>>({});
  /**
   * 自動開始をもう試したIssue。**同じIssueへ二度積みに行かない**ための記録で、
   * 結果（成功・失敗）とは別に持つ。失敗しても自動では繰り返さず、
   * 「サブPCで開始」を押して人がやり直す
   */
  const attemptedRef = useRef<Set<string>>(new Set());

  const { top } = guide.view;
  const topKey = top ? buildIssueOrderKey(top.issue) : null;

  useEffect(() => {
    if (!guide.autoStart || !top || !topKey) return;
    // **`isLoaded`が立つまで積みに行かない**（#1666・#1810）。取得前の`hosts`は`[]`で、
    // 「1台も無い」と区別が付かないため、待たないと必ず「起動先がありません」で失敗する
    if (!dispatch.isLoaded) return;
    if (attemptedRef.current.has(topKey)) return;

    attemptedRef.current.add(topKey);
    setStartingKey(topKey);
    void (async () => {
      const outcome = await enqueueIssueToDefaultHost(top.issue, {
        hosts: dispatch.hosts,
        sessions: dispatch.sessions,
        enqueue: dispatch.enqueue,
        enqueueError: dispatch.error,
        updateIssue,
      });
      setOutcomes((prev) => ({
        ...prev,
        [topKey]: outcome.ok
          ? {
              ok: true,
              message: `${formatDispatchHostName(outcome.hostName)}へ積みました。順番が来ると実装セッションが起動します。`,
            }
          : { ok: false, message: outcome.reason },
      }));
      setStartingKey(null);
    })();
  }, [guide.autoStart, top, topKey, dispatch, updateIssue]);

  return (
    <>
      <header className="flex flex-col gap-1.5 border-b p-4">
        <div className="flex items-center gap-2">
          <DialogTitle className="flex min-w-0 items-center gap-1.5 text-sky-700 dark:text-sky-300">
            <Compass className="size-4 shrink-0" />
            次にやること
          </DialogTitle>
          {guide.totalCount > 0 && (
            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
              未着手{guide.totalCount}件
              {guide.candidateCount < guide.totalCount && `（うち${guide.candidateCount}件が対象）`}
            </span>
          )}
        </div>
        <DialogDescription className="text-xs">
          {guide.isDeciding
            ? "着手する順番をClaudeが決めています…"
            : "未着手のIssueから、着手する順番をClaudeが決めました。"}
        </DialogDescription>
      </header>

      <div className="flex min-h-0 flex-col overflow-y-auto">
        <OrderBody
          guide={guide}
          outcomes={outcomes}
          startingKey={startingKey}
          onSelectIssue={(issue) => {
            guide.setOpen(false);
            onSelectIssue(issue);
          }}
        />
      </div>

      <footer className="flex flex-col gap-2 border-t bg-muted/50 p-3 sm:flex-row sm:items-center">
        <label className="flex min-w-0 flex-1 items-start gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={guide.autoStart}
            onCheckedChange={(checked) => guide.setAutoStart(checked === true)}
            className="mt-0.5 shrink-0"
          />
          <span>
            1位が決まったら自動でサブPCへ積む
            <span className="block text-[11px]">
              積めない状態（起動先が無い・既に走っている）のときは積まずに理由を出します。
            </span>
          </span>
        </label>
        <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row">
          <Button
            variant="outline"
            size="sm"
            disabled={guide.isDeciding}
            onClick={guide.redecide}
          >
            {guide.isDeciding ? <Loader2 className="animate-spin" /> : <RotateCw />}
            決め直す
          </Button>
          <Button size="sm" onClick={() => guide.setOpen(false)}>
            閉じる
          </Button>
        </div>
      </footer>
    </>
  );
}

function OrderBody({
  guide,
  outcomes,
  startingKey,
  onSelectIssue,
}: {
  guide: IssueOrderGuideHandle;
  outcomes: Record<string, StartOutcome>;
  startingKey: string | null;
  onSelectIssue: (issue: Issue) => void;
}) {
  const { overview, top, rest, skip } = guide.view;

  if (guide.isDeciding) {
    return (
      <div className="flex flex-col items-center gap-2 p-10 text-center">
        <Loader2 className="size-6 animate-spin text-sky-600 dark:text-sky-400" />
        <p className="text-sm text-muted-foreground">
          Claudeが{guide.candidateCount}件を読んでいます。
        </p>
      </div>
    );
  }

  if (guide.notConfigured) {
    return (
      <div className="flex flex-col items-center gap-2 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          この環境ではAIによる判定を使えません（<code>CLAUDE_CODE_OAUTH_TOKEN</code>が未設定）。
        </p>
      </div>
    );
  }

  if (guide.error) {
    return (
      <div className="p-4">
        <ApiErrorMessage message={guide.error} />
      </div>
    );
  }

  if (guide.totalCount === 0) {
    return (
      <div className="flex flex-col items-center gap-2 p-10 text-center">
        <PartyPopper className="size-7 text-emerald-600 dark:text-emerald-400" />
        <p className="text-sm text-muted-foreground">
          未着手のIssueがありません。決める順番もありません。
        </p>
      </div>
    );
  }

  if (!top && rest.length === 0 && skip.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          着手順を決められませんでした。「決め直す」でもう一度試せます。
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {overview && (
        <div className="flex items-start gap-2 rounded-md bg-muted p-3 text-xs leading-relaxed">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
          <p>{overview}</p>
        </div>
      )}

      {top && (
        <TopCard
          entry={top}
          outcome={outcomes[buildIssueOrderKey(top.issue)] ?? null}
          isStarting={startingKey === buildIssueOrderKey(top.issue)}
          onOpen={() => onSelectIssue(top.issue)}
          onDismiss={() => guide.dismiss(buildIssueOrderKey(top.issue))}
        />
      )}

      {rest.length > 0 && (
        <ul className="flex flex-col">
          {rest.map((entry, index) => (
            <li key={buildIssueOrderKey(entry.issue)}>
              <RestRow entry={entry} order={index + 2} onOpen={() => onSelectIssue(entry.issue)} />
            </li>
          ))}
        </ul>
      )}

      {skip.length > 0 && <SkipSection entries={skip} onSelectIssue={onSelectIssue} />}
    </div>
  );
}

function IssueLabels({ issue }: { issue: Issue }) {
  if (issue.labels.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {issue.labels.map((label) => (
        <span
          key={label.name}
          className="rounded-full px-2 py-px text-[11px] leading-4"
          style={getLabelBadgeStyle(label.color)}
        >
          {label.name}
        </span>
      ))}
    </div>
  );
}

function TopCard({
  entry,
  outcome,
  isStarting,
  onOpen,
  onDismiss,
}: {
  entry: IssueOrderEntry;
  outcome: StartOutcome | null;
  isStarting: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { issue, reason } = entry;

  return (
    <section className="flex flex-col gap-2 rounded-md border border-sky-500/40 bg-sky-500/5 p-3">
      <div className="flex items-start gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-sky-600 text-xs font-bold tabular-nums text-white dark:bg-sky-400 dark:text-neutral-900">
          1
        </span>
        <div className="min-w-0">
          <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {issue.repositoryFullName} #{issue.number}
          </p>
          <h3 className="text-sm font-semibold leading-snug">{issue.title}</h3>
        </div>
      </div>

      <IssueLabels issue={issue} />

      {reason && <p className="text-xs leading-relaxed">{reason}</p>}

      {isStarting && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          サブPCへ積んでいます…
        </p>
      )}
      {outcome && (
        <p
          className={cn(
            "flex items-start gap-1.5 text-xs",
            outcome.ok ? "text-emerald-700 dark:text-emerald-300" : "text-destructive",
          )}
        >
          <Server className="mt-0.5 size-3.5 shrink-0" />
          {outcome.message}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
        <Button variant="ghost" size="xs" onClick={onDismiss} className="sm:order-2 sm:ml-auto">
          見送って次の候補へ
        </Button>
        <Button size="sm" onClick={onOpen} className="sm:order-1">
          <ArrowRight />
          このIssueを開く
        </Button>
      </div>
    </section>
  );
}

function RestRow({
  entry,
  order,
  onOpen,
}: {
  entry: IssueOrderEntry;
  order: number;
  onOpen: () => void;
}) {
  const { issue, reason } = entry;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-2 border-t p-2 text-left hover:bg-accent"
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded border text-xs font-semibold tabular-nums text-muted-foreground">
        {order}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {issue.repositoryFullName} #{issue.number}
          </span>
          <span className="text-[13px] font-medium">{issue.title}</span>
        </span>
        {reason && <span className="text-[11px] leading-relaxed text-muted-foreground">{reason}</span>}
      </span>
    </button>
  );
}

/**
 * 実施しない方がよさそうなもの（#1853）。
 *
 * **クローズもラベル付けも行わない。** 重複・陳腐化の判定はタイトルと本文の冒頭からの推測でしか
 * なく、外れることがある。挙げるところまでを機械が担い、どうするかは開いて確かめた人が決める。
 */
function SkipSection({
  entries,
  onSelectIssue,
}: {
  entries: IssueOrderEntry[];
  onSelectIssue: (issue: Issue) => void;
}) {
  return (
    <section className="flex flex-col gap-1.5 rounded-md border border-dashed p-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <X className="size-3.5" />
        実施しない方がよさそうなもの
        <span className="ml-auto font-normal tabular-nums">{entries.length}件</span>
      </h3>
      <ul className="flex flex-col">
        {entries.map((entry) => (
          <li key={buildIssueOrderKey(entry.issue)}>
            <button
              type="button"
              onClick={() => onSelectIssue(entry.issue)}
              className="flex w-full items-start gap-2 rounded p-1.5 text-left hover:bg-accent"
            >
              <CircleMinus className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {entry.issue.repositoryFullName} #{entry.issue.number}
                  </span>
                  <span className="text-[13px] font-medium">{entry.issue.title}</span>
                </span>
                {entry.reason && (
                  <span className="text-[11px] leading-relaxed text-muted-foreground">
                    {entry.reason}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        押すとそのIssueを開きます。クローズは自動で行いません。
      </p>
    </section>
  );
}
