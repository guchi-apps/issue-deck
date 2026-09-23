"use client";

import { useEffect, useState } from "react";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RELEASE_PREP_INTERVAL_MINUTES_OPTIONS } from "@/lib/app-settings";

function describeInterval(minutes: number): string {
  if (minutes === 0) return "自動実行しない";
  if (minutes < 60) return `${minutes}分ごと`;
  return `${minutes / 60}時間ごと`;
}

/**
 * リリース準備（バンプPR・develop→mainのPR作成）の自動実行間隔（#3416）。
 * 他の項目と違い、選んだ時点で保存する（値の取得・保存とも専用APIで完結する）。
 */
export function ReleasePrepIntervalField() {
  const [value, setValue] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/release-prep-interval")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (!cancelled) setValue(data.releasePrepIntervalMinutes);
      })
      .catch(() => {
        if (!cancelled) setError("現在の値を取得できませんでした");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleChange(next: string) {
    const minutes = Number(next);
    const previous = value;
    setValue(minutes);
    setError(null);
    try {
      const res = await fetch("/api/settings/release-prep-interval", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releasePrepIntervalMinutes: minutes }),
      });
      if (!res.ok) throw new Error(`リクエストに失敗しました (${res.status})`);
    } catch (err) {
      setValue(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="release-prep-interval">リリース準備の自動実行間隔</Label>
      <Select
        value={value === null ? undefined : String(value)}
        onValueChange={handleChange}
        disabled={value === null}
      >
        <SelectTrigger id="release-prep-interval">
          <SelectValue placeholder="読み込み中..." />
        </SelectTrigger>
        <SelectContent>
          {RELEASE_PREP_INTERVAL_MINUTES_OPTIONS.map((minutes) => (
            <SelectItem key={minutes} value={String(minutes)}>
              {describeInterval(minutes)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        developからリリース準備（バージョンのバンプPRとdevelop→mainのPR作成）を自動で始める間隔です。
        実装中のIssueがあるときは見送ります。本番へのマージは自動では行いません。選んだ時点で
        保存され、次の15分刻みの起動から反映されます。
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
