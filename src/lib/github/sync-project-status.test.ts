import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repositoryFindMany = vi.fn();
const issueFindMany = vi.fn();
const issueUpdateMany = vi.fn();
const getInstallationToken = vi.fn();
const fetchProjectItems = vi.fn();
const fetchProjectStatusField = vi.fn();
const updateProjectItemStatus = vi.fn();
const addProjectItem = vi.fn();
const fetchOpenIssueNodes = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findMany() {
        return repositoryFindMany;
      },
    },
    issue: {
      get findMany() {
        return issueFindMany;
      },
      get updateMany() {
        return issueUpdateMany;
      },
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/projects-api", () => ({
  get fetchProjectItems() {
    return fetchProjectItems;
  },
  get fetchProjectStatusField() {
    return fetchProjectStatusField;
  },
  get updateProjectItemStatus() {
    return updateProjectItemStatus;
  },
  get addProjectItem() {
    return addProjectItem;
  },
  get fetchOpenIssueNodes() {
    return fetchOpenIssueNodes;
  },
}));

import { addMissingProjectItems } from "@/lib/github/sync-project-status";

const STATUS_FIELD = {
  projectId: "PVT_1",
  fieldId: "PVTSSF_1",
  optionIdByName: new Map([
    ["Planning", "opt-planning"],
    ["Implementation", "opt-impl"],
    ["Develop", "opt-develop"],
    ["Ready", "opt-ready"],
  ]),
};

function item(issueNumber: number, status: string | null) {
  return { itemId: `item-${issueNumber}`, repositoryDatabaseId: 100, issueNumber, status };
}

describe("addMissingProjectItems", () => {
  const REPO = { githubRepositoryId: 100, ownerLogin: "guchi-apps", name: "dayspan" };

  beforeEach(() => {
    process.env.PROJECT_V2_OWNER = "guchi-apps";
    process.env.PROJECT_V2_NUMBER = "1";

    repositoryFindMany.mockReset().mockResolvedValue([REPO]);
    issueFindMany.mockReset().mockResolvedValue([]);
    issueUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    getInstallationToken.mockReset().mockResolvedValue("token");
    fetchProjectItems.mockReset().mockResolvedValue([]);
    fetchProjectStatusField.mockReset().mockResolvedValue(STATUS_FIELD);
    updateProjectItemStatus.mockReset().mockResolvedValue(undefined);
    addProjectItem.mockReset();
    fetchOpenIssueNodes.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    delete process.env.PROJECT_V2_OWNER;
    delete process.env.PROJECT_V2_NUMBER;
  });

  it("盤面に無いopenなIssueを追加し、StatusをReadyにする", async () => {
    fetchOpenIssueNodes.mockResolvedValue([{ number: 5, nodeId: "I_5" }]);
    addProjectItem.mockResolvedValue({
      itemId: "item-5",
      repositoryDatabaseId: 100,
      issueNumber: 5,
      status: null,
    });

    const result = await addMissingProjectItems(42);

    expect(result).toEqual({ added: 1, skipped: false });
    expect(addProjectItem).toHaveBeenCalledWith("PVT_1", "I_5", "token");
    // 追加直後がStatus未設定のままだと、Readyからの遷移を条件にする起動（Phase 3）が働かない
    expect(updateProjectItemStatus).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "item-5", optionId: "opt-ready" }),
      "token",
    );
  });

  it("既に盤面にあるIssueは追加しない", async () => {
    fetchOpenIssueNodes.mockResolvedValue([{ number: 5, nodeId: "I_5" }]);
    fetchProjectItems.mockResolvedValue([item(5, "Implementation")]);

    const result = await addMissingProjectItems(42);

    expect(result).toEqual({ added: 0, skipped: false });
    expect(addProjectItem).not.toHaveBeenCalled();
  });

  it("追加時にStatusが既に入っていれば書き換えない", async () => {
    fetchOpenIssueNodes.mockResolvedValue([{ number: 5, nodeId: "I_5" }]);
    addProjectItem.mockResolvedValue({
      itemId: "item-5",
      repositoryDatabaseId: 100,
      issueNumber: 5,
      status: "Ready",
    });

    await addMissingProjectItems(42);

    expect(updateProjectItemStatus).not.toHaveBeenCalled();
  });

  it("マルチエージェント対応リポジトリ・アーカイブ済みでないものだけを対象にする", async () => {
    await addMissingProjectItems(42);

    expect(repositoryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ hasClaudeWorkflow: true, archived: false }),
      }),
    );
  });

  it("環境変数が未設定ならGitHubへ問い合わせずskippedを返す", async () => {
    delete process.env.PROJECT_V2_NUMBER;

    const result = await addMissingProjectItems(42);

    expect(result).toEqual({ added: 0, skipped: true });
    expect(getInstallationToken).not.toHaveBeenCalled();
  });
});
