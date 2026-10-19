import type { IosPrecheckPhase, IosPrecheckSummary } from "@/lib/github/ios-precheck";
import { resolveReviewVerdictFreshness } from "@/lib/github/review-verdict-freshness";
import type { CiState } from "@/lib/github/release-api";
import {
  describeCandidateTarget,
  type ReleaseCheckCell,
  type ReleaseCheckCells,
} from "@/lib/release-candidate-checks";
import {
  AI_REVIEW_VERDICT_LABEL,
  resolveAiReviewVerdictState,
} from "@/lib/pull-request-list";
import type { PullRequestSummary, ReleaseChangePullRequest } from "@/types/pull-request";

/**
 * PR詳細・PR一覧・ブランチ画面・本番マージ確認の一覧が共通で出す6チェック（#4366。#4305の5項目の後継）。
 *
 * 6項目は**独立した状態**で、1つの「レビュー」や総合成功へまとめない。実際に取得できた状態だけを
 * 出し、情報が足りないものを成功と推測しない（記録なし・取得不可・未実施・対象外・古い結果を別の状態にする）。
 * 並びは固定: CI → コードレビュー → コンフリクト → 全体レビュー → 統合検証 → iOS検証。
 * **計画レビューはPRのチェックに含めない**（Issue側の計画レビューは別機能として残る）。
 */
export type MergeCheckKey = "ci" | "code" | "conflict" | "all" | "integration" | "mac" | "ios";

export const MERGE_CHECK_KEYS: readonly MergeCheckKey[] = ["ci", "code", "conflict", "all", "integration", "mac"];

/**
 * 個別PRのiOS事前検証の項目（#4882）。`MERGE_CHECK_KEYS`の6項目とは別で、PR詳細だけが
 * CI・コード・競合の後ろへ足す（PR一覧は10秒間隔の自動更新でiOSを引かないため出さない。#4140）。
 */
export type IosPrecheckInput = IosPrecheckSummary | null | "loading";

export type MergeCheckTone = "ok" | "bad" | "warn" | "run" | "muted";

/** 詳細から辿る証跡。`pr`はPR詳細、`candidate`は共通結果を持つ候補PRの詳細 */
export type MergeCheckEvidence = { kind: "pr" | "candidate"; label: string };

export type MergeCheckItem = {
  key: MergeCheckKey;
  /** 行に出す短い名前 */
  shortLabel: string;
  /** 詳細に出す正式名称 */
  fullName: string;
  /** 色に頼らず状態を示す記号 */
  mark: string;
  /** 状態の短い日本語 */
  state: string;
  tone: MergeCheckTone;
  /** 何を対象にした判定か（対象PR・SHAを含む） */
  target: string;
  /** 理由・指摘。無ければnull */
  reason: string | null;
  evidence: MergeCheckEvidence | null;
  /** リリース候補の共通結果か（全体レビュー・統合検証・iOS検証） */
  common: boolean;
  /** 共通結果の判定対象の候補PR番号（個別PRの項目ではnull） */
  candidateNumber: number | null;
};

/** 個別PRの項目（CI・コードレビュー・コンフリクト）の元になる値 */
export type PerPullRequestCell = ReleaseCheckCell & {
  target: string;
  evidence: MergeCheckEvidence | null;
};

export type MergeChecksInput = {
  ci: PerPullRequestCell;
  code: PerPullRequestCell;
  conflict: PerPullRequestCell;
  release: ReleaseCheckCells;
};

const RELEASE_CI_LABEL: Record<CiState, string> = {
  success: "成功",
  pending: "実行中",
  failure: "失敗",
  unknown: "不明",
};

const CI_TARGET = "このPRのheadコミットのチェック結果";
const PR_EVIDENCE_CI: MergeCheckEvidence = { kind: "pr", label: "PRのChecksを開く" };

