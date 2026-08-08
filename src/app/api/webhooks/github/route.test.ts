import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueRepository = vi.fn();
const deleteIssueByGithubId = vi.fn();
const upsertIssueFromWebhookPayload = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findUnique() {
        return findUniqueRepository;
      },
    },
  },
}));

vi.mock("@/lib/github/sync-issues", () => ({
  get deleteIssueByGithubId() {
    return deleteIssueByGithubId;
  },
  get upsertIssueFromWebhookPayload() {
    return upsertIssueFromWebhookPayload;
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

function makeRequest(body: unknown): NextRequest {
  const rawBody = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`;
  return {
    text: async () => rawBody,
    headers: new Map([
      ["x-hub-signature-256", signature],
      ["x-github-event", "issues"],
    ]),
  } as unknown as NextRequest;
}

describe("POST /api/webhooks/github issues.transferred", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    findUniqueRepository.mockReset();
    deleteIssueByGithubId.mockReset().mockResolvedValue(undefined);
    upsertIssueFromWebhookPayload.mockReset().mockResolvedValue(undefined);
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
