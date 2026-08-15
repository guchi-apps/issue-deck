import { githubGraphql } from "@/lib/github/graphql";
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
