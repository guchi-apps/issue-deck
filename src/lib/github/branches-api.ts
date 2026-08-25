import { GithubApiError } from "@/lib/github/github-api-error";
import { githubGraphql } from "@/lib/github/graphql";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import { isVersionBumpHeadRef } from "@/lib/pull-request-list";
import type { BranchComparison, UnreleasedUnits } from "@/types/branch-flow";

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

/**
 * 比較のコミットを1リクエストで読む上限（GraphQLのconnectionの上限と同じ100）。
 * これを超える比較では件数のグルーピングを諦め、従来どおりコミット数を出す。
 */
const MAX_COMPARE_COMMITS = 100;

type RefNode = { name: string } | null;
/** `compare`が返すコミット。tree OIDが取れないケース（targetがCommitでない）を許す */
type CompareTarget = { oid?: string | null; tree?: { oid?: string | null } | null } | null;
/** `compare`が返すコミット1件。first-parentをたどるのに親のOIDまで見る（#2333） */
type CompareCommit = {
  oid?: string | null;
  messageHeadline?: string | null;
  parents?: { totalCount?: number | null; nodes?: ({ oid?: string | null } | null)[] | null } | null;
};
type CompareNode = {
  aheadBy: number;
  behindBy: number;
  baseTarget: CompareTarget;
  headTarget: CompareTarget;
  commits?: { totalCount?: number | null; nodes?: (CompareCommit | null)[] | null } | null;
} | null;

type GraphqlResult = {
  repository: ({ comparison: { compare: CompareNode } | null } & Record<
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
          compare(headRef: "develop") {
            aheadBy
            behindBy
            # 「未リリース ◯コミット」をコミット数ではなく中身の差分で判定するために取る
            # （#2316）。baseはこのref（main）、headはdevelop。同じ1リクエストに乗るので
            # GitHub APIの消費は増えない。
            baseTarget { ... on Commit { tree { oid } } }
            # headのOIDはfirst-parentをたどる起点（#2333）。tree OIDとは別物なので両方取る。
            headTarget { ... on Commit { oid tree { oid } } }
            # 「未リリース ◯件」をマージコミット単位で数えるためのコミット一覧（#2333）。
            # 親のOIDまで取るのは、developの幹（first-parent）に載った単位だけを数えるため。
            commits(first: ${MAX_COMPARE_COMMITS}) {
              totalCount
              nodes {
                oid
                messageHeadline
                parents(first: 2) { totalCount nodes { oid } }
              }
            }
          }
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
    developVsMain: toBranchComparison(repository.comparison?.compare ?? null),
  };
}

/**
 * `compare`の応答を`BranchComparison`へ落とす（#2316）。
 *
 * **tree OIDが両方取れて一致したときだけ`sameContent: true`。** 取れなかった場合は
 * false（＝差分があるものとして扱う）へ倒し、取得の失敗でリリースを止めないようにする。
 */
function toBranchComparison(compare: CompareNode): BranchComparison | null {
  if (!compare) return null;
  const baseTree = compare.baseTarget?.tree?.oid ?? null;
  const headTree = compare.headTarget?.tree?.oid ?? null;
  return {
    aheadBy: compare.aheadBy,
    behindBy: compare.behindBy,
    sameContent: baseTree !== null && baseTree === headTree,
    units: toUnreleasedUnits(compare),
  };
}

/**
 * マージコミットのメッセージから、取り込んだブランチ名を読む（#2333）。読めなければ`null`。
 *
 * バージョンバンプのマージ（`release/vX.Y.Z`→`develop`）を件数の本体から外すためだけに使う。
 * `associatedPullRequests`を引けば確実だが、コミット100件ぶんのネストした問い合わせになり
 * 1画面ぶんの取得コストが跳ね上がるため、既定のマージコミットメッセージを読む方を採る。
 */
export function mergedHeadRefFromHeadline(headline: string): string | null {
  // GitHubのマージボタン: `Merge pull request #123 from owner/branch`
  const viaPullRequest = /^Merge pull request #\d+ from [^\s/]+\/(\S+)/.exec(headline);
  if (viaPullRequest) return viaPullRequest[1];
  // 手元での`git merge`: `Merge branch 'branch' into develop`
  const viaGit = /^Merge branch '([^']+)'/.exec(headline);
  return viaGit ? viaGit[1] : null;
}

/**
 * `main..develop`をfirst-parentでたどって「実質的な未リリースの件数」を数える（#2333）。
 *
 * **たどるのはdevelopの先端からで、比較のコミット一覧は「そこに含まれるか」の集合として
 * しか使わない。** 一覧の並び順（GitHubは古い順で返す）に依存せず、幹から枝へ降りた
 * コミット（PRの作業コミット）を確実に落とせる。`git log --first-parent main..develop`と
 * 同じ数になる。
 *
 * 数えられない場合は`null`を返し、呼び出し側は従来どおりコミット数を出す。
 */
function toUnreleasedUnits(compare: NonNullable<CompareNode>): UnreleasedUnits | null {
  const nodes = compare.commits?.nodes ?? null;
  if (!nodes) return null;
  // 取得上限を超えた比較では、先端側のコミットが一覧に入っていない可能性がある。
  // 数え落としたまま「◯件」と言い切るより、コミット数へ落とすほうが害が小さい。
  if ((compare.commits?.totalCount ?? nodes.length) > nodes.length) return null;

  const byOid = new Map<string, CompareCommit>();
  for (const node of nodes) {
    if (node?.oid) byOid.set(node.oid, node);
  }

  let cursor: string | null = compare.headTarget?.oid ?? null;
  if (!cursor || !byOid.has(cursor)) return null;

  const units: UnreleasedUnits = { mergeCount: 0, directCount: 0, versionBumpCount: 0 };
  const visited = new Set<string>();
  while (cursor && byOid.has(cursor) && !visited.has(cursor)) {
    visited.add(cursor);
    const commit: CompareCommit = byOid.get(cursor)!;
    const parents = commit.parents?.nodes ?? [];
    const parentCount = commit.parents?.totalCount ?? parents.length;
    if (parentCount >= 2) {
      const headRef = mergedHeadRefFromHeadline(commit.messageHeadline ?? "");
      if (headRef !== null && isVersionBumpHeadRef(headRef)) units.versionBumpCount += 1;
      else units.mergeCount += 1;
    } else {
      units.directCount += 1;
    }
    cursor = parents[0]?.oid ?? null;
  }

  return units;
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
