"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CODE_REVIEW_RECOMMEND_DAYS_MAX,
  CODE_REVIEW_RECOMMEND_DAYS_MIN,
  CODE_REVIEW_RECOMMEND_PR_COUNT_MAX,
  CODE_REVIEW_RECOMMEND_PR_COUNT_MIN,
  parseCodeReviewRecommendDays,
  parseCodeReviewRecommendPrCount,
} from "@/lib/app-settings";
import { InfoHint } from "@/components/dashboard/settings/info-hint";

type Saved = { days: number; prCount: number };

/**
 * コードレビューの提案条件（#3685）。「コードレビュー」ビューで「レビューを提案」を出す基準。
 * 2つの値をまとめて、専用の保存ボタンで保存する。
 */
export function CodeReviewRecommendField() {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [days, setDays] = useState("");
  const [prCount, setPrCount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/code-review-recommend")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: Saved) => {
        if (cancelled) return;
        setSaved(data);
        setDays(String(data.days));
        setPrCount(String(data.prCount));
      })
      .catch(() => {
        if (!cancelled) setError("現在の値を取得できませんでした");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const parsedDays = parseCodeReviewRecommendDays(days === "" ? NaN : Number(days));
  const parsedPrCount = parseCodeReviewRecommendPrCount(prCount === "" ? NaN : Number(prCount));
  const valid = parsedDays !== null && parsedPrCount !== null;
  const dirty = saved !== null && (Number(days) !== saved.days || Number(prCount) !== saved.prCount);

  async function handleSave() {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/code-review-recommend", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: parsedDays, prCount: parsedPrCount }),
      });
      if (!res.ok) throw new Error(`リクエストに失敗しました (${res.status})`);
      setSaved(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-semibold">コードレビューの提案条件</span>
        <InfoHint label="コードレビューの提案条件">
          未実施のリポジトリは常に提案します。既定は30日・100件です。経過日数は、一覧で経過が長い
          リポジトリを注意の色で出す基準にも使います。
        </InfoHint>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="code-review-recommend-days">経過日数</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="code-review-recommend-days"
            type="number"
            className="w-28"
            min={CODE_REVIEW_RECOMMEND_DAYS_MIN}
            max={CODE_REVIEW_RECOMMEND_DAYS_MAX}
            value={days}
            disabled={saved === null}
            onChange={(e) => setDays(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">日以上レビューしていない</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="code-review-recommend-pr-count">PR数</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="code-review-recommend-pr-count"
            type="number"
            className="w-28"
            min={CODE_REVIEW_RECOMMEND_PR_COUNT_MIN}
            max={CODE_REVIEW_RECOMMEND_PR_COUNT_MAX}
            value={prCount}
            disabled={saved === null}
            onChange={(e) => setPrCount(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">
            件以上のマージ済みPRが前回レビュー以降にある
          </span>
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={handleSave} disabled={saving || !valid || !dirty}>
          {saving ? "保存中..." : "提案条件を保存"}
        </Button>
        {!valid && saved !== null && (
          <span className="text-xs text-destructive">
            日数は{CODE_REVIEW_RECOMMEND_DAYS_MIN}〜{CODE_REVIEW_RECOMMEND_DAYS_MAX}、PR数は
            {CODE_REVIEW_RECOMMEND_PR_COUNT_MIN}〜{CODE_REVIEW_RECOMMEND_PR_COUNT_MAX}の整数で入力してください
          </span>
        )}
      </div>
    </div>
  );
}
