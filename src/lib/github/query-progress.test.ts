import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const getInstallationToken = vi.fn();
const fetchProjectStatusField = vi.fn();
const findIssueProjectState = vi.fn();
const fetchProjectItems = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findFirst() {
        return findFirst;
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
  get fetchProjectItems() {
    return fetchProjectItems;
  },
}));

import {
  queryIssueProgressStatus,
  queryIssuesByProgressStatus,
} from "@/lib/github/query-progress";

const REPOSITORY = {
  id: "repo-1",
  githubRepositoryId: 100,
  ownerLogin: "guchi-apps",
  name: "issue-deck",
  installation: { installationId: 42 },
};

const STATUS_FIELD = { projectId: "PVT_1", fieldId: "PVTSSF_1", optionIdByName: new Map() };

function item(issueNumber: number, status: string | null, extra?: Partial<{ issueOpen: boolean; repositoryDatabaseId: number }>) {
  return {
    itemId: `item-${issueNumber}`,
    repositoryDatabaseId: extra?.repositoryDatabaseId ?? 100,
    issueNumber,
    issueOpen: extra?.issueOpen ?? true,
    status,
  };
}

beforeEach(() => {
  process.env.PROJECT_V2_OWNER = "guchi-apps";
  process.env.PROJECT_V2_NUMBER = "1";
  findFirst.mockReset().mockResolvedValue(REPOSITORY);
  getInstallationToken.mockReset().mockResolvedValue("token");
  fetchProjectStatusField.mockReset().mockResolvedValue(STATUS_FIELD);
  findIssueProjectState.mockReset();
  fetchProjectItems.mockReset();
});

afterEach(() => {
  delete process.env.PROJECT_V2_OWNER;
  delete process.env.PROJECT_V2_NUMBER;
  vi.clearAllMocks();
});

describe("queryIssueProgressStatus", () => {
  it("盤面のStatusを状態キーへ正規化して返す", async () => {
    findIssueProjectState.mockResolvedValue({
      issueNodeId: "I_1",
      item: item(10, "Develop PR"),
    });

    await expect(
      queryIssueProgressStatus({ repositoryFullName: "guchi-apps/issue-deck", issueNumber: 10 }),
    ).resolves.toEqual({ available: true, status: "develop-pr" });
  });

  it("盤面へ未登録・Status未設定はnullを返す（進捗が始まっていない）", async () => {
    findIssueProjectState.mockResolvedValue({ issueNodeId: "I_1", item: null });
    await expect(
      queryIssueProgressStatus({ repositoryFullName: "guchi-apps/issue-deck", issueNumber: 10 }),
    ).resolves.toEqual({ available: true, status: null });

    findIssueProjectState.mockResolvedValue({ issueNodeId: "I_1", item: item(10, null) });
    await expect(
      queryIssueProgressStatus({ repositoryFullName: "guchi-apps/issue-deck", issueNumber: 10 }),
    ).resolves.toEqual({ available: true, status: null });
  });

  it("GitHub上にIssueが無ければnullを返す", async () => {
    findIssueProjectState.mockResolvedValue(null);
    await expect(
      queryIssueProgressStatus({ repositoryFullName: "guchi-apps/issue-deck", issueNumber: 10 }),
    ).resolves.toEqual({ available: true, status: null });
  });

  it("Project連携が無効なら理由を返す", async () => {
    delete process.env.PROJECT_V2_OWNER;
    await expect(
      queryIssueProgressStatus({ repositoryFullName: "guchi-apps/issue-deck", issueNumber: 10 }),
    ).resolves.toEqual({ available: false, reason: "project_disabled" });
  });

  it("接続していないリポジトリなら理由を返す", async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      queryIssueProgressStatus({ repositoryFullName: "someone/other", issueNumber: 10 }),
    ).resolves.toEqual({ available: false, reason: "unknown_repository" });
  });
});

describe("queryIssuesByProgressStatus", () => {
  it("指定した進捗にあるopenなIssueだけを昇順で返す", async () => {
    fetchProjectItems.mockResolvedValue([
      item(30, "Develop"),
      item(10, "Release"),
      item(20, "Implementation"),
      item(40, "Develop", { issueOpen: false }),
      item(50, "Develop", { repositoryDatabaseId: 999 }),
      item(60, null),
    ]);

    await expect(
      queryIssuesByProgressStatus({
        repositoryFullName: "guchi-apps/issue-deck",
        statuses: ["develop", "release"],
      }),
    ).resolves.toEqual({ available: true, issues: [10, 30] });
  });

  it("該当が無ければ空配列を返す", async () => {
    fetchProjectItems.mockResolvedValue([item(10, "Implementation")]);
    await expect(
      queryIssuesByProgressStatus({
        repositoryFullName: "guchi-apps/issue-deck",
        statuses: ["done"],
      }),
    ).resolves.toEqual({ available: true, issues: [] });
  });

  it("接続していないリポジトリなら理由を返す", async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      queryIssuesByProgressStatus({ repositoryFullName: "someone/other", statuses: ["develop"] }),
    ).resolves.toEqual({ available: false, reason: "unknown_repository" });
  });
});
