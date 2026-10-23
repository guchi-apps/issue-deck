"use client";

import { useCallback, useEffect, useState } from "react";

import { IssueDetailSection } from "@/components/dashboard/issue-detail-section";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import type { PlanChild } from "@/lib/execution-plan/types";
import { formatRef } from "@/lib/execution-plan/types";
import { parentRunChildMarkText, type ParentRunChildMark } from "@/lib/parent-run/child-state";
import type { ChildAction, ChildPhase } from "@/lib/parent-run/decide";
import type { ParentRunBadge as ParentRunBadgeData, ParentRunChildView, ParentRunView } from "@/lib/parent-run/run";
import { cn } from "@/lib/utils";

/**
 * 親Issueの自動実行パネル（#4536）。現在地は先頭の件数と帯、主操作は右上の1つだけ、
 * 止まっている原因は対象Issueと必要な操作つきの帯で示す。PC・スマホで同じ構成（狭い幅では縦に積む）。
 */

type PlanPreview = { currentVersion: number; objective: string; children: PlanChild[]; stages: string[][] };
type Payload = { run: ParentRunView | null; plan: PlanPreview | null };

const PHASE_CLASS: Record<ChildPhase, string> = {
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  running: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  launching: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  ready: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  waiting: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  blocked: "bg-muted text-muted-foreground",
  attention: "bg-red-500/15 text-red-700 dark:text-red-300",
  skipped: "bg-muted text-muted-foreground",
};

const ACTION_LABEL: Record<ChildAction, string> = { retry: "再試行", verify: "本番確認を記録", user: "Issueを開く" };

