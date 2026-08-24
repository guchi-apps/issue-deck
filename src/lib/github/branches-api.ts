import { GithubApiError } from "@/lib/github/github-api-error";
import { githubGraphql } from "@/lib/github/graphql";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import type { BranchComparison } from "@/types/branch-flow";

/**
 * 1リポジトリあたりに存在を確認するブランチ数の上限。
 * 進行中のIssueの数だけ問い合わせる作りなので通常は数件で、上限に当たることはまずない。
 */
const MAX_BRANCH_LOOKUP = 60;

export type BranchRefLookup = {
  /** 存在を確認できたブランチ名（問い合わせた中の部分集合） */
  existingBranches: string[];
  /** `main`と`develop`の差分。どちらかのブランチが無いリポジトリではnull */
  developVsMain: BranchComparison | null;
};

type RefNode = { name: string } | null;
type GraphqlResult = {
  repository: ({ comparison: { compare: BranchComparison | null } | null } & Record<
    string,
    unknown
  >) | null;
};

/**
 * 「ブランチ」画面が要るブランチ情報を、リポジトリあたり1リクエストで取る（#1455）。
 *
 * **ブランチ一覧を列挙しない。** issue-deckのリポジトリには実際に670のブランチがあり
 * （マージ後の削除を自動化していないため`issue-*`が残り続ける）、RESTの一覧は
 * アルファベット順・1ページ100件なので、全部読むとリポジトリあたり7回かかるうえ、
 * 読めた範囲に何が入るかが名前の並び次第になる。得られるのも大半が「終わった作業の残骸」で、
 * 画面に出す意味が無い。
 *
 * 代わりに**知りたいブランチを名指しで問い合わせる**。GraphQLはエイリアスを並べれば
 * 1リクエストで何本でも引けるので、進行中のIssueのぶんだけ存在を確認すれば足りる
 * （「ブランチはあるがPRがまだ無い」を出すための判定）。`main...develop`の差分も
 * 同じクエリに相乗りさせている。
 */
export async function lookupBranchRefs(
  owner: string,
  repo: string,
  branchNames: string[],
  token: string,
): Promise<BranchRefLookup> {
  const targets = branchNames.slice(0, MAX_BRANCH_LOOKUP);

  // ブランチ名は外部から来た文字列なので、クエリ本文へ埋め込まずGraphQLの変数として渡す。
  const variableDeclarations = targets.map((_, index) => `$b${index}: String!`).join(", ");
  const refSelections = targets
    .map((_, index) => `b${index}: ref(qualifiedName: $b${index}) { name }`)
    .join("\n        ");

  const query = `
    query($owner: String!, $name: String!${variableDeclarations ? `, ${variableDeclarations}` : ""}) {
      repository(owner: $owner, name: $name) {
        comparison: ref(qualifiedName: "refs/heads/main") {
          compare(headRef: "develop") { aheadBy behindBy }
        }
        ${refSelections}
      }
    }
  `;

  const variables: Record<string, unknown> = { owner, name: repo };
  targets.forEach((branch, index) => {
    variables[`b${index}`] = `refs/heads/${branch}`;
  });

  const data = await githubGraphql<GraphqlResult>(
    token,
    query,
    variables,
    "branch refs",
    { permissionHint: "（リポジトリのContents/Metadataの読み取り権限が必要です）" },
  );

  const repository = data.repository;
  if (!repository) return { existingBranches: [], developVsMain: null };

  const existingBranches = targets.filter(
    (_, index) => (repository[`b${index}`] as RefNode) !== null,
  );

  return {
    existingBranches,
    developVsMain: repository.comparison?.compare ?? null,
  };
}

/**
 * ブランチの先端SHAを読む（#2294）。**ブランチが存在しなければ`null`。**
 *
 * 進捗の取り残し巡回（`progress-sweep-run.ts`）が「マージ済みPRの先端と現在のブランチの
 * 先端が一致するか」を確かめるのに使う。`develop-merge-sweep`ジョブだった頃の
 * `gh api repos/<repo>/git/ref/heads/issue-<番号>`にあたる。
 *
 * **404（＝マージ後に削除済み）は`null`を返して呼び出し側へ渡す。** 追加のpushが無い証拠
 * として扱うため、取得できなかった（他の失敗）と区別する必要がある。それ以外の失敗は
 * 例外にして、呼び出し側が次の巡回へ回せるようにする。
 */
export async function fetchBranchHeadSha(
  owner: string,
  repo: string,
  branch: string,
  token: string,
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const res = await githubFetch(url, token);
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const body: { object?: { sha?: unknown } } = await res.json().catch(() => ({}));
  return typeof body.object?.sha === "string" ? body.object.sha : null;
}

/** `compareBranches`の結果。`develop...issue-<番号>`の三点比較から取れるものだけを持つ */
export type BranchCompareResult = {
  /** headにあってbaseに無いコミット数 */
  aheadBy: number;
  /**
   * baseへ持ち込む変更のファイル数。**応答に`files`が無ければ`null`。**
   * 三点比較なので、これが0ならマージしても何も入らない（#2289）。
   */
  changedFiles: number | null;
  /** baseに無い最後のコミットの時刻（ISO8601）。取れなければ`null` */
  lastCommitAt: string | null;
};

/**
 * 2つのブランチを三点比較する（#2294）。取得できなければ`null`。
 *
 * 進捗の取り残し巡回が「developへ入っていないコミットが本当に残っているか」を確かめるのに
 * 使う。`gh api repos/<repo>/compare/develop...issue-<番号>`にあたる。
 */
export async function compareBranches(
  owner: string,
  repo: string,
  base: string,
  head: string,
  token: string,
): Promise<BranchCompareResult | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const res = await githubFetch(url, token);
  if (!res.ok) return null;
  const body: {
    ahead_by?: unknown;
    files?: unknown;
    commits?: { commit?: { committer?: { date?: unknown } } }[];
  } = await res.json().catch(() => ({}));
  if (typeof body.ahead_by !== "number") return null;
  const lastCommit = Array.isArray(body.commits) ? body.commits[body.commits.length - 1] : undefined;
  const lastCommitAt = lastCommit?.commit?.committer?.date;
  return {
    aheadBy: body.ahead_by,
    changedFiles: Array.isArray(body.files) ? body.files.length : null,
    lastCommitAt: typeof lastCommitAt === "string" ? lastCommitAt : null,
  };
}
