import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    appSetting: {
      get findUnique() {
        return findUnique;
      },
      get upsert() {
        return upsert;
      },
    },
  },
}));

const { GET, PATCH } = await import("./route");

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/settings/claude-model", {
    method: "PATCH",
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserId.mockResolvedValue("user-1");
  upsert.mockImplementation(async ({ update }) => ({
    claudeModel: update.claudeModel ?? "auto",
    claudeModelAssist: update.claudeModelAssist ?? "auto",
    codexModel: update.codexModel ?? "auto",
  }));
});

describe("GET", () => {
  it("設定が無い場合はすべてautoを返す", async () => {
    findUnique.mockResolvedValue(null);
    await expect((await GET()).json()).resolves.toEqual({
      claudeModel: "auto",
      claudeModelAssist: "auto",
      codexModel: "auto",
    });
  });

  it("保存済みの値をそのまま返す", async () => {
    findUnique.mockResolvedValue({
      claudeModel: "opus",
      claudeModelAssist: "sonnet",
      codexModel: "gpt-5.6-terra",
    });
    await expect((await GET()).json()).resolves.toEqual({
      claudeModel: "opus",
      claudeModelAssist: "sonnet",
      codexModel: "gpt-5.6-terra",
    });
  });
});

describe("PATCH", () => {
  it("両方指定された場合は両方を更新する", async () => {
    const res = await PATCH(
      patchRequest({
        claudeModel: "opus",
        claudeModelAssist: "haiku",
        codexModel: "gpt-5.6-sol",
      }),
    );

    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          claudeModel: "opus",
          claudeModelAssist: "haiku",
          codexModel: "gpt-5.6-sol",
        },
      }),
    );
  });

  // 設定画面は常に両方を送るが、片方だけ更新したい呼び出しや旧形式のリクエストを壊さないため、
  // claudeModelAssistの省略を許容し、その場合は既存値を変更しない。
  it("claudeModelAssistが無い場合はclaudeModelだけを更新する", async () => {
    const res = await PATCH(patchRequest({ claudeModel: "sonnet" }));

    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { claudeModel: "sonnet" } }),
    );
  });

  it("claudeModelAssistが不正な値の場合は400を返す", async () => {
    const res = await PATCH(patchRequest({ claudeModel: "opus", claudeModelAssist: "gpt" }));

    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("claudeModelが不正な値の場合は400を返す", async () => {
    const res = await PATCH(patchRequest({ claudeModel: "gpt" }));

    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("codexModelが不正な値の場合は400を返す", async () => {
    const res = await PATCH(patchRequest({ claudeModel: "opus", codexModel: "gpt-5-codex" }));

    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("未認証の場合は401を返す", async () => {
    requireUserId.mockResolvedValue(null);

    const res = await PATCH(patchRequest({ claudeModel: "opus" }));

    expect(res.status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });
});