async function call(body: Record<string, unknown>): Promise<{ ok: true; run: ParentRunView } | { ok: false; message: string }> {
  try {
    const res = await fetch("/api/parent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: json.message ?? json.error ?? `失敗しました（HTTP ${res.status}）` };
    return { ok: true, run: json.run };
  } catch {
    return { ok: false, message: "通信に失敗しました" };
  }
}

export function ParentRunSection({
  repositoryFullName,
  issueNumber,
  hosts,
  idPrefix = "",
}: {
  repositoryFullName: string;
  issueNumber: number;
  hosts: DispatchHostView[];
  idPrefix?: string;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/parent-runs?repository=${encodeURIComponent(repositoryFullName)}&issue=${issueNumber}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      setData((await res.json()) as Payload);
    } catch {
      // 一時的な通信失敗は前回の表示を保つ
    }
  }, [repositoryFullName, issueNumber]);

  useEffect(() => {
    // 取得結果を状態へ反映する（外部のAPIとの同期）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const run = data?.run ?? null;
  const active = run !== null && (run.status === "RUNNING" || run.status === "PAUSED");
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  // 計画を持たない親（本文のみのEpic）は従来どおり。何も出さない
  if (!data || (!data.plan && !run)) return null;

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const result = await call({ repository: repositoryFullName, issue: issueNumber, ...body });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setData((prev) => ({ plan: prev?.plan ?? null, run: result.run }));
  };

  const summary = run?.summary ?? null;
  const counts = summary?.counts;
  const attention = run?.children.filter((c) => c.display.phase === "attention") ?? [];
  const statusLabel =
    run?.status === "COMPLETED" ? "完了" : run?.status === "PAUSED" ? "新規起動を一時停止中" : run?.status === "STOPPED" ? "停止済み" : run ? "進行中" : "未開始";

  const primary = !active ? (
    <Button size="sm" disabled={busy || !data.plan} onClick={() => setDialogOpen(true)}>
      {run ? "もう一度実行を開始" : "計画内の子を実行開始"}
    </Button>
  ) : run.status === "PAUSED" ? (
    <Button size="sm" disabled={busy} onClick={() => void act({ action: "resume" })}>
      再開
    </Button>
  ) : (
    <Button size="sm" disabled={busy} onClick={() => void act({ action: "pause" })}>
      新規起動を一時停止
    </Button>
  );

  return (
    <IssueDetailSection
      id={`${idPrefix}parent-run`}
      title="自動実行"
      forceOpen={active || attention.length > 0}
      tone={attention.length > 0 ? "attention" : "default"}
      summary={
        counts ? (
          <span className="text-xs" data-testid="parent-run-summary">
            完了{counts.done}件／実行中{counts.running}件／待機{counts.waiting}件
            {counts.attention > 0 ? `／要対応${counts.attention}件` : ""}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{statusLabel}</span>
        )
      }
    >
      <div className="flex flex-col gap-3" data-testid="parent-run-section">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-sm font-bold">
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs">{statusLabel}</span>
              {counts && (
                <>
                  <span className={cn("rounded-full px-2.5 py-0.5 text-xs", PHASE_CLASS.done)}>完了{counts.done}件</span>
                  <span className={cn("rounded-full px-2.5 py-0.5 text-xs", PHASE_CLASS.running)}>実行中{counts.running}件</span>
                  <span className={cn("rounded-full px-2.5 py-0.5 text-xs", PHASE_CLASS.waiting)}>待機{counts.waiting}件</span>
                  {counts.attention > 0 && (
                    <span className={cn("rounded-full px-2.5 py-0.5 text-xs", PHASE_CLASS.attention)}>要対応{counts.attention}件</span>
                  )}
                </>
              )}
            </div>
            {counts && counts.total > 0 && (
              <div className="mt-2 flex h-2 overflow-hidden rounded bg-muted" aria-hidden>
                <i className="bg-emerald-500" style={{ width: `${(counts.done / counts.total) * 100}%` }} />
                <i className="bg-sky-500" style={{ width: `${(counts.running / counts.total) * 100}%` }} />
              </div>
            )}
            {run && (
              <p className="mt-1 text-xs text-muted-foreground">
                計画v{run.planVersion}に固定／実行先: {run.hostName}（{run.agent}）
                {summary?.next ? `／次に着手: ${summary.next.split("/").pop()}` : ""}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {primary}
            {active && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: "stop" })}>
                未起動の子を停止
              </Button>
            )}
          </div>
        </div>

        {run?.notice && <p className="rounded-md bg-muted px-3 py-2 text-xs">{run.notice}</p>}
        {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300" role="alert">{error}</p>}

        {attention.length > 0 && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs" data-testid="parent-run-attention">
            {attention.map((c) => (
              <p key={`${c.repository}#${c.number}`}>
                <b>#{c.number}</b> {c.display.reason}
              </p>
            ))}
            <p className="mt-1 text-muted-foreground">この子に依存する後続は止まっています。独立した子は進みます。</p>
          </div>
        )}

        {run && (
          <ul className="flex flex-col gap-2">
            {run.children.map((c) => (
              <ChildRow
                key={`${c.repository}#${c.number}`}
                child={c}
                active={active}
                busy={busy}
                baseRepository={repositoryFullName}
                onAction={(body) => void act(body)}
              />
            ))}
          </ul>
        )}

        {summary && !summary.complete && summary.evidence.some((e) => e.label === "本番（main）への反映" && e.ok) && (
          // リリース済みと機能全体の完了は別（#4524）。本番確認などが残る間は未完了と言う
          <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs" data-testid="parent-run-released-incomplete">
            <b>リリース済みですが、機能全体は未完了です。</b>
            残り: {summary.evidence.filter((e) => !e.ok).map((e) => e.label).join("、")}
          </p>
        )}

        {summary && (
          <ul className="border-t border-dashed pt-2 text-xs" data-testid="parent-run-evidence">
            {summary.evidence.map((e) => (
              <li key={e.label} className="flex gap-2">
                <b className={e.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>{e.ok ? "済" : "未"}</b>
                <span>
                  {e.label}: {e.detail}
                </span>
              </li>
            ))}
            {!summary.complete && active && run && !run.verified && summary.evidence[0]?.ok && (
              <li className="mt-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: "verify" })}>
                  親全体の本番確認を記録
                </Button>
              </li>
            )}
          </ul>
        )}
      </div>

      {data.plan && (
        <StartDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          plan={data.plan}
          run={run}
          hosts={hosts}
          busy={busy}
          onStart={async (body) => {
            await act({ action: "start", ...body });
            setDialogOpen(false);
          }}
        />
      )}
    </IssueDetailSection>
  );
}

function ChildRow({
  child,
  active,
  busy,
  baseRepository,
  onAction,
}: {
  child: ParentRunChildView;
  active: boolean;
  busy: boolean;
  baseRepository: string;
  onAction: (body: Record<string, unknown>) => void;
}) {
  const d = child.display;
  const ref = { repository: child.repository, number: child.number };
  const label = child.repository === baseRepository ? `#${child.number}` : formatRef(ref);
  const url = `https://github.com/${child.repository}/issues/${child.number}`;
  return (
    <li className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-md border px-3 py-2", d.phase === "running" && "border-primary")} data-phase={d.phase}>
      <div className="min-w-0 text-sm font-bold">
        <a href={url} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted-foreground underline-offset-2 hover:underline">
          {label}
        </a>{" "}
        <span className="break-words">{child.title ?? ""}</span>
      </div>
      <span className={cn("self-start whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-bold", PHASE_CLASS[d.phase])}>{d.label}</span>
      <p className="col-span-2 break-words text-xs text-muted-foreground">{d.reason}</p>
      {active && d.action && d.action !== "user" && (
        <div className="col-span-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onAction(d.action === "retry" ? { action: "retry", child: ref } : { action: "verify", child: ref })}
          >
            {ACTION_LABEL[d.action]}
          </Button>
        </div>
      )}
      {d.action === "user" && (
        <div className="col-span-2">
          <a href={url} target="_blank" rel="noreferrer" className="text-xs underline">
            {ACTION_LABEL.user}
          </a>
        </div>
      )}
    </li>
  );
}

