/**
 * 「おまかせ」の判定を起動ジョブへ残すための記録（#4853）。**判定の当たり外れを後から測るため。**
 *
 * 積んだモデル（`DispatchJob.claudeModel`/`codexModel`）だけでは、判定が何を出したのか・人が
 * 上書きしたのかが分からない。そこで「実装を開始」ダイアログが持っている判定結果を一緒に送り、
 * 経路・判定が出したモデル・候補ごとの確率（Jevのときだけ）をジョブへ写す。
 *
 * - 開いている間に判定が出ていれば、経路はその判定の経路（`jev`/`ai`/`rule`）。**人が別のチップへ
 *   切り替えても判定の記録は残し**、`modelPickModel`と積んだモデルの食い違いで上書きが読める
 * - 判定を一度も走らせずにモデルを選んだ起動は`manual`（判定のモデル・確率はnull）
 *
 * 画面（クライアント）と受け口（サーバー）の両方から読むため、サーバー専用の依存を持たない。
 */

import { parseClaudeLocalModel, parseCodexLocalModel } from "@/lib/app-settings";
import type { ModelPickAgent, ModelPickResult } from "@/lib/claude/model-pick";

/** 経路。`jev`・`ai`・`rule`は`ModelPickResult.source`と同じ語で、`manual`は判定を使わなかった起動 */
export const MODEL_PICK_RECORD_SOURCES = ["jev", "ai", "rule", "manual"] as const;

export type ModelPickRecordSource = (typeof MODEL_PICK_RECORD_SOURCES)[number];

export type ModelPickRecord = {
  source: ModelPickRecordSource;
  /** 判定が出したモデル。`manual`ではnull */
  model: string | null;
  /** 候補ごとの確率（0〜1）。**Jevのときだけ入る** */
  probabilities: Record<string, number> | null;
};

function parseModelForAgent(value: unknown, agent: ModelPickAgent): string | null {
  return agent === "codex" ? parseCodexLocalModel(value) : parseClaudeLocalModel(value);
}

/**
 * ダイアログの状態から記録を組み立てる。**積むモデルが決まっていない（`null`）ときは記録しない。**
 *
 * `pickedModel`は判定結果を今のエージェントの候補に照らし直したもの（`parse*`済み）を渡す。
 * 判定は出ていても候補外なら「判定が出ていない」と同じに扱う。
 */
export function buildModelPickRecord(params: {
  result: ModelPickResult | null;
  pickedModel: string | null;
  isAutoPick: boolean;
  effectiveModel: string | null;
}): ModelPickRecord | null {
  if (!params.effectiveModel) return null;
  if (params.result && params.pickedModel) {
    return {
      source: params.result.source,
      model: params.pickedModel,
      probabilities:
        params.result.source === "jev" ? (params.result.probabilities ?? null) : null,
    };
  }
  // 「おまかせ」のまま判定が無いことは無い（開始を押させない）が、念のため経路を偽らない
  if (params.isAutoPick) return null;
  return { source: "manual", model: null, probabilities: null };
}

/**
 * 受け口で記録を検証する。**既知の語だけを通し、形が違えば`null`**（記録しない）。
 *
 * 不正でも起動そのものは断らない——測るための付帯情報で、起動の入口を塞ぐ理由にならない。
 * 確率は`jev`のときだけ、`agent`の候補をキーとする0〜1の数値だけを残す。
 */
export function parseModelPickRecord(value: unknown, agent: ModelPickAgent): ModelPickRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const source = MODEL_PICK_RECORD_SOURCES.find((candidate) => candidate === raw.source);
  if (!source) return null;
  if (source === "manual") return { source, model: null, probabilities: null };

  const model = parseModelForAgent(raw.model, agent);
  if (!model) return null;

  let probabilities: Record<string, number> | null = null;
  if (source === "jev" && raw.probabilities && typeof raw.probabilities === "object") {
    const picked: Record<string, number> = {};
    for (const [key, probability] of Object.entries(raw.probabilities)) {
      if (parseModelForAgent(key, agent) !== key) continue;
      if (typeof probability !== "number" || !Number.isFinite(probability)) continue;
      if (probability < 0 || probability > 1) continue;
      picked[key] = probability;
    }
    if (Object.keys(picked).length > 0) probabilities = picked;
  }
  return { source, model, probabilities };
}

