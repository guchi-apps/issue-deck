import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryFindMany = vi.fn();
const getInstallationToken = vi.fn();
const githubFetch = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findMany() {
        return repositoryFindMany;
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

import { collectWorkflowTags } from "@/lib/github/workflow-tags";

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
