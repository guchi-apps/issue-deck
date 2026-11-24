"use client";

import { useEffect, useState } from "react";

import { InfoHint } from "@/components/dashboard/settings/info-hint";
import { Label } from "@/components/ui/label";

/**
 * RCの公開承認の自動化（#5629）のトグル。切り替えた時点で保存し、効くのは次の巡回から
 * （設定ダイアログの保存ボタンには載せない）。判断の条件は`src/lib/release-auto-approval.ts`
 */
export function ReleaseAutoApprovalField() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/release-auto-approval")
      .then((res) => (res.ok ? (res.json() as Promise<{ enabled: boolean }>) : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        if (!cancelled) setEnabled(data.enabled);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(`取得できませんでした（${String(cause)}）`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    setError(null);
    try {
      const res = await fetch("/api/settings/release-auto-approval", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (cause) {
      setEnabled(previous);
      setError(`保存できませんでした（${String(cause)}）`);
    }
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="release-auto-approval-field">
      <div className="flex flex-wrap items-center gap-1.5">
        <Label htmlFor="release-auto-approval-enabled">リリース候補の公開承認を自動で出す</Label>
        <InfoHint label="公開承認の自動化">
          ONにすると、リリース候補（RC）の全体レビューをCodex（Claudeとは別系統）で実行し、指摘なしで合格して
          CI・統合検証も通った候補の「本番公開へ進む（公開承認）」を、巡回が代わりに出します。全体レビューが
          合格していない候補・人の確認ラベル（22.merge-confirm-required・00.check-user）が付いた候補は
          自動では承認せず、人が判断します。切り替えた時点で保存され、次の巡回から効きます（#5629）。
        </InfoHint>
        {/* AI・モデル区分の他の欄は下の保存ボタンで保存されるため、この欄だけ即時保存であることを見出しに出す（#5643） */}
        <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-emerald-600/40 px-2 py-px text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
          すぐ保存
        </span>
      </div>
      <p className="-mt-1 text-[11px] text-muted-foreground">切り替えた時点で保存され、次の巡回から効きます。</p>
      <label className="flex items-center gap-2 text-sm" htmlFor="release-auto-approval-enabled">
        <input
          id="release-auto-approval-enabled"
          type="checkbox"
          checked={enabled ?? false}
          disabled={enabled === null}
          onChange={(event) => void save(event.target.checked)}
        />
        別系統の全体レビューが合格したら自動で承認する
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
