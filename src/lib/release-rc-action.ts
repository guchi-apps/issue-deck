import type { RcPhase, RcStatus } from "@/lib/release-rc";

/**
 * 新方式のリリース候補（`release-rc/<番号>`）で、いま「本番公開へ進む」を出してよいか・マージ要求を通してよいか（#4635）。
 * **純関数だけ**を置き、画面（3つの導線）とマージAPIが同じ判定を使う。画面の表示だけに頼らず、古い画面からの
 * 操作・ドラフトのままの要求はサーバーがここで止める（GitHubのmerge APIの405を利用者に見せない）。
 *
 * 旧方式（`release-main/v*`）の候補には使わない。RC記録が無く、従来のゲートだけで進めるため。
 */

export type RcPublishNext =
  /** 全体レビュー・統合検証の合格を待つ、または再実行・修正で解消する */
  | "verify"
  /** 合格済み。公開準備（正式バンプ）へ進む */
  | "prepare"
  /** 公開準備の最終検証を待つ（操作不要） */
  | "wait"
  /** 状態を取り直して確かめる（取得できていない・食い違い） */
  | "recheck"
  /** 公開済み・取り消し済みで、進める操作は無い */
  | "none";

export type RcPublishDecision =
  | { ok: true }
  | {
      ok: false;
      error:
        | "rc_record_missing"
        | "rc_cancelled"
        | "rc_already_published"
        | "rc_not_prepared"
        | "rc_preparing"
        | "rc_draft"
        | "rc_pull_request_unobserved"
        | "rc_head_mismatch"
        | "rc_auto_publishing";
      next: RcPublishNext;
      /** 利用者に見せる短い理由と、次にできる操作 */
      message: string;
    };

export type RcPublishInput = {
  /** 候補の記録の段階。記録が引けなければnull（推測で通さない） */
  phase: RcPhase | null;
  /** PRのドラフト状態。GitHubから取れていなければundefined（推測で通さない） */
  draft: boolean | undefined;
  /** 現在のPRのheadが、公開準備の最終head（バンプ後）と一致するか。記録が無ければfalse */
  headMatchesFinalization: boolean;
  /**
   * 有効な公開承認（#4666）があるか。承認済みの候補は自動公開の系列だけがマージする（手動のマージ操作を並べない）。
   * 省略時はfalse
   */
  publishApproved?: boolean;
};

export function decideRcPublish(input: RcPublishInput): RcPublishDecision {
  const { phase } = input;
  if (phase === null) {
    return { ok: false, error: "rc_record_missing", next: "recheck", message: "候補の記録を確認できません。状態を取り直してから操作してください" };
  }
  if (phase === "cancelled") {
    return { ok: false, error: "rc_cancelled", next: "none", message: "この候補は取り消されています" };
  }
  if (phase === "deploying" || phase === "verifying_production" || phase === "completed") {
    return { ok: false, error: "rc_already_published", next: "none", message: "この候補はすでに本番へ反映されています" };
  }
  if (phase === "creating" || phase === "review") {
    return {
      ok: false,
      error: "rc_not_prepared",
      next: "verify",
      message: "公開準備（正式バンプと最終検証）がまだです。全体レビュー・統合検証に合格したら「本番公開へ進む（公開承認）」を押してください",
    };
  }
  if (input.publishApproved && (phase === "preparing" || phase === "awaiting_approval")) {
    return {
      ok: false,
      error: "rc_auto_publishing",
      next: "wait",
      message: "公開承認済みです。最終検証に合格したら自動で本番公開します（承認し直しは不要です）。手動で公開する場合は、先に自動公開を取り消してください",
    };
  }
  if (phase === "preparing") {
    return { ok: false, error: "rc_preparing", next: "wait", message: "公開準備中です。バンプ後の最終検証が終わるまで待ってください" };
  }
  // awaiting_approval: ドラフトの解除（公開準備の最後の工程）が済み、最終headと一致するときだけ通す
  if (input.draft === undefined) {
    return { ok: false, error: "rc_pull_request_unobserved", next: "recheck", message: "PRの状態を取得できません。状態を取り直してから操作してください" };
  }
  if (input.draft) {
    return { ok: false, error: "rc_draft", next: "recheck", message: "PRがドラフトのままです。公開準備の完了（ドラフト解除）を待つか、状態を取り直してください" };
  }
  if (!input.headMatchesFinalization) {
    return { ok: false, error: "rc_head_mismatch", next: "recheck", message: "候補が公開準備の後に変わっています。状態を取り直し、必要なら公開準備をやり直してください" };
  }
  return { ok: true };
}

/** 候補の状態（`deriveRcStatus`）から、画面が出す主操作の種別。公開操作は`awaiting_approval`だけ */
export type RcPrimaryAction =
  | { kind: "wait"; label: null }
  | { kind: "rerun_review"; label: "全体レビューを再実行" }
  | { kind: "fix"; label: "修正を取り込む" }
  | { kind: "prepare"; label: "本番公開へ進む（公開承認）" }
  | { kind: "publish"; label: "本番公開へ進む" }
  | { kind: "none"; label: null };

export function describeRcPrimaryAction(input: {
  status: RcStatus;
  /** 現在のheadの全体レビューが実行失敗（指摘なし）か。失敗中は「自動で進む」にしない */
  reviewRunFailed?: boolean;
  /** PRがドラフトでない・公開準備の最終headと一致する、など`decideRcPublish`が通る */
  publishable: boolean;
}): RcPrimaryAction {
  switch (input.status) {
    case "creating":
    case "verifying":
    case "fixing":
    case "preparing":
    case "deploying":
    case "verifying_production":
      return { kind: "wait", label: null };
    case "awaiting_verification":
      return input.reviewRunFailed ? { kind: "rerun_review", label: "全体レビューを再実行" } : { kind: "wait", label: null };
    case "needs_fix":
      return input.reviewRunFailed ? { kind: "rerun_review", label: "全体レビューを再実行" } : { kind: "fix", label: "修正を取り込む" };
    case "ready_to_prepare":
      return { kind: "prepare", label: "本番公開へ進む（公開承認）" };
    case "awaiting_approval":
      return input.publishable ? { kind: "publish", label: "本番公開へ進む" } : { kind: "wait", label: null };
    case "completed":
    case "cancelled":
      return { kind: "none", label: null };
  }
}

/** 検証結果の対象が、修正前（旧SHA）の結果か。現在のheadの結果は現在結果として扱う（#4635） */
export function isPreviousVerificationResult(input: {
  series: { status: string; releasePrNumber: number; originHeadSha: string } | null;
  pullRequestNumber: number;
  /** 表示している検証結果の対象head。取得できていなければnull */
  targetHeadSha: string | null;
}): boolean {
  const { series } = input;
  if (series === null) return false;
  if (series.status !== "rebuilding" && series.status !== "reverifying") return false;
  if (series.releasePrNumber !== input.pullRequestNumber) return false;
  // 対象が分からない間は現在の結果として見せない。分かれば、修正前のhead（起点）の結果だけを履歴へ分ける
  return input.targetHeadSha === null || input.targetHeadSha === series.originHeadSha;
}
