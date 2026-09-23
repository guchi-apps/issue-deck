"use client";

import { useCallback, useState } from "react";

import type { ClaudeLocalModel } from "@/lib/app-settings";
import {
  reserveIssuesSequentially,
  type BulkReserveTarget,
} from "@/lib/nightly-run";

/** 「次の5時間枠」へ1件積む。積む口は「実装を開始」ダイアログと同じ`POST /api/nightly-run` */
async function reserveOnNextWindow(
  target: BulkReserveTarget,
  model: ClaudeLocalModel | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await fetch("/api/nightly-run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repository: target.repositoryFullName,
      issue: target.number,
      host: target.host,
      kind: "next-window",
      // 未選択（設定に従う）のときは送らない。積む口が「未指定＝設定の既定」として扱う
      ...(model ? { model } : {}),
    }),
  });
  if (res.ok) return { ok: true };
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  return { ok: false, message: json.message ?? `予約実行に積めませんでした (${res.status})` };
}

export type BulkReserveSummary = { queued: number; failed: number };

/**
 * Issue一覧の一括予約（#3284）の状態。選択モードの入切・選んだ行・登録の進み具合・結果を持つ。
 *
 * **選べるかどうかの判定はここに置かない**（行の状態を読める`IssueList`が
 * `resolveBulkReserveRejection`で決め、選べるものだけを`submit`へ渡す）。
 */
export function useBulkReserve({ onQueued }: { onQueued?: () => void } = {}) {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<BulkReserveSummary | null>(null);
  // この回に予約する全件へ適用するClaudeのモデル。nullは「設定に従う」
  const [model, setModel] = useState<ClaudeLocalModel | null>(null);

  const isSubmitting = progress !== null;

  const start = useCallback(() => {
    setActive(true);
    setSummary(null);
  }, []);

  const exit = useCallback(() => {
    setActive(false);
    setSelected(new Set());
    setFailures(new Map());
    setSummary(null);
  }, []);

  const toggle = useCallback((issueId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
    setFailures((prev) => {
      if (!prev.has(issueId)) return prev;
      const next = new Map(prev);
      next.delete(issueId);
      return next;
    });
  }, []);

  const replaceSelection = useCallback((issueIds: readonly string[]) => {
    setSelected(new Set(issueIds));
    setFailures(new Map());
  }, []);

  const submit = useCallback(
    async (targets: readonly BulkReserveTarget[]) => {
      if (targets.length === 0) return;
      setSummary(null);
      setFailures(new Map());
      setProgress({ done: 0, total: targets.length });
      let done = 0;
      const results = await reserveIssuesSequentially(targets, async (target) => {
        const outcome = await reserveOnNextWindow(target, model);
        done += 1;
        setProgress({ done, total: targets.length });
        return outcome;
      });
      const failed = new Map<string, string>();
      const queuedIds = new Set<string>();
      for (const result of results) {
        if (result.ok) queuedIds.add(result.issueId);
        else failed.set(result.issueId, result.message);
      }
      setProgress(null);
      setSummary({ queued: queuedIds.size, failed: failed.size });
      setFailures(failed);
      // 積めたものは選択から外し、積めなかったものだけを選択のまま残して再試行できるようにする
      setSelected((prev) => new Set([...prev].filter((id) => !queuedIds.has(id))));
      // 全件積めたら選択モードを閉じる。結果の1行だけは`summary`として残す
      if (failed.size === 0) setActive(false);
      if (queuedIds.size > 0) onQueued?.();
    },
    [onQueued, model],
  );

  return {
    active,
    selected,
    failures,
    progress,
    summary,
    model,
    setModel,
    isSubmitting,
    start,
    exit,
    toggle,
    replaceSelection,
    submit,
    dismissSummary: useCallback(() => setSummary(null), []),
  };
}

export type BulkReserveHandle = ReturnType<typeof useBulkReserve>;
