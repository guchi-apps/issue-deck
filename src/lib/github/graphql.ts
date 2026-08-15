import { GithubApiError } from "@/lib/github/github-api-error";
import { githubFetch, GITHUB_API } from "@/lib/github/request";

/**
 * GitHub GraphQL APIの共通入口。RESTで扱えない領域（Projects v2・サブIssue）が複数できたため、
 * `projects-api.ts`が持っていた実装をここへ切り出した。
 *
 * `issues-api.ts`の`deleteIssue`・`transferIssue`と同じ流儀で、HTTPレベルの失敗と
 * GraphQLの`errors`の両方を`GithubApiError`へ寄せる。**HTTP 200でも`errors`があれば失敗**
 * として扱うのがGraphQLの仕様で、ここを素通しにすると権限不足が静かに空データになる。
 */

type GraphqlResponse<T> = {
  data?: T;
  errors?: { message: string }[];
};

/** 権限不足のエラーメッセージ。必要な権限のヒントを添える判定に使う */
const NOT_ACCESSIBLE = "Resource not accessible by integration";

export type GraphqlOptions = {
  /**
   * 権限不足（`Resource not accessible by integration`）だったときにメッセージへ添える一文。
   * 必要な権限は呼び出す領域ごとに違う（Projects v2ならorganization permission、
   * サブIssueならIssuesのread）ため、共通化せず呼び出し側から渡す。
   */
  permissionHint?: string;
  /**
   * `data`が返っていれば`errors`があっても失敗にしない（既定はfalse＝全体を失敗にする）。
   *
   * **1クエリで複数リポジトリをエイリアスで並べる問い合わせ向け。** GraphQLは一部の
   * エイリアスだけが解決できなかった場合、そのエイリアスを`null`にした`data`と`errors`を
   * 同時に返す（DBに残っているが削除済みのリポジトリなど）。既定のまま全体を失敗にすると、
   * 1件の欠けで一覧そのものが出なくなるため、まとめ取りの呼び出し側だけがこれを立てる。
   */
  allowPartialData?: boolean;
};

/**
 * GraphQLを実行する。`operationLabel`は失敗時のメッセージに出す操作名。
 */
export async function githubGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  operationLabel: string,
  options: GraphqlOptions = {},
): Promise<T> {
  const res = await githubFetch(`${GITHUB_API}/graphql`, token, {
    method: "POST",
    body: { query, variables },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub GraphQL request failed: ${res.status} ${detail}`);
  }

  const json: GraphqlResponse<T> = await res.json();
  if (json.errors?.length && json.data && options.allowPartialData) {
    const message = json.errors.map((error) => error.message).join("; ");
    console.warn(`[githubGraphql] ${operationLabel}: 一部を取得できませんでした: ${message}`);
    return json.data;
  }
  if (json.errors?.length || !json.data) {
    const message = json.errors?.map((error) => error.message).join("; ") ?? "unknown error";
    // 権限不足はここに出るため、原因を切り分けやすいようヒントを添える
    const hint = options.permissionHint && message.includes(NOT_ACCESSIBLE) ? options.permissionHint : "";
    throw new GithubApiError(403, `GitHub GraphQL ${operationLabel} failed: ${message}${hint}`);
  }
  return json.data;
}
