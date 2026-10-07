import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const saveBackupCiSetting = vi.fn();
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
  get saveBackupCiSetting() {
    return saveBackupCiSetting;
  },
}));

import type { NextRequest } from "next/server";

import { PUT } from "@/app/api/repositories/backup-ci-settings/route";

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const valid = {
  owner: "o",
  repo: "r",
  enabled: true,
  circleciProjectSlug: "circleci/org-id/project-id",
  circleciDefinitionId: "0123abcd-0000-0000-0000-000000000000",
};

describe("PUT /api/repositories/backup-ci-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PREVIEW_MODE;
    requireUserId.mockResolvedValue("user-1");
    findFirst.mockResolvedValue({ fullName: "o/r" });
    saveBackupCiSetting.mockImplementation(async (input) => input);
  });

  afterEach(() => {
    delete process.env.PREVIEW_MODE;
  });

  it("有効化と設定を保存する", async () => {
    const response = await PUT(request(valid));
    expect(response.status).toBe(200);
    expect(saveBackupCiSetting).toHaveBeenCalledWith(expect.objectContaining({ repositoryFullName: "o/r", enabled: true }));
  });

  it("スラッグ・定義IDが揃わないまま有効にはできない", async () => {
    const response = await PUT(request({ ...valid, circleciDefinitionId: "" }));
    expect(response.status).toBe(400);
    expect(saveBackupCiSetting).not.toHaveBeenCalled();
  });

  it("URLへ埋め込めない形のスラッグは受け付けない", async () => {
    const response = await PUT(request({ ...valid, circleciProjectSlug: "../../x" }));
    expect(response.status).toBe(400);
  });

  it("プレビュー環境では403で封じる", async () => {
    process.env.PREVIEW_MODE = "true";
    const response = await PUT(request(valid));
    expect(response.status).toBe(403);
    expect(saveBackupCiSetting).not.toHaveBeenCalled();
  });
});
