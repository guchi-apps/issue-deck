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

import {
  collectWorkflowTags,
  dispatchPropagation,
  dispatchSharedFilePropagation,
} from "@/lib/github/workflow-tags";

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
  // ETagの条件付きGET（配布ワークフローのrun取得）が`headers.get`を読むため付ける。
  // etagを返さなければプロセス内キャッシュには入らず、テスト間で持ち越さない
  return { ok: true, status: 200, json: async () => body, headers: new Headers() };
}

/** 配布ワークフローの実行（`propagate-workflow-tag.yml`の最新run） */
function run(status: string, conclusion: string | null = null) {
  return {
    status,
    conclusion,
    html_url: "https://github.com/guchi-apps/issue-deck/actions/runs/1",
    created_at: "2026-08-15T10:00:00.000Z",
  };
}

type GraphqlCall = { query: string; variables: Record<string, unknown> };

/** `githubFetch`へ渡されたGraphQLのクエリと変数を読む */
function graphqlCalls(): GraphqlCall[] {
  return githubFetch.mock.calls
    .filter((call) => String(call[0]).endsWith("/graphql"))
    .map((call) => (call[2] as { body: GraphqlCall }).body);
}

type RouteHandlers = {
  tags?: string[] | null;
  entries?: Record<string, unknown[]>;
  /** リポジトリごとのopenなPR（更新PRの検知に使う） */
  pullRequests?: Record<string, { number: number; title: string; url: string }[]>;
  /** 配布ワークフローの最新run。省略すると「1度も動いていない」 */
  latestRun?: ReturnType<typeof run> | null;
  /** 配布元（issue-deckの`main`）の共有ファイルの本文（#2240）。省略すると読めなかった扱い */
  sharedFileSource?: string | null;
  /** リポジトリごとの共有ファイルの本文（#2240）。省略すると置かれていない扱い */
  sharedFiles?: Record<string, string | null>;
};

/**
 * GitHubの応答を組み立てる簡易ルータ。
 *
 * 実装が投げるのは「最新タグ」「リポジトリごとのTreeとopen PR」のGraphQL 2種類と、
 * 配布ワークフローの最新runを取るRESTだけ。クエリ文字列とURLで見分ける。
 * Treeの応答はエイリアス（`r0`・`r1`…）に対応付けて返す。
 */