/** CIのセル。`note`は別の判定（リリース候補のCI）の併記 */
export function ciCell(
  state: CiState | "none",
  options: { note?: string | null; target?: string } = {},
): PerPullRequestCell {
  const note = options.note ?? null;
  const join = (text: string | null) => [text, note].filter(Boolean).join("。") || null;
  const base = { target: options.target ?? CI_TARGET, evidence: PR_EVIDENCE_CI };
  switch (state) {
    case "success":
      return { ...base, mark: "●", state: "成功", tone: "ok", reason: note };
    case "pending":
      return { ...base, mark: "◷", state: "実行中", tone: "run", reason: note };
    case "failure":
      return { ...base, mark: "■", state: "失敗", tone: "bad", reason: join("PRのCIが失敗しています") };
    case "none":
      return { ...base, mark: "–", state: "未実施", tone: "muted", reason: join("このPRのheadにチェックの記録がありません") };
    default:
      return { ...base, mark: "？", state: "取得不可", tone: "warn", reason: join("CIを取得できませんでした。成功とは扱いません") };
  }
}

const CODE_EVIDENCE: MergeCheckEvidence = { kind: "pr", label: "PR詳細を開く" };
const CODE_TARGET = "このPRのAIレビュー（個別PRの判定）";

function codeCellFrom(
  kind: "ok" | "needs-check" | "changes-requested" | "skipped" | "unknown" | "failed" | "pending",
  reason: string | null,
): PerPullRequestCell {
  const base = { target: CODE_TARGET, evidence: CODE_EVIDENCE };
  switch (kind) {
    case "ok":
      return { ...base, mark: "●", state: "問題なし", tone: "ok", reason };
    case "needs-check":
      return { ...base, mark: "▲", state: "要確認", tone: "warn", reason };
    case "changes-requested":
      return { ...base, mark: "■", state: "要修正", tone: "bad", reason };
    case "failed":
      return { ...base, mark: "■", state: "失敗", tone: "bad", reason: reason ?? "レビューの実行が失敗しました" };
    case "pending":
      return { ...base, mark: "◷", state: "実行中", tone: "run", reason };
    case "skipped":
      return { ...base, mark: "⊘", state: "省略", tone: "muted", reason: "低リスクのためレビューを省略（意図的な省略）" };
    default:
      return { ...base, mark: "–", state: "未実施", tone: "muted", reason: "判定の記録がありません" };
  }
}

/** 本番マージ確認の一覧の行（リリース候補に含まれるPR）から、CIとコードレビューのセルを作る */
export function cellsFromReleaseChange(
  pr: ReleaseChangePullRequest | null,
  releaseNote: string,
): { ci: PerPullRequestCell; code: PerPullRequestCell } {
  const ciState = pr?.mergeChecks?.ci.state;
  const ci =
    ciState === undefined || ciState === "unavailable"
      ? ciCell("unknown", { note: releaseNote })
      : ciCell(ciState, {
          note: releaseNote,
          target: "このPRのheadコミットの、マージ時点までの結果（個別PRの過去の結果）",
        });
  if (!pr || pr.reviewUnavailable) {
    return {
      ci,
      code: {
        ...codeCellFrom("unknown", null),
        mark: "？",
        state: "取得不可",
        tone: "warn",
        reason: "PR本文を取得できませんでした。問題なしとは扱いません",
      },
    };
  }
  const review = pr.review;
  if (!review) return { ci, code: codeCellFrom("unknown", null) };
  const freshness = resolveReviewVerdictFreshness({ reviewedSha: review.reviewedSha, headSha: pr.prHeadSha });
  if (freshness === "stale") {
    return {
      ci,
      code: {
        ...codeCellFrom("unknown", null),
        mark: "⟳",
        state: "無効",
        tone: "warn",
        reason: "判定の後にPRのheadが変わったため、今の内容に対する判定ではありません",
      },
    };
  }
  return { ci, code: codeCellFrom(review.reviewKind, review.reviewLabel) };
}

