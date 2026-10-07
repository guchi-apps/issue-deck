"use client";

import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PLAN_REVIEW_AUTO_REFLECT_MAX_ROUNDS_MAX,
  PLAN_REVIEW_AUTO_REFLECT_MAX_ROUNDS_MIN,
  parsePlanReviewAutoReflectMaxRounds,
} from "@/lib/app-settings";
import { InfoHint } from "@/components/dashboard/settings/info-hint";

type Values = { enabled: boolean; maxRounds: number };

/**
 * 計画レビューの指摘を、Jevが判断して自動で反映する設定（#3648）。
 * `ReleasePrepIntervalField`と同じく、変えた時点で保存する（値の取得・保存とも専用APIで完結する）。
 */
export function PlanReviewAutoReflectField() {
  const [values, setValues] = useState<Values | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/plan-review-auto-reflect")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (!cancelled) {
          setValues({
            enabled: data.planReviewAutoReflectEnabled,
            maxRounds: data.planReviewAutoReflectMaxRounds,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setError("現在の値を取得できませんでした");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: Values, patch: Record<string, unknown>) {
    const previous = values;
    setValues(next);
    setError(null);
    try {
      const res = await fetch("/api/settings/plan-review-auto-reflect", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`リクエストに失敗しました (${res.status})`);
    } catch (err) {
      setValues(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div className="flex items-center gap-1.5">
        <Label htmlFor="plan-review-auto-reflect-enabled">
          Jevが判断して、計画レビューの指摘を自動で反映する
        </Label>
        <InfoHint label="計画レビューの指摘の自動反映">
          ONにすると、Jevが初回レビューの重大な指摘を採用するか判断します。採用なら通知なしで計画を修正し、
          解消確認を1回だけ行って自動の見直しを終えます（#3765）。解消確認の後も重大な問題が残れば、
          未解消点をまとめて人へ通知します。不採用・判断できないときも人へ通知します。OFFのときは、
          レビューが届いてから通知し、反映するかは承認パネルで選びます。ローカルのClaude Code
          セッションだけが対象です。
        </InfoHint>
      </div>
      <label className="flex items-center gap-2 text-sm" htmlFor="plan-review-auto-reflect-enabled">
        <input
          id="plan-review-auto-reflect-enabled"
          type="checkbox"
          checked={values?.enabled ?? false}
          disabled={values === null}
          onChange={(event) =>
            values &&
            save(
              { ...values, enabled: event.target.checked },
              { planReviewAutoReflectEnabled: event.target.checked },
            )
          }
        />
        自動で反映する
      </label>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="plan-review-auto-reflect-max-rounds">自動反映の上限回数</Label>
          <InfoHint label="自動反映の上限回数">
            人の修正を挟まずに連続して自動反映する回数です。実際に効くのは1回までです（以前の既定の5を
            設定していても、初回レビュー1回→解消確認1回で終わります）。人が画面から修正を送っても、
            全体レビューは自動では再開しません。
          </InfoHint>
        </div>
        <div className="flex items-center gap-2">
          <Input
            id="plan-review-auto-reflect-max-rounds"
            type="number"
            min={PLAN_REVIEW_AUTO_REFLECT_MAX_ROUNDS_MIN}
            max={PLAN_REVIEW_AUTO_REFLECT_MAX_ROUNDS_MAX}
            value={values?.maxRounds ?? ""}
            disabled={values === null || !values.enabled}
            onChange={(event) => {
              if (!values) return;
              const maxRounds = Number(event.target.value);
              if (parsePlanReviewAutoReflectMaxRounds(maxRounds) === null) {
                setValues({ ...values, maxRounds });
                return;
              }
              void save({ ...values, maxRounds }, { planReviewAutoReflectMaxRounds: maxRounds });
            }}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">回</span>
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
