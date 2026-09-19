import type { ReviewVerdictKind } from "@/lib/github/release-verification";
import {
  pullRequestChangeLabel,
  tallyChangeReviews,
  type PullRequestChangeReview,
} from "@/lib/pull-request-changes";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 行1つの状態（#3093）。
 *
 * - `ok` … 問題なし（●）
 * - `warn` … 確認が必要（▲）
 * - `bad` … 止めるべき（■）
 * - `neutral` … 判定の対象外・まだ判定できない（–）。**危険信号ではなく、総合判定の件数にも数えない**
 */
export type MergePrecheckLevel = "ok" | "warn" | "bad" | "neutral";

export type MergePrecheckRow = {
  id: "ci" | "conflict" | "review";
  label: string;
  level: MergePrecheckLevel;
  /** 結果の要点（「成功」「要修正 1 ／ 問題なし 3」など） */
  summary: string;
  /** 結果の補足（該当PR・自動修復の実行中など）。無ければnull */
  detail: string | null;
};

/** 総合判定。`pending`は変更点の取得中でレビューの行がまだ決まっていない状態 */
export type MergePrecheckOverall = "ok" | "warn" | "bad" | "pending";

export type MergePrecheck = {
  rows: MergePrecheckRow[];
  overall: MergePrecheckOverall;
  /** 総合判定の見出し。「3項目すべて問題ありません」など */
  headline: string;
};

/**
 * 変更点（＝レビュー判定の材料）の取得状態。
 *
 * **取得できなかった場合はレビューの行を`neutral`にし、▲にはしない。** 判定を取得できなかった
 * ことは「確認が必要」ではなく「まだ言えることが無い」で、マージも止めない
 * （変更点は判断材料であって前提条件ではない。`PullRequestMergeChanges`と同じ立場）。
 */
export type MergePrecheckReviews =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; reviewed: readonly PullRequestChangeReview[] };

/** 判定に使うPRの項目。画面は`PullRequestSummary`をそのまま渡せる */
export type MergePrecheckSource = Pick<
  PullRequestSummary,
  "ciState" | "ciChecks" | "mergeable" | "repairRun"
>;

/** 補足に並べるPR番号の上限。超えた分は「ほかN件」にまとめる */
const DETAIL_LIST_LIMIT = 3;

function ciRow(pullRequest: MergePrecheckSource): MergePrecheckRow {
  const repairing = pullRequest.repairRun?.kind === "ci" ? "自動修正を実行中です" : null;
  switch (pullRequest.ciState) {
    case "success":
      return { id: "ci", label: "CI", level: "ok", summary: "成功", detail: null };
    case "pending":
      return { id: "ci", label: "CI", level: "warn", summary: "実行中", detail: repairing };
    case "failure": {
      const failed = pullRequest.ciChecks
        .filter((check) => check.conclusion === "failure")
        .map((check) => check.name);
      const names = failed.length > 0 ? `${failed.slice(0, DETAIL_LIST_LIMIT).join("・")}が失敗しています` : null;
      return {
        id: "ci",
        label: "CI",
        level: "bad",
        summary: "失敗",
        detail: [names, repairing].filter(Boolean).join("。") || null,
      };
    }
    default:
      return { id: "ci", label: "CI", level: "warn", summary: "確認できません", detail: repairing };
  }
}

function conflictRow(pullRequest: MergePrecheckSource): MergePrecheckRow {
  const repairing = pullRequest.repairRun?.kind === "conflict" ? "自動解消を実行中です" : null;
  // `null`はGitHubが判定中（draft・closedでは取得しない）。**「なし」として扱わない**
  if (pullRequest.mergeable === true) {
    return { id: "conflict", label: "コンフリクト", level: "ok", summary: "なし", detail: null };
  }
  if (pullRequest.mergeable === false) {
    return { id: "conflict", label: "コンフリクト", level: "bad", summary: "あり", detail: repairing };
  }
  return {
    id: "conflict",
    label: "コンフリクト",
    level: "warn",
    summary: "GitHubが判定中",
    detail: null,
  };
}

/** 並びは重い順（要修正 → 要確認 → 問題なし → 実施なし → 記録なし） */
const REVIEW_SUMMARY_ORDER: readonly { kind: ReviewVerdictKind; label: string }[] = [
  { kind: "changes-requested", label: "要修正" },
  { kind: "needs-check", label: "要確認" },
  { kind: "ok", label: "問題なし" },
  { kind: "skipped", label: "実施なし" },
  { kind: "unknown", label: "記録なし" },
];

