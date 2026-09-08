import type { PullRequestLink } from "@/lib/github/pull-request-link";
import type { IssuePullRequest } from "@/types/pull-request";

/**
 * 取得したPRのうち、このIssueの対応PRとして表示してよいものだけを残す（#1339）。
 *
 * 対応PRの候補はIssueコメント中のPR URL（`lib/github/pull-request-link.ts`）から拾うため、
 * 「#1327を参考に」のような単なる言及も混ざる。1件（最新）だけを出していた頃は誤検出しても
 * 影響が限定的だったが、全件を並べるようになると無関係なPRがそのまま画面に出てしまう。
 *
 * そこでPR側から推定した対応Issue番号（`extractLinkedIssueNumber`）を突き合わせ、
 * **明確に別のIssueに紐づくPRだけ**を落とす。推定できなかった（`linkedIssueNumber`がnullの）
 * PRは残す。ブランチ名が`issue-<番号>`規約から外れているだけの正当な対応PRを、
 * 推定できないという理由で消さないため。
 */
export function selectIssuePullRequests(
  pullRequests: IssuePullRequest[],
  issueNumber: number,
): IssuePullRequest[] {
  return pullRequests
    .filter((pr) => pr.linkedIssueNumber === null || pr.linkedIssueNumber === issueNumber)
    .sort((a, b) => a.number - b.number);
}

/**
 * この対応PRにマージボタンを出してよいか。
 *
 * マージできるのはまだopenで、下書きでもマージ済みでもないPRだけ。CI実行中に押させない判定は
 * ボタン側（`IssueMergeButton`の`ciStatus`）が持つので、ここには含めない。
 *
 * **コンフリクトしているPR（`mergeable`が`false`）も外す**（#2145。PR画面の`canMergeFromDeck`と
 * 同じ扱い）。押してもGitHubが受け付けないため、ボタンを出しても失敗するだけになる。代わりに
 * 行にはコンフリクトのバッジが出る。`null`（GitHubが判定中・未取得）のときはボタンを出す——
 * 判定前を「コンフリクトあり」として扱わないため。
 */
export function canMergeIssuePullRequest(pullRequest: IssuePullRequest): boolean {
  return (
    pullRequest.state === "open" &&
    !pullRequest.draft &&
    !pullRequest.merged &&
    pullRequest.mergeable !== false
  );
}

/**
 * 数分で確定する状態か（#2145。旧`isIssuePullRequestSettling`）。
 *
 * CI実行中だけを見て止めていた頃は、**CIが通ったあとに動く状態が更新されなかった**。
 * コンフリクトの自動解消が走っている最中はCIが「通過」のまま止まるため、解消が終わっても
 * バッジは「自動解消中」のまま、マージボタンも出てこない（Issueを開き直すまで気付けない）。
 *
 * - `in_progress` … CIの結果がまだ確定していない
 * - 自動マージ可否の判定が`pending` … 判定が終わればマージボタンが押せるようになる（#1968）
 * - 自動修復が走っている … 終わればコンフリクトかCI失敗のどちらかが解消される（#2072）
 *
 * どれも数分で終わるため、`ISSUE_PULL_REQUEST_POLL_INTERVAL_MS`で追ってよい。
 * **コンフリクトはここに入れない**（誰かが直すまで残るので、間隔を分けて扱う。#2915）。
 */
function isSettlingSoon(pullRequest: IssuePullRequest): boolean {
  return (
    pullRequest.ciStatus === "in_progress" ||
    pullRequest.mergeJudgement.state === "pending" ||
    pullRequest.repairRun !== null
  );
}

/** 数分で確定する状態を追う間隔。CI・判定・自動修復の移り変わりに追随する（#2145） */
export const ISSUE_PULL_REQUEST_POLL_INTERVAL_MS = 20_000;

/**
 * コンフリクトだけが理由で取り直すときの間隔（#2915）。
 *
 * **打ち切りは置かない。** 何回・何分で諦める形にすると、そのあと解消されたときに
 * 「コンフリクトあり」が固まったままになり、直そうとしている不具合がそのまま戻ってくる。
 * 代わりに間隔を粗くして消費を抑える——コンフリクトの解消は自動でも数分、人が直すなら
 * それ以上かかるもので、1分あれば消えたことは十分早く分かる（Issue一覧がPR一覧を
 * 取り直す間隔`ISSUE_LIST_PULL_REQUEST_POLL_INTERVAL_MS`と同じ考え方）。
 */
export const ISSUE_PULL_REQUEST_CONFLICT_POLL_INTERVAL_MS = 60_000;

