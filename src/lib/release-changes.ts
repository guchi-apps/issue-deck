import {
  tallyChangeReviews,
  toPullRequestChanges,
  type PullRequestCommitSource,
} from "@/lib/pull-request-changes";
import { parsePullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import type { ReleaseVerificationTally } from "@/lib/github/release-verification";
import type {
  ReleaseChangeCiCheck,
  ReleaseChangeCommit,
  ReleaseChangePullRequest,
} from "@/types/pull-request";

/**
 * リリース差分のコミットを、PR単位の一覧へ畳む（#4201）。
 *
 * 件名の解析は`toPullRequestChanges`（リリースPRの確認ダイアログと同じ）を使う。差分に
 * 含まれるコミットだけから求めるので、Issueのopen/closedや進捗には依存せず、本番に
 * 反映済みのPR・未マージのPRは入りようが無い。
 *
 * - 同じPR番号は1行にまとめる（マージコミットとsquashコミットが両方拾えた場合の重複）
 * - PR番号を特定できないコミットは`unknownCommits`へ分ける。PRとして並べず、かといって
 *   捨てもしない（捨てると「PRに紐づかない変更が本番へ出る」ことが見えなくなる）
 */
export function toReleaseChanges(commits: readonly PullRequestCommitSource[]): {
  pullRequests: ReleaseChangePullRequest[];
  unknownCommits: ReleaseChangeCommit[];
} {
  const pullRequests: ReleaseChangePullRequest[] = [];
  const unknownCommits: ReleaseChangeCommit[] = [];
  const seen = new Set<number>();

  for (const change of toPullRequestChanges(commits)) {
    if (change.pullRequestNumber === null) {
      unknownCommits.push({ sha: change.id, title: change.title });
      continue;
    }
    if (seen.has(change.pullRequestNumber)) continue;
    seen.add(change.pullRequestNumber);
    pullRequests.push({
      number: change.pullRequestNumber,
      title: change.title,
      issueNumber: change.issueNumber,
      isVersionBump: change.kind === "version-bump",
      // 本文は別に取得して`withReleaseReviews`で埋める
      review: null,
      prHeadSha: null,
      reviewUnavailable: false,
    });
  }

  return { pullRequests, unknownCommits };
}

/**
 * 各PRへ、取得したPR本文から読んだ判定を付ける（#4245）。
 *
 * `bodies`に無いPRは「本文を取得できなかった」として`reviewUnavailable`にする。**記録が無い
 * （本文に節が無い）こととは別**で、混ぜると取得の失敗が「記録なし」という穏やかな表示に
 * 化けて、見過ごした指摘が無いかを確かめる場で何も言わないことになる。バンプPRはレビューの
 * 対象ではないので取得も不可扱いもしない。
 */
export function withReleaseReviews(
  pullRequests: readonly ReleaseChangePullRequest[],
  bodies: ReadonlyMap<number, { body: string | null; headSha: string }>,
): ReleaseChangePullRequest[] {
  return pullRequests.map((pr) => {
    if (pr.isVersionBump) return pr;
    const found = bodies.get(pr.number);
    if (!found) return { ...pr, reviewUnavailable: true };
    return {
      ...pr,
      review: parsePullRequestReviewVerdict(found.body),
      prHeadSha: found.headSha,
    };
  });
}

/** 一覧の判定の内訳。`unavailable`は取得できなかったPR（`tallyChangeReviews`の分母には入れない） */
export function tallyReleaseReviews(
  pullRequests: readonly ReleaseChangePullRequest[],
): ReleaseVerificationTally & { unavailable: number } {
  const available = pullRequests.filter((pr) => !pr.reviewUnavailable);
  const tally = tallyChangeReviews(
    available.map((pr) => ({
      kind: pr.isVersionBump ? ("version-bump" as const) : ("issue" as const),
      reviewKind: pr.review?.reviewKind ?? "unknown",
    })),
  );
  return {
    ...tally,
    unavailable: pullRequests.filter((pr) => pr.reviewUnavailable).length,
  };
}

/** 修正系列のうち、取り込み済みの判定に使う列 */
export type ReleaseFixSeriesRow = {
  status: string;
  sourceKind: string;
  issueNumber: number;
  fixPrNumber: number | null;
  fixPrMergedAt: Date | null;
  /** `items[].pullRequests`（全体レビュー指摘の関連PR）を展開したもの */
  relatedPullRequests: readonly number[];
};

/**
 * 各PRへ、修正系列の修正PRが同じ一覧に取り込まれていることを付ける（#5175）。
 *
 * 条件: 全体レビュー指摘の系列（`review_finding`）・`stopped`/`superseded`でない・修正PRがマージ済み・
 * 修正PRが**同じ一覧に含まれる**・元PRが指摘の関連PRに含まれる。元PRの判定自体は変えない。
 */
export function withFixedBy(
  pullRequests: readonly ReleaseChangePullRequest[],
  series: readonly ReleaseFixSeriesRow[],
): ReleaseChangePullRequest[] {
  const inList = new Set(pullRequests.map((pr) => pr.number));
  const usable = series.filter(
    (s) =>
      s.sourceKind === "review_finding" &&
      s.status !== "stopped" &&
      s.status !== "superseded" &&
      s.fixPrNumber !== null &&
      s.fixPrMergedAt !== null &&
      inList.has(s.fixPrNumber),
  );
  return pullRequests.map((pr) => {
    if (pr.isVersionBump) return pr;
    const found = usable.find((s) => s.fixPrNumber !== pr.number && s.relatedPullRequests.includes(pr.number));
    if (!found || found.fixPrNumber === null) return pr;
    return { ...pr, fixedBy: { fixPrNumber: found.fixPrNumber, fixIssueNumber: found.issueNumber } };
  });
}

/** GitHubのチェック集約（`statusCheckRollup.state`）を5チェックのCIの記録へ写す。無ければ`none` */
export function toReleaseChangeCi(rollupState: string | null | undefined): ReleaseChangeCiCheck {
  switch (rollupState) {
    case "success":
      return { state: "success" };
    case "pending":
    case "expected":
      return { state: "pending" };
    case "failure":
    case "error":
      return { state: "failure" };
    default:
      return { state: "none" };
  }
}

/**
 * 6チェック用の追加取得（個別PRのCI）の結果を各PRへ付ける（#4305・#4366。計画レビューはPRのチェックに含めない）。
 *
 * **取れなかったものは`unavailable`にする**（成功へ倒さない）。バージョンバンプPRはレビュー・CIの対象ではないので触らない。
 */
export function withMergeChecks(
  pullRequests: readonly ReleaseChangePullRequest[],
  ci: ReadonlyMap<number, ReleaseChangeCiCheck>,
): ReleaseChangePullRequest[] {
  return pullRequests.map((pr) => {
    if (pr.isVersionBump) return pr;
    return {
      ...pr,
      mergeChecks: { ci: ci.get(pr.number) ?? { state: "unavailable" } },
    };
  });
}
