import { githubGraphql } from "@/lib/github/graphql";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

/**
 * 共通知識の格上げ判定を都度起動してよいか、起動前に候補の有無を確かめる（#4211）。**AIは呼ばない。**
 *
 * 判定対象の条件は`guchi-apps/docs`の`promote-knowledge.yml`（収集ステップ）に揃える。**正は向こう**で、
 * 変えたらここも変える。
 *
 * 1. `<!-- knowledge-candidate -->`のコメントが、判定済みマーカー`<!-- knowledge-promotion:judged -->`の
 *    付いた最後のコメントより**後**にある（判定済みのIssueに後から付いたメモも対象。Issue単位では除外しない）
 * 2. そのコメントの投稿者が`OWNER`/`MEMBER`/`COLLABORATOR`（publicリポジトリの第三者コメントは入力にしない）
 * 3. 実装がマージ済み（`issue-<番号>`ブランチのPRがマージ、またはIssueが`COMPLETED`でclose）
 *
 * 都度の判定で見るのは**最近更新された分だけ**（既定の巡回は日次cronが全件を見る）。取りこぼしは
 * 毎日05:00 JSTのGitHub側の回収が拾うので、ここで全件を舐めない。
 */

const ORG = "guchi-apps";
const BASE_QUERY = `org:${ORG} type:issue in:comments "knowledge-candidate"`;
const JUDGED_TERM = `"knowledge-promotion:judged"`;

export const CANDIDATE_MARKER = "<!-- knowledge-candidate -->";
export const JUDGED_MARKER = "<!-- knowledge-promotion:judged -->";

/** 判定済みのIssueのうち、再確認に回す更新日数（docsの`RECHECK_DAYS`と同じ） */
const RECHECK_DAYS = 14;
/** 1検索で見るIssue数。更新の新しい順なので、都度の契機になった直近の変更は先頭に来る */
const ISSUES_PER_SEARCH = 30;
/** 1Issueあたり読むコメント数（末尾から）。知見メモも判定も実装後に投稿される */
const COMMENTS_PER_ISSUE = 30;
/** マージ確認（PR検索）まで進めるIssue数の上限 */
const MERGE_CHECK_LIMIT = 20;

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type CandidateIssue = {
  repoFullName: string;
  number: number;
  state: string;
  stateReason: string | null;
  comments: { body: string; createdAt: string; authorAssociation: string }[];
};

/** 判定済みマーカーより後の、信頼できる投稿者の知見メモがあるか（docsの`MEMOS`の組み立てと同じ） */
export function hasUnjudgedMemo(issue: CandidateIssue): { hasMemo: boolean; hasJudged: boolean } {
  let judgedAt = "";
  let hasJudged = false;
  for (const comment of issue.comments) {
    if (comment.body.includes(JUDGED_MARKER)) {
      hasJudged = true;
      if (comment.createdAt > judgedAt) judgedAt = comment.createdAt;
    }
  }
  const hasMemo = issue.comments.some(
    (comment) =>
      TRUSTED_ASSOCIATIONS.has(comment.authorAssociation) &&
      comment.body.includes(CANDIDATE_MARKER) &&
      !comment.body.includes(JUDGED_MARKER) &&
      comment.createdAt > judgedAt,
  );
  return { hasMemo, hasJudged };
}

export type PromotionSkipReason =
  /** 知見メモが無い（検索が拾っただけで、コメントに実体が無いものを含む） */
  | "no_memo"
  /** 知見メモはあるが、すべて判定済みで新しいメモが無い */
  | "judged_only"
  /** 未判定のメモはあるが、実装がまだマージされていない（判定対象の条件を満たさない） */
  | "unmerged";

export type PromotionCandidateCheck =
  | { kind: "candidates"; count: number; issues: string[] }
  | { kind: "none"; reason: PromotionSkipReason; inspected: number }
  /** 確認そのものに失敗した。「候補なし」とは別物として扱う */
  | { kind: "failed"; message: string };

