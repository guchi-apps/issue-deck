import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const startBackupCiRun = vi.fn();
const findFirst = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findFirst() {
        return findFirst;
      },
    },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/backup-ci/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backup-ci/service")>()),
  get startBackupCiRun() {
    return startBackupCiRun;
  },
}));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/pull-requests/backup-ci/route";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/pull-requests/backup-ci", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PREVIEW_MODE;
    requireUserId.mockResolvedValue("user-1");
    findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.PREVIEW_MODE;
  });

  it("ログインしていなければ起動しない", async () => {
    requireUserId.mockResolvedValue(null);
    const response = await POST(request({ owner: "o", repo: "r", number: 1 }));
    expect(response.status).toBe(401);
    expect(startBackupCiRun).not.toHaveBeenCalled();
  });

  it("権限の無いリポジトリでは起動しない", async () => {
    const response = await POST(request({ owner: "o", repo: "r", number: 1 }));
    expect(response.status).toBe(404);
    expect(startBackupCiRun).not.toHaveBeenCalled();
  });

  /** #2441。開発サーバーから本番のCircleCIを起動・共通チェックを発行しない */
  it("プレビュー環境では403で封じる", async () => {
    process.env.PREVIEW_MODE = "true";
    const response = await POST(request({ owner: "o", repo: "r", number: 1 }));
    expect(response.status).toBe(403);
    expect(startBackupCiRun).not.toHaveBeenCalled();
  });
});
