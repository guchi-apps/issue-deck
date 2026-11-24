/**
 * RCの公開承認の自動化（#5629）の判断。**純関数だけ**を置き、DB・GitHubへの操作は`release-auto-approval-run.ts`が持つ。
 *
 * 公開承認は「ほぼ確認せずに押される」ことが多く、形だけになりやすい。そこで**作った側（Claude）とは別系統の
 * エージェントが全体レビューを指摘なしで合格させた**ことを根拠に、巡回が代わりに承認する。
 * 承認の作成経路は増やさず、既存の`requestRcFinalize`（押した時点のhead・mainの先端・合格した契約が全て一致するときだけ受け付ける）を通す。
 *
 * 自動マージ不可カテゴリ（認証・DBスキーマ・Secrets等）は各PRの作成・マージ時に確認済みの前提で、ここでは再判定しない。
 * 人の確認ラベルだけは、公開準備（正式バンプ）へ進む前に止める。
 */

/** 自動承認の要求キーの接頭辞。人が押した承認と区別する */
export const AUTO_APPROVAL_REQUEST_KEY_PREFIX = "auto-";

/** 作った側の系統。全体レビューの担当がこれと同じなら独立した検証とみなさない */
export const AUTO_APPROVAL_AUTHOR_FAMILY = "claude";

/** 公開承認を自動で止める人の確認ラベル（完了系列のマージ判定と同じ） */
export const AUTO_APPROVAL_BLOCKING_LABELS = ["22.merge-confirm-required", "00.check-user"] as const;

export type AutoApprovalWait =
  | "disabled"
  | "not_review_phase"
  | "not_ready"
  | "review_waiver_required"
  | "review_agent_unknown"
  | "review_not_independent"
  | "human_check_label";

export const AUTO_APPROVAL_WAIT_LABEL: Record<AutoApprovalWait, string> = {
  disabled: "公開承認の自動化がOFFです",
  not_review_phase: "公開準備を始められる段階ではありません",
  not_ready: "公開準備の契約が出ていません（検証が合格していません）",
  review_waiver_required: "全体レビューが合格していません（承知で進む明示が要るため自動承認しません）",
  review_agent_unknown: "全体レビューの担当を確かめられませんでした",
  review_not_independent: "全体レビューが作った側と同じ系統（Claude）で、独立した検証と言えません",
  human_check_label: "人の確認ラベルが付いています",
};

export type AutoApprovalDecision = { approve: true } | { approve: false; wait: AutoApprovalWait };

/** `claude:opus`・`codex:gpt-6-sol`のような記録された担当から系統（`claude`・`codex`）を読む。読めなければnull */
export function parseReviewAgentFamily(agent: string | null | undefined): string | null {
  if (!agent) return null;
  const family = agent.split(":")[0]?.trim().toLowerCase();
  return family ? family : null;
}

export function decideAutoApproval(input: {
  enabled: boolean;
  phase: string;
  /** `buildRcFinalizeContract`の結果。公開準備可能でなければnull */
  contract: { requiresAiReviewWaiver: boolean } | null;
  /** 現在のbase/headに対する`ai_review`の記録された担当（`claude:opus`など） */
  reviewAgent: string | null;
  /** 候補PRのラベル名 */
  labels: readonly string[];
}): AutoApprovalDecision {
  if (!input.enabled) return { approve: false, wait: "disabled" };
  if (input.phase !== "review") return { approve: false, wait: "not_review_phase" };
  if (input.contract === null) return { approve: false, wait: "not_ready" };
  // 全体レビューが合格していない候補は、人が結果を承知で進む明示が要る。自動では外さない
  if (input.contract.requiresAiReviewWaiver) return { approve: false, wait: "review_waiver_required" };
  const family = parseReviewAgentFamily(input.reviewAgent);
  if (family === null) return { approve: false, wait: "review_agent_unknown" };
  if (family === AUTO_APPROVAL_AUTHOR_FAMILY) return { approve: false, wait: "review_not_independent" };
  if (input.labels.some((label) => (AUTO_APPROVAL_BLOCKING_LABELS as readonly string[]).includes(label))) {
    return { approve: false, wait: "human_check_label" };
  }
  return { approve: true };
}

/** 自動承認の要求キー。同じ候補・同じheadなら同じ値で、再送しても公開準備を二重に作らない（8〜48文字の英数・`-`・`_`） */
export function buildAutoApprovalRequestKey(candidateId: string, headSha: string): string {
  const id = candidateId.replace(/[^A-Za-z0-9]/g, "").slice(-16);
  return `${AUTO_APPROVAL_REQUEST_KEY_PREFIX}${id}-${headSha.slice(0, 12)}`;
}
