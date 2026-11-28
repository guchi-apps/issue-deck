import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findSetting: vi.fn(),
  getAppAiToken: vi.fn(),
  generateIssueSuggestion: vi.fn(),
  suggestLabelsByJev: vi.fn(),
  addIssueLabels: vi.fn(),
  fetchRepoLabels: vi.fn(),
  updateIssue: vi.fn(),
  upsertIssueAndGetDisplay: vi.fn(),
  loadOwnedShareImages: vi.fn(),
  consumeShareImageUploads: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { appSetting: { findUnique: mocks.findSetting } } }));
vi.mock("@/lib/claude/request", () => ({ getAppAiToken: mocks.getAppAiToken }));
vi.mock("@/lib/claude/issue-suggest", () => ({
  generateIssueSuggestion: mocks.generateIssueSuggestion,
  suggestLabelsByJev: mocks.suggestLabelsByJev,
}));
vi.mock("@/lib/github/issues-api", () => ({
  addIssueLabels: mocks.addIssueLabels,
  createIssue: vi.fn(),
  fetchRepoLabels: mocks.fetchRepoLabels,
  updateIssue: mocks.updateIssue,
}));
vi.mock("@/lib/github/sync-issues", () => ({ upsertIssueAndGetDisplay: mocks.upsertIssueAndGetDisplay }));
vi.mock("@/lib/github/with-user-github-token", () => ({
  withUserGithubToken: async (_user: unknown, _context: string, fn: (token: string) => unknown) => ({
    value: await fn("gh-token"),
  }),
}));
vi.mock("@/lib/images/share-image-ownership", () => ({
  loadOwnedShareImages: mocks.loadOwnedShareImages,
  consumeShareImageUploads: mocks.consumeShareImageUploads,
}));

import { fillSharedIssueByAi } from "@/lib/github/issue-create-service";

const user = { id: "user-1", githubAccessToken: "x", githubRefreshToken: null };
const repository = { fullName: "owner/repo" } as Parameters<typeof fillSharedIssueByAi>[1];
const run = (title: string, body: string) => fillSharedIssueByAi(user, repository, { number: 7 }, { title, body });
const image = { filename: "a.png", mediaType: "image/png", data: "aGk=" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSetting.mockResolvedValue({ modelPickEngine: "jev" });
  mocks.getAppAiToken.mockResolvedValue("ai-token");
  mocks.fetchRepoLabels.mockResolvedValue([{ name: "30.bug", description: null }]);
  mocks.generateIssueSuggestion.mockResolvedValue({ kind: "issue", title: "AIの件名", labels: ["30.bug"] });
  mocks.updateIssue.mockResolvedValue({});
  mocks.loadOwnedShareImages.mockResolvedValue([]);
  mocks.consumeShareImageUploads.mockResolvedValue(undefined);
});

describe("fillSharedIssueByAi", () => {
  it("写真だけの共有は画像をAIへ渡してラベルとタイトルを書き込む", async () => {
    mocks.loadOwnedShareImages.mockResolvedValue([image]);

    await run("", "![image](https://example.test/api/issues/images/a.png)");

    expect(mocks.suggestLabelsByJev).not.toHaveBeenCalled();
    expect(mocks.generateIssueSuggestion).toHaveBeenCalledWith(
      "ai-token",
      { body: "", availableLabels: [{ name: "30.bug", description: null }] },
      { includeLabels: true, images: [image] },
    );
    expect(mocks.addIssueLabels).toHaveBeenCalledWith("owner", "repo", 7, "gh-token", ["30.bug"]);
    expect(mocks.updateIssue).toHaveBeenCalledWith("owner", "repo", 7, "gh-token", { title: "AIの件名" });
    expect(mocks.consumeShareImageUploads).toHaveBeenCalled();
  });

  it("タイトルがあり画像が無ければJevでラベルだけを付け、タイトルは変えない", async () => {
    mocks.suggestLabelsByJev.mockResolvedValue(["30.bug"]);

    await run("手入力の件名", "本文");

    expect(mocks.generateIssueSuggestion).not.toHaveBeenCalled();
    expect(mocks.addIssueLabels).toHaveBeenCalledWith("owner", "repo", 7, "gh-token", ["30.bug"]);
    expect(mocks.updateIssue).toHaveBeenCalledWith("owner", "repo", 7, "gh-token", {});
  });

  it("本文も本人の画像も無ければ何もしない", async () => {
    await run("", "![image](https://example.test/api/issues/images/a.png)");

    expect(mocks.generateIssueSuggestion).not.toHaveBeenCalled();
    expect(mocks.addIssueLabels).not.toHaveBeenCalled();
    expect(mocks.updateIssue).not.toHaveBeenCalled();
  });

  it("AIが失敗しても例外を投げず、Issueは変えない", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.suggestLabelsByJev.mockResolvedValue(null);
    mocks.generateIssueSuggestion.mockRejectedValue(new Error("失敗"));

    await expect(run("", "本文")).resolves.toBeUndefined();
    expect(mocks.updateIssue).not.toHaveBeenCalled();
  });
});
