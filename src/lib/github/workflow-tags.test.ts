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

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function encode(text: string) {
  return { content: Buffer.from(text, "utf8").toString("base64") };
}

/** URLの形でレスポンスを出し分ける簡易ルータ */
function route(handlers: { tags?: unknown; list?: unknown; file?: unknown }) {
  return (url: string) => {
    if (url.includes("/tags?")) return Promise.resolve(handlers.tags ?? ok([]));
    if (url.includes("/contents/.github/workflows?")) return Promise.resolve(handlers.list ?? ok([]));
    return Promise.resolve(handlers.file ?? ok(encode(CALLER)));
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
      route({
        tags: ok([{ name: "workflows/v11" }, { name: "workflows/v12" }, { name: "v3.1.3" }]),
        list: ok([{ name: "claude-issue-dispatch.yml", type: "file" }]),
      }),
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
        tags: ok([{ name: "workflows/v12" }]),
        list: ok([{ name: "ci.yml", type: "file" }]),
        file: ok(encode("jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n")),
      }),
    );

    const overview = await collectWorkflowTags("user-1");

    expect(overview.repositories).toEqual([]);
  });

  it("ディレクトリと .yml 以外は読まない", async () => {
    githubFetch.mockImplementation(
      route({
        tags: ok([{ name: "workflows/v12" }]),
        list: ok([
          { name: "claude-issue-dispatch.yml", type: "file" },
          { name: "README.md", type: "file" },
          { name: "shared", type: "dir" },
        ]),
      }),
    );

    await collectWorkflowTags("user-1");

    const fileUrls = githubFetch.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/contents/.github/workflows/"));
    expect(fileUrls).toHaveLength(1);
    expect(fileUrls[0]).toContain("claude-issue-dispatch.yml");
  });

  it("タグ取得に失敗しても結果を返し、latest は null になる", async () => {
    // ここで全リポジトリを「古い」と表示すると、誤って一斉配布を促してしまう
    githubFetch.mockImplementation((url: string) => {
      if (url.includes("/tags?")) return Promise.resolve({ ok: false, status: 500 });
      if (url.includes("/contents/.github/workflows?")) {
        return Promise.resolve(ok([{ name: "claude-issue-dispatch.yml", type: "file" }]));
      }
      return Promise.resolve(ok(encode(CALLER)));
    });

    const overview = await collectWorkflowTags("user-1");

    expect(overview.latest).toBeNull();
    expect(overview.repositories[0]?.outdated).toBe(false);
  });

  it("同じインストールのトークンは取り直さない", async () => {
    repositoryFindMany.mockResolvedValue([
      repo("guchi-apps/car-care", 42),
      repo("guchi-apps/solitaire", 42),
    ]);
    githubFetch.mockImplementation(
      route({
        tags: ok([{ name: "workflows/v12" }]),
        list: ok([{ name: "claude-issue-dispatch.yml", type: "file" }]),
      }),
    );

    await collectWorkflowTags("user-1");

    expect(getInstallationToken).toHaveBeenCalledTimes(1);
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

  /** 検知（GET相当）は成功させ、dispatch（POST）だけを差し替える */
  function withDispatch(dispatchResponse: unknown) {
    githubFetch.mockImplementation((url: string, _token: string, options?: { method?: string }) => {
      if (options?.method === "POST") return Promise.resolve(dispatchResponse);
      if (url.includes("/tags?")) return Promise.resolve(ok([{ name: "workflows/v12" }]));
      if (url.includes("/contents/.github/workflows?")) {
        return Promise.resolve(ok([{ name: "claude-issue-dispatch.yml", type: "file" }]));
      }
      return Promise.resolve(ok(encode(CALLER)));
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

    const post = githubFetch.mock.calls.find(
      (call) => (call[2] as { method?: string } | undefined)?.method === "POST",
    );
    expect(String(post?.[0])).toContain("propagate-workflow-tag.yml/dispatches");
    // **対象は呼び出し側で決めて渡す。** ワークフロー側で再検知すると画面の表示とずれる
    expect((post?.[2] as { body: { inputs: Record<string, string> } }).body.inputs).toEqual({
      tag: "workflows/v12",
      repositories: '["guchi-apps/car-care"]',
    });
  });

  it("更新が必要なリポジトリが無ければ起動しない", async () => {
    // 何もしないrunが履歴に残ると紛らわしい
    githubFetch.mockImplementation((url: string) => {
      if (url.includes("/tags?")) return Promise.resolve(ok([{ name: "workflows/v11" }]));
      if (url.includes("/contents/.github/workflows?")) {
        return Promise.resolve(ok([{ name: "claude-issue-dispatch.yml", type: "file" }]));
      }
      return Promise.resolve(ok(encode(CALLER)));
    });

    const result = await dispatchPropagation("user-1");

    expect(result.dispatched).toBe(false);
    const posts = githubFetch.mock.calls.filter(
      (call) => (call[2] as { method?: string } | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(0);
  });

  it("最新タグが分からなければ起動しない", async () => {
    // 全リポジトリを対象にしてしまうと、意図しない一斉配布になる
    githubFetch.mockImplementation((url: string) => {
      if (url.includes("/tags?")) return Promise.resolve({ ok: false, status: 500 });
      if (url.includes("/contents/.github/workflows?")) {
        return Promise.resolve(ok([{ name: "claude-issue-dispatch.yml", type: "file" }]));
      }
      return Promise.resolve(ok(encode(CALLER)));
    });

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
    githubFetch.mockImplementation((url: string, _t: string, options?: { method?: string }) => {
      if (options?.method === "POST") return Promise.resolve({ ok: true, status: 204 });
      if (url.includes("/tags?")) return Promise.resolve(ok([{ name: "workflows/v12" }]));
      if (url.includes("/contents/.github/workflows?")) {
        return Promise.resolve(ok([{ name: "claude-issue-dispatch.yml", type: "file" }]));
      }
      return Promise.resolve(ok(encode(mismatched)));
    });

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