/** PR詳細・PR一覧・ブランチ画面の行（`PullRequestSummary`）から、CI・コードレビュー・コンフリクトのセルを作る */
export function cellsFromSummary(pullRequest: PullRequestSummary): {
  ci: PerPullRequestCell;
  code: PerPullRequestCell;
  conflict: PerPullRequestCell;
} {
  const aiReview = pullRequest.mergeJudgement?.aiReview;
  const verdict = pullRequest.reviewVerdict;
  let code: PerPullRequestCell;
  if (aiReview?.state === "pending") {
    code = codeCellFrom("pending", "AIレビューを実行中です");
  } else {
    const resolved = resolveAiReviewVerdictState(aiReview, verdict);
    if (resolved === null) {
      code = codeCellFrom("unknown", null);
    } else if (
      verdict &&
      resolveReviewVerdictFreshness({ reviewedSha: verdict.reviewedSha, headSha: pullRequest.headSha }) === "stale"
    ) {
      code = {
        ...codeCellFrom("unknown", null),
        mark: "⟳",
        state: "無効",
        tone: "warn",
        reason: "判定の後にPRのheadが変わったため、今の内容に対する判定ではありません",
      };
    } else {
      code = codeCellFrom(resolved, resolved === "ok" ? null : (verdict?.reviewLabel ?? AI_REVIEW_VERDICT_LABEL[resolved]));
    }
  }

  const closed = pullRequest.merged || pullRequest.state === "closed";
  const conflictBase = {
    target: "このPRとマージ先ブランチの差分の競合（GitHubの判定）",
    evidence: { kind: "pr", label: "PR詳細を開く" } as MergeCheckEvidence,
  };
  const conflict: PerPullRequestCell = closed
    ? { ...conflictBase, mark: "⊘", state: "対象外", tone: "muted", reason: "クローズ済み・マージ済みのPRです" }
    : pullRequest.mergeable === false
      ? { ...conflictBase, mark: "■", state: "あり", tone: "bad", reason: "マージ先と競合しています" }
      : pullRequest.mergeable === true
        ? { ...conflictBase, mark: "●", state: "なし", tone: "ok", reason: null }
        : { ...conflictBase, mark: "？", state: "確認中", tone: "warn", reason: "GitHubが競合を計算中です。成功とは扱いません" };

  const ci: PerPullRequestCell = closed
    ? { ...ciCell("unknown"), mark: "⊘", state: "対象外", tone: "muted", reason: "クローズ済み・マージ済みのPRです" }
    : pullRequest.draft
      ? { ...ciCell(pullRequest.ciState), ...(pullRequest.ciState === "unknown" ? { state: "未実施", mark: "–", tone: "muted" as const, reason: "ドラフトのためCIは未実行です" } : {}) }
      : ciCell(pullRequest.ciState);
  return { ci, code, conflict };
}

const shortSha = (sha: string) => sha.slice(0, 7);

const IOS_PHASE_LABEL: Record<IosPrecheckPhase, string> = {
  success: "成功",
  failure: "失敗",
  running: "検証中",
  waiting: "検証待ち",
};

/**
 * iOS事前検証（`issue-deck/ios-precheck`）の要約から、個別PRの「iOS」項目を作る（#4882）。
 * statusはSHAに付くため、**headに結果が無ければ前回の成功を引き継がず「未実施」**にする。
 * どのコミットにも記録が無い（null）は、対象外か未依頼かを区別できないので「記録なし」と出す。
 */
