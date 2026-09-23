import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const readClaudeWindowSnapshot = vi.fn();
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

vi.mock("@/lib/next-window-run-db", () => ({
  get readClaudeWindowSnapshot() {
    return readClaudeWindowSnapshot;
  },
}));

import type { NextRequest } from "next/server";

import { GET, POST } from "@/app/api/nightly-run/route";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

/** 2026-09-18 08:40 JST。実測のリセット時刻と同じ半端な時刻（#2995） */
const RESETS_AT = Date.UTC(2026, 8, 17, 23, 40);

const VALID_BODY = {
  repository: "guchi-apps/issue-deck",
  issue: 2772,
  host: "subpc",
  kind: "next-window",
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
    listNightlyRunState.mockResolvedValue({
      nextWindow: { settings: { enabled: false, leadMinutes: 60, intervalMinutes: 10 } },
    });
    readClaudeWindowSnapshot.mockResolvedValue({ resetsAt: RESETS_AT, usedPercent: 62 });
  });

  afterEach(() => {
    delete process.env.PREVIEW_MODE;
  });

  it("GETは画面に出す状態を返す", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(listNightlyRunState).toHaveBeenCalledTimes(1);
  });

  it("POSTは次の5時間枠の予定として積み、いまは起動しない", async () => {
    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(201);
    expect(createEntry).toHaveBeenCalledTimes(1);
    const data = createEntry.mock.calls[0][0].data;
    expect(data).toMatchObject({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2772,
      targetHost: "subpc",
      agent: "claude",
      kind: "NEXT_WINDOW",
      activeKey: "guchi-apps/issue-deck#2772",
      requestedByUserId: "user-1",
      optionLabels: ["21.plan-required"],
    });
    // **積んだ時点の枠のリセット時刻を控える**（この時刻を過ぎるまで起動しないのが「次の」枠の実体）
    expect(data.reservedResetsAt).toEqual(new Date(RESETS_AT));
  });

  /** #2995: 枠を取れなくても積める（起動の判定側が枠の状態だけで待つ） */
  it("枠を取得できなくても「次の5時間枠」に積める", async () => {
    readClaudeWindowSnapshot.mockResolvedValue(null);

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(201);
    expect(createEntry.mock.calls[0][0].data.reservedResetsAt).toBeNull();
  });

  /** #3019: 「今夜の夜間実行」は削除済み。`kind`省略・`"nightly"`はどちらも400で断る */
  it("`kind`を指定しない、または`nightly`を指定すると400になる", async () => {
    const { kind: _kind, ...withoutKind } = VALID_BODY;
    expect((await POST(request(withoutKind))).status).toBe(400);
    expect((await POST(request({ ...VALID_BODY, kind: "nightly" }))).status).toBe(400);
    expect(createEntry).not.toHaveBeenCalled();
  });

  it("知らない`kind`は400で断る", async () => {
    expect((await POST(request({ ...VALID_BODY, kind: "weekly" }))).status).toBe(400);
    expect(createEntry).not.toHaveBeenCalled();
  });

  it("承認・確認を待つ人がいないと進まないラベルが付いていれば積ませない（G1の指摘1）", async () => {
    findFirstIssue.mockResolvedValue({ labels: [{ name: "25.artifact-required" }] });

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "label_blocked" });
    expect(createEntry).not.toHaveBeenCalled();
  });

  /**
   * #3366: 積む前から`11.local`が付いていたIssueを断らずに積むと、201で受け付けた直後の巡回
   * （`cancelManuallyStartedScheduledRuns`）が「積んだ後に手動着手された」と誤判定して
   * 黙って`CANCELED`にしてしまう。積む口で先に断る
   */
  it("すでに`11.local`が付いているIssueは積ませない", async () => {
    findFirstIssue.mockResolvedValue({ labels: [{ name: "11.local" }] });

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "already_started" });
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
