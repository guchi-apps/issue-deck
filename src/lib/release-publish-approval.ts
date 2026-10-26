import { RELEASE_COMPLETION_TTL_MS } from "@/lib/release-completion";
import type { ChangedFileCategory } from "@/lib/release-finalize";

/**
 * RCから本番公開へ進む「公開承認」（#4666）の判断。**純関数だけ**を置き、DB・GitHubへの操作は
 * `release-publish-approval-run.ts`が持つ。
 *
 * - 承認は「本番公開へ進む（公開承認）」（公開準備の開始）を押した1回だけ。承認の範囲は、押した時点の候補（revision・base/head）と、
 *   その後に行う**想定した正式バンプ**（版ファイル・更新履歴だけの変更）まで
 * - 範囲内の変化（バンプ後のhead）では失効させず、二度目の承認を求めない。範囲を外れた変化（それ以外の
 *   ファイル・候補の更新/置換・mainの前進・取消・期限切れ）は失効理由と差分を残して再承認へ戻す
 * - 承認の根拠はサーバー側の記録だけ。既存候補の「公開準備済み」から承認を推定しない
 */

export const PUBLISH_APPROVAL_STATUSES = ["active", "merging", "consumed", "revoked", "invalidated"] as const;
export type PublishApprovalStatus = (typeof PUBLISH_APPROVAL_STATUSES)[number];

/** 承認の有効期間。自動公開を進めるリリース完了系列の期限と揃える（承認だけが残り続けない） */
export const PUBLISH_APPROVAL_TTL_MS = RELEASE_COMPLETION_TTL_MS;

/** 承認の範囲に含める、正式バンプで変わってよいファイルの分類 */
export const PUBLISH_APPROVAL_ALLOWED_CATEGORIES: readonly ChangedFileCategory[] = ["version", "changelog"];

export const PUBLISH_APPROVAL_STATUS_LABEL: Record<PublishApprovalStatus, string> = {
  active: "公開承認済み",
  merging: "本番マージ中",
  consumed: "公開済み",
  revoked: "取り消し済み",
  invalidated: "失効",
};

export type PublishApprovalInvalidReason =
  | "expired"
  | "candidate_cancelled"
  | "candidate_changed"
  | "unexpected_changes"
  | "main_advanced"
  | "finalize_target_changed";

export const PUBLISH_APPROVAL_INVALID_LABEL: Record<PublishApprovalInvalidReason, string> = {
  expired: "公開承認の有効期限（24時間）を過ぎました",
  candidate_cancelled: "候補が取り消されました",
  candidate_changed: "承認した後に候補が更新・置換されました",
  unexpected_changes: "正式バンプで版ファイル・更新履歴以外のファイルが変わりました",
  main_advanced: "承認した後にmainが進みました",
  finalize_target_changed: "公開準備の対象が承認した候補と一致しません",
};

export type PublishApprovalTarget = {
  status: PublishApprovalStatus;
  baseSha: string;
  headSha: string;
  expiresAt: Date;
};

/** この承認の対象から始めた公開準備（バンプ前→バンプ後）の記録 */
export type PublishApprovalFinalization = {
  status: string;
  preBaseSha: string;
  preHeadSha: string;
  finalBaseSha: string | null;
  finalHeadSha: string | null;
  files: readonly { path: string; category: string; versionLinesOnly?: boolean }[];
};

export type PublishApprovalValidity =
  | { valid: true; finalHeadSha: string | null }
  | { valid: false; reason: PublishApprovalInvalidReason; detail: string | null; diff: string[] };

/** 承認範囲の外のファイル（想定バンプに含まれないもの） */
export function filesBeyondApproval(files: readonly { path: string; category: string; versionLinesOnly?: boolean }[]): string[] {
  return files
    .filter((f) => !(PUBLISH_APPROVAL_ALLOWED_CATEGORIES as readonly string[]).includes(f.category))
    // iOS設定は、差分が版番号の行の書き換えだけと確かめたものに限り範囲内（#4753）。分類だけでは許可しない
    .filter((f) => !(f.category === "ios_version" && f.versionLinesOnly === true))
    // アセット参照の`?v=`だけを予約済みの正式版へ変えたと確かめたもの（`asset_version`）も範囲内（#5101）。パスだけでは許可しない
    .filter((f) => f.category !== "asset_version")
    .map((f) => f.path);
}

/**
 * 公開承認が今も有効か。**本番マージ前（`active`）の承認だけを評価する**（マージを確保した後はmainが進むのが正しい）。
 *
 * - 期限・候補の取消を先に見る
 * - この承認の対象（pre base/head）から始めて適用した公開準備があれば、その差分が想定バンプに収まることを確かめる。
 *   収まれば、バンプ後のheadも承認の範囲として扱う
 * - 現在の候補のheadが「承認したhead」か「範囲内のバンプ後head」のどちらでもなければ失効
 * - mainの先端が承認したbaseから進んでいれば失効（他の公開の先行も含む）
 * - 観測できないものは`valid`にも失効にもしない（呼び出し側が待つ）。`observed`がnullなら判定を保留する
 */