function route(handlers: RouteHandlers) {
  return (url: string, _token: string, options?: { body?: GraphqlCall }) => {
    if (String(url).includes("/actions/workflows/")) {
      const runs = handlers.latestRun ? [handlers.latestRun] : [];
      return Promise.resolve(ok({ workflow_runs: runs }));
    }
    if (!String(url).endsWith("/graphql")) return Promise.resolve(ok({}));

    const body = options?.body;
    if (body?.query.includes("refPrefix")) {
      if (handlers.tags === null) return Promise.resolve(ok({ errors: [{ message: "boom" }] }));
      const nodes = (handlers.tags ?? []).map((name) => ({ name }));
      return Promise.resolve(ok({ data: { repository: { refs: { nodes } } } }));
    }

    // 配布する共有ファイルの本文（#2240）。配布元1リポジトリぶんなので、変数は添字なしの
    // `owner`・`name`になる（リポジトリごとの取得は`owner0`・`name0`…）
    if (body?.variables && "name" in body.variables) {
      const text = handlers.sharedFileSource ?? null;
      return Promise.resolve(
        ok({ data: { repository: { sf0: text === null ? null : { text } } } }),
      );
    }

    const data: Record<string, unknown> = {};
    const variables = body?.variables ?? {};
    for (const key of Object.keys(variables)) {
      const match = /^name(\d+)$/.exec(key);
      if (!match) continue;
      const index = match[1];
      const fullName = `${variables[`owner${index}`]}/${variables[`name${index}`]}`;
      const entries = handlers.entries?.[fullName] ?? [blob("claude-issue-dispatch.yml")];
      const nodes = handlers.pullRequests?.[fullName] ?? [];
      const sharedFile = handlers.sharedFiles?.[fullName] ?? null;
      data[`r${index}`] = {
        object: { entries },
        sf0: sharedFile === null ? null : { text: sharedFile },
        pullRequests: { nodes },
      };
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

  it("不足しているcallerを、同じ取得結果から割り出す（#1948・#1475）", async () => {
    // 参照タグの解析と同じTreeのentriesを使うため、追加のGitHub API呼び出しは要らない
    githubFetch.mockImplementation(
      route({
        tags: ["workflows/v12"],
        entries: {
          "guchi-apps/car-care": [
            blob("claude-issue-dispatch.yml"),
            blob("release-develop-to-main.yml", CALLER),
            blob("claude-ci-fix.yml", CALLER),
          ],
        },
      }),
    );

    const overview = await collectWorkflowTags("user-1");

    expect(overview.repositories[0]?.missingRepairWorkflows).toEqual([
      "claude-conflict-resolve.yml",
      "claude-pr-repair.yml",
      "claude-review-develop.yml",
    ]);
  });

  it("配布PRが既にあれば、それを結果に持たせる（#1948）", async () => {
    // 対象から外す判定に使う。除外しないと押すたびに2本目のPRが作られる
    githubFetch.mockImplementation(
      route({
        tags: ["workflows/v12"],
        pullRequests: {
          "guchi-apps/car-care": [
            {
              number: 12,
              title: "不足しているワークフローを追加する",
              url: "https://github.com/guchi-apps/car-care/pull/12",
            },
          ],
        },
      }),
    );

    const overview = await collectWorkflowTags("user-1");

    expect(overview.repositories[0]?.repairPullRequest?.number).toBe(12);
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
    // 最新タグ用の1本、配布する共有ファイルの本文用の1本（#2240）、
    // 3リポジトリぶんをまとめた1本だけ。**リポジトリが増えても増えるのは最後の1本の中身だけ**
    expect(graphqlCalls()).toHaveLength(3);
    // GraphQLの3本＋配布ワークフロー3種（タグ配布・不足callerの配布・共有ファイルの更新）の
    // 最新run（REST・ETagの条件付きGET）の3本
    expect(githubFetch.mock.calls).toHaveLength(6);
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

    const treeCalls = githubFetch.mock.calls.filter((call) => {
      // 配布ワークフローの最新runはRESTで、bodyを持たない。最新タグ（refPrefix）と
      // 配布する共有ファイルの本文（#2240。エイリアスが`sf`で始まる）は対象リポジトリを
      // 跨がないので数えない
      const body = (call[2] as { body?: GraphqlCall } | undefined)?.body;
      if (body === undefined) return false;
      return !body.query.includes("refPrefix") && body.query.includes("$owner0");
    });
    expect(treeCalls).toHaveLength(2);
    expect(treeCalls.map((call) => call[1])).toEqual(["token-42", "token-99"]);
  });

  it("対象リポジトリが無ければGitHubへ問い合わせない", async () => {
    repositoryFindMany.mockResolvedValue([]);

    const overview = await collectWorkflowTags("user-1");

    expect(overview).toEqual({
      latest: null,
      repositories: [],
      propagation: null,
      repairPropagation: null,
      sharedFilePropagation: null,
    });
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

    const result = await dispatchPropagation("user-1", true);

    expect(result).toMatchObject({
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
      auto_merge: "true",
    });
  });

  it("更新が必要なリポジトリが無ければ起動しない", async () => {
    // 何もしないrunが履歴に残ると紛らわしい
    githubFetch.mockImplementation(route({ tags: ["workflows/v11"] }));

    const result = await dispatchPropagation("user-1", true);

    expect(result.dispatched).toBe(false);
    const posts = githubFetch.mock.calls.filter((call) => String(call[0]).includes("/dispatches"));
    expect(posts).toHaveLength(0);
  });

  it("最新タグが分からなければ起動しない", async () => {
    // 全リポジトリを対象にしてしまうと、意図しない一斉配布になる
    githubFetch.mockImplementation(route({ tags: null }));

    const result = await dispatchPropagation("user-1", true);

    expect(result).toMatchObject({ dispatched: false, tag: null, repositories: [] });
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

    const result = await dispatchPropagation("user-1", true);

    // 最新タグと同じでも、prompts-ref がずれていれば配り直す必要がある
    expect(result.dispatched).toBe(true);
    expect(result.repositories).toEqual(["guchi-apps/car-care"]);
  });

  it("起動に失敗したら例外を投げる", async () => {
    withDispatch({ ok: false, status: 403, text: async () => "forbidden" });

    await expect(dispatchPropagation("user-1", true)).rejects.toThrow();
  });

  it("実行中なら起動しない（連続押下の防止）", async () => {
    // 起動は数秒で返るのにPRが出来上がるまでは数分かかる。画面のボタンを無効にするだけでは
    // リロード後・別のタブから押せてしまうため、サーバー側でも断る（#1602）
    withDispatch({ ok: true, status: 204 }, { latestRun: run("in_progress") });

    const result = await dispatchPropagation("user-1", true);

    expect(result).toMatchObject({ dispatched: false, reason: "running" });
    const posts = githubFetch.mock.calls.filter((call) => String(call[0]).includes("/dispatches"));
    expect(posts).toHaveLength(0);
  });

  it("直近の実行が完了していれば起動する", async () => {
    withDispatch({ ok: true, status: 204 }, { latestRun: run("completed", "success") });

    const result = await dispatchPropagation("user-1", true);

    expect(result.dispatched).toBe(true);
  });

  it("更新PRが既にopenのリポジトリは対象に含めない", async () => {
    // 含めると同じリポジトリへ2本目のIssueとPRが作られる
    withDispatch(
      { ok: true, status: 204 },
      {
        pullRequests: {
          "guchi-apps/car-care": [
            {
              number: 42,
              title: "共有ワークフローの参照をworkflows/v12へ上げる",
              url: "https://github.com/guchi-apps/car-care/pull/42",
            },
          ],
        },
      },
    );

    const result = await dispatchPropagation("user-1", true);

    expect(result).toMatchObject({ dispatched: false, reason: "no_targets" });
  });

  it("自動マージを外すとその指定で起動する", async () => {
    withDispatch({ ok: true, status: 204 });

    await dispatchPropagation("user-1", false);

    const post = githubFetch.mock.calls.find((call) => String(call[0]).includes("/dispatches"));
    expect((post?.[2] as { body: { inputs: Record<string, string> } }).body.inputs.auto_merge).toBe(
      "false",
    );
  });
});

describe("共有ファイルの検知（#2240）", () => {
  beforeEach(() => {
    repositoryFindMany.mockReset().mockResolvedValue([repo("guchi-apps/car-care")]);
    getInstallationToken.mockReset().mockResolvedValue("token");
    githubFetch.mockReset();
  });

  it("配布元と内容が違えば配布対象にする", async () => {
    githubFetch.mockImplementation(
      route({
        tags: ["workflows/v11"],
        sharedFileSource: "new\n",
        sharedFiles: { "guchi-apps/car-care": "old\n" },
      }),
    );

    const overview = await collectWorkflowTags("user-1");

    expect(overview.repositories[0]?.outdatedSharedFiles).toEqual([
      ".github/scripts/signaly-notify.sh",
    ]);
  });

  it("内容が同じならスキップする", async () => {
    githubFetch.mockImplementation(
      route({
        tags: ["workflows/v11"],
        sharedFileSource: "same\n",
        sharedFiles: { "guchi-apps/car-care": "same\n" },
      }),
    );

    const overview = await collectWorkflowTags("user-1");

    expect(overview.repositories[0]?.outdatedSharedFiles).toEqual([]);
  });

  it("置かれていないリポジトリは対象にしない", async () => {
    // 呼び出し側のステップが無いリポジトリへスクリプトだけ置いても誰も呼ばない
    githubFetch.mockImplementation(route({ tags: ["workflows/v11"], sharedFileSource: "new\n" }));

    const overview = await collectWorkflowTags("user-1");

    expect(overview.repositories[0]?.outdatedSharedFiles).toEqual([]);
  });

  it("配布元を読めなければ対象にしない", async () => {
    // ここを緩めると、取得が失敗しただけで全リポジトリが配布対象になる
    githubFetch.mockImplementation(
      route({ tags: ["workflows/v11"], sharedFiles: { "guchi-apps/car-care": "old\n" } }),
    );

    const overview = await collectWorkflowTags("user-1");

    expect(overview.repositories[0]?.outdatedSharedFiles).toEqual([]);
  });

  it("配布元は main から読む", async () => {
    // 配布ワークフローは`ref: main`で起動するため、developを基準にすると
    // 画面の件数と配られる中身が食い違う
    githubFetch.mockImplementation(route({ tags: ["workflows/v11"], sharedFileSource: "new\n" }));

    await collectWorkflowTags("user-1");

    const sourceCall = graphqlCalls().find((call) => "shared0" in call.variables);
    expect(sourceCall?.variables.shared0).toBe("main:.github/scripts/signaly-notify.sh");
  });

  it("配布先はデフォルトブランチから読む", async () => {
    githubFetch.mockImplementation(route({ tags: ["workflows/v11"], sharedFileSource: "new\n" }));

    await collectWorkflowTags("user-1");

    const treeCall = graphqlCalls().find((call) => "shared0_0" in call.variables);
    expect(treeCall?.variables.shared0_0).toBe("develop:.github/scripts/signaly-notify.sh");
  });
});

describe("dispatchSharedFilePropagation", () => {
  beforeEach(() => {
    repositoryFindMany.mockReset().mockResolvedValue([repo("guchi-apps/car-care")]);
    repositoryFindFirst.mockReset().mockResolvedValue({ installation: { installationId: 42 } });
    getInstallationToken.mockReset().mockResolvedValue("token");
    githubFetch.mockReset();
  });

  /** 検知（GraphQL）は成功させ、dispatch（REST POST）だけを差し替える */
  function withDispatch(dispatchResponse: unknown, handlers: Parameters<typeof route>[0] = {}) {
    const detect = route({
      tags: ["workflows/v11"],
      sharedFileSource: "new\n",
      sharedFiles: { "guchi-apps/car-care": "old\n" },
      ...handlers,
    });
    githubFetch.mockImplementation(
      (url: string, token: string, options?: { method?: string; body?: GraphqlCall }) => {
        if (String(url).includes("/dispatches")) return Promise.resolve(dispatchResponse);
        return detect(url, token, options);
      },
    );
  }

  it("古い配布物を持つリポジトリを対象に起動する", async () => {
    withDispatch({ ok: true, status: 204 });

    const result = await dispatchSharedFilePropagation("user-1");

    expect(result).toMatchObject({
      dispatched: true,
      targets: [
        { repository: "guchi-apps/car-care", files: [".github/scripts/signaly-notify.sh"] },
      ],
    });

    const post = githubFetch.mock.calls.find((call) => String(call[0]).includes("/dispatches"));
    expect(String(post?.[0])).toContain("propagate-shared-files.yml");
    // 配る中身も`main`のものを使う（画面が「古い」と判定した基準と揃える）
    expect((post?.[2] as { body: { ref: string } }).body.ref).toBe("main");
  });

  it("対象が無ければ起動しない", async () => {
    // 何もしないrunが履歴に残ると紛らわしい
    withDispatch({ ok: true, status: 204 }, { sharedFiles: { "guchi-apps/car-care": "new\n" } });

    const result = await dispatchSharedFilePropagation("user-1");

    expect(result).toMatchObject({ dispatched: false, reason: "no_targets" });
    expect(githubFetch.mock.calls.some((call) => String(call[0]).includes("/dispatches"))).toBe(
      false,
    );
  });

  it("実行中なら起動しない", async () => {
    // 起動は数秒で返るのにPRが出来上がるまでは数分かかる。画面のボタンを無効にするだけでは
    // リロード後・別のタブから押せてしまう
    withDispatch({ ok: true, status: 204 }, { latestRun: run("in_progress") });

    const result = await dispatchSharedFilePropagation("user-1");

    expect(result).toMatchObject({ dispatched: false, reason: "running" });
  });
});
