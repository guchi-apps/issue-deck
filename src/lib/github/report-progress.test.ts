import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const updateMany = vi.fn();
const getInstallationToken = vi.fn();
const fetchProjectStatusField = vi.fn();
const findIssueProjectState = vi.fn();
const addProjectItem = vi.fn();
const updateProjectItemStatus = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findFirst() {
        return findFirst;
      },
    },
    issue: {
      get updateMany() {
        return updateMany;
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
  get fetchProjectStatusField() {
    return fetchProjectStatusField;
  },
  get findIssueProjectState() {
    return findIssueProjectState;
  },
  get addProjectItem() {
    return addProjectItem;
  },
  get updateProjectItemStatus() {
    return updateProjectItemStatus;
  },
}));

import { clearProjectStatusFieldCache, reportProgressStatus } from "@/lib/github/report-progress";

const REPOSITORY = {
  id: "repo-1",
  ownerLogin: "guchi-apps",
  name: "issue-deck",
  installation: { installationId: 42 },
};

const STATUS_FIELD = {
  projectId: "PVT_1",
  fieldId: "PVTSSF_1",
  optionIdByName: new Map([
    ["Implementation", "opt-impl"],
    ["Develop", "opt-develop"],
  ]),
};

/** 盤面に載っている状態 */
function onBoard(status: string | null, itemId = "item-1") {
  return {
    issueNodeId: "I_issue1",
    item: { itemId, repositoryDatabaseId: 100, issueNumber: 1007, status },
  };
}

/** Issueは存在するが盤面には無い状態 */
const NOT_ON_BOARD = { issueNodeId: "I_issue1", item: null };

function report(issueNumber = 1007, status: "implementation" | "release" = "implementation") {
  return reportProgressStatus({
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber,
    status,
  });
}

describe("reportProgressStatus", () => {
  beforeEach(() => {
    clearProjectStatusFieldCache();
    process.env.PROJECT_V2_OWNER = "guchi-apps";
    process.env.PROJECT_V2_NUMBER = "1";

    findFirst.mockReset().mockResolvedValue(REPOSITORY);
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    getInstallationToken.mockReset().mockResolvedValue("token");
    fetchProjectStatusField.mockReset().mockResolvedValue(STATUS_FIELD);
    findIssueProjectState.mockReset();
    addProjectItem.mockReset();
    updateProjectItemStatus.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.PROJECT_V2_OWNER;
    delete process.env.PROJECT_V2_NUMBER;
  });

  it("ProjectのStatusを更新し、DBのキャッシュも同時に書き換える", async () => {
    findIssueProjectState.mockResolvedValue(onBoard("Ready"));

    const result = await report();

    expect(result).toEqual({ applied: true, from: "Ready", to: "Implementation" });
    expect(updateProjectItemStatus).toHaveBeenCalledWith(
      { projectId: "PVT_1", itemId: "item-1", fieldId: "PVTSSF_1", optionId: "opt-impl" },
      "token",
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { repositoryId: "repo-1", number: 1007 },
      data: { projectStatus: "Implementation", projectItemId: "item-1" },
    });
    expect(addProjectItem).not.toHaveBeenCalled();
  });

  it("盤面に無いIssueは自分で載せてからStatusを書く（Auto-addに頼らない）", async () => {
    findIssueProjectState.mockResolvedValue(NOT_ON_BOARD);
    addProjectItem.mockResolvedValue({
      itemId: "item-new",
      repositoryDatabaseId: 100,
      issueNumber: 1007,
      status: null,
    });

    const result = await report();

    expect(addProjectItem).toHaveBeenCalledWith("PVT_1", "I_issue1", "token");
    expect(result).toEqual({ applied: true, from: null, to: "Implementation" });
    expect(updateProjectItemStatus).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "item-new", optionId: "opt-impl" }),
      "token",
    );
  });

  it("環境変数が未設定ならGitHubへ一切問い合わせずproject_disabledを返す", async () => {
    delete process.env.PROJECT_V2_OWNER;

    const result = await report();

    expect(result).toEqual({ applied: false, reason: "project_disabled" });
    expect(findFirst).not.toHaveBeenCalled();
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it("issue-deckが接続していないリポジトリならunknown_repositoryを返す", async () => {
    findFirst.mockResolvedValue(null);

    const result = await reportProgressStatus({
      repositoryFullName: "other/repo",
      issueNumber: 1,
      status: "implementation",
    });

    expect(result).toEqual({ applied: false, reason: "unknown_repository" });
    expect(updateProjectItemStatus).not.toHaveBeenCalled();
  });

  it("GitHub上にIssueが無ければ何もしない", async () => {
    findIssueProjectState.mockResolvedValue(null);

    const result = await report();

    expect(result).toEqual({ applied: false, reason: "not_in_project" });
    expect(addProjectItem).not.toHaveBeenCalled();
    expect(updateProjectItemStatus).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("Projectへの追加に失敗したら何も書かない", async () => {
    findIssueProjectState.mockResolvedValue(NOT_ON_BOARD);
    addProjectItem.mockResolvedValue(null);

    const result = await report();

    expect(result).toEqual({ applied: false, reason: "not_in_project" });
    expect(updateProjectItemStatus).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("既に同じStatusならProjectへ書かず、DBのキャッシュだけ揃える", async () => {
    findIssueProjectState.mockResolvedValue(onBoard("Implementation"));

    const result = await report();

    expect(result).toEqual({ applied: false, reason: "unchanged" });
    expect(updateProjectItemStatus).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { repositoryId: "repo-1", number: 1007 },
      data: { projectStatus: "Implementation", projectItemId: "item-1" },
    });
  });

  it("Project側に対応する選択肢が無ければ何も書かずunknown_statusを返す", async () => {
    findIssueProjectState.mockResolvedValue(onBoard("Ready"));

    // PROGRESS_STATUSESには存在するがProject側に選択肢が無いケース（Release）
    const result = await report(1007, "release");

    expect(result).toEqual({ applied: false, reason: "unknown_status" });
    // 選択肢が無いと分かった時点で止め、盤面へ載せる操作もしない
    expect(findIssueProjectState).not.toHaveBeenCalled();
    expect(addProjectItem).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("Statusフィールドの取得は繰り返しの報告でキャッシュされる", async () => {
    findIssueProjectState.mockResolvedValue(onBoard("Ready"));

    await report(1007);
    await report(1008);

    expect(fetchProjectStatusField).toHaveBeenCalledTimes(1);
  });
});
