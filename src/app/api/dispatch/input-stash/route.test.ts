import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const findUniqueStash = vi.fn();
const findUniqueJob = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    dispatchJob: { findUnique: (...a: unknown[]) => findUniqueJob(...a) },
    sessionInputStash: {
      create: (...a: unknown[]) => create(...a),
      findUnique: (...a: unknown[]) => findUniqueStash(...a),
    },
  },
}));
vi.mock("@/lib/dispatch/dispatch-auth", () => ({
  authorizeDispatch: (h: string | null) => (h === "Bearer ok" ? "ok" : "unauthorized"),
}));
vi.mock("@/lib/auth-user", () => ({ requireUserId: async () => null }));
vi.mock("@/lib/preview-mode", () => ({ previewModeGuard: () => null }));

import { GET, POST } from "./route";

function req(body: unknown, auth = "Bearer ok") {
  return new Request("http://localhost/api/dispatch/input-stash", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const goodJob = {
  id: "job1",
  kind: "INSTRUCTION",
  stashInput: true,
  targetHost: "subpc",
  status: "RUNNING",
  repositoryFullName: "guchi-apps/issue-deck",
  issueNumber: 4378,
};
const body = { jobId: "job1", host: "subpc", tmuxSessionName: "s", content: "改行なし 日本語 😀" };

beforeEach(() => {
  create.mockReset();
  findUniqueStash.mockReset();
  findUniqueJob.mockReset();
  findUniqueJob.mockResolvedValue(goodJob);
  create.mockResolvedValue({ id: "stash1" });
});

describe("POST /api/dispatch/input-stash", () => {
  it("認証が無ければ保存しない", async () => {
    expect((await POST(req(body, "Bearer bad"))).status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("確認を通した（stashInput）追加指示のジョブにだけ、Unicodeを含む本文を保存する", async () => {
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    expect(create.mock.calls[0][0].data.content).toBe(body.content);
    expect(create.mock.calls[0][0].data.charCount).toBe([...body.content].length);
    expect(JSON.stringify(await res.json())).not.toContain("日本語");
  });

  it.each([
    ["stashInputが立っていない", { stashInput: false }],
    ["別のホスト", { targetHost: "other" }],
    ["追加指示以外", { kind: "LAUNCH" }],
    ["終わったジョブ", { status: "SUCCEEDED" }],
  ])("%sなら保存しない", async (_name, patch) => {
    findUniqueJob.mockResolvedValue({ ...goodJob, ...patch });
    expect((await POST(req(body))).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("再試行（unique違反）は既存の退避を返し、二重に保存しない", async () => {
    create.mockRejectedValue(new Error("Unique constraint"));
    findUniqueStash.mockResolvedValue({ id: "stash1" });
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    expect((await res.json()).duplicate).toBe(true);
  });

  it("空の本文は保存しない", async () => {
    expect((await POST(req({ ...body, content: "" }))).status).toBe(400);
  });
});

describe("GET /api/dispatch/input-stash", () => {
  it("ログインしていなければ本文を返さない", async () => {
    const res = await GET(new Request("http://localhost/api/dispatch/input-stash?repository=a/b&issue=1") as never);
    expect(res.status).toBe(401);
  });
});