function listPullRequests(changes: readonly PullRequestChangeReview[]): string {
  const labels = changes.map((change) => pullRequestChangeLabel(change) ?? change.title);
  const shown = labels.slice(0, DETAIL_LIST_LIMIT).join("・");
  return labels.length > DETAIL_LIST_LIMIT ? `${shown}ほか${labels.length - DETAIL_LIST_LIMIT}件` : shown;
}

function reviewRow(reviews: MergePrecheckReviews): MergePrecheckRow {
  const base = { id: "review" as const, label: "Claudeのレビュー" };
  if (reviews.status === "loading") {
    return { ...base, level: "neutral", summary: "確認しています…", detail: null };
  }
  if (reviews.status === "error") {
    return { ...base, level: "neutral", summary: "確認できません", detail: "変更点を取得できませんでした" };
  }

  const tally = tallyChangeReviews(reviews.reviewed);
  // 判定が1件も無い（自動レビューを持たないリポジトリなど）。**▲にしない**——何も問題が無くても
  // 毎回「確認が必要」になり、本当の指摘が埋もれる（`mergeWarnings`が「記録なし」で止めないのと同じ）。
  // 「記録なし」を▲にするのは、判定が1件でもあるリリースに限る
  if (tally.total === tally.unknown) {
    return { ...base, level: "neutral", summary: "自動レビューの記録がありません", detail: null };
  }

  const counts: Record<ReviewVerdictKind, number> = {
    "changes-requested": tally.changesRequested,
    "needs-check": tally.needsCheck,
    ok: tally.ok,
    skipped: tally.skipped,
    unknown: tally.unknown,
  };
  const summary = REVIEW_SUMMARY_ORDER.filter(({ kind }) => counts[kind] > 0)
    .map(({ kind, label }) => `${label} ${counts[kind]}`)
    .join(" ／ ");

  // バンプPRはレビューの対象ではないので、補足の対象にも入れない（`tallyChangeReviews`と同じ）
  const reviewable = reviews.reviewed.filter((change) => change.kind !== "version-bump");
  const pick = (kind: ReviewVerdictKind) => reviewable.filter((change) => change.reviewKind === kind);
  const details = [
    [pick("changes-requested"), "が要修正"],
    [pick("needs-check"), "が要確認"],
    [pick("unknown"), "は判定の記録がありません"],
  ] as const;
  const detail =
    details
      .filter(([changes]) => changes.length > 0)
      .map(([changes, phrase]) => `${listPullRequests(changes)}${phrase}`)
      .join("、") || null;

  const level: MergePrecheckLevel =
    tally.changesRequested > 0 ? "bad" : tally.needsCheck > 0 || tally.unknown > 0 ? "warn" : "ok";
  return { ...base, level, summary, detail };
}

/**
 * mainへのマージ確認ダイアログに出す「マージ前の確認」を組み立てる（#3093）。
 *
 * **判定はマージを止めない。** 押してよいかの材料を並べるだけで、最終判断は人が行う
 * （変更点は判断材料であって前提条件ではない、という既存の方針に揃える）。
 *
 * レビューの行は「レビューが終わったか」と「結果に問題が無いか」を1つにまとめている。
 * どちらもリリースPR本文の検証結果の表から作る同じ情報で、「記録なし」が未実行なのか
 * 取得失敗なのかも表からは区別できないため、別々の行にしても同じ表を2回読ませるだけになる。
 */
export function buildMergePrecheck(
  pullRequest: MergePrecheckSource,
  reviews: MergePrecheckReviews,
): MergePrecheck {
  const rows = [ciRow(pullRequest), conflictRow(pullRequest), reviewRow(reviews)];
  const bad = rows.filter((row) => row.level === "bad").length;
  const warn = rows.filter((row) => row.level === "warn").length;
  const counted = rows.filter((row) => row.level !== "neutral").length;

  if (bad > 0) {
    return { rows, overall: "bad", headline: `止めるべき項目があります（${bad}件）` };
  }
  if (warn > 0) {
    return { rows, overall: "warn", headline: `確認が必要な項目があります（${warn}件）` };
  }
  if (reviews.status === "loading") {
    return { rows, overall: "pending", headline: "レビューの結果を確認しています" };
  }
  return {
    rows,
    overall: "ok",
    // 判定の対象外の行（記録なし・取得失敗）があるときは「すべて」と言い切らない
    headline:
      counted === rows.length
        ? `${counted}項目すべて問題ありません`
        : `確認できた${counted}項目に問題はありません`,
  };
}
