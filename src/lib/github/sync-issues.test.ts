import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { askClaudeCommentBody, QA_ANSWER_MARKER } from "@/lib/github/ask-claude";
import { FALLBACK_NOTICE_MARKER } from "@/lib/github/fallback-notice";
import { updateQaAnswerPendingState, upsertIssueFromWebhookPayload } from "@/lib/github/sync-issues";
import type { GithubApiIssue } from "@/lib/github/issues-api";

const findUnique = vi.fn();
const upsert = vi.fn();
const updateMany = vi.fn();
const $transaction = vi.fn();
const issueLabelUpsert = vi.fn();
const issueLabelDeleteMany = vi.fn();
const repositoryFindUnique = vi.fn();
const issueUpdate = vi.fn();
// closeでセッションを畳む後片付け（#1518）。ここでは「遷移したときだけ呼ぶ」ことだけを見る
const handleIssueClosedForDispatch = vi.fn();
// closeで残ると害になるラベルを外す後片付け（#2178）。外す対象の選別自体は
// `issue-close.test.ts`で見ているので、ここでは呼び出しとDBへの反映だけを見る
const clearLabelsOnIssueClose = vi.fn();
const getInstallationToken = vi.fn();

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/issue-close-cleanup", () => ({
  get clearLabelsOnIssueClose() {
    return clearLabelsOnIssueClose;
  },
}));

vi.mock("@/lib/dispatch/session-close", () => ({
  get handleIssueClosedForDispatch() {
    return handleIssueClosedForDispatch;
  },
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
      get updateMany() {
        return updateMany;
      },
      get update() {
        return issueUpdate;
      },
    },
    repository: {
      get findUnique() {
        return repositoryFindUnique;
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

  // Push通知（#838）の送信済み記録。送るのは巡回側（notifications/check-user-push.ts）で、
  // ここは「いつ記録を落とすか」だけを持つ
  it("00.check-userが付き直したら、Push通知の送信済み記録を落とす", async () => {
    findUnique.mockResolvedValue({
      githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      checkUserLabeledAt: null,
      checkUserPushSentAt: new Date("2026-08-01T00:00:00.000Z"),
      labels: [],
    });
    const raw = makeRawIssue({
      labels: [{ id: 1, name: "00.check-user", color: "d3f2d0", description: null }],
    });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ checkUserPushSentAt: null }) }),
    );
  });

  it("00.check-userが付いたまま変化していなければ、送信済み記録を維持する（同じ確認待ちで鳴らし直さない）", async () => {
    const labeledAt = new Date("2026-08-01T00:00:00.000Z");
    const sentAt = new Date("2026-08-01T00:03:00.000Z");
    findUnique.mockResolvedValue({
      githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      checkUserLabeledAt: labeledAt,
      checkUserPushSentAt: sentAt,
      labels: [{ name: "00.check-user" }],
    });
    const raw = makeRawIssue({
      labels: [{ id: 1, name: "00.check-user", color: "d3f2d0", description: null }],
    });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ checkUserPushSentAt: sentAt }) }),
    );
  });

  it("00.check-userが外れたら、送信済み記録もnullに戻す", async () => {
    findUnique.mockResolvedValue({
      githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      checkUserLabeledAt: new Date("2026-08-01T00:00:00.000Z"),
      checkUserPushSentAt: new Date("2026-08-01T00:03:00.000Z"),
      labels: [{ name: "00.check-user" }],
    });
    const raw = makeRawIssue({ labels: [] });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ checkUserPushSentAt: null }) }),
    );
  });
});

