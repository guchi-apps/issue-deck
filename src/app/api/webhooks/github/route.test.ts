import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueRepository = vi.fn();
const deleteIssueByGithubId = vi.fn();
const upsertIssueFromWebhookPayload = vi.fn();
const updateQaAnswerPendingState = vi.fn();
const updateManyIssue = vi.fn();
const findUniqueInstallation = vi.fn();
const findFirstInstallation = vi.fn();
const fetchProjectItem = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findUnique() {
        return findUniqueRepository;
      },
    },
    issue: {
      get updateMany() {
        return updateManyIssue;
      },
    },
    githubInstallation: {
      get findUnique() {
        return findUniqueInstallation;
      },
      get findFirst() {
        return findFirstInstallation;
      },
    },
  },
}));

vi.mock("@/lib/github/projects-api", () => ({
  get fetchProjectItem() {
    return fetchProjectItem;
  },
}));

vi.mock("@/lib/github/sync-issues", () => ({
  get deleteIssueByGithubId() {
    return deleteIssueByGithubId;
  },
  get upsertIssueFromWebhookPayload() {
    return upsertIssueFromWebhookPayload;
  },
  get updateQaAnswerPendingState() {
    return updateQaAnswerPendingState;
  },
  syncRepositoryIssues: vi.fn(),
}));

vi.mock("@/lib/github/app-auth", () => ({
  getInstallationToken: vi.fn(),
}));

vi.mock("@/lib/github/workflow-support", () => ({
  fetchClaudeWorkflowExists: vi.fn(),
}));

import { POST } from "@/app/api/webhooks/github/route";

const SECRET = "test-secret";

