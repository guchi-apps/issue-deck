import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/issues/suggest/route";

const { requireUserId } = vi.hoisted(() => ({ requireUserId: vi.fn() }));
const { findUniqueSetting } = vi.hoisted(() => ({ findUniqueSetting: vi.fn() }));
const { generateIssueSuggestion, suggestLabelsByJev } = vi.hoisted(() => ({
  generateIssueSuggestion: vi.fn(),
  suggestLabelsByJev: vi.fn(),
}));
const { getAppAiToken } = vi.hoisted(() => ({ getAppAiToken: vi.fn() }));

vi.mock("@/lib/auth-user", () => ({ requireUserId }));
vi.mock("@/lib/db", () => ({ db: { appSetting: { findUnique: findUniqueSetting } } }));
vi.mock("@/lib/claude/issue-suggest", () => ({ generateIssueSuggestion, suggestLabelsByJev }));
vi.mock("@/lib/claude/request", () => ({ getAppAiToken }));

const LABELS = [{ name: "30.bug", description: "不具合" }];

function request() {
  return new Request("http://localhost/api/issues/suggest", {
    method: "POST",
    body: JSON.stringify({ body: "ログインに失敗する", labels: LABELS }),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserId.mockResolvedValue("user-1");
  getAppAiToken.mockResolvedValue("token");
  findUniqueSetting.mockResolvedValue({ modelPickEngine: "app-ai" });
  generateIssueSuggestion.mockResolvedValue({ kind: "issue", title: "AIのタイトル", labels: ["50.feature"] });
  suggestLabelsByJev.mockResolvedValue(["30.bug"]);
});

describe("POST /api/issues/suggest", () => {
  it("設定がapp-aiならJevを呼ばず、AIにラベルまで選ばせる", async () => {
    const body = await (await POST(request())).json();

    expect(body).toEqual({ kind: "issue", title: "AIのタイトル", labels: ["50.feature"] });
    expect(suggestLabelsByJev).not.toHaveBeenCalled();
    expect(generateIssueSuggestion).toHaveBeenCalledWith(
      "token",
      { body: "ログインに失敗する", availableLabels: LABELS },
      { includeLabels: true },
    );
  });

  it("設定がjevならラベルはJev、タイトルと種別はAIにする", async () => {
    findUniqueSetting.mockResolvedValue({ modelPickEngine: "jev" });
    generateIssueSuggestion.mockResolvedValue({ kind: "issue", title: "AIのタイトル", labels: [] });

    const body = await (await POST(request())).json();

    expect(body).toEqual({ kind: "issue", title: "AIのタイトル", labels: ["30.bug"] });
    expect(generateIssueSuggestion).toHaveBeenCalledWith(
      "token",
      { body: "ログインに失敗する", availableLabels: LABELS },
      { includeLabels: false },
    );
  });

  it("Jevで判定できなければ、AIにラベルも選ばせる従来の経路へ倒す", async () => {
    findUniqueSetting.mockResolvedValue({ modelPickEngine: "jev" });
    suggestLabelsByJev.mockResolvedValue(null);

    const body = await (await POST(request())).json();

    expect(body.labels).toEqual(["50.feature"]);
    expect(generateIssueSuggestion).toHaveBeenCalledWith(
      "token",
      expect.anything(),
      { includeLabels: true },
    );
  });

  it("設定を読めなくてもapp-ai扱いで提案する", async () => {
    findUniqueSetting.mockRejectedValue(new Error("db down"));

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(suggestLabelsByJev).not.toHaveBeenCalled();
  });

  it("AIのトークンが無ければJevも呼ばず501を返す", async () => {
    getAppAiToken.mockResolvedValue(null);

    const res = await POST(request());

    expect(res.status).toBe(501);
    expect(suggestLabelsByJev).not.toHaveBeenCalled();
  });
});
