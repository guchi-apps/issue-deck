/**
 * 全体レビューの指摘ごとのAIの推奨判断と理由案（#4676）。**純関数だけ**を置き、AI呼び出しは
 * `lib/claude/release-review-recommend.ts`、DBの読み書きは`release-review-recommendation-store.ts`が持つ。
 * 画面からも読むので`node:crypto`等に依存しない。
 *
 * **推奨は判断ではない。** ここで作るのは「どれを勧めるか」と「判断の種類ごとの理由案」までで、
 * 保存（`ReleaseReviewDecision`）はユーザーが確定したときだけ既存の判断APIが行う。
 * - 既存のIssue番号・具体的な期日はAIに作らせない（題の案と「本番公開の直後」のような相対的な時期だけ）
 * - 判断材料が足りないときは`missing`へ書かせ、確認できていない事項を事実として理由案に入れさせない
 */

import {
  RELEASE_REVIEW_DECISION_KINDS,
  RELEASE_REVIEW_DECISION_LABEL,
  validateDecisionInput,
  type ReleaseReviewDecisionAction,
  type ReleaseReviewDecisionKind,
} from "@/lib/release-review-decision";
import type { ReleaseReviewFinding } from "@/lib/release-review-result";

/** 判断の種類1つぶんの理由案。判断ごとに必要な項目だけを埋める */
export type RecommendationDraft = {
  reason: string;
  /** 見送り: 残る影響 */
  impact: string | null;
  /** 見送り: 対象範囲 */
  scope: string | null;
  /** 公開後対応: 実施時期の案（相対的な時期。期日ではない） */
  timing: string | null;
  /** 公開後対応: 新しく作るIssueの題の案（既存のIssue番号は推奨しない） */
  followUpTitle: string | null;
};

export type ReleaseReviewRecommendation = {
  id: string;
  findingId: string;
  baseSha: string;
  headSha: string;
  recommended: ReleaseReviewDecisionKind;
  /** その判断を勧める根拠（影響・発生条件・時期）。重大度の名前だけで決めていないことを示す */
  rationale: string;
  drafts: Record<ReleaseReviewDecisionKind, RecommendationDraft>;
  /** 判断材料の不足（確認できていない事項） */
  missing: string[];
  createdAt: string;
};

/** 画面へ返す推奨の一覧。指摘IDごとに、推奨か取得失敗の理由のどちらか */
export type ReleaseReviewRecommendationsView = {
  /** `unavailable`はAIの認証情報が無い等で、この環境では推奨を出せない */
  status: "ready" | "unavailable";
  byFinding: Record<string, ReleaseReviewRecommendation>;
  failures: Record<string, string>;
};

/** 推奨を作る対象の指摘。AIの原判定のうち、推奨に要るところ */
export type RecommendationTarget = Pick<
  ReleaseReviewFinding,
  "title" | "detail" | "severity" | "file" | "line" | "impact" | "evidence" | "recommendation" | "pullRequests"
> & {
  id: string;
  blocking: boolean;
  blockingReason?: string | null;
  occurrences?: number;
  premiseChanged?: string | null;
  /** 前提が変わって再確認が必要になった、前回のユーザー判断（あれば） */
  previousDecision?: { decision: ReleaseReviewDecisionAction; reason: string; stale: string } | null;
};

/** 1回のAI呼び出しで推奨を作る指摘の上限。超えた分は次の呼び出しへ回す */
export const RECOMMENDATION_BATCH_SIZE = 8;

const TEXT_MAX = 1200;
const SHORT_MAX = 300;

const clip = (value: string, max: number) => {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
};

