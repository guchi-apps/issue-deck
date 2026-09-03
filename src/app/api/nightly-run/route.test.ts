import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findUniqueHost = vi.fn();
const findFirstIssue = vi.fn();
const createEntry = vi.fn();
const listNightlyRunState = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    dispatchHost: {
      get findUnique() {
        return findUniqueHost;
      },
    },
    issue: {
      get findFirst() {
        return findFirstIssue;
      },
    },
    nightlyRunEntry: {
      get create() {
        return createEntry;
      },
    },
  },
}));

vi.mock("@/lib/nightly-run-state", () => ({
  get listNightlyRunState() {
    return listNightlyRunState;
  },
}));

import type { NextRequest } from "next/server";

import { GET, POST } from "@/app/api/nightly-run/route";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const VALID_BODY = {
  repository: "guchi-apps/issue-deck",
  issue: 2772,
  host: "subpc",
  optionLabels: ["21.plan-required"],
};

describe("/api/nightly-run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PREVIEW_MODE;
    requireUserId.mockResolvedValue("user-1");
    findUniqueHost.mockResolvedValue({
      name: "subpc",
      repositories: JSON.stringify(["guchi-apps/issue-deck"]),
      codexCapable: null,
    });
    findFirstIssue.mockResolvedValue({ labels: [{ name: "21.plan-required" }] });
    createEntry.mockResolvedValue({ id: "entry-1" });
    listNightlyRunState.mockResolvedValue({ settings: { enabled: false, startHour: 1 } });
  });

  afterEach(() => {
    delete process.env.PREVIEW_MODE;
  });

  it("GETは画面に出す状態を返す", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(listNightlyRunState).toHaveBeenCalledTimes(1);
  });

  it("POSTは今夜の予定として積み、いまは起動しない", async () => {
    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(201);
    expect(createEntry).toHaveBeenCalledTimes(1);
    const data = createEntry.mock.calls[0][0].data;
    expect(data).toMatchObject({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2772,
      targetHost: "subpc",
      agent: "claude",
      activeKey: "guchi-apps/issue-deck#2772",
      requestedByUserId: "user-1",
      optionLabels: ["21.plan-required"],
    });
  });

  it("承認・確認を待つ人がいないと進まないラベルが付いていれば積ませない（G1の指摘1）", async () => {
    findFirstIssue.mockResolvedValue({ labels: [{ name: "25.artifact-required" }] });

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "label_blocked" });
    expect(createEntry).not.toHaveBeenCalled();
  });

  it("そのリポジトリを実行できないホストへは積ませない", async () => {
    findUniqueHost.mockResolvedValue({
      name: "subpc",
      repositories: JSON.stringify(["guchi-apps/myroom"]),
      codexCapable: null,
    });

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "repository_not_runnable" });
  });

  it("同じIssueの二重投入はunique制約で409になる", async () => {
    createEntry.mockRejectedValue(new Error("unique"));

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "already_queued" });
  });

  /** #2441。プレビュー環境から本番のDB・GitHubへ書かせない */
  it("プレビュー環境ではPOSTを403で封じる", async () => {
    process.env.PREVIEW_MODE = "true";

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(403);
    expect(createEntry).not.toHaveBeenCalled();
  });
});
