import type { RepairKind } from "@/lib/github/pull-request-repair";
import { repairKindsFor } from "@/lib/github/pull-request-repair";
import { resolveReviewVerdictFreshness } from "@/lib/github/review-verdict-freshness";
import { deriveMergeHold } from "@/lib/pull-request-merge-hold";
import {
  CI_STATE_LABEL,
  mergeJudgementLabel,
  requiresUserMerge,
} from "@/lib/pull-request-list";
import type { ReleaseCheckCells } from "@/lib/release-candidate-checks";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * PR一覧・PR詳細が最初に見せる「代表状態と理由」（#4427）。
 *
 * **表示のための要約であって、マージ可否の判定ではない。** マージできるかは従来どおり
 * `canMergeFromDeck`・`mergeWarnings`・確認ダイアログが決める。ここは既に持っている値
 * （CI・レビュー判定・コンフリクト・修復の実行・自動マージ保留）を、人が先に直すべき順に1つへ畳むだけで、
 * 読めない値を成功へ倒さない。リリース候補（全体・統合・Mac）の有無は通常PRの代表状態に影響させない
 * （`describeReleaseCandidate`が別軸として返す）。
 */
export type PrimaryStateKind =
  | "merged"
  | "closed"
  | "draft"
  | "repairing"
  | "conflict"
  | "ci-failed"
  | "review-findings"
  | "ci-running"
  | "judging"
  | "merge-held"
  | "mergeable"
  | "unknown";

export type PrimaryStateTone = "ok" | "bad" | "warn" | "run" | "muted";

export type PrimaryState = {
  kind: PrimaryStateKind;
  /** 短い日本語の状態名 */
  label: string;
  tone: PrimaryStateTone;
  /** 何を待っている・何が問題かの理由 */
  reason: string;
  /** 色に頼らず状態を示す記号 */
  mark: string;
  /** 人が今すぐ操作する必要があるか（待てば進む状態・終端はfalse） */
  needsAction: boolean;
  /** 起動できる自動修正の種類（実際に起動できるものだけ） */
  repairKinds: RepairKind[];
};

const MARK: Record<PrimaryStateTone, string> = { ok: "●", bad: "■", warn: "▲", run: "◷", muted: "–" };

function state(
  kind: PrimaryStateKind,
  label: string,
  tone: PrimaryStateTone,
  reason: string,
  extra: { needsAction?: boolean; repairKinds?: RepairKind[] } = {},
): PrimaryState {
  return {
    kind,
    label,
    tone,
    reason,
    mark: MARK[tone],
    needsAction: extra.needsAction ?? false,
    repairKinds: extra.repairKinds ?? [],
  };
}

/** レビュー判定が今のheadに対するものか。判定が古いときは現在の指摘として扱わない */
function currentReviewKind(pullRequest: PullRequestSummary): "changes-requested" | "needs-check" | null {
  const verdict = pullRequest.reviewVerdict;
  if (!verdict) return null;
  if (resolveReviewVerdictFreshness({ reviewedSha: verdict.reviewedSha, headSha: pullRequest.headSha }) === "stale") {
    return null;
  }
  return verdict.reviewKind === "changes-requested" || verdict.reviewKind === "needs-check"
    ? verdict.reviewKind
    : null;
}

export function derivePrimaryState(pullRequest: PullRequestSummary): PrimaryState {
  if (pullRequest.merged) return state("merged", "マージ済み", "muted", "このPRはマージされています");
  if (pullRequest.state === "closed") return state("closed", "クローズ済み", "muted", "マージされずに閉じられています");
  if (pullRequest.draft) return state("draft", "ドラフト", "muted", "ドラフトのためマージできません。詳細で「レビュー可能にする」を押すと、CI・コードレビューが始まります");

  const repairKinds = repairKindsFor(pullRequest, pullRequest.mergeable);

  if (pullRequest.repairRun) {
    return state(
      "repairing",
      "修正中",
      "run",
      "自動修正が実行中です。完了すると自動で再検証されます（操作は不要です）",
    );
  }
  if (pullRequest.mergeable === false) {
    return state("conflict", "競合あり", "bad", "マージ先ブランチと競合しています", {
      needsAction: true,
      repairKinds,
    });
  }
  if (pullRequest.ciState === "failure") {
    return state("ci-failed", "CI失敗", "bad", "CIが失敗しています。原因を直してから進めます", {
      needsAction: true,
      repairKinds,
    });
  }
  const review = currentReviewKind(pullRequest);
  if (review === "changes-requested") {
    return state("review-findings", "レビュー指摘", "bad", "自動レビューが要修正と判定しています", {
      needsAction: true,
      repairKinds,
    });
  }
  if (pullRequest.ciState === "pending") {
    return state("ci-running", "CI実行中", "run", "CIの完了を待っています（操作は不要です）");
  }
  if (pullRequest.mergeJudgement.state === "pending") {
    return state(
      "judging",
      "判定中",
      "run",
      `${mergeJudgementLabel(pullRequest.mergeJudgement.step)}です。終わるまでマージできません（操作は不要です）`,
    );
  }
  if (review === "needs-check") {
    return state("review-findings", "レビュー要確認", "warn", "自動レビューが要確認と判定しています。内容を読んで判断します", {
      needsAction: true,
      repairKinds,
    });
  }
  if (pullRequest.ciState === "unknown") {
    return state("unknown", "CI状態不明", "warn", `${CI_STATE_LABEL.unknown}。成功とは扱いません`, {
      needsAction: true,
    });
  }
  const hold = deriveMergeHold(pullRequest);
  if (hold.status === "held") {
    return state("merge-held", "マージ前の確認", "warn", hold.reasons.map((reason) => reason.text).join(" / "), {
      needsAction: requiresUserMerge(pullRequest),
    });
  }
  if (pullRequest.mergeable === null) {
    return state("unknown", "競合を確認中", "warn", "GitHubが競合を計算中です。成功とは扱いません");
  }
  return state(
    "mergeable",
    "マージ可能",
    "ok",
    pullRequest.autoMergeEnabled ? "条件を満たしており、自動マージを待っています" : "CI・競合・レビューに止める理由はありません",
    { needsAction: !pullRequest.autoMergeEnabled },
  );
}

/**
 * リリース候補の有無（#4427）。**通常PRの代表状態・マージ判定には影響させない別軸。**
 * 候補が無いことは「リリース用チェックが未実施」という説明に使うだけで、新しいマージ条件にはしない。
 */
export type ReleaseCandidateScope =
  | { status: "loading" }
  | { status: "error" }
  | { status: "none" }
  | { status: "present"; number: number; headRef: string; version: string | null; headSha: string };

/** `release-main/v8.54.0`のようなブランチ名から版を取り出す。読めなければnull */
export function releaseVersionFromRef(headRef: string): string | null {
  const match = /^release-main\/(v\d+\.\d+\.\d+.*)$/.exec(headRef);
  return match ? match[1] : null;
}

export function describeReleaseCandidate(release: ReleaseCheckCells): ReleaseCandidateScope {
  if (release.candidate) {
    return {
      status: "present",
      number: release.candidate.number,
      headRef: release.candidate.headRef,
      version: releaseVersionFromRef(release.candidate.headRef),
      headSha: release.candidate.headSha,
    };
  }
  if (release.all.state === "取得中") return { status: "loading" };
  if (release.all.state === "取得不可") return { status: "error" };
  return { status: "none" };
}
