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

import {
  addMissingProjectItems,
  closeStrandedProjectItems,
} from "@/lib/github/sync-project-status";

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
  const REPO = { id: "repo-1", githubRepositoryId: 100, ownerLogin: "guchi-apps", name: "dayspan" };

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
    // **DBへも書く（#1132）。** Projectだけ更新してDBをnullのままにすると、載せた直後の
    // 最初のドラッグが from = null になり、カンバン起点の起動が除外されてしまう
    expect(issueUpdateMany).toHaveBeenCalledWith({
      where: { repositoryId: "repo-1", number: 5 },
      data: { projectStatus: "Ready", projectItemId: "item-5" },
    });
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
    // Projectを書き換えないケースでも、DBにはその値を写しておく（#1132）
    expect(issueUpdateMany).toHaveBeenCalledWith({
      where: { repositoryId: "repo-1", number: 5 },
      data: { projectStatus: "Ready", projectItemId: "item-5" },
    });
  });

  it("追加できなかったIssueはDBへ書かない", async () => {
    fetchOpenIssueNodes.mockResolvedValue([{ number: 5, nodeId: "I_5" }]);
    addProjectItem.mockResolvedValue(null);

    const result = await addMissingProjectItems(42);

    expect(result).toEqual({ added: 0, skipped: false });
    expect(issueUpdateMany).not.toHaveBeenCalled();
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

describe("closeStrandedProjectItems", () => {
  const REPO = { id: "repo-1", githubRepositoryId: 100 };

  /** closedなIssueの盤面アイテム */
  function closedItem(issueNumber: number, status: string | null) {
    return { ...item(issueNumber, status), issueOpen: false };
  }

  const STATUS_FIELD_WITH_CLOSED = {
    ...STATUS_FIELD,
    optionIdByName: new Map([...STATUS_FIELD.optionIdByName, ["Closed", "opt-closed"]]),
  };

  beforeEach(() => {
    process.env.PROJECT_V2_OWNER = "guchi-apps";
    process.env.PROJECT_V2_NUMBER = "1";

    repositoryFindMany.mockReset().mockResolvedValue([REPO]);
    issueUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    getInstallationToken.mockReset().mockResolvedValue("token");
    fetchProjectItems.mockReset().mockResolvedValue([]);
    fetchProjectStatusField.mockReset().mockResolvedValue(STATUS_FIELD_WITH_CLOSED);
    updateProjectItemStatus.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.PROJECT_V2_OWNER;
    delete process.env.PROJECT_V2_NUMBER;
  });

  it("closedなのに実装中の3状態に残っているIssueを終端へ寄せ、DBも揃える", async () => {
    fetchProjectItems.mockResolvedValue([closedItem(70, "Implementation")]);

    const result = await closeStrandedProjectItems(42);

    expect(result).toEqual({ closed: 1, skipped: false });
    expect(updateProjectItemStatus).toHaveBeenCalledWith(
      { projectId: "PVT_1", itemId: "item-70", fieldId: "PVTSSF_1", optionId: "opt-closed" },
      "token",
    );
    expect(issueUpdateMany).toHaveBeenCalledWith({
      where: { repositoryId: "repo-1", number: 70 },
      data: { projectStatus: "Closed", projectItemId: "item-70" },
    });
  });

  it("openなIssue・対象外のStatus・Status無しは触らない", async () => {
    fetchProjectItems.mockResolvedValue([
      { ...item(1, "Implementation"), issueOpen: true },
      closedItem(2, "Develop"),
      closedItem(3, "Done"),
      closedItem(4, "Ready"),
      closedItem(5, null),
      closedItem(6, "Closed"),
    ]);

    const result = await closeStrandedProjectItems(42);

    expect(result).toEqual({ closed: 0, skipped: false });
    expect(updateProjectItemStatus).not.toHaveBeenCalled();
    expect(issueUpdateMany).not.toHaveBeenCalled();
  });

  it("Projectに`Closed`の選択肢が無ければ何も書かずskippedを返す", async () => {
    // 選択肢を手で足すまでは、別のStatusで代用せずそのまま待つ
    fetchProjectStatusField.mockResolvedValue(STATUS_FIELD);
    fetchProjectItems.mockResolvedValue([closedItem(70, "Implementation")]);

    const result = await closeStrandedProjectItems(42);

    expect(result).toEqual({ closed: 0, skipped: true });
    expect(fetchProjectItems).not.toHaveBeenCalled();
    expect(updateProjectItemStatus).not.toHaveBeenCalled();
  });

  it("環境変数が未設定ならGitHubへ問い合わせずskippedを返す", async () => {
    delete process.env.PROJECT_V2_NUMBER;

    const result = await closeStrandedProjectItems(42);

    expect(result).toEqual({ closed: 0, skipped: true });
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it("issue-deckが接続していないリポジトリのIssueもStatusだけは直す", async () => {
    repositoryFindMany.mockResolvedValue([]);
    fetchProjectItems.mockResolvedValue([closedItem(70, "Develop PR")]);

    const result = await closeStrandedProjectItems(42);

    expect(result).toEqual({ closed: 1, skipped: false });
    expect(updateProjectItemStatus).toHaveBeenCalled();
    expect(issueUpdateMany).not.toHaveBeenCalled();
  });
});
