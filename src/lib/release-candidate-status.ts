import { isReleasePullRequest } from "@/lib/release-merge-gate";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";
import type { PullRequestReleaseCheckState, PullRequestReleaseChecks } from "@/types/pull-request";

/**
 * リリース候補（`release-main/v*`→`main`のPR）の、統合検証・全体レビューから見た状態（#4390）。
 *
 * **「mainへマージ待ち」を出してよいかは、ここだけで決める。** ブランチ画面の見出し・畳んだ行・
 * 「手が要るもの／待てば進むもの」の集計、マージボタン、ヘッダーのリリース状況・反映待ち件数・
 * 本番マージ待ちPushが同じ判定を通す。CI・自動マージ判定しか見ていなかったころは、全体レビューの
 * 実行中にも琥珀の「mainへマージ待ち」と「検証中」が並んでいた（morrow v3.15.5 / PR #554）。
 *
 * - **進行中**（`progress`）: 実行中・待機中の検証。#4354と同じく、結果が出るまで通常のマージはできない
 * - **問題**（`problem`）: 失敗・設定不足・要確認・対象変更で無効・未実施（強制時のみ）・取得不能。
 *   マージを禁じるかどうかは既存のゲート（`release-merge-gate.ts`）が決め、ここでは変えない。
 *   **強制していないリポジトリでも、問題を「問題なしのマージ待ち」とは見せない**
 * - どちらも無いときだけ`clear`（＝「mainへマージ待ち」を出してよい）
 *
 * 進行中と問題は両方立ちうる（一方が失敗し、もう一方が実行中など）。画面は両方を出し、問題を隠さない。
 */
export type ReleaseCandidateProblemKind =
  | "failed"
  | "setup_missing"
  | "needs_check"
  | "invalidated"
  | "not_run"
  | "unavailable";

export type ReleaseCandidatePendingCheck = {
  /** 「全体レビュー」「統合検証」「統合検証（Mac検証）」 */
  name: string;
  /** 実行側が動き出しているか。falseは順番待ち */
  started: boolean;
};

export type ReleaseCandidateVerification = {
  /** 実行中・待機中の検証があるとき。`label`は「リリース検証中」か「リリース検証待ち」 */
  progress: { label: string; checks: ReleaseCandidatePendingCheck[] } | null;
  /** 問題があるとき。`label`はいちばん重い問題の短い名前、`reasons`は全件 */
  problem: { kind: ReleaseCandidateProblemKind; label: string; reasons: string[] } | null;
  /** 待っている検証と問題を1文で（ボタンの`title`・読み上げ用）。clearならnull */
  detail: string | null;
};

export const RELEASE_VERIFYING_LABEL = "リリース検証中";
export const RELEASE_VERIFICATION_WAITING_LABEL = "リリース検証待ち";

const PROBLEM_LABEL: Record<ReleaseCandidateProblemKind, string> = {
  failed: "検証失敗",
  setup_missing: "検証の設定不足",
  needs_check: "検証要確認",
  invalidated: "再検証が必要",
  not_run: "検証未実施",
  unavailable: "検証状態を取得できません",
};

/** 重いものから。見出しの1語にはいちばん重い問題を出す */
const PROBLEM_ORDER: ReleaseCandidateProblemKind[] = [
  "failed",
  "setup_missing",
  "needs_check",
  "invalidated",
  "not_run",
  "unavailable",
];

const CLEAR: ReleaseCandidateVerification = { progress: null, problem: null, detail: null };

/**
 * リリース候補の検証状態を畳む。`checks`はPR一覧が載せる`releaseChecks`（`fetchReleaseChecks`）。
 *
 * `isReleaseCandidate`がfalse（headが`release-main/`でない旧世代のリリースPR）は検証の対象外なので
 * `clear`を返し、従来どおりCI・判定だけで決める。候補なのに`checks`が無い・読めなかったときは
 * **成功と推測せず**「取得不能」にする（未取得をマージ待ちにしない）。
 */