function makeRequest(body: unknown, event = "issues"): NextRequest {
  const rawBody = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`;
  return {
    text: async () => rawBody,
    headers: new Map([
      ["x-hub-signature-256", signature],
      ["x-github-event", event],
    ]),
  } as unknown as NextRequest;
}

describe("POST /api/webhooks/github issues.transferred", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    findUniqueRepository.mockReset();
    deleteIssueByGithubId.mockReset().mockResolvedValue(undefined);
    upsertIssueFromWebhookPayload.mockReset().mockResolvedValue(undefined);
    updateQaAnswerPendingState.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    vi.clearAllMocks();
  });

  it("changes.new_repositoryが欠落している場合、移動元Issueの行を削除するフォールバックを行う", async () => {
    const response = await POST(
      makeRequest({
        action: "transferred",
        issue: { id: 123, number: 1 },
        repository: { id: 1 },
      }),
    );

    expect(response.status).toBe(200);
    expect(deleteIssueByGithubId).toHaveBeenCalledWith(123);
  });

  it("changes.new_repositoryがあり移動先が接続済みの場合は移動先へupsertする", async () => {
    findUniqueRepository.mockResolvedValue({ id: "repo-destination" });

    const response = await POST(
      makeRequest({
        action: "transferred",
        issue: { id: 123, number: 5 },
        repository: { id: 1 },
        changes: { new_repository: { id: 2 } },
      }),
    );

    expect(response.status).toBe(200);
    expect(upsertIssueFromWebhookPayload).toHaveBeenCalledWith("repo-destination", {
      id: 123,
      number: 5,
    });
    expect(deleteIssueByGithubId).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/github issue_comment", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    findUniqueRepository.mockReset().mockResolvedValue({ id: "repo-1" });
    upsertIssueFromWebhookPayload.mockReset().mockResolvedValue(undefined);
    updateQaAnswerPendingState.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    vi.clearAllMocks();
  });

  it("action=createdの場合、comment.created_atをlastCommentAt更新用に渡し、コメント本文を渡してqaAnswerPendingAtを更新する", async () => {
    const response = await POST(
      makeRequest(
        {
          action: "created",
          issue: { id: 123, number: 1 },
          comment: {
            body: "@claude 質問: これは質問です",
            created_at: "2026-08-08T00:00:00.000Z",
          },
          repository: { id: 1 },
        },
        "issue_comment",
      ),
    );

    expect(response.status).toBe(200);
    expect(upsertIssueFromWebhookPayload).toHaveBeenCalledWith(
      "repo-1",
      { id: 123, number: 1 },
      new Date("2026-08-08T00:00:00.000Z"),
    );
    expect(updateQaAnswerPendingState).toHaveBeenCalledWith(123, "@claude 質問: これは質問です");
  });

  it("action=editedの場合、コメント投稿日時は渡さずqaAnswerPendingAtも更新しない", async () => {
    const response = await POST(
      makeRequest(
        {
          action: "edited",
          issue: { id: 123, number: 1 },
          comment: {
            body: "@claude 質問: これは質問です",
            created_at: "2026-08-08T00:00:00.000Z",
          },
          repository: { id: 1 },
        },
        "issue_comment",
      ),
    );

    expect(response.status).toBe(200);
    expect(upsertIssueFromWebhookPayload).toHaveBeenCalledWith(
      "repo-1",
      { id: 123, number: 1 },
      undefined,
    );
    expect(updateQaAnswerPendingState).not.toHaveBeenCalled();
  });

  it("PRへのコメント（issue.pull_requestあり）は無視する", async () => {
    const response = await POST(
      makeRequest(
        {
          action: "created",
          issue: { id: 123, number: 1, pull_request: {} },
          comment: {
            body: "@claude 質問: これは質問です",
            created_at: "2026-08-08T00:00:00.000Z",
          },
          repository: { id: 1 },
        },
        "issue_comment",
      ),
    );

    expect(response.status).toBe(200);
    expect(upsertIssueFromWebhookPayload).not.toHaveBeenCalled();
    expect(updateQaAnswerPendingState).not.toHaveBeenCalled();
    expect(findUniqueRepository).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/github projects_v2_item", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    findUniqueRepository.mockReset();
    updateManyIssue.mockReset().mockResolvedValue({ count: 1 });
    findUniqueInstallation.mockReset();
    findFirstInstallation.mockReset();
    fetchProjectItem.mockReset();
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    vi.clearAllMocks();
  });

  function makeItemPayload(action: string, overrides: Record<string, unknown> = {}) {
    return {
      action,
      projects_v2_item: { node_id: "PVTI_item1" },
      installation: { id: 100 },
      organization: { login: "guchi-apps" },
      ...overrides,
    };
  }

  it("Statusの変更をIssueへ反映する", async () => {
    findUniqueInstallation.mockResolvedValue({ id: "inst-1", installationId: 100 });
    fetchProjectItem.mockResolvedValue({
      itemId: "PVTI_item1",
      repositoryDatabaseId: 555,
      issueNumber: 42,
      status: "Implementation",
    });
    findUniqueRepository.mockResolvedValue({ id: "repo-1" });

    const response = await POST(makeRequest(makeItemPayload("edited"), "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(updateManyIssue).toHaveBeenCalledWith({
      where: { repositoryId: "repo-1", number: 42 },
      data: { projectStatus: "Implementation", projectItemId: "PVTI_item1" },
    });
  });

  it("installationが無い場合はorganization.loginからインストールを引く", async () => {
    findFirstInstallation.mockResolvedValue({ id: "inst-1", installationId: 100 });
    fetchProjectItem.mockResolvedValue({
      itemId: "PVTI_item1",
      repositoryDatabaseId: 555,
      issueNumber: 42,
      status: "Ready",
    });
    findUniqueRepository.mockResolvedValue({ id: "repo-1" });

    const payload = makeItemPayload("created");
    delete (payload as Record<string, unknown>).installation;
    const response = await POST(makeRequest(payload, "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(findFirstInstallation).toHaveBeenCalledWith({
      where: { accountLogin: "guchi-apps" },
    });
    expect(updateManyIssue).toHaveBeenCalled();
  });

  it("Projectから外れたらStatusを消してラベル起点の判定へ戻す", async () => {
    findUniqueInstallation.mockResolvedValue({ id: "inst-1", installationId: 100 });

    const response = await POST(makeRequest(makeItemPayload("deleted"), "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(updateManyIssue).toHaveBeenCalledWith({
      where: { projectItemId: "PVTI_item1" },
      data: { projectStatus: null, projectItemId: null },
    });
    // Projectから外れているのでGitHubへ問い合わせる必要はない
    expect(fetchProjectItem).not.toHaveBeenCalled();
  });

  it("archivedもStatusを消す対象にする", async () => {
    findUniqueInstallation.mockResolvedValue({ id: "inst-1", installationId: 100 });

    await POST(makeRequest(makeItemPayload("archived"), "projects_v2_item"));

    expect(updateManyIssue).toHaveBeenCalledWith({
      where: { projectItemId: "PVTI_item1" },
      data: { projectStatus: null, projectItemId: null },
    });
  });

  it("Issue以外（PR等）のアイテムは何もしない", async () => {
    findUniqueInstallation.mockResolvedValue({ id: "inst-1", installationId: 100 });
    fetchProjectItem.mockResolvedValue(null);

    const response = await POST(makeRequest(makeItemPayload("edited"), "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(updateManyIssue).not.toHaveBeenCalled();
  });

  it("未接続のリポジトリのIssueは無視する", async () => {
    findUniqueInstallation.mockResolvedValue({ id: "inst-1", installationId: 100 });
    fetchProjectItem.mockResolvedValue({
      itemId: "PVTI_item1",
      repositoryDatabaseId: 999,
      issueNumber: 1,
      status: "Done",
    });
    findUniqueRepository.mockResolvedValue(null);

    const response = await POST(makeRequest(makeItemPayload("edited"), "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(updateManyIssue).not.toHaveBeenCalled();
  });

  it("インストールが見つからない場合は何もしない", async () => {
    findUniqueInstallation.mockResolvedValue(null);

    const response = await POST(makeRequest(makeItemPayload("edited"), "projects_v2_item"));

    expect(response.status).toBe(200);
    expect(fetchProjectItem).not.toHaveBeenCalled();
    expect(updateManyIssue).not.toHaveBeenCalled();
  });
});
