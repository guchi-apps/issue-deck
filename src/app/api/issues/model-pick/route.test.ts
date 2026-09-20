import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/issues/model-pick/route";

const { requireUserId } = vi.hoisted(() => ({ requireUserId: vi.fn() }));
const { findFirstRepository, findFirstIssue, findUniqueSetting } = vi.hoisted(() => ({
  findFirstRepository: vi.fn(),
  findFirstIssue: vi.fn(),
  findUniqueSetting: vi.fn(),
}));
const { pickModelByJev, pickModelForIssue, pickModelByRule } = vi.hoisted(() => ({
  pickModelByJev: vi.fn(),
  pickModelForIssue: vi.fn(),
  pickModelByRule: vi.fn(),
}));
const { getAppAiToken } = vi.hoisted(() => ({ getAppAiToken: vi.fn() }));

vi.mock("@/lib/auth-user", () => ({ requireUserId }));
vi.mock("@/lib/db", () => ({
  db: {
    repository: { findFirst: findFirstRepository },
    issue: { findFirst: findFirstIssue },
    appSetting: { findUnique: findUniqueSetting },
  },
}));
vi.mock("@/lib/claude/model-pick", () => ({ pickModelByJev, pickModelForIssue, pickModelByRule }));
vi.mock("@/lib/claude/request", () => ({ getAppAiToken }));

function request() {
  return new Request("http://localhost/api/issues/model-pick", {
    method: "POST",
    body: JSON.stringify({ owner: "guchi-apps", repo: "issue-deck", number: 1 }),
  }) as unknown as Parameters<typeof POST>[0];
}

const JEV_RESULT = { model: "opus", reason: "難しさ 2/3と判定したためです。", source: "jev" };
const AI_RESULT = { model: "sonnet", reason: "通常の実装だと判断したためです。", source: "ai" };
const RULE_RESULT = { model: "sonnet", reason: "やることの範囲が読めるためです。" };

beforeEach(() => {
  vi.clearAllMocks();
  requireUserId.mockResolvedValue("user-1");
  findFirstRepository.mockResolvedValue({ id: "repo-1" });
  findFirstIssue.mockResolvedValue({ title: "直す", body: "", labels: [], commentCount: 0 });
  findUniqueSetting.mockResolvedValue({ modelPickEngine: "app-ai" });
  pickModelByJev.mockResolvedValue(JEV_RESULT);
  pickModelForIssue.mockResolvedValue(AI_RESULT);
  pickModelByRule.mockReturnValue(RULE_RESULT);
  getAppAiToken.mockResolvedValue("token");
});

describe("POST /api/issues/model-pick", () => {
  it("設定がapp-aiならJevを呼ばずアプリ内AIで判定する", async () => {
    await expect((await POST(request())).json()).resolves.toEqual(AI_RESULT);
    expect(pickModelByJev).not.toHaveBeenCalled();
  });

  it("設定がjevならJevで判定し、アプリ内AIは呼ばない", async () => {
    findUniqueSetting.mockResolvedValue({ modelPickEngine: "jev" });

    await expect((await POST(request())).json()).resolves.toEqual(JEV_RESULT);
    expect(pickModelForIssue).not.toHaveBeenCalled();
  });

  /**
   * キーが無い環境・呼び出しが失敗した場合（`pickModelByJev`が`null`）。
   * **設定を戻さないと起動できない、という状態を作らない。**
   */
  it("Jevで選べなければアプリ内AIへ倒す", async () => {
    findUniqueSetting.mockResolvedValue({ modelPickEngine: "jev" });
    pickModelByJev.mockResolvedValue(null);

    await expect((await POST(request())).json()).resolves.toEqual(AI_RESULT);
    expect(pickModelForIssue).toHaveBeenCalledTimes(1);
  });

  it("Jevもアプリ内AIのトークンも無ければルールで選ぶ", async () => {
    findUniqueSetting.mockResolvedValue({ modelPickEngine: "jev" });
    pickModelByJev.mockResolvedValue(null);
    getAppAiToken.mockResolvedValue(null);

    await expect((await POST(request())).json()).resolves.toEqual({
      ...RULE_RESULT,
      source: "rule",
    });
  });

  // 設定を読めなくても判定は走る（既定＝アプリ内AIとして扱う）
  it("設定が読めなくてもアプリ内AIで判定する", async () => {
    findUniqueSetting.mockRejectedValue(new Error("db down"));

    await expect((await POST(request())).json()).resolves.toEqual(AI_RESULT);
    expect(pickModelByJev).not.toHaveBeenCalled();
  });

  it("未認証の場合は401を返す", async () => {
    requireUserId.mockResolvedValue(null);

    expect((await POST(request())).status).toBe(401);
  });
});
