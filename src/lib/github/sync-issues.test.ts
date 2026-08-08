import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { upsertIssueFromWebhookPayload } from "@/lib/github/sync-issues";
import type { GithubApiIssue } from "@/lib/github/issues-api";

const findUnique = vi.fn();
const upsert = vi.fn();
const $transaction = vi.fn();
const issueLabelUpsert = vi.fn();
const issueLabelDeleteMany = vi.fn();

vi.mock("@/lib/github/app-auth", () => ({
  getInstallationToken: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    issue: {
      get findUnique() {
        return findUnique;
      },
      get upsert() {
        return upsert;
      },
    },
    issueLabel: {
      get upsert() {
        return issueLabelUpsert;
      },
      get deleteMany() {
        return issueLabelDeleteMany;
      },
    },
    get $transaction() {
      return $transaction;
    },
  },
}));

function makeRawIssue(overrides: Partial<GithubApiIssue> = {}): GithubApiIssue {
  return {
    id: 1,
    number: 1,
    title: "サンプルIssue",
    body: "本文",
    state: "open",
    state_reason: null,
    html_url: "https://github.com/owner/repo/issues/1",
    user: { login: "author" },
    assignee: null,
    labels: [],
    milestone: null,
    comments: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    closed_at: null,
    ...overrides,
  };
}

const NOW = new Date("2026-08-06T00:00:00.000Z");

describe("upsertIssueFromWebhookPayload の checkUserLabeledAt 更新", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    findUnique.mockReset();
    upsert.mockReset().mockImplementation(async ({ update }) => ({ id: "issue-1", ...update }));
    issueLabelUpsert.mockReset().mockResolvedValue(undefined);
    issueLabelDeleteMany.mockReset().mockResolvedValue(undefined);
    $transaction.mockReset().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("新規Issueに00.check-userが付いている場合、現在時刻を設定する", async () => {
    findUnique.mockResolvedValue(null);
    const raw = makeRawIssue({
      labels: [{ id: 1, name: "00.check-user", color: "d3f2d0", description: null }],
    });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ checkUserLabeledAt: NOW }),
        update: expect.objectContaining({ checkUserLabeledAt: NOW }),
      }),
    );
  });

  it("既存Issueに00.check-userが新たに付与された場合、現在時刻を設定する", async () => {
    findUnique.mockResolvedValue({
      githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      checkUserLabeledAt: null,
      labels: [],
    });
    const raw = makeRawIssue({
      labels: [{ id: 1, name: "00.check-user", color: "d3f2d0", description: null }],
    });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ checkUserLabeledAt: NOW }) }),
    );
  });

  it("00.check-userが付いたまま変化していない場合、既存の日時を維持する", async () => {
    const labeledAt = new Date("2026-08-01T00:00:00.000Z");
    findUnique.mockResolvedValue({
      githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      checkUserLabeledAt: labeledAt,
      labels: [{ name: "00.check-user" }],
    });
    const raw = makeRawIssue({
      labels: [{ id: 1, name: "00.check-user", color: "d3f2d0", description: null }],
    });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ checkUserLabeledAt: labeledAt }) }),
    );
  });

  it("00.check-userが外れた場合、nullに戻す", async () => {
    findUnique.mockResolvedValue({
      githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      checkUserLabeledAt: new Date("2026-08-01T00:00:00.000Z"),
      labels: [{ name: "00.check-user" }],
    });
    const raw = makeRawIssue({ labels: [] });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ checkUserLabeledAt: null }) }),
    );
  });
});

describe("upsertIssueFromWebhookPayload の lastCommentAt 更新", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    findUnique.mockReset();
    upsert.mockReset().mockImplementation(async ({ update }) => ({ id: "issue-1", ...update }));
    issueLabelUpsert.mockReset().mockResolvedValue(undefined);
    issueLabelDeleteMany.mockReset().mockResolvedValue(undefined);
    $transaction.mockReset().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("コメント投稿日時が渡された場合、lastCommentAtに設定する", async () => {
    findUnique.mockResolvedValue({
      githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      checkUserLabeledAt: null,
      lastCommentAt: null,
      labels: [],
    });
    const raw = makeRawIssue();
    const commentCreatedAt = new Date("2026-08-05T00:00:00.000Z");

    await upsertIssueFromWebhookPayload("repo-1", raw, commentCreatedAt);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ lastCommentAt: commentCreatedAt }),
      }),
    );
  });

  it("既存のlastCommentAtより古いコメント投稿日時が渡された場合、既存の日時を維持する（Webhookの配信順序の入れ替わり対策）", async () => {
    const existingLastCommentAt = new Date("2026-08-05T00:00:00.000Z");
    findUnique.mockResolvedValue({
      githubUpdatedAt: new Date("2026-08-05T00:00:00.000Z"),
      checkUserLabeledAt: null,
      lastCommentAt: existingLastCommentAt,
      labels: [],
    });
    const raw = makeRawIssue({ updated_at: "2026-08-06T00:00:00.000Z" });
    const olderCommentCreatedAt = new Date("2026-08-01T00:00:00.000Z");

    await upsertIssueFromWebhookPayload("repo-1", raw, olderCommentCreatedAt);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ lastCommentAt: existingLastCommentAt }),
      }),
    );
  });

  it("コメント投稿日時が渡されない場合、既存のlastCommentAtを維持する", async () => {
    const existingLastCommentAt = new Date("2026-08-01T00:00:00.000Z");
    findUnique.mockResolvedValue({
      githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      checkUserLabeledAt: null,
      lastCommentAt: existingLastCommentAt,
      labels: [],
    });
    const raw = makeRawIssue();

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ lastCommentAt: existingLastCommentAt }),
      }),
    );
  });
});