export function decidePublishApprovalValidity(input: {
  approval: PublishApprovalTarget;
  now: Date;
  candidatePhase: string;
  finalizations: readonly PublishApprovalFinalization[];
  observed: { headSha: string; mainSha: string } | null;
}): PublishApprovalValidity | null {
  const { approval } = input;
  const invalid = (reason: PublishApprovalInvalidReason, detail: string | null = null, diff: string[] = []): PublishApprovalValidity => ({
    valid: false,
    reason,
    detail,
    diff,
  });
  if (input.now.getTime() >= approval.expiresAt.getTime()) return invalid("expired");
  if (input.candidatePhase === "cancelled") return invalid("candidate_cancelled");

  // この承認の対象から始め、バンプ後のheadを記録した公開準備（失敗して修正工程へ戻ったものも含む）
  const bumped = input.finalizations.filter(
    (f) => f.preHeadSha === approval.headSha && f.preBaseSha === approval.baseSha && f.finalHeadSha !== null && f.status !== "requested" && f.status !== "expired",
  );
  for (const f of bumped) {
    const beyond = filesBeyondApproval(f.files);
    if (beyond.length > 0) return invalid("unexpected_changes", `${short(f.preHeadSha)} → ${short(f.finalHeadSha)}`, beyond);
    if (f.finalBaseSha !== null && f.finalBaseSha !== approval.baseSha) {
      return invalid("main_advanced", `${short(approval.baseSha)} → ${short(f.finalBaseSha)}`);
    }
  }
  const finalHeadSha = bumped.length > 0 ? bumped[bumped.length - 1].finalHeadSha : null;

  if (input.observed === null) return null;
  const allowedHeads = new Set([approval.headSha, ...bumped.map((f) => f.finalHeadSha!)]);
  if (!allowedHeads.has(input.observed.headSha)) {
    return invalid("candidate_changed", `${short(finalHeadSha ?? approval.headSha)} → ${short(input.observed.headSha)}`);
  }
  if (input.observed.mainSha !== approval.baseSha) {
    return invalid("main_advanced", `${short(approval.baseSha)} → ${short(input.observed.mainSha)}`);
  }
  return { valid: true, finalHeadSha };
}

/**
 * 公開準備の要求（再試行を含む）が、既存の有効な承認の範囲内か。**同じ処理の再試行で再承認を増やさない**ため、
 * 押した時点の候補が「承認したhead」か「範囲内のバンプ後head」で、baseが承認したbaseのときだけ使い回す
 */
export function isWithinApprovalTarget(input: {
  approval: Pick<PublishApprovalTarget, "baseSha" | "headSha">;
  finalizations: readonly PublishApprovalFinalization[];
  target: { baseSha: string; headSha: string };
}): boolean {
  if (input.target.baseSha !== input.approval.baseSha) return false;
  if (input.target.headSha === input.approval.headSha) return true;
  return input.finalizations.some(
    (f) =>
      f.preHeadSha === input.approval.headSha &&
      f.preBaseSha === input.approval.baseSha &&
      f.finalHeadSha === input.target.headSha &&
      filesBeyondApproval(f.files).length === 0,
  );
}

// ---------------------------------------------------------------------------
// 画面に出す段階

export type PublishProgressStage =
  /** 承認の記録が無い（既存の候補を含む）。明示の承認を1回求める */
  | "needs_approval"
  /** 承認済みで、正式バンプ・最終検証を進めている */
  | "final_checks"
  /** 最終検証に合格し、mainへの自動マージの条件を確かめている */
  | "auto_publish"
  /** 自動公開が止まっている（理由あり） */
  | "stopped"
  | "deploying"
  | "verifying_production"
  | "completed"
  /** 承認が失効・取消された */
  | "invalidated"
  | "revoked";

export const PUBLISH_PROGRESS_LABEL: Record<PublishProgressStage, string> = {
  needs_approval: "公開承認が必要",
  final_checks: "最終検証中",
  auto_publish: "自動公開待ち",
  stopped: "自動公開が停止",
  deploying: "本番反映中",
  verifying_production: "稼働確認中",
  completed: "完了",
  invalidated: "公開承認が失効",
  revoked: "自動公開を取り消し済み",
};

/**
 * 候補の段階・承認・自動公開の系列から、画面に出す段階を1つに決める。**実処理の記録だけ**から導き、
 * 承認済みの候補では「本番承認待ち」を出さない
 */
export function describePublishProgress(input: {
  phase: string;
  approval: { status: PublishApprovalStatus } | null;
  /** 承認に紐づくリリース完了系列。無ければnull */
  run: { status: string; active: boolean } | null;
}): PublishProgressStage {
  const { phase, approval, run } = input;
  if (phase === "completed") return "completed";
  if (phase === "verifying_production") return "verifying_production";
  if (phase === "deploying") return "deploying";
  if (approval === null) return "needs_approval";
  if (approval.status === "revoked") return "revoked";
  if (approval.status === "invalidated") return "invalidated";
  if (approval.status === "merging" || approval.status === "consumed") return "deploying";
  if (run === null || !run.active) return "stopped";
  if (phase === "awaiting_approval" || run.status === "merging") return "auto_publish";
  return "final_checks";
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}
