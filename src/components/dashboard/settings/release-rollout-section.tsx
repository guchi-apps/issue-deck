"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ROLLOUT_STATUS_LABELS, type RolloutRow, type RolloutStatus } from "@/lib/release-rollout";

const STATUS_STYLES: Record<RolloutStatus, string> = {
  not_registered: "border-destructive/40 text-destructive",
  setup_missing: "border-destructive/40 text-destructive",
  awaiting_distribution: "border-amber-500/50 text-amber-600 dark:text-amber-400",
  awaiting_verification: "border-amber-500/50 text-amber-600 dark:text-amber-400",
  verified: "border-sky-500/50 text-sky-600 dark:text-sky-400",
  enforced: "border-emerald-500/50 text-emerald-600 dark:text-emerald-400",
  excluded: "border-muted-foreground/40 text-muted-foreground",
};

/**
 * リリース検証（統合検証・全体レビュー）の導入状況（#4365）。全対象を1回の読み取りで一覧する。
 * 未導入・設定不足・配布待ち・検証待ち・検証済み・必須化済み・対象外を、理由つきで出す。スマホは縦積み。
 */
export function ReleaseRolloutSection() {
  const [rows, setRows] = useState<RolloutRow[] | null>(null);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/repositories/release/rollout", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json: { repositories: RolloutRow[]; complete: boolean }) => {
        if (cancelled) return;
        setError(null);
        setRows(json.repositories);
        setComplete(json.complete);
      })
      .catch(() => !cancelled && setError("導入状況を取得できませんでした。再取得してください。"));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const counts = new Map<RolloutStatus, number>();
  for (const row of rows ?? []) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {[...counts].map(([status, count]) => (
          <span key={status} className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLES[status]}`}>
            {ROLLOUT_STATUS_LABELS[status]} {count}
          </span>
        ))}
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setReloadKey((key) => key + 1)}>
          再取得
        </Button>
      </div>
      {rows && !complete ? (
        <p className="text-xs text-muted-foreground">
          全対象の必須化が終わるまで、この展開は完了していません（対象外は根拠つきで除く）。
        </p>
      ) : null}
      {error ? <p className="rounded-md border p-2">{error}</p> : null}
      {!rows && !error ? <p className="text-muted-foreground">取得しています…</p> : null}
      <ul className="flex flex-col">
        {rows?.map((row) => (
          <li key={row.fullName} className="flex flex-col gap-0.5 border-t py-1.5 text-xs first:border-t-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="break-all font-medium">{row.fullName}</span>
              <span className={`rounded-full border px-2 py-0.5 ${STATUS_STYLES[row.status]}`}>
                {ROLLOUT_STATUS_LABELS[row.status]}
              </span>
              {row.stack ? <span className="text-muted-foreground">{row.stack}</span> : null}
              {row.macRequired ? <span className="text-muted-foreground">Mac検証あり</span> : null}
              {row.hosts.length > 0 ? <span className="text-muted-foreground">実行: {row.hosts.join("・")}</span> : null}
            </div>
            {row.reasons.map((reason) => (
              <p key={reason} className="break-words text-muted-foreground">
                {reason}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
