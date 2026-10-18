import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  findRepositoryByFullName: vi.fn(),
  listRemoteSessions: vi.fn(),
  enqueueRemoteSession: vi.fn(),
  enqueueRemoteSessionKill: vi.fn(),
}));

vi.mock("@/lib/auth-user", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/preview-mode", () => ({ previewModeGuard: () => null }));
vi.mock("@/lib/github/issue-create-service", () => ({
  findRepositoryByFullName: mocks.findRepositoryByFullName,
}));
vi.mock("@/lib/dispatch/remote-session", () => ({
  listRemoteSessions: mocks.listRemoteSessions,
  enqueueRemoteSession: mocks.enqueueRemoteSession,
  enqueueRemoteSessionKill: mocks.enqueueRemoteSessionKill,
}));

import { DELETE, GET, POST } from "./route";

function post(body: unknown) {
  return new Request("http://localhost/api/remote-sessions", {
    method: "POST",
    body: JSON.stringify(body),
  }) as never;
}

describe("/api/remote-sessions の認可", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUserId.mockResolvedValue("u1");
  });

  it("GETは要求利用者のIDで一覧を絞る", async () => {
    mocks.listRemoteSessions.mockResolvedValue({ sessions: [], hosts: [], maxPerHost: 1 });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mocks.listRemoteSessions).toHaveBeenCalledWith("u1");
  });

  it("POSTは連携していないリポジトリを403で拒否し、積まない", async () => {
    mocks.findRepositoryByFullName.mockResolvedValue(null);
    const res = await POST(post({ repositoryFullName: "other/private" }));
    expect(res.status).toBe(403);
    expect(mocks.findRepositoryByFullName).toHaveBeenCalledWith("u1", "other/private");
    expect(mocks.enqueueRemoteSession).not.toHaveBeenCalled();
  });

  it("POSTは連携済みリポジトリなら起動を積む", async () => {
    mocks.findRepositoryByFullName.mockResolvedValue({ id: "r1" });
    mocks.enqueueRemoteSession.mockResolvedValue({ ok: true, session: { id: "s1" } });
    const res = await POST(post({ repositoryFullName: "me/app" }));
    expect(res.status).toBe(201);
    expect(mocks.enqueueRemoteSession).toHaveBeenCalledWith({
      repositoryFullName: "me/app",
      requestedByUserId: "u1",
    });
  });

  it("DELETEは要求利用者のIDを終了処理へ渡し、他人のセッションはnot_found(404)になる", async () => {
    mocks.enqueueRemoteSessionKill.mockResolvedValue({ ok: false, reason: "not_found", message: "x" });
    const res = await DELETE({ nextUrl: new URL("http://localhost/api/remote-sessions?id=s9") } as never);
    expect(res.status).toBe(404);
    expect(mocks.enqueueRemoteSessionKill).toHaveBeenCalledWith({ id: "s9", requestedByUserId: "u1" });
  });
});