export function iosPrecheckCheck(input: IosPrecheckInput, options: { closed?: boolean } = {}): MergeCheckItem {
  const base = {
    key: "ios" as const,
    shortLabel: "iOS",
    fullName: "iOS検証（このPRのiOS事前検証）",
    // 結果はPRの指摘・CIの内訳には出ないため、導線を出さない（判定対象のSHAと理由は詳細に出る）
    evidence: null,
    common: false,
    candidateNumber: null,
  };
  const target = (sha: string) => `このPRのheadコミット${shortSha(sha)}のiOS事前検証（Macでのビルド・テスト）`;
  if (options.closed) {
    return { ...base, mark: "⊘", state: "対象外", tone: "muted", target: "このPRのiOS事前検証", reason: "クローズ済み・マージ済みのPRです" };
  }
  if (input === "loading") {
    return { ...base, mark: "◷", state: "取得中", tone: "muted", target: "このPRのiOS事前検証", reason: "PR詳細を取得しています" };
  }
  if (input === null) {
    return {
      ...base,
      mark: "–",
      state: "記録なし",
      tone: "muted",
      target: "このPRのiOS事前検証",
      reason: "このPRのコミットにiOS検証の記録がありません（iOS検証の対象外か、まだ依頼していません）",
    };
  }
  const head = input.head;
  if (!head) {
    const previous = input.previous;
    return {
      ...base,
      mark: "–",
      state: "未実施",
      tone: "muted",
      target: target(input.headSha),
      reason: previous
        ? `最新のコミットではまだ検証していません。前回の結果は${shortSha(previous.sha)}で${IOS_PHASE_LABEL[previous.phase]}です`
        : "最新のコミットではまだ検証していません",
    };
  }
  const reason = head.description;
  switch (head.phase) {
    case "success":
      return { ...base, mark: "●", state: "成功", tone: "ok", target: target(head.sha), reason };
    case "failure":
      return { ...base, mark: "■", state: "失敗", tone: "bad", target: target(head.sha), reason: reason ?? "iOSのビルド・テストが失敗しました" };
    case "running":
      return { ...base, mark: "◷", state: "検証中", tone: "run", target: target(head.sha), reason };
    default:
      return {
        ...base,
        mark: "▲",
        state: "検証待ち",
        tone: "warn",
        target: target(head.sha),
        reason: reason ?? "Macで検証できる状態を待っています。成功とは扱いません",
      };
  }
}

/** 6項目を、固定の並びで返す */
export function buildMergeChecks(input: MergeChecksInput): MergeCheckItem[] {
  const { release } = input;
  const candidate = release.candidate;
  const candidateTarget = candidate
    ? `${describeCandidateTarget(candidate)}の共通結果。このPR専用ではありません`
    : "リリース候補の共通結果（対象の候補PRはまだありません）";
  const common = (
    key: "all" | "integration" | "mac",
    shortLabel: string,
    fullName: string,
    cell: ReleaseCheckCell,
  ): MergeCheckItem => ({
    key,
    shortLabel,
    fullName,
    ...cell,
    target: key === "mac" && candidate ? `${candidateTarget}（iOSでのビルド確認）` : candidateTarget,
    evidence: candidate ? { kind: "candidate", label: `候補PR #${candidate.number}の詳細へ` } : null,
    common: true,
    candidateNumber: candidate?.number ?? null,
  });
  const own = (key: "ci" | "code" | "conflict", shortLabel: string, fullName: string, cell: PerPullRequestCell): MergeCheckItem => ({
    key,
    shortLabel,
    fullName,
    ...cell,
    common: false,
    candidateNumber: null,
  });
  return [
    own("ci", "CI", "CI（個別PRのチェック）", input.ci),
    own("code", "コード", "コードレビュー（このPRのAIレビュー）", input.code),
    own("conflict", "競合", "コンフリクト", input.conflict),
    common("all", "全体〔共通〕", "全体レビュー（リリース候補の共通結果）", release.all),
    common("integration", "統合〔共通〕", "統合検証（リリース候補の共通結果）", release.integration),
    common("mac", "iOS〔共通〕", "iOS検証（リリース候補のiOSビルド確認）", release.mac),
  ];
}

export { RELEASE_CI_LABEL };