function StartDialog({
  open,
  onOpenChange,
  plan,
  run,
  hosts,
  busy,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: PlanPreview;
  run: ParentRunView | null;
  hosts: DispatchHostView[];
  busy: boolean;
  onStart: (body: Record<string, unknown>) => Promise<void>;
}) {
  const online = hosts.filter((h) => h.online);
  const [host, setHost] = useState<string>("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [maxParallel, setMaxParallel] = useState(2);
  const chosen = host || online[0]?.name || "";
  const host_ = hosts.find((h) => h.name === chosen);
  const codexOk = host_?.codexCapable === true;
  const doneKeys = new Set(run?.children.filter((c) => c.display.phase === "done").map((c) => `${c.repository}#${c.number}`) ?? []);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>計画内の子を実行開始</AlertDialogTitle>
          <AlertDialogDescription>
            計画v{plan.currentVersion}に結びつけて開始します。計画に無い子は起動せず、本番リリースや既存の必須承認は自動で許可しません。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex flex-col gap-1 text-xs">
          <li>対象: {plan.children.length}件（完了済みの子は成果を再利用し、実行中の子は引き継ぎます）</li>
          <li>順序:</li>
          {plan.stages.map((stage, i) => (
            <li key={i} className="ml-3 break-words">
              {i + 1}段目{stage.length > 1 ? "（並行可）" : ""}: {stage.map((k) => (doneKeys.has(k) ? `${k}（完了済み）` : k)).join("、")}
            </li>
          ))}
          <li>到達点: 全ての子のdevelopマージ・本番反映・本番確認（本番リリース自体は別の承認）</li>
        </ul>
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex flex-col gap-1 text-xs" htmlFor="parent-run-host">
            実行先ホスト
            <select
              id="parent-run-host"
              className="rounded-md border bg-background px-2 py-2 text-sm"
              value={chosen}
              onChange={(e) => setHost(e.target.value)}
            >
              {online.length === 0 && <option value="">オンラインのホストがありません</option>}
              {online.map((h) => (
                <option key={h.name} value={h.name}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs" htmlFor="parent-run-agent">
            エージェント
            <select
              id="parent-run-agent"
              className="rounded-md border bg-background px-2 py-2 text-sm"
              value={agent}
              onChange={(e) => setAgent(e.target.value === "codex" ? "codex" : "claude")}
            >
              <option value="claude">Claude Code</option>
              <option value="codex" disabled={!codexOk}>
                Codex{codexOk ? "" : "（このホストは未対応）"}
              </option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs" htmlFor="parent-run-parallel">
            同時に進める子の上限
            <select
              id="parent-run-parallel"
              className="rounded-md border bg-background px-2 py-2 text-sm"
              value={maxParallel}
              onChange={(e) => setMaxParallel(Number(e.target.value))}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}件（ホストの同時実行枠の範囲内）
                </option>
              ))}
            </select>
          </label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>キャンセル</AlertDialogCancel>
          <Button disabled={busy || !chosen} onClick={() => void onStart({ host: chosen, agent, maxParallel })}>
            この内容で開始
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** 一覧の親の行に出す印。要対応があれば赤、一時停止は橙、進行中は青 */
export function ParentRunBadge({ run }: { run: ParentRunBadgeData }) {
  const attention = (run.counts?.attention ?? 0) > 0;
  const tone = attention ? PHASE_CLASS.attention : run.status === "PAUSED" ? PHASE_CLASS.waiting : PHASE_CLASS.running;
  const text = attention ? "自動実行・要対応" : run.status === "PAUSED" ? "自動実行・一時停止" : "自動実行中";
  return (
    <span
      data-testid="parent-run-badge"
      title={run.counts ? `完了${run.counts.done}件／実行中${run.counts.running}件／待機${run.counts.waiting}件` : undefined}
      className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold", tone)}
    >
      {text}
      {run.counts ? ` ${run.counts.done}/${run.counts.total}` : ""}
    </span>
  );
}

/**
 * 親の自動実行の対象になっている子Issueの印（#4953）。一覧の行と詳細の状態欄に出す。
 * `showReason`なら待機先・理由を続けて書く（詳細）。一覧ではtitleに置く
 */
export function ParentRunChildBadge({ mark, showReason = false }: { mark: ParentRunChildMark; showReason?: boolean }) {
  const tone = mark.kind === "running" ? PHASE_CLASS.running : PHASE_CLASS.waiting;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span
        data-testid="parent-run-child-badge"
        data-kind={mark.kind}
        title={mark.reason}
        className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold", tone)}
      >
        {parentRunChildMarkText(mark)}
      </span>
      {showReason && <span className="text-xs text-muted-foreground">{mark.reason}</span>}
    </span>
  );
}
