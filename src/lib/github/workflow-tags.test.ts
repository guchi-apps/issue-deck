import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryFindMany = vi.fn();
const getInstallationToken = vi.fn();
const githubFetch = vi.fn();

const repositoryFindFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findMany() {
        return repositoryFindMany;
      },
      get findFirst() {
        return repositoryFindFirst;
      },
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/request", () => ({
  GITHUB_API: "https://api.github.com",
  get githubFetch() {
    return githubFetch;
  },
}));

import { collectWorkflowTags, dispatchPropagation } from "@/lib/github/workflow-tags";

function repo(fullName: string, installationId = 42) {
  const [ownerLogin, name] = fullName.split("/");
  return {
    fullName,
    ownerLogin,
    name,
    defaultBranch: "develop",
    installation: { installationId },
  };
}

const CALLER = `jobs:
  dispatch:
    uses: guchi-apps/issue-deck/.github/workflows/reusable-issue-dispatch.yml@workflows/v11
    with:
      prompts-ref: workflows/v11
`;

/** GraphQLのTreeエントリ（ファイル1件ぶん） */
function blob(name: string, text: string | null = CALLER) {
  return { name, type: "blob", object: text === null ? null : { text } };
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

type GraphqlCall = { query: string; variables: Record<string, unknown> };

/** `githubFetch`へ渡されたGraphQLのクエリと変数を読む */
function graphqlCalls(): GraphqlCall[] {
  return githubFetch.mock.calls
    .filter((call) => String(call[0]).endsWith("/graphql"))
    .map((call) => (call[2] as { body: GraphqlCall }).body);
}

/**
 * GraphQLの応答を組み立てる簡易ルータ。
 *
 * 実装は「最新タグ」と「リポジトリごとのTree」の2種類のクエリしか投げないため、
 * クエリ文字列で見分ける。Treeの応答はエイリアス（`r0`・`r1`…）に対応付けて返す。
 */
function route(handlers: { tags?: string[] | null; entries?: Record<string, unknown[]> }) {
  return (url: string, _token: string, options?: { body?: GraphqlCall }) => {
    if (!String(url).endsWith("/graphql")) return Promise.resolve(ok({}));

    const body = options?.body;
    if (body?.query.includes("refPrefix")) {
      if (handlers.tags === null) return Promise.resolve(ok({ errors: [{ message: "boom" }] }));
      const nodes = (handlers.tags ?? []).map((name) => ({ name }));
      return Promise.resolve(ok({ data: { repository: { refs: { nodes } } } }));
    }

    const data: Record<string, unknown> = {};
    const variables = body?.variables ?? {};
    for (const key of Object.keys(variables)) {
      const match = /^name(\d+)$/.exec(key);
      if (!match) continue;
      const index = match[1];
      const fullName = `${variables[`owner${index}`]}/${variables[`name${index}`]}`;
      const entries = handlers.entries?.[fullName] ?? [blob("claude-issue-dispatch.yml")];
      data[`r${index}`] = { object: { entries } };
    }
    return Promise.resolve(ok({ data }));
  };
}

describe("collectWorkflowTags", () => {
  beforeEach(() => {
    repositoryFindMany.mockReset().mockResolvedValue([repo("guchi-apps/car-care")]);
    getInstallationToken.mockReset().mockResolvedValue("token");
    githubFetch.mockReset();
  });

  it("最新タグと各リポジトリの参照タグを返す", async () => {
    githubFetch.mockImplementation(
      route({ tags: ["workflows/v11", "workflows/v12", "v3.1.3"] }),
    );

    const overview = await collectWorkflowTags("user-1");

    expect(overview.latest).toBe("workflows/v12");
    expect(overview.repositories).toHaveLength(1);
    expect(overview.repositories[0]).toMatchObject({
      fullName: "guchi-apps/car-care",
      outdated: true,
      mismatched: false,
    });
  });

  it("マルチエージェント対応・アーカイブ済みでないものだけを対象にする", async () => {
    githubFetch.mockImplementation(route({}));

    await collectWorkflowTags("user-1");

    expect(repositoryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ hasClaudeWorkflow: true, archived: false }),
      }),
    );
  });

  it("共有ワークフローを参照していないリポジトリは結果に含めない", async () => {
    // issue-deck自身はローカルパス参照（uses: ./...）でタグを持たないため、ここに該当する
    githubFetch.mockImplementation(
      route({
        tags: ["workflows/v12"],
        entries: {
          "guchi-apps/car-care": [
            blob("ci.yml", "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n"),
          ],
        },
      }),
    );

    const overview = await collectWorkflowTags("user-1");

    expect(overview.repositories).toEqual([]);
  });

  it("ディレクトリと .yml 以外は読まない", async () => {
    githubFetch.mockImplementation(
      route({
        tags: ["workflows/v12"],
        entries: {
          "guchi-apps/car-care": [
            blob("claude-issue-dispatch.yml"),
            // 拡張子が違う・Blobでないものを読むと、無関係な `uses:` を拾ってしまう
            blob("README.md", CALLER),
            { name: "shared", type: "tree", object: null },
          ],
        },
      }),
    );

    const overview = await collectWorkflowTags("user-1");

    expect(overview.repositories[0]?.refs.map((ref) => ref.file)).toEqual([
      "claude-issue-dispatch.yml",
    ]);
  });

  it("リポジトリ数ぶんの往復をしない（1クエリにまとめる）", async () => {
    // 元はリポジトリあたり 1 + ワークフロー数のRESTリクエストで、実測141回・42秒かかっていた（#1503）
    repositoryFindMany.mockResolvedValue([
      repo("guchi-apps/car-care"),
      repo("guchi-apps/solitaire"),
      repo("guchi-apps/dayspan"),
    ]);
    githubFetch.mockImplementation(route({ tags: ["workflows/v12"] }));

    const overview = await collectWorkflowTags("user-1");

    expect(overview.repositories).toHaveLength(3);
    // 最新タグ用の1本と、3リポジトリぶんをまとめた1本だけ
    expect(graphqlCalls()).toHaveLength(2);
    expect(githubFetch.mock.calls).toHaveLength(2);
  });

  it("タグ取得に失敗しても結果を返し、latest は null になる", async () => {
    // ここで全リポジトリを「古い」と表示すると、誤って一斉配布を促してしまう
    githubFetch.mockImplementation(route({ tags: null }));

    const overview = await collectWorkflowTags("user-1");

    expect(overview.latest).toBeNull();
    expect(overview.repositories[0]?.outdated).toBe(false);
  });

  it("一部のリポジトリが読めなくても残りを返す", async () => {
    // 削除済みリポジトリがDBに残っている場合、GraphQLはそのエイリアスだけnullにして
    // data と errors を同時に返す。全体を失敗にするとパネルごと出なくなる
    repositoryFindMany.mockResolvedValue([repo("guchi-apps/car-care"), repo("guchi-apps/gone")]);
    githubFetch.mockImplementation((url: string, _token: string, options?: { body?: GraphqlCall }) => {
      if (options?.body?.query.includes("refPrefix")) {
        return Promise.resolve(ok({ data: { repository: { refs: { nodes: [{ name: "workflows/v11" }] } } } }));
      }
      return Promise.resolve(
        ok({
          data: { r0: { object: { entries: [blob("claude-issue-dispatch.yml")] } }, r1: null },
          errors: [{ message: "Could not resolve to a Repository" }],
        }),
      );
    });

    const overview = await collectWorkflowTags("user-1");

    expect(overview.repositories.map((status) => status.fullName)).toEqual([
      "guchi-apps/car-care",
    ]);
  });

  it("同じインストールのトークンは取り直さない", async () => {
    repositoryFindMany.mockResolvedValue([
      repo("guchi-apps/car-care", 42),
      repo("guchi-apps/solitaire", 42),
    ]);
    githubFetch.mockImplementation(route({ tags: ["workflows/v12"] }));

    await collectWorkflowTags("user-1");

    expect(getInstallationToken).toHaveBeenCalledTimes(1);
  });

  it("インストールが違うリポジトリは同じクエリに混ぜない", async () => {
    // トークンはインストール単位。混ぜると片方が権限不足で落ちる
    repositoryFindMany.mockResolvedValue([
      repo("guchi-apps/car-care", 42),
      repo("other-org/app", 99),
    ]);
    getInstallationToken.mockImplementation(async (id: number) => `token-${id}`);
    githubFetch.mockImplementation(route({ tags: ["workflows/v11"] }));

    await collectWorkflowTags("user-1");

    const treeCalls = githubFetch.mock.calls.filter(
      (call) => !(call[2] as { body: GraphqlCall }).body.query.includes("refPrefix"),
    );
    expect(treeCalls).toHaveLength(2);
    expect(treeCalls.map((call) => call[1])).toEqual(["token-42", "token-99"]);
  });

  it("対象リポジトリが無ければGitHubへ問い合わせない", async () => {
    repositoryFindMany.mockResolvedValue([]);

    const overview = await collectWorkflowTags("user-1");

    expect(overview).toEqual({ latest: null, repositories: [] });
    expect(githubFetch).not.toHaveBeenCalled();
  });
});


