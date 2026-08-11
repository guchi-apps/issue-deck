import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const updateMany = vi.fn();
const getInstallationToken = vi.fn();
const fetchProjectStatusField = vi.fn();
const findProjectItemForIssue = vi.fn();
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
  get findProjectItemForIssue() {
    return findProjectItemForIssue;
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

describe("reportProgressStatus", () => {
  beforeEach(() => {
    clearProjectStatusFieldCache();
    process.env.PROJECT_V2_OWNER = "guchi-apps";
    process.env.PROJECT_V2_NUMBER = "1";

    findFirst.mockReset().mockResolvedValue(REPOSITORY);
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    getInstallationToken.mockReset().mockResolvedValue("token");
    fetchProjectStatusField.mockReset().mockResolvedValue(STATUS_FIELD);
    findProjectItemForIssue.mockReset();
    updateProjectItemStatus.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.PROJECT_V2_OWNER;
    delete process.env.PROJECT_V2_NUMBER;
  });

  it("ProjectのStatusを更新し、DBのキャッシュも同時に書き換える", async () => {
    findProjectItemForIssue.mockResolvedValue({
      itemId: "item-1",
      repositoryDatabaseId: 100,
      issueNumber: 1007,
      status: "Ready",
    });

    const result = await reportProgressStatus({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1007,
      status: "implementation",
    });

    expect(result).toEqual({ applied: true, from: "Ready", to: "Implementation" });
    expect(updateProjectItemStatus).toHaveBeenCalledWith(
      { projectId: "PVT_1", itemId: "item-1", fieldId: "PVTSSF_1", optionId: "opt-impl" },
      "token",
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { repositoryId: "repo-1", number: 1007 },
      data: { projectStatus: "Implementation", projectItemId: "item-1" },
    });
  });

  it("環境変数が未設定ならGitHubへ一切問い合わせずproject_disabledを返す", async () => {
    delete process.env.PROJECT_V2_OWNER;

    const result = await reportProgressStatus({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1007,
      status: "implementation",
    });

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

  it("Projectに未登録のIssueは何もせずnot_in_projectを返す（自動追加はしない）", async () => {
    findProjectItemForIssue.mockResolvedValue(null);

    const result = await reportProgressStatus({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1007,
      status: "implementation",
    });

    expect(result).toEqual({ applied: false, reason: "not_in_project" });
    expect(updateProjectItemStatus).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("既に同じStatusならProjectへ書かず、DBのキャッシュだけ揃える", async () => {
    findProjectItemForIssue.mockResolvedValue({
      itemId: "item-1",
      repositoryDatabaseId: 100,
      issueNumber: 1007,
      status: "Implementation",
    });

    const result = await reportProgressStatus({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1007,
      status: "implementation",
    });

    expect(result).toEqual({ applied: false, reason: "unchanged" });
    expect(updateProjectItemStatus).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { repositoryId: "repo-1", number: 1007 },
      data: { projectStatus: "Implementation", projectItemId: "item-1" },
    });
  });

  it("Project側に対応する選択肢が無ければ何も書かずunknown_statusを返す", async () => {
    findProjectItemForIssue.mockResolvedValue({
      itemId: "item-1",
      repositoryDatabaseId: 100,
      issueNumber: 1007,
      status: "Ready",
    });

    // PROGRESS_STATUSESには存在するがProject側に選択肢が無いケース（Release）
    const result = await reportProgressStatus({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1007,
      status: "release",
    });

    expect(result).toEqual({ applied: false, reason: "unknown_status" });
    expect(updateProjectItemStatus).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("Statusフィールドの取得は繰り返しの報告でキャッシュされる", async () => {
    findProjectItemForIssue.mockResolvedValue({
      itemId: "item-1",
      repositoryDatabaseId: 100,
      issueNumber: 1007,
      status: "Ready",
    });

    await reportProgressStatus({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1007,
      status: "implementation",
    });
    await reportProgressStatus({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1008,
      status: "implementation",
    });

    expect(fetchProjectStatusField).toHaveBeenCalledTimes(1);
  });
});
