import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  deleteMany: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { issueCreateRequest: mocks },
}));

import {
  completeIssueCreate,
  parseIdempotencyKey,
  releaseIssueCreate,
  reserveIssueCreate,
} from "./create-idempotency";

const KEY = "a".repeat(32);

describe("create-idempotency", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("形式に合うキーだけを受け付ける", () => {
    expect(parseIdempotencyKey(KEY)).toBe(KEY);
    expect(parseIdempotencyKey("short")).toBeNull();
    expect(parseIdempotencyKey(123)).toBeNull();
    expect(parseIdempotencyKey("a/b".padEnd(20, "c"))).toBeNull();
  });

  it("初回は予約できる", async () => {
    mocks.create.mockResolvedValue({});
    expect(await reserveIssueCreate("u1", KEY)).toEqual({ kind: "reserved" });
  });

  it("作成済みのキーは保存した結果を返す", async () => {
    mocks.create.mockRejectedValue({ code: "P2002" });
    mocks.findUnique.mockResolvedValue({ status: "done", resultJson: '{"number":7}' });
    expect(await reserveIssueCreate("u1", KEY)).toEqual({ kind: "done", result: { number: 7 } });
  });

  it("結果が無い予約済みのキーは作成中（結果不明）として再作成しない", async () => {
    mocks.create.mockRejectedValue({ code: "P2002" });
    mocks.findUnique.mockResolvedValue({ status: "pending", resultJson: null });
    expect(await reserveIssueCreate("u1", KEY)).toEqual({ kind: "in_progress" });
  });

  it("一意制約以外の失敗は握りつぶさない", async () => {
    mocks.create.mockRejectedValue(new Error("db down"));
    await expect(reserveIssueCreate("u1", KEY)).rejects.toThrow("db down");
  });

  it("完了と解放は自分のキーだけを対象にする", async () => {
    mocks.update.mockResolvedValue({});
    await completeIssueCreate("u1", KEY, { number: 1 });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_key: { userId: "u1", key: KEY } } }),
    );
    await releaseIssueCreate("u1", KEY);
    expect(mocks.deleteMany).toHaveBeenLastCalledWith({
      where: { userId: "u1", key: KEY, status: "pending" },
    });
  });
});