export function buildRecommendationPrompt(input: {
  repoFullName: string;
  prNumber: number;
  findings: readonly RecommendationTarget[];
}): string {
  const findings = input.findings.map((f) => ({
    id: f.id,
    kind: f.blocking ? "リリースを止める指摘" : "止めない改善提案",
    severity: f.severity,
    title: f.title,
    detail: clip(f.detail ?? "", TEXT_MAX),
    file: f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : null,
    impact: f.impact ? clip(f.impact, TEXT_MAX) : null,
    evidence: f.evidence ? clip(f.evidence, TEXT_MAX) : null,
    blockingReason: f.blockingReason ? clip(f.blockingReason, TEXT_MAX) : null,
    reviewerRecommendation: f.recommendation ? clip(f.recommendation, TEXT_MAX) : null,
    pullRequests: f.pullRequests,
    occurrences: f.occurrences ?? null,
    premiseChanged: f.premiseChanged ?? null,
    previousUserDecision: f.previousDecision
      ? {
          decision: RELEASE_REVIEW_DECISION_LABEL[f.previousDecision.decision],
          reason: clip(f.previousDecision.reason, TEXT_MAX),
          whyRecheck: f.previousDecision.stale,
        }
      : null,
  }));
  return `あなたはリリース判断を手伝うエンジニアです。リリース候補 ${input.repoFullName} #${input.prNumber} の全体レビュー（AI）が出した指摘について、
本番公開の前に人が下す判断の「推奨」と「理由案」を日本語で作ってください。**判断を確定するのは人です。**

判断は次の4種類です。
- fix_now（今回直す）: 公開前に直す。修正系列が修正Issueを起案して直し、再検証する
- post_release（公開後に対応する）: 公開を止めず、公開後の作業としてIssueで追跡する
- defer（今回は見送る）: 対応しない。残る影響と対象範囲を記録する
- reject（指摘を採用しない）: 誤認・対象外・過剰な要求などで採用しない

# 守ること

- 重大度（high/medium/low）の名前だけで決めない。利用者・本番への具体的な影響、発生する条件（通常の操作か、まれな条件か）、
  公開後に直しても取り返せるか（データ消失・セキュリティ・課金は取り返せない）、公開後でもできる作業か、から決める
- 指摘に書かれていないこと（コードの中身・利用者の数・既存のIssue）を事実として書かない。確かめられていない事項は missing に書く
- **既存のIssue番号を書かない。** post_release の追跡先は、新しく作るIssueの題の案（followUpTitle）だけを書く
- **具体的な期日（日付）を書かない。** timing は「本番公開の直後」「次のリリースまで」のような相対的な時期にする
- 理由案は、その判断を選んだ人がそのまま記録として残せる1〜3文にする。指摘の影響・根拠に触れる
- 4種類すべての理由案を書く。**推奨しない判断の理由案は、人がその判断を選んだときに本人の記録としてそのまま残せる文にする。**
  推奨に反論しない（「〜はできない」「不適切」と書かない）。その判断が成り立つ前提を文頭に置き、その判断を選ぶ理由を書く
  （例: 推奨が fix_now の指摘の defer なら「発生が送信中の再編集に限られまれだと確認できたため、今回は見送る。」）。
  「該当しません」「なし」のような中身の無い理由案も書かない。defer には impact と scope、post_release には timing と followUpTitle も書く
- previousUserDecision がある指摘は、前回の判断と再確認が必要になった理由を踏まえる（前回の判断に合わせる必要はない）

# 指摘（JSON）

${JSON.stringify(findings, null, 2)}

# 出力

次のJSONだけを返してください（前後の文章・コードフェンスは不要）。指摘ごとに1要素で、id は指摘のidをそのまま使います。

{"recommendations": [{"id": "R-xxxxxx", "recommended": "fix_now|post_release|defer|reject", "rationale": "推奨の根拠（1〜2文）", "missing": ["確認できていない事項", ...], "drafts": {"fix_now": {"reason": "..."}, "post_release": {"reason": "...", "timing": "...", "followUpTitle": "..."}, "defer": {"reason": "...", "impact": "...", "scope": "..."}, "reject": {"reason": "..."}}}]}`;
}

/** 具体的な期日（AIに作らせないもの）。年月日・月日・ISO形式 */
const CONCRETE_DATE = /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?)|(\d{1,2}月\d{1,2}日)/;
/** 中身の無い理由案（「該当しません」など）。理由案が無いのと同じに扱い、そのまま保存できる形で出さない */
const EMPTY_REASON = /^(該当(しません|なし|しない)|なし|特になし|n\/a|none|-+)[。.]?$/i;

/** 既存のIssue・PR番号の参照（AIに作らせないもの） */
const ISSUE_NUMBER = /(^|[^\w&])#\d+\b/;

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" && !EMPTY_REASON.test(value.trim()) ? clip(value, max) : null;
}

/**
 * 応答の検証。**読めない・形が違う指摘は推奨なし**（呼び出し側が失敗として扱う）。
 * 既存のIssue番号・具体的な期日が入っていたら、その項目を捨てて不足点へ回す（捏造を画面へ出さない）
 */
export function parseRecommendationResponse(
  text: string,
  findingIds: readonly string[],
): Map<string, Omit<ReleaseReviewRecommendation, "id" | "findingId" | "baseSha" | "headSha" | "createdAt">> {
  const result = new Map<string, Omit<ReleaseReviewRecommendation, "id" | "findingId" | "baseSha" | "headSha" | "createdAt">>();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return result;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return result;
  }
  const list = (raw as { recommendations?: unknown })?.recommendations;
  if (!Array.isArray(list)) return result;
  const wanted = new Set(findingIds);
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : null;
    const recommended = obj.recommended;
    if (!id || !wanted.has(id) || result.has(id)) continue;
    if (typeof recommended !== "string" || !(RELEASE_REVIEW_DECISION_KINDS as readonly string[]).includes(recommended)) continue;
    const rationale = str(obj.rationale, TEXT_MAX);
    if (!rationale) continue;
    const missing = Array.isArray(obj.missing) ? obj.missing.flatMap((m) => (str(m, SHORT_MAX) ? [str(m, SHORT_MAX) as string] : [])).slice(0, 6) : [];
    const rawDrafts = (typeof obj.drafts === "object" && obj.drafts !== null ? obj.drafts : {}) as Record<string, unknown>;
    const drafts = {} as Record<ReleaseReviewDecisionKind, RecommendationDraft>;
    for (const kind of RELEASE_REVIEW_DECISION_KINDS) {
      const d = (typeof rawDrafts[kind] === "object" && rawDrafts[kind] !== null ? rawDrafts[kind] : {}) as Record<string, unknown>;
      let timing = kind === "post_release" ? str(d.timing, 200) : null;
      if (timing && CONCRETE_DATE.test(timing)) {
        timing = null;
        missing.push("実施時期の期日は決まっていません（AIの提案から日付を外しました）");
      }
      let followUpTitle = kind === "post_release" ? str(d.followUpTitle, 200) : null;
      if (followUpTitle && ISSUE_NUMBER.test(followUpTitle)) followUpTitle = null;
      drafts[kind] = {
        reason: str(d.reason, TEXT_MAX) ?? "",
        impact: kind === "defer" ? str(d.impact, TEXT_MAX) : null,
        scope: kind === "defer" ? str(d.scope, SHORT_MAX) : null,
        timing,
        followUpTitle,
      };
    }
    if (!drafts[recommended as ReleaseReviewDecisionKind].reason) continue;
    if (recommended === "post_release") {
      missing.push("既存の関連Issueは確認していません（新しいIssueの作成を提案しています）");
    }
    result.set(id, { recommended: recommended as ReleaseReviewDecisionKind, rationale, drafts, missing: [...new Set(missing)] });
  }
  return result;
}

