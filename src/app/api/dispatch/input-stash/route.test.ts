import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const findUniqueStash = vi.fn();
const findUniqueJob = vi.fn();
const findManyStash = vi.fn();
const findFirstStash = vi.fn();
const deleteManyStash = vi.fn();
const findFirstRepo = vi.fn();
let currentUser: string | null = null;
vi.mock("@/lib/db", () => ({
  db: {
    dispatchJob: { findUnique: (...a: unknown[]) => findUniqueJob(...a) },
    sessionInputStash: {
      create: (...a: unknown[]) => create(...a),
      findUnique: (...a: unknown[]) => findUniqueStash(...a),
      findMany: (...a: unknown[]) => findManyStash(...a),
      findFirst: (...a: unknown[]) => findFirstStash(...a),
      deleteMany: (...a: unknown[]) => deleteManyStash(...a),
    },
    repository: { findFirst: (...a: unknown[]) => findFirstRepo(...a) },
  },
}));
vi.mock("@/lib/dispatch/dispatch-auth", () => ({
  authorizeDispatch: (h: string | null) => (h === "Bearer ok" ? "ok" : "unauthorized"),
}));
vi.mock("@/lib/auth-user", () => ({ requireUserId: async () => currentUser }));
vi.mock("@/lib/preview-mode", () => ({ previewModeGuard: () => null }));

import { DELETE, GET, POST } from "./route";

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
  requestedByUserId: "userA",
};
const body = { jobId: "job1", host: "subpc", tmuxSessionName: "s", content: "改行なし 日本語 😀" };

beforeEach(() => {
  create.mockReset();
  findUniqueStash.mockReset();
  findUniqueJob.mockReset();
  findManyStash.mockReset().mockResolvedValue([]);
  findFirstStash.mockReset();
  deleteManyStash.mockReset().mockResolvedValue({ count: 1 });
  findFirstRepo.mockReset().mockResolvedValue({ id: "r" });
  currentUser = null;
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
    const res = await GET(new NextRequest("http://localhost/api/dispatch/input-stash?repository=a/b&issue=1") as never);
    expect(res.status).toBe(401);
  });

  it("リポジトリへ権限が無いユーザーには本文を返さない", async () => {
    currentUser = "userB";
    findFirstRepo.mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/api/dispatch/input-stash?repository=a/b&issue=1") as never);
    expect(res.status).toBe(403);
    expect(findManyStash).not.toHaveBeenCalled();
  });

  it("依頼者本人の行だけを検索する", async () => {
    currentUser = "userA";
    await GET(new NextRequest("http://localhost/api/dispatch/input-stash?repository=a/b&issue=1") as never);
    expect(findManyStash.mock.calls[0][0].where.requestedByUserId).toBe("userA");
  });
});

describe("DELETE /api/dispatch/input-stash", () => {
  const del = () => DELETE(new NextRequest("http://localhost/api/dispatch/input-stash?id=s1", { method: "DELETE" }) as never);

  it("他人の行は消さない", async () => {
    currentUser = "userB";
    findFirstStash.mockResolvedValue(null);
    expect((await del()).status).toBe(404);
    expect(findFirstStash.mock.calls[0][0].where).toEqual({ id: "s1", requestedByUserId: "userB" });
    expect(deleteManyStash).not.toHaveBeenCalled();
  });

  it("本人かつ権限があれば消す", async () => {
    currentUser = "userA";
    findFirstStash.mockResolvedValue({ repositoryFullName: "a/b" });
    expect((await del()).status).toBe(200);
    expect(deleteManyStash).toHaveBeenCalledWith({ where: { id: "s1", requestedByUserId: "userA" } });
  });
});