describe("dispatchPropagation", () => {
  beforeEach(() => {
    repositoryFindMany.mockReset().mockResolvedValue([repo("guchi-apps/car-care")]);
    repositoryFindFirst
      .mockReset()
      .mockResolvedValue({ installation: { installationId: 42 } });
    getInstallationToken.mockReset().mockResolvedValue("token");
    githubFetch.mockReset();
  });

  /** 検知（GraphQL）は成功させ、dispatch（REST POST）だけを差し替える */
  function withDispatch(dispatchResponse: unknown, handlers: Parameters<typeof route>[0] = {}) {
    const detect = route({ tags: ["workflows/v12"], ...handlers });
    githubFetch.mockImplementation((url: string, token: string, options?: { method?: string; body?: GraphqlCall }) => {
      if (String(url).includes("/dispatches")) return Promise.resolve(dispatchResponse);
      return detect(url, token, options);
    });
  }

  it("古いリポジトリを対象にワークフローを起動する", async () => {
    withDispatch({ ok: true, status: 204 });

    const result = await dispatchPropagation("user-1");

    expect(result).toEqual({
      dispatched: true,
      tag: "workflows/v12",
      repositories: ["guchi-apps/car-care"],
    });

    const post = githubFetch.mock.calls.find((call) => String(call[0]).includes("/dispatches"));
    expect(String(post?.[0])).toContain("propagate-workflow-tag.yml/dispatches");
    // **対象は呼び出し側で決めて渡す。** ワークフロー側で再検知すると画面の表示とずれる
    expect((post?.[2] as { body: { inputs: Record<string, string> } }).body.inputs).toEqual({
      tag: "workflows/v12",
      repositories: '["guchi-apps/car-care"]',
    });
  });

  it("更新が必要なリポジトリが無ければ起動しない", async () => {
    // 何もしないrunが履歴に残ると紛らわしい
    githubFetch.mockImplementation(route({ tags: ["workflows/v11"] }));

    const result = await dispatchPropagation("user-1");

    expect(result.dispatched).toBe(false);
    const posts = githubFetch.mock.calls.filter((call) => String(call[0]).includes("/dispatches"));
    expect(posts).toHaveLength(0);
  });

  it("最新タグが分からなければ起動しない", async () => {
    // 全リポジトリを対象にしてしまうと、意図しない一斉配布になる
    githubFetch.mockImplementation(route({ tags: null }));

    const result = await dispatchPropagation("user-1");

    expect(result).toEqual({ dispatched: false, tag: null, repositories: [] });
  });

  it("uses と prompts-ref が不一致のリポジトリも対象にする", async () => {
    const mismatched = `jobs:
  dispatch:
    uses: guchi-apps/issue-deck/.github/workflows/reusable-issue-dispatch.yml@workflows/v12
    with:
      prompts-ref: workflows/v11
`;
    withDispatch(
      { ok: true, status: 204 },
      { entries: { "guchi-apps/car-care": [blob("claude-issue-dispatch.yml", mismatched)] } },
    );

    const result = await dispatchPropagation("user-1");

    // 最新タグと同じでも、prompts-ref がずれていれば配り直す必要がある
    expect(result.dispatched).toBe(true);
    expect(result.repositories).toEqual(["guchi-apps/car-care"]);
  });

  it("起動に失敗したら例外を投げる", async () => {
    withDispatch({ ok: false, status: 403, text: async () => "forbidden" });

    await expect(dispatchPropagation("user-1")).rejects.toThrow();
  });
});
