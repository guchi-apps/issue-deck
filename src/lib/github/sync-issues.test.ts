import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { askClaudeCommentBody, QA_ANSWER_MARKER } from "@/lib/github/ask-claude";
import { FALLBACK_NOTICE_MARKER } from "@/lib/github/fallback-notice";
import {
  deleteTransferredSourceIssue,
  updateQaAnswerPendingState,
  upsertIssueFromWebhookPayload,
} from "@/lib/github/sync-issues";
import type { GithubApiIssue } from "@/lib/github/issues-api";

const findUnique = vi.fn();
const upsert = vi.fn();
const updateMany = vi.fn();
const $transaction = vi.fn();
const issueLabelCreateMany = vi.fn();
const issueLabelUpdateMany = vi.fn();
const issueLabelDeleteMany = vi.fn();
const repositoryFindUnique = vi.fn();
const issueUpdate = vi.fn();
const issueDeleteMany = vi.fn();
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
      get deleteMany() {
        return issueDeleteMany;
      },
    },
    repository: {
      get findUnique() {
        return repositoryFindUnique;
      },
    },
    issueLabel: {
      get createMany() {
        return issueLabelCreateMany;
      },
      get updateMany() {
        return issueLabelUpdateMany;
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
    issueLabelCreateMany.mockReset().mockResolvedValue({ count: 0 });
    issueLabelUpdateMany.mockReset().mockResolvedValue({ count: 0 });
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

  // #2300: 読んだ値を書き戻すと、`existing`を読んでからupsertするまでの隙間に巡回側が
  // 立てた記録を消してしまい、同じ通知がもう一度送られる
  it("00.check-userが付いたまま変化していなければ、送信済み記録の列を書かない（同じ確認待ちで鳴らし直さない）", async () => {
    const labeledAt = new Date("2026-08-01T00:00:00.000Z");
    findUnique.mockResolvedValue({
      githubUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
      checkUserLabeledAt: labeledAt,
      checkUserPushSentAt: new Date("2026-08-01T00:03:00.000Z"),
      labels: [{ name: "00.check-user" }],
    });
    const raw = makeRawIssue({
      labels: [{ id: 1, name: "00.check-user", color: "d3f2d0", description: null }],
    });

    await upsertIssueFromWebhookPayload("repo-1", raw);

    const update = upsert.mock.calls.at(-1)?.[0].update;
    expect(update).not.toHaveProperty("checkUserPushSentAt");
    expect(update).toEqual(expect.objectContaining({ checkUserLabeledAt: labeledAt }));
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
    issueLabelCreateMany.mockReset().mockResolvedValue({ count: 0 });
    issueLabelUpdateMany.mockReset().mockResolvedValue({ count: 0 });
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
    issueLabelCreateMany.mockReset().mockResolvedValue({ count: 0 });
    issueLabelUpdateMany.mockReset().mockResolvedValue({ count: 0 });
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

/**
 * ラベルの同期（#2365）。
 *
 * **1件ずつの`upsert`はP2002で落ちる。** 複合ユニークキーへのPrismaの`upsert`はMySQLでは
 * 「SELECT→INSERT」に分かれるため、同じIssueの同期が同時に2本走ると後発が
 * `IssueLabel_issueId_name_key`で落ち、Webhookの処理が丸ごと失敗する（後段のclose検知にも
 * 到達しない）。ここでは競合しても落ちない書き方（`INSERT IGNORE`＋`updateMany`）に
 * なっていることを見る。
 */
describe("upsertIssueFromWebhookPayload のラベル同期", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    findUnique.mockReset().mockResolvedValue(null);
    upsert.mockReset().mockImplementation(async ({ update }) => ({ id: "issue-1", ...update }));
    issueLabelCreateMany.mockReset().mockResolvedValue({ count: 0 });
    issueLabelUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    issueLabelDeleteMany.mockReset().mockResolvedValue(undefined);
    issueUpdate.mockReset().mockResolvedValue(undefined);
    $transaction.mockReset().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const LABELS = [
    { id: 1, name: "11.local", color: "ededed", description: null },
    { id: 2, name: "40.unexpected", color: "d73a4a", description: "想定外の挙動" },
  ];

  it("同時実行で落ちない書き方で入れる（skipDuplicates付きのcreateMany）", async () => {
    await upsertIssueFromWebhookPayload("repo-1", makeRawIssue({ labels: LABELS }));

    expect(issueLabelCreateMany).toHaveBeenCalledWith({
      data: [
        {
          issueId: "issue-1",
          name: "11.local",
          color: "ededed",
          description: null,
          githubLabelId: BigInt(1),
        },
        {
          issueId: "issue-1",
          name: "40.unexpected",
          color: "d73a4a",
          description: "想定外の挙動",
          githubLabelId: BigInt(2),
        },
      ],
      skipDuplicates: true,
    });
  });

  it("色・説明・GitHubのラベルIDの追随は、ユニークキーを動かさないupdateManyで行う", async () => {
    await upsertIssueFromWebhookPayload("repo-1", makeRawIssue({ labels: LABELS }));

    expect(issueLabelUpdateMany).toHaveBeenCalledTimes(2);
    expect(issueLabelUpdateMany).toHaveBeenCalledWith({
      where: { issueId: "issue-1", name: "40.unexpected" },
      data: { color: "d73a4a", description: "想定外の挙動", githubLabelId: BigInt(2) },
    });
  });

  it("GitHub側で外れたラベルはDBからも消す", async () => {
    await upsertIssueFromWebhookPayload("repo-1", makeRawIssue({ labels: LABELS }));

    expect(issueLabelDeleteMany).toHaveBeenCalledWith({
      where: { issueId: "issue-1", name: { notIn: ["11.local", "40.unexpected"] } },
    });
  });

  it("ラベルが1枚も無いIssueでは空配列のINSERTを投げず、全部消すだけにする", async () => {
    await upsertIssueFromWebhookPayload("repo-1", makeRawIssue({ labels: [] }));

    expect(issueLabelCreateMany).not.toHaveBeenCalled();
    expect(issueLabelUpdateMany).not.toHaveBeenCalled();
    expect(issueLabelDeleteMany).toHaveBeenCalledWith({
      where: { issueId: "issue-1", name: { notIn: [] } },
    });
  });

  // Issue本体のupsertも同じ競合を持つ（まだDBに無いIssueへ同時に2本届くと後発が
  // `Issue_githubIssueId_key`で落ちる）。落ちた側はUPDATEへ回して処理を続ける
  it("Issue本体のINSERTが競合したら、UPDATEへ回して処理を続ける", async () => {
    upsert.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    issueUpdate.mockResolvedValue({ id: "issue-1", number: 1 });

    await upsertIssueFromWebhookPayload("repo-1", makeRawIssue({ labels: LABELS }));

    expect(issueUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { githubIssueId: BigInt(1) } }),
    );
    expect(issueLabelCreateMany).toHaveBeenCalled();
  });

  it("ユニーク制約違反以外のエラーは握り潰さない", async () => {
    upsert.mockRejectedValue(Object.assign(new Error("接続できません"), { code: "P1001" }));

    await expect(upsertIssueFromWebhookPayload("repo-1", makeRawIssue())).rejects.toThrow(
      "接続できません",
    );
    expect(issueUpdate).not.toHaveBeenCalled();
  });
});

/**
 * 同じIssueの同期を直列に流す（#2365）。
 *
 * この関数はDBを「読んでから書く」ため、同時に2本走ると両方が同じ読んだ値を見て書きに行く。
 * 本番のP2002はこれで、開発DBでの実測では同時2本でも高い確率でP2002／P2034に落ちた。
 */
describe("upsertIssueFromWebhookPayload の直列化", () => {
  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset().mockImplementation(async ({ update }) => ({ id: "issue-1", ...update }));
    issueLabelCreateMany.mockReset().mockResolvedValue({ count: 0 });
    issueLabelUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    issueLabelDeleteMany.mockReset().mockResolvedValue(undefined);
    $transaction.mockReset().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
  });

  it("同じIssueへ同時に届いても、前の書き込みが終わるまで次の読み取りを始めない", async () => {
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    findUnique.mockImplementationOnce(async () => {
      await firstRead;
      return null;
    });
    findUnique.mockResolvedValue(null);

    const raw = makeRawIssue({ id: 2365 });
    const both = Promise.all([
      upsertIssueFromWebhookPayload("repo-1", raw),
      upsertIssueFromWebhookPayload("repo-1", raw),
    ]);

    await Promise.resolve();
    expect(findUnique).toHaveBeenCalledTimes(1);

    releaseFirst();
    await both;
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("別のIssueは待たせない", async () => {
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    findUnique.mockImplementationOnce(async () => {
      await firstRead;
      return null;
    });
    findUnique.mockResolvedValue(null);

    const blocked = upsertIssueFromWebhookPayload("repo-1", makeRawIssue({ id: 2365 }));
    await upsertIssueFromWebhookPayload("repo-1", makeRawIssue({ id: 2366 }));

    expect(findUnique).toHaveBeenCalledTimes(2);
    releaseFirst();
    await blocked;
  });
});

describe("deleteTransferredSourceIssue", () => {
  beforeEach(() => {
    issueDeleteMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it("移動元リポジトリの同じ番号の行を、移動後のIssue IDを除いて消す", async () => {
    await deleteTransferredSourceIssue("repo-source", 420, 456);

    expect(issueDeleteMany).toHaveBeenCalledWith({
      where: {
        repositoryId: "repo-source",
        number: 420,
        githubIssueId: { not: BigInt(456) },
      },
    });
  });
});
