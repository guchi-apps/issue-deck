import { resolveModelRate } from "@/lib/ai-model-pricing";
import { CLAUDE_ALIAS_MODEL_IDS, type ClaudeModel } from "@/lib/app-settings";
import type { IssueImplementationAgent } from "@/lib/dispatch/issue-session";

/**
 * エージェント×モデルの重さの色（#3075）。
 *
 * **Claude=朱寄りの赤・Codex=青寄りの緑で、同じ段どうしの明度をそろえている。** 実行状況の
 * ●は「濃いほど重いモデル」を表すため、2系統の濃さが段ごとに対応していないと読めない。
 * 以前のrose-800（#9f1239）と明るい緑（#33cc4d）は明度が大きく離れていて段を作れなかった。
 * 明度をそろえると赤緑の区別が色相だけに頼ることになるため、赤を朱へ・緑を青緑へ振り、
 * 1型・2型の色覚シミュレーションでも黄土色系／青灰色系に分かれて見えるようにした
 * （同じ段どうしのΔEは2型で16〜35、1型で10〜16）。
 */
export const AGENT_MODEL_TIER_COLORS: Readonly<
  Record<IssueImplementationAgent, readonly [string, string, string, string]>
> = {
  claude: ["#7a1a12", "#b3261e", "#e0533f", "#f3a293"],
  codex: ["#0b4a34", "#0f6b48", "#2f9469", "#8fcfb0"],
};

/** 段: 0=最重・1=重・2=標準・3=軽 */
export type ModelWeightTier = 0 | 1 | 2 | 3;

/**
 * 各エージェントの代表色。**濃淡で重さを表さない場所**——AI使用量画面の凡例・バー、
 * エージェントの一括操作の●、モデル未確定の中抜き●——はこの1色を使う。
 *
 * **Claudeだけ最重の段を採る。** 「重」の段（#b3261e）はAI使用量画面のトークン帯の
 * キャッシュ書き込み（`TOKEN_COLORS.local.cacheCreate` #a8452a）と、1型・2型の色覚
 * シミュレーションでΔE 5〜6まで寄り、#2667で分けた色が再び重なる。最重の段なら
 * そこから17以上離れ、Codex（重の段）との差も1型で15→22へ広がる。Codexの最重の段は
 * ダークモードの背景に沈むので、Codexは重の段のまま。
 */
export const AGENT_BASE_COLORS: Readonly<Record<IssueImplementationAgent, string>> = {
  claude: AGENT_MODEL_TIER_COLORS.claude[0],
  codex: AGENT_MODEL_TIER_COLORS.codex[1],
};

/**
 * モデルの重さの段。**出力単価（1Mトークンあたり）で決める**ので、Claude・Codexを同じ
 * 物差しで並べられる（Opus≒GPT-5.6 Sol、Sonnet≒Terra、Haiku≒Luna）。単価表に無い
 * モデル・`auto`（どのモデルで立つかCLI任せ）は`null`で、呼び出し側は「未確定」として扱う。
 */
export function modelWeightTier(model: string | null | undefined): ModelWeightTier | null {
  if (!model || model === "auto") return null;
  const id = CLAUDE_ALIAS_MODEL_IDS[model as Exclude<ClaudeModel, "auto">] ?? model;
  const rate = resolveModelRate(id);
  if (!rate) return null;
  if (rate.output >= 40) return 0;
  if (rate.output >= 20) return 1;
  if (rate.output >= 8) return 2;
  return 3;
}

/** エージェントとモデルから●の色を引く。段が決まらなければ`null`（中抜きで出す） */
export function agentModelColor(
  agent: IssueImplementationAgent,
  model: string | null | undefined,
): string | null {
  const tier = modelWeightTier(model);
  return tier === null ? null : AGENT_MODEL_TIER_COLORS[agent][tier];
}

/**
 * セッションが使っているモデル群（`DispatchSessionView.models`）から、●に出す1つを選ぶ。
 * **いちばん重いものを採る。** Claude Codeは小さな処理（タイトル付け等）でHaikuを併用する
 * ことがあり、並び順や件数で選ぶと本体がOpusでも薄い色になってしまう。段が決まるモデルが
 * 1つも無ければ`null`（未集計・単価表に無いモデル）。
 */
export function pickPrimaryModel(models: readonly string[]): string | null {
  let best: { model: string; tier: ModelWeightTier } | null = null;
  for (const model of models) {
    const tier = modelWeightTier(model);
    if (tier === null) continue;
    if (best === null || tier < best.tier) best = { model, tier };
  }
  return best?.model ?? null;
}