export function resolveReleaseCandidateVerification(
  checks: PullRequestReleaseChecks | null | undefined,
  isReleaseCandidate: boolean,
): ReleaseCandidateVerification {
  if (!isReleaseCandidate) return CLEAR;
  if (!checks || checks.unavailable) {
    const reasons = ["統合検証・全体レビューの状態を取得できませんでした"];
    return {
      progress: null,
      problem: { kind: "unavailable", label: PROBLEM_LABEL.unavailable, reasons },
      detail: reasons[0],
    };
  }

  const enforced = checks.enforced !== false;
  const sections: { name: string; state: PullRequestReleaseCheckState; started: boolean; integration: boolean }[] = [
    {
      name: "全体レビュー",
      state: checks.aiReview,
      started: checks.started?.aiReview ?? false,
      integration: false,
    },
    {
      name: checks.started?.mac ? "統合検証（Mac検証）" : "統合検証",
      state: checks.integration,
      started: checks.started?.integration ?? false,
      integration: true,
    },
  ];

  const pending: ReleaseCandidatePendingCheck[] = [];
  const problems: { kind: ReleaseCandidateProblemKind; reason: string }[] = [];
  for (const section of sections) {
    switch (section.state) {
      case "running":
        pending.push({ name: section.name, started: section.started });
        break;
      case "failed":
        if (section.integration && checks.integrationSetupGap) {
          problems.push({ kind: "setup_missing", reason: `${section.name}: ${checks.integrationSetupGap}` });
        } else {
          problems.push({ kind: "failed", reason: `${section.name}が失敗しています` });
        }
        break;
      case "needs_check":
        problems.push({ kind: "needs_check", reason: `${section.name}に要確認の結果があります` });
        break;
      case "invalidated":
        problems.push({
          kind: "invalidated",
          reason: `${section.name}: 候補（mainまたはリリースブランチの先端）が変わったため、古い結果は使えません`,
        });
        break;
      case "not_run":
        // 記録が無い（依頼されていない）ものは、強制していなければ待たない（#4354と同じ）。
        // 強制しているならゲートが「未実施」で止めるので、マージ待ちとは見せない
        if (enforced) problems.push({ kind: "not_run", reason: `${section.name}が未実施です` });
        break;
      case "passed":
      case "not_applicable":
        break;
    }
  }

  const progress =
    pending.length > 0
      ? {
          label: pending.some((check) => check.started) ? RELEASE_VERIFYING_LABEL : RELEASE_VERIFICATION_WAITING_LABEL,
          checks: pending,
        }
      : null;
  const worst = PROBLEM_ORDER.find((kind) => problems.some((p) => p.kind === kind)) ?? null;
  const problem =
    worst !== null ? { kind: worst, label: PROBLEM_LABEL[worst], reasons: problems.map((p) => p.reason) } : null;
  if (!progress && !problem) return CLEAR;

  const detail = [
    ...(problem?.reasons ?? []),
    ...pending.map((check) => `${check.name}の${check.started ? "実行中" : "開始待ち"}です`),
  ].join("。");
  return { progress, problem, detail };
}

/** 「mainへマージ待ち」を出してよいか（検証の面で）。進行中・問題のどちらも無いとき */
export function isReleaseCandidateClear(verification: ReleaseCandidateVerification): boolean {
  return verification.progress === null && verification.problem === null;
}

/**
 * 通常のマージ操作を止める理由（#4354の完了待ち）。進行中の検証があるあいだだけ返す。
 * **結果（失敗・要確認など）ではここで止めない**——止めるかどうかは既存のゲートと確認画面が決める
 */
export function describeReleaseVerificationWait(verification: ReleaseCandidateVerification): string | null {
  if (!verification.progress) return null;
  return `${verification.progress.checks
    .map((check) => `${check.name}（${check.started ? "実行中" : "開始待ち"}）`)
    .join("・")}の判定が出るまでマージできません`;
}

/** PR1本から。リリース候補（base=main・head=`release-main/v*`）かどうかもここで判定する */
export function resolvePullRequestReleaseVerification(pullRequest: {
  baseRef: string;
  headRef: string;
  state?: "open" | "closed";
  releaseChecks?: PullRequestReleaseChecks | null;
}): ReleaseCandidateVerification {
  if (pullRequest.state === "closed") return CLEAR;
  return resolveReleaseCandidateVerification(pullRequest.releaseChecks, isReleasePullRequest(pullRequest));
}

/**
 * ヘッダーのリリース状況（`release-button-status.ts`）へ渡す、検証から見た止まり方（#4390）。
 * 問題があれば`problem`（手が要る）、進行中だけなら`progressing`（待てば進む）、無ければnull。
 * 両方あるときは問題を優先する（問題を「待てば進む」に隠さない）
 */
export type ReleaseVerificationBlock = "progressing" | "problem";

export function releaseVerificationBlock(verification: ReleaseCandidateVerification): ReleaseVerificationBlock | null {
  if (verification.problem) return "problem";
  if (verification.progress) return "progressing";
  return null;
}

/** ヘッダー・一覧のバッジに出す1つ（文言・理由）。clearならnull */
export type ReleaseVerificationBadgeInfo = {
  block: ReleaseVerificationBlock;
  label: string;
  detail: string | null;
};

export function describeReleaseVerificationBadge(
  verification: ReleaseCandidateVerification,
): ReleaseVerificationBadgeInfo | null {
  const block = releaseVerificationBlock(verification);
  if (block === null) return null;
  const label = block === "problem" ? verification.problem!.label : verification.progress!.label;
  return { block, label, detail: verification.detail };
}

/**
 * リリース画面の検証の要約（`GET /api/repositories/release`の`verification`）を、PR一覧と同じ形へ畳む（#4390）。
 * スマホのリポジトリ画面のリリース状況も同じ判定を通すために使う。記録で`waiting`のものは、
 * 実行側が動いていれば要約の段階で`running`になっている（`summarizeReleaseVerification`）
 */
export function releaseChecksFromSummary(
  summary: ReleaseVerificationSummary,
  integrationSetupGap: string | null = null,
): PullRequestReleaseChecks {
  const fold = (state: ReleaseVerificationSummary["integration"]["state"]): PullRequestReleaseCheckState =>
    state === "waiting" || state === "running" ? "running" : state;
  return {
    aiReview: fold(summary.aiReview.state),
    integration: fold(summary.integration.state),
    enforced: summary.enforced,
    started: {
      aiReview: summary.aiReview.state === "running",
      integration: summary.integration.state === "running",
      mac: summary.mac.state === "running",
    },
    integrationSetupGap,
  };
}
