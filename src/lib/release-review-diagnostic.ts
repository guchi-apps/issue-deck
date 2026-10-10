/**
 * 全体レビューの実行失敗の診断（#4300）。**コードへの指摘（`ReleaseReviewFinding`）とは別物**で、
 * 「レビューを最後まで行えなかった」理由だけを表す。実行側（`scripts/run-release-review.sh`）が
 * 報告し、サーバーは受け取った値をここで絞り直して`ReleaseVerification.findings`へ対象SHAとともに残す。
 *
 * **根拠のない原因を断定しない。** 原因は実行側が観測できた事実（時間切れの終了コード124・ログ中の
 * 認証エラー表示・結果JSONが読めなかった等）から決め、決められなければ`unknown`（原因未特定）にする。
 * 終了コード126・127は「AI CLIを実行できなかった」までしか言えず、権限・パス・実行形式のどれかは特定しない。
 */

export const REVIEW_DIAGNOSTIC_STAGES = ["prepare", "diff", "review", "finalize"] as const;
export type ReviewDiagnosticStage = (typeof REVIEW_DIAGNOSTIC_STAGES)[number];

export const REVIEW_DIAGNOSTIC_CAUSES = [
  "no_host",
  "target_missing",
  "launch_failed",
  "auth_failed",
  "timeout",
  "parse_failed",
  "unknown",
] as const;
export type ReviewDiagnosticCause = (typeof REVIEW_DIAGNOSTIC_CAUSES)[number];

export type ReleaseReviewDiagnostic = {
  stage: ReviewDiagnosticStage | null;
  cause: ReviewDiagnosticCause;
  exitCode: number | null;
  /** 機密除去済みのエラー抜粋（末尾）。生ログ全文ではない */
  excerpt: string | null;
  /** この診断が対応する対象。画面は現在のSHAと一致するときだけ出す */
  targetBaseSha: string | null;
  targetHeadSha: string | null;
};

export const EXCERPT_MAX_LENGTH = 2000;
const EXCERPT_MAX_LINES = 30;

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[秘密鍵を除去]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [除去]"],
  [/\bop:\/\/\S+/g, "op://[除去]"],
  [/\b(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1[除去]@"],
  [/\b(?:gh[pousr]_|github_pat_|sk-ant-|sk-|xox[abprs]-|AKIA|AIza|eyJ)[A-Za-z0-9_\-.]{8,}/g, "[トークンを除去]"],
  [
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTHORIZATION|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi,
    "$1=[除去]",
  ],
];

/** 機密らしい値を伏せる。実行側と同じ考え方をサーバー側でも通す（実行側の除去漏れの最後の砦） */
export function redactDiagnosticText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of REDACTIONS) result = result.replace(pattern, replacement);
  return result;
}

/** 末尾を残して長さを切り、機密を伏せた抜粋にする。空ならnull */
export function buildDiagnosticExcerpt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // 制御文字（色指定など）を除く
  const cleaned = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const tail = cleaned.split("\n").slice(-EXCERPT_MAX_LINES).join("\n").trim();
  if (tail === "") return null;
  const redacted = redactDiagnosticText(tail);
  return redacted.length > EXCERPT_MAX_LENGTH ? `…${redacted.slice(-EXCERPT_MAX_LENGTH)}` : redacted;
}

/** 実行側から届いた診断を、記録できる形へ絞る。形が違えばnull（呼び出し側が原因未特定として扱う） */
export function normalizeReleaseReviewDiagnostic(
  raw: unknown,
  target: { baseSha: string; headSha: string },
): ReleaseReviewDiagnostic | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const cause = REVIEW_DIAGNOSTIC_CAUSES.find((c) => c === value.cause) ?? "unknown";
  const stage = REVIEW_DIAGNOSTIC_STAGES.find((s) => s === value.stage) ?? null;
  const exitCode =
    typeof value.exitCode === "number" && Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255
      ? value.exitCode
      : null;
  return {
    stage,
    cause,
    exitCode,
    excerpt: buildDiagnosticExcerpt(value.excerpt),
    // 対象はジョブ自身のSHAで決める。報告の本文からは決めない
    targetBaseSha: target.baseSha,
    targetHeadSha: target.headSha,
  };
}

/** 保存済みの`findings`から診断を取り出す。現在の対象と違えばnull（旧実行の原因を現在の結果に見せない） */
export function readReleaseReviewDiagnostic(
  findings: unknown,
  current: { baseSha: string; headSha: string },
): ReleaseReviewDiagnostic | null {
  if (typeof findings !== "object" || findings === null) return null;
  const raw = (findings as Record<string, unknown>).diagnostic;
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.targetBaseSha !== current.baseSha || value.targetHeadSha !== current.headSha) return null;
  const normalized = normalizeReleaseReviewDiagnostic(raw, current);
  // 保存時にも除去済みだが、読み出しでも通す（除去規則を後から強めたとき、既存の行にも効かせる）
  return normalized;
}

const CAUSE_LABEL: Record<ReviewDiagnosticCause, string> = {
  no_host: "実行できるサブPCがありません",
  target_missing: "対象のコミットを取得できませんでした",
  launch_failed: "AI CLIを起動できませんでした",
  auth_failed: "AIの認証に失敗しました",
  timeout: "時間切れで完走できませんでした",
  parse_failed: "AIの結果を読み取れませんでした",
  unknown: "原因を特定できていません",
};

const CAUSE_ACTION: Record<ReviewDiagnosticCause, string> = {
  no_host: "サブPCのオンライン状態とpollerの対応（全体レビュー・担当AI・リポジトリ登録）を確認してから、再実行してください。",
  target_missing: "対象のコミットがサブPCから取得できていません。ネットワークとリポジトリの取得状況を確認してから、再実行してください。",
  launch_failed:
    "サブPCでAI CLI（claude／codex）が実行できる状態か（インストール・実行権限・PATH）を確認してから、再実行してください。",
  auth_failed: "サブPCのAI CLIのログイン状態を確認し、再ログインしてから再実行してください。",
  timeout: "差分が大きいか、AIの応答が遅れています。時間をおいて再実行してください。繰り返す場合は差分を分けることを検討してください。",
  parse_failed: "AIの応答がJSONになっていませんでした。一時的なことが多いので、まず再実行してください。",
  unknown:
    "コードへの指摘ではありません。サブPCの環境（AI CLI・ログイン・ディスク）を確認したうえで、再実行してください。",
};

const STAGE_LABEL: Record<ReviewDiagnosticStage, string> = {
  prepare: "準備",
  diff: "差分取得",
  review: "AIレビュー",
  finalize: "結果整理",
};

export type ReleaseReviewDiagnosticView = {
  /** 「レビュー未完了」の見出しに続ける、原因の短い説明 */
  causeLabel: string;
  /** 失敗した（最後に確認できた）工程。分からなければnull */
  stageLabel: string | null;
  /** 次に取れる操作 */
  action: string;
  /** 原因を確定できていないか */
  unidentified: boolean;
};

export function describeReleaseReviewDiagnostic(
  diagnostic: ReleaseReviewDiagnostic | null,
): ReleaseReviewDiagnosticView {
  const cause = diagnostic?.cause ?? "unknown";
  return {
    causeLabel: CAUSE_LABEL[cause],
    stageLabel: diagnostic?.stage ? STAGE_LABEL[diagnostic.stage] : null,
    action: CAUSE_ACTION[cause],
    unidentified: cause === "unknown",
  };
}