describe("updateQaAnswerPendingState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    updateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("質問コメントの場合、現在時刻を設定する", async () => {
    await updateQaAnswerPendingState(1, askClaudeCommentBody("質問内容"));

    expect(updateMany).toHaveBeenCalledWith({
      where: { githubIssueId: BigInt(1) },
      data: { qaAnswerPendingAt: NOW },
    });
  });

  it("回答コメントの場合、nullに戻す", async () => {
    await updateQaAnswerPendingState(1, `回答本文\n\n${QA_ANSWER_MARKER}`);

    expect(updateMany).toHaveBeenCalledWith({
      where: { githubIssueId: BigInt(1) },
      data: { qaAnswerPendingAt: null },
    });
  });

  it("回答できなかったことの通知の場合も、nullに戻す（#1766）", async () => {
    await updateQaAnswerPendingState(
      1,
      `⚠️ 質問への回答を投稿できませんでした。\n\n${FALLBACK_NOTICE_MARKER}`,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { githubIssueId: BigInt(1) },
      data: { qaAnswerPendingAt: null },
    });
  });

  it("通常のコメントの場合、何も更新しない", async () => {
    await updateQaAnswerPendingState(1, "通常の実装進捗コメント");

    expect(updateMany).not.toHaveBeenCalled();
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

/**
 * closeを検知してローカルセッションを畳む（#1518）。
 *
 * **「今CLOSEDである」ではなくOPEN→CLOSEDの遷移で1回だけ**という点がここの本体。
 * 現在の状態で判定すると、定期同期が回るたびに（closedなIssueで人が手で起こした
 * セッションも含めて）畳みに行ってしまう。
 */
describe("upsertIssueFromWebhookPayload のclose検知", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    findUnique.mockReset();
    upsert.mockReset().mockImplementation(async ({ update }) => ({ id: "issue-1", ...update }));
    issueLabelUpsert.mockReset().mockResolvedValue(undefined);
    issueLabelDeleteMany.mockReset().mockResolvedValue(undefined);
    $transaction.mockReset().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
    repositoryFindUnique.mockReset().mockResolvedValue({
      fullName: "guchi-apps/issue-deck",
      ownerLogin: "guchi-apps",
      name: "issue-deck",
      installation: { installationId: 42 },
    });
    issueUpdate.mockReset().mockResolvedValue(undefined);
    getInstallationToken.mockReset().mockResolvedValue("token");
    clearLabelsOnIssueClose.mockReset().mockResolvedValue([]);
    handleIssueClosedForDispatch.mockReset().mockResolvedValue({
      killedHosts: [],
      skipped: [],
      canceledJobs: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function existingIssue(state: "OPEN" | "CLOSED") {
    return {
      state,
      githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      checkUserLabeledAt: null,
      lastCommentAt: null,
      labels: [],
    };
  }

  it("OPENからCLOSEDへ変わったとき、走っているセッションの後片付けを呼ぶ", async () => {
    findUnique.mockResolvedValue(existingIssue("OPEN"));
    const raw = makeRawIssue({ number: 1518, state: "closed", state_reason: "completed" });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(handleIssueClosedForDispatch).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1518,
    });
  });

  it("すでにCLOSEDだったIssueの更新では呼ばない（定期同期で毎回畳まない）", async () => {
    findUnique.mockResolvedValue(existingIssue("CLOSED"));
    const raw = makeRawIssue({ state: "closed", state_reason: "completed" });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(handleIssueClosedForDispatch).not.toHaveBeenCalled();
  });

  it("OPENのままの更新では呼ばない", async () => {
    findUnique.mockResolvedValue(existingIssue("OPEN"));

    await upsertIssueFromWebhookPayload("repo-1", makeRawIssue());

    expect(handleIssueClosedForDispatch).not.toHaveBeenCalled();
  });

  it("初めて取り込むIssueがCLOSEDでも呼ばない（遷移ではない）", async () => {
    findUnique.mockResolvedValue(null);
    const raw = makeRawIssue({ state: "closed", state_reason: "completed" });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(handleIssueClosedForDispatch).not.toHaveBeenCalled();
  });

  it("反映済みより古いペイロードでは呼ばない（Webhookの配信順序の入れ替わり対策）", async () => {
    findUnique.mockResolvedValue({
      ...existingIssue("OPEN"),
      githubUpdatedAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    const raw = makeRawIssue({
      state: "closed",
      state_reason: "completed",
      updated_at: "2026-08-01T00:00:00.000Z",
    });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(upsert).not.toHaveBeenCalled();
    expect(handleIssueClosedForDispatch).not.toHaveBeenCalled();
  });

  it("リポジトリの行が引けないときは何もしない（owner/repoが組み立てられない）", async () => {
    findUnique.mockResolvedValue(existingIssue("OPEN"));
    repositoryFindUnique.mockResolvedValue(null);
    const raw = makeRawIssue({ state: "closed", state_reason: "completed" });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(handleIssueClosedForDispatch).not.toHaveBeenCalled();
    expect(clearLabelsOnIssueClose).not.toHaveBeenCalled();
  });

  it("OPENからCLOSEDへ変わったとき、残ると害になるラベルの除去へ今のラベル一覧を渡す", async () => {
    findUnique.mockResolvedValue(existingIssue("OPEN"));
    clearLabelsOnIssueClose.mockResolvedValue(["11.local"]);
    const raw = makeRawIssue({
      number: 2178,
      state: "closed",
      state_reason: "completed",
      labels: [
        { id: 1, name: "11.local", color: "ededed", description: null },
        { id: 2, name: "50.feature", color: "a2eeef", description: null },
      ],
    });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(clearLabelsOnIssueClose).toHaveBeenCalledWith({
      owner: "guchi-apps",
      repo: "issue-deck",
      issueNumber: 2178,
      token: "token",
      currentLabelNames: ["11.local", "50.feature"],
    });
    // 画面がWebhookの往復を待たずに反映できるよう、DBの行も落とす
    expect(issueLabelDeleteMany).toHaveBeenCalledWith({
      where: { issueId: "issue-1", name: { in: ["11.local"] } },
    });
  });

  it("対象ラベルが1枚も付いていなければ、トークンの取得すら行わない", async () => {
    findUnique.mockResolvedValue(existingIssue("OPEN"));
    const raw = makeRawIssue({
      state: "closed",
      state_reason: "completed",
      labels: [{ id: 2, name: "50.feature", color: "a2eeef", description: null }],
    });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(clearLabelsOnIssueClose).not.toHaveBeenCalled();
  });

  it("`00.check-user`を外したときは、確認待ちの基準時刻とPush通知の記録も戻す", async () => {
    findUnique.mockResolvedValue(existingIssue("OPEN"));
    clearLabelsOnIssueClose.mockResolvedValue(["00.check-user", "01.check-plan"]);
    const raw = makeRawIssue({
      state: "closed",
      state_reason: "not_planned",
      labels: [
        { id: 1, name: "00.check-user", color: "d93f0b", description: null },
        { id: 2, name: "01.check-plan", color: "fbca04", description: null },
      ],
    });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(issueUpdate).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: { checkUserLabeledAt: null, checkUserPushSentAt: null },
    });
  });

  it("すでにCLOSEDだったIssueの更新ではラベルを外しに行かない（定期同期で毎回叩かない）", async () => {
    findUnique.mockResolvedValue(existingIssue("CLOSED"));
    const raw = makeRawIssue({
      state: "closed",
      state_reason: "completed",
      labels: [{ id: 1, name: "11.local", color: "ededed", description: null }],
    });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    expect(clearLabelsOnIssueClose).not.toHaveBeenCalled();
  });
});
