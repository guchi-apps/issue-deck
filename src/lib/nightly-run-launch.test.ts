import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { refreshGithubUserToken } from "@/lib/github/refresh-user-token";
import { enqueueDispatchJob } from "@/lib/dispatch/jobs";
import { launchScheduledRunEntry } from "@/lib/nightly-run-launch";

const entryUpdateMany = vi.fn();
const entryUpdate = vi.fn();
const userFindUnique = vi.fn();
const userUpdate = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    nightlyRunEntry: {
      get updateMany() {
        return entryUpdateMany;
      },
      get update() {
        return entryUpdate;
      },
    },
    user: {
      get findUnique() {
        return userFindUnique;
      },
      get update() {
        return userUpdate;
      },
    },
  },
}));

vi.mock("@/lib/crypto/secret-cipher", () => ({
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (cipher: string) => cipher.replace(/^enc:/, ""),
}));

vi.mock("@/lib/github/refresh-user-token", () => ({
  refreshGithubUserToken: vi.fn(),
}));

vi.mock("@/lib/dispatch/jobs", () => ({
  enqueueDispatchJob: vi.fn(),
}));

const mockedRefresh = vi.mocked(refreshGithubUserToken);
const mockedEnqueue = vi.mocked(enqueueDispatchJob);

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** トークンごとに応答を変えるfetch。古いトークンは401、新しいトークンは実物のように答える */
function stubGithub(validToken: string) {
  const fetchMock = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    if (init.headers.Authorization !== `Bearer ${validToken}`) {
      return jsonResponse(401, { message: "Bad credentials" });
    }
    if (url.endsWith("/labels?per_page=100")) return jsonResponse(200, [{ name: "30.bug" }]);
    if (url.endsWith("/labels")) return jsonResponse(200, [{ name: "11.local" }]);
    return jsonResponse(200, { state: "open" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const now = new Date("2026-09-19T14:30:00Z");
const params = {
  entry: {
    id: "entry-1",
    repositoryFullName: "guchi-apps/aide",
    issueNumber: 309,
    agent: "CLAUDE",
    claudeModel: null,
    requestedByUserId: "user-1",
  },
  kind: "NEXT_WINDOW" as const,
  runKey: "2026-09-19 23:30",
  hostName: "subpc",
  now,
};

describe("launchScheduledRunEntry: 期限切れのトークン（#3148）", () => {
  beforeEach(() => {
    entryUpdateMany.mockResolvedValue({ count: 1 });
    entryUpdate.mockResolvedValue({});
    userUpdate.mockResolvedValue({});
    userFindUnique.mockResolvedValue({
      id: "user-1",
      githubAccessToken: "enc:expired",
      githubRefreshToken: "enc:refresh",
    });
    mockedEnqueue.mockResolvedValue({ ok: true, job: { id: "job-1" } } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("アクセストークンが切れていても、延長してから起動する", async () => {
    const fetchMock = stubGithub("fresh");
    mockedRefresh.mockResolvedValue({ accessToken: "fresh", refreshToken: "refresh-2" } as never);
    // 延長で保存したトークンを、以降の読み出しで返す（DBの代わり）
    let stored = { id: "user-1", githubAccessToken: "enc:expired", githubRefreshToken: "enc:refresh" };
    userFindUnique.mockImplementation(async () => stored);
    userUpdate.mockImplementation(async ({ data }: { data: Partial<typeof stored> }) => {
      stored = { ...stored, ...data };
      return stored;
    });

    const result = await launchScheduledRunEntry(params);

    expect(result.action?.result).toBe("launched");
    expect(mockedEnqueue).toHaveBeenCalledTimes(1);
    // 延長は1回だけ。`11.local`の付与は延長後のトークンで直接通る
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(mockedRefresh).toHaveBeenCalledWith("refresh");
    const labelCall = fetchMock.mock.calls.filter(([url]) => url.endsWith("/labels"));
    expect(labelCall.map(([, init]) => init.headers.Authorization)).toEqual(["Bearer fresh"]);
  });

  it("延長にも失敗したときは、再ログインを促す理由で見送る", async () => {
    stubGithub("fresh");
    mockedRefresh.mockResolvedValue(null);
    userFindUnique
      .mockResolvedValueOnce({ id: "user-1", githubAccessToken: "enc:expired", githubRefreshToken: "enc:refresh" })
      .mockResolvedValueOnce({ githubAccessToken: "enc:expired" });

    const result = await launchScheduledRunEntry(params);

    expect(result.action?.result).toBe("skipped");
    expect(result.action?.detail).toContain("ログインし直して");
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });
});

// #3192。予約実行に積んだCodexのモデルは、起動時のジョブへそのまま引き継ぐ
describe("launchScheduledRunEntry: モデルの引き継ぎ（#3192）", () => {
  beforeEach(() => {
    entryUpdateMany.mockResolvedValue({ count: 1 });
    entryUpdate.mockResolvedValue({});
    userFindUnique.mockResolvedValue({
      id: "user-1",
      githubAccessToken: "enc:ok",
      githubRefreshToken: "enc:refresh",
    });
    mockedEnqueue.mockResolvedValue({ ok: true, job: { id: "job-1" } } as never);
    stubGithub("ok");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("Codexのモデルの指定をジョブへ渡す。未知の語は指定なしへ倒す", async () => {
    await launchScheduledRunEntry({
      ...params,
      entry: { ...params.entry, agent: "codex", codexModel: "gpt-5.6-sol" },
    });
    expect(mockedEnqueue.mock.calls[0][0]).toMatchObject({
      agent: "codex",
      codexModel: "gpt-5.6-sol",
      claudeModel: null,
    });

    mockedEnqueue.mockClear();
    await launchScheduledRunEntry({
      ...params,
      entry: { ...params.entry, agent: "codex", codexModel: "opus" },
    });
    expect(mockedEnqueue.mock.calls[0][0].codexModel).toBeNull();
  });
});