/** 理由案から判断APIへ送る入力を作る。公開後対応の追跡先は「新しいIssueを作る」だけ */
export function draftToDecisionInput(kind: ReleaseReviewDecisionKind, draft: RecommendationDraft) {
  return {
    decision: kind,
    reason: draft.reason,
    impact: kind === "defer" ? draft.impact : null,
    scope: kind === "defer" ? draft.scope : null,
    timing: kind === "post_release" ? draft.timing : null,
    followUp: kind === "post_release" && draft.followUpTitle ? { kind: "create" as const, title: draft.followUpTitle } : null,
  };
}

/**
 * 推奨どおりにワンタップで確定できない理由（できるならnull）。判断に必須の項目が理由案に揃っていなければ、
 * フォームで不足を埋めてもらう（必須項目を空のまま、または推測で埋めて保存しない）
 */
export function oneTapBlocker(rec: ReleaseReviewRecommendation): string | null {
  const invalid = validateDecisionInput(draftToDecisionInput(rec.recommended, rec.drafts[rec.recommended]));
  if (!invalid) return null;
  const label: Record<string, string> = {
    reason: "理由",
    impact: "残る影響",
    scope: "対象範囲",
    timing: "実施時期",
    followUp: "追跡するIssue",
  };
  return `${label[invalid.field] ?? invalid.field}をAIが用意できませんでした。「別の判断を選ぶ」から入力して保存してください`;
}

export type ReasonSource = "ai" | "ai_edited" | "manual";

export const REASON_SOURCE_LABEL: Record<ReasonSource, string> = {
  ai: "AIの理由案のまま",
  ai_edited: "AIの理由案を編集",
  manual: "手入力",
};

/** 保存する理由の出どころ。推奨が無ければ手入力、理由案と同じならAI案のまま */
export function classifyReasonSource(
  rec: Pick<ReleaseReviewRecommendation, "drafts"> | null,
  decision: ReleaseReviewDecisionAction,
  reason: string,
): ReasonSource {
  if (!rec || decision === "withdrawn") return "manual";
  const draft = rec.drafts[decision]?.reason.trim();
  if (!draft) return "manual";
  return draft === reason.trim() ? "ai" : "ai_edited";
}

/** 確定した判断とAIの推奨の関係（画面のバッジ）。推奨が無かった判断はnull */
export function describeAdoption(record: {
  decision: ReleaseReviewDecisionAction;
  recommendedDecision: ReleaseReviewDecisionKind | null;
  reasonSource: ReasonSource | null;
}): { label: string; tone: "adopted" | "edited" | "differs" } | null {
  if (!record.recommendedDecision || record.decision === "withdrawn") return null;
  if (record.decision !== record.recommendedDecision) return { label: "AI推奨と異なる判断", tone: "differs" };
  return record.reasonSource === "ai" ? { label: "AI推奨を採用", tone: "adopted" } : { label: "推奨を編集して採用", tone: "edited" };
}

export function parseReasonSource(value: unknown): ReasonSource | null {
  return value === "ai" || value === "ai_edited" || value === "manual" ? value : null;
}

/** DBの`drafts`列（JSON）を読む。形が違えばnull */
export function parseStoredDrafts(value: unknown): Record<ReleaseReviewDecisionKind, RecommendationDraft> | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const drafts = {} as Record<ReleaseReviewDecisionKind, RecommendationDraft>;
  for (const kind of RELEASE_REVIEW_DECISION_KINDS) {
    const d = obj[kind];
    if (typeof d !== "object" || d === null) return null;
    const r = d as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
    drafts[kind] = { reason: s(r.reason) ?? "", impact: s(r.impact), scope: s(r.scope), timing: s(r.timing), followUpTitle: s(r.followUpTitle) };
  }
  return drafts;
}