const SEARCH_QUERY = `
query PromotionCandidates($unjudged: String!, $rechecked: String!, $issues: Int!, $comments: Int!) {
  unjudged: search(query: $unjudged, type: ISSUE, first: $issues) { nodes { ...Fields } }
  rechecked: search(query: $rechecked, type: ISSUE, first: $issues) { nodes { ...Fields } }
}
fragment Fields on Issue {
  number
  state
  stateReason
  repository { nameWithOwner }
  comments(last: $comments) { nodes { body createdAt authorAssociation } }
}`;

type SearchNode = {
  number?: number;
  state?: string;
  stateReason?: string | null;
  repository?: { nameWithOwner: string };
  comments?: { nodes: { body: string; createdAt: string; authorAssociation: string }[] };
} | null;

type SearchResponse = {
  unjudged: { nodes: SearchNode[] };
  rechecked: { nodes: SearchNode[] };
};

/** 実装がマージ済みか。`COMPLETED`でcloseしたIssueか、`issue-<番号>`ブランチのマージ済みPRがあれば真 */
async function isImplementationMerged(issue: CandidateIssue, token: string): Promise<boolean> {
  if (issue.state === "CLOSED" && issue.stateReason === "COMPLETED") return true;
  const [owner, repo] = issue.repoFullName.split("/");
  const url =
    `${GITHUB_API}/repos/${owner}/${repo}/pulls` +
    `?head=${encodeURIComponent(`${owner}:issue-${issue.number}`)}&state=closed&per_page=10`;
  const res = await githubFetch(url, token);
  if (!res.ok) throw new Error(`PRの確認に失敗しました（${issue.repoFullName}#${issue.number}: HTTP ${res.status}）`);
  const pulls = (await res.json()) as { merged_at: string | null }[];
  return pulls.some((pull) => pull.merged_at);
}

/**
 * 判定対象になりうる知見メモが、今あるかを確かめる。例外は投げず、失敗は`failed`で返す。
 */
export async function checkPromotionCandidates(
  token: string,
  now: Date = new Date(),
): Promise<PromotionCandidateCheck> {
  try {
    const since = new Date(now.getTime() - RECHECK_DAYS * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const data = await githubGraphql<SearchResponse>(
      token,
      SEARCH_QUERY,
      {
        unjudged: `${BASE_QUERY} NOT ${JUDGED_TERM} sort:updated-desc`,
        rechecked: `${BASE_QUERY} ${JUDGED_TERM} updated:>=${since} sort:updated-desc`,
        issues: ISSUES_PER_SEARCH,
        comments: COMMENTS_PER_ISSUE,
      },
      "checkPromotionCandidates",
    );

    const seen = new Set<string>();
    const issues: CandidateIssue[] = [];
    for (const node of [...data.unjudged.nodes, ...data.rechecked.nodes]) {
      if (!node?.number || !node.repository) continue;
      const key = `${node.repository.nameWithOwner}#${node.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        repoFullName: node.repository.nameWithOwner,
        number: node.number,
        state: node.state ?? "",
        stateReason: node.stateReason ?? null,
        comments: node.comments?.nodes ?? [],
      });
    }

    let withMemo = 0;
    let judgedOnly = 0;
    const withMemoIssues: CandidateIssue[] = [];
    for (const issue of issues) {
      const { hasMemo, hasJudged } = hasUnjudgedMemo(issue);
      if (hasMemo) {
        withMemo += 1;
        withMemoIssues.push(issue);
      } else if (hasJudged) {
        judgedOnly += 1;
      }
    }

    const merged: string[] = [];
    for (const issue of withMemoIssues.slice(0, MERGE_CHECK_LIMIT)) {
      if (await isImplementationMerged(issue, token)) merged.push(`${issue.repoFullName}#${issue.number}`);
    }

    if (merged.length > 0) return { kind: "candidates", count: merged.length, issues: merged };
    if (withMemo > 0) return { kind: "none", reason: "unmerged", inspected: issues.length };
    return { kind: "none", reason: judgedOnly > 0 ? "judged_only" : "no_memo", inspected: issues.length };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