/**
 * 対応PRを取り直す間隔（#2915）。`null`＝取り直さない（＝状態が確定した）。
 *
 * `use-issue-pull-requests.ts`の「まだ動きうるなら取り直し、確定したら自分で止める」を
 * 純粋関数に出したもの。**間隔を2段に分ける**のは、コンフリクトだけが数分で確定しないため。
 *
 * **コンフリクトを`repairRun`で代用できない**（#2915）。修復runの行が立つのはissue-deckから
 * 起動した経路（画面のボタン・コンフリクト巡回）だけで、`claude-conflict-resolve.yml`が
 * GitHub側のイベント（`pull_request` / `schedule` / `workflow_run`）で自分から動いたときは
 * DBに何も残らない。その状態では「CI通過・判定済み・修復run無し」が揃うため、取り直しが
 * 止まったまま解消され、Issueを開き直すまで「コンフリクトあり」の赤いピルが残っていた。
 */
export function issuePullRequestPollIntervalMs(
  pullRequests: readonly IssuePullRequest[],
): number | null {
  if (pullRequests.some(isSettlingSoon)) return ISSUE_PULL_REQUEST_POLL_INTERVAL_MS;
  // `null`（GitHubが判定中・未取得）は数えない。表示（`ConflictBadge`）と同じく
  // `false`のときだけコンフリクトとして扱う
  if (pullRequests.some((pullRequest) => pullRequest.mergeable === false)) {
    return ISSUE_PULL_REQUEST_CONFLICT_POLL_INTERVAL_MS;
  }
  return null;
}

/** 対応PRの状態を表すラベル。画面の状態バッジに使う */
export type IssuePullRequestStateLabel = "draft" | "open" | "merged" | "closed";

export function issuePullRequestStateLabel(
  pullRequest: IssuePullRequest,
): IssuePullRequestStateLabel {
  if (pullRequest.merged) return "merged";
  if (pullRequest.state === "closed") return "closed";
  return pullRequest.draft ? "draft" : "open";
}

/**
 * 画面に出す対応PRのリンクだけを残す。
 *
 * 並びの正は`links`（コメント本文・timelineから得たPR番号）だが、詳細が1件でも取れている場合は
 * 無関係PRを落とす絞り込み（`selectIssuePullRequests`）を通った`pullRequests`のほうを正とする。
 * 一覧の描画（`IssuePullRequestList`）と、セクションを出すかどうかの判定（#1577）で同じ結果に
 * なる必要があるため、判定をここに一本化している。
 */
export function selectVisiblePullRequestLinks(
  links: PullRequestLink[],
  pullRequests: IssuePullRequest[],
): PullRequestLink[] {
  if (pullRequests.length === 0) return links;
  const numbers = new Set(pullRequests.map((pullRequest) => pullRequest.number));
  return links.filter((link) => numbers.has(link.number));
}

/**
 * 対応PRがすべてマージ済みになったか（#2914）。マージ待ちの操作を出すのをやめる判定に使う。
 *
 * **画面上部の対応PRセクション（マージボタン・レビュー本文・修正依頼欄）と、コメント欄の
 * 承認カード（「マージしました」の案内）で同じ条件を使うためにここへ置く。** 判定を両方に
 * 書くと、押した直後にどちらか片方だけが切り替わる。
 *
 * **1件もマージしていない状態はfalse。** `mergedNumbers`は「この画面のボタンから押した」記録で、
 * 空のまま`every`を評価すると対応PRが0件のIssueまで「全部マージ済み」になる。
 */
export function areIssuePullRequestsAllMerged(
  links: PullRequestLink[],
  mergedNumbers: ReadonlySet<number>,
): boolean {
  return mergedNumbers.size > 0 && links.every((link) => mergedNumbers.has(link.number));
}

/** 畳んだ対応PRセクションの1行に出す内訳（#1577） */
export type IssuePullRequestSummary = {
  /** 対応PRの総数。並びの正である`links`の件数と一致する */
  total: number;
  /** 状態ごとの件数。0件の状態は含めず、`STATE_ORDER`の順に並ぶ */
  buckets: { state: IssuePullRequestStateLabel; count: number }[];
};

/** 内訳を出す順。進んだ状態ほど左に来るようにして、ざっと見て「どこまで進んだか」が分かるようにする */
const STATE_ORDER: IssuePullRequestStateLabel[] = ["merged", "open", "draft", "closed"];

/**
 * 対応PRを畳んだときに出す内訳（#1577）。
 *
 * **`total`は`linkCount`（コメント・timelineから拾ったPR番号の件数）を正とする。** 状態の内訳は
 * 詳細（`pullRequests`）が取れた分だけなので、取得前・取得失敗時は`buckets`が空になり件数だけが出る。
 * 詳細が取れていないことを理由に件数まで消すと、畳んだ行から対応PRの存在自体が見えなくなる。
 */
export function summarizeIssuePullRequestStates(
  pullRequests: IssuePullRequest[],
  linkCount: number,
): IssuePullRequestSummary {
  const counts = new Map<IssuePullRequestStateLabel, number>();
  for (const pullRequest of pullRequests) {
    const state = issuePullRequestStateLabel(pullRequest);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }

  return {
    total: linkCount,
    buckets: STATE_ORDER.filter((state) => (counts.get(state) ?? 0) > 0).map((state) => ({
      state,
      count: counts.get(state) ?? 0,
    })),
  };
}
