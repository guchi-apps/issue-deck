import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestCreate: vi.fn(),
  requestUpdate: vi.fn(),
  requestUpdateMany: vi.fn(),
  requestFindUnique: vi.fn(),
  requestFindMany: vi.fn(),
  eventCreate: vi.fn(),
  userFind: vi.fn(),
  repoFindMany: vi.fn(),
  issueFindFirst: vi.fn(),
  convCreate: vi.fn(),
  convFind: vi.fn(),
  handleChatMessage: vi.fn(),
  executeConfirmedCard: vi.fn(),
  findRepositoryByFullName: vi.fn(),
  createComment: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const db: Record<string, unknown> = {
    slackIntakeRequest: {
      create: mocks.requestCreate,
      update: mocks.requestUpdate,
      updateMany: mocks.requestUpdateMany,
      findUnique: mocks.requestFindUnique,
      findMany: mocks.requestFindMany,
    },
    slackProcessedEvent: { create: mocks.eventCreate },
    user: { findUnique: mocks.userFind },
    repository: { findMany: mocks.repoFindMany },
    issue: { findFirst: mocks.issueFindFirst },
    chatConversation: { create: mocks.convCreate, findUnique: mocks.convFind, update: vi.fn() },
    chatMessage: { create: vi.fn() },
  };
  // 対話型トランザクションは同じモックをtxとして渡す（配列形式は何もしない）
  db.$transaction = vi.fn(async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => unknown)(db) : []));
  return { db };
});
vi.mock("@/lib/chat/handlers", () => ({
  handleChatMessage: mocks.handleChatMessage,
  executeConfirmedCard: mocks.executeConfirmedCard,
}));
vi.mock("@/lib/github/issue-create-service", () => ({ findRepositoryByFullName: mocks.findRepositoryByFullName }));
vi.mock("@/lib/github/issues-api", () => ({ createComment: mocks.createComment }));
vi.mock("@/lib/github/with-user-github-token", () => ({
  withUserGithubToken: async (_u: unknown, _c: string, fn: (t: string) => Promise<unknown>) => ({ value: await fn("gh-token") }),
}));

import {
  acceptMessageEvent,
  claimEvent,
  handleInteraction,
  handleMessageEvent as handleWithEventId,
  processPendingRequest,
  resumeStalePendingRequests,
  type IntakeContext,
  type SlackMessageEvent,
} from "@/lib/slack/intake";

const handleMessageEvent = (c: IntakeContext, teamId: string, event: SlackMessageEvent) =>
  handleWithEventId(c, teamId, `E-${event.ts}`, event);

const config = {
  signingSecret: "s",
  botToken: "t",
  teamIds: ["T1"],
  channelIds: ["C1"],
  userMap: { U1: "user-1" },
  repoOwners: [],
};
const call = vi.fn();
const ctx: IntakeContext = { config, client: { call } };

const baseRequest = {
  id: "req-1",
  teamId: "T1",
  channelId: "C1",
  parentTs: "100.1",
  slackUserId: "U1",
  userId: "user-1",
  permalink: "https://slack.example/p100",
  text: "car-careのホームに車検の期限表示がほしい",
  selectedRepo: null as string | null,
  status: "awaiting_repo",
  failure: null,
  conversationId: null as string | null,
  proposal: null as unknown,
  confirmState: null as string | null,
  issues: [] as unknown,
  selectorTs: "100.2",
  updatedAt: new Date("2026-10-12T00:00:00Z"),
};

const postedTexts = () => call.mock.calls.filter(([m]) => m === "chat.postMessage").map(([, b]) => (b as { text: string }).text);
const issueCard = { type: "confirm_issue", repo: "guchi-apps/car-care", title: "車検の期限表示", body: "本文", duplicates: [] };

beforeEach(() => {
  vi.clearAllMocks();
  call.mockImplementation(async (method: string) => (method === "chat.getPermalink" ? { permalink: "https://slack.example/p100" } : { ts: "200.1" }));
  // 作った行を以後のfindUniqueで返す（受付→ack後の処理の順に読まれるため）
  mocks.requestCreate.mockImplementation(async ({ data }: { data: object }) => {
    const created = { ...baseRequest, permalink: null, selectorTs: null, ...data };
    mocks.requestFindUnique.mockResolvedValue(created);
    return created;
  });
  mocks.requestUpdate.mockImplementation(async ({ data }: { data: object }) => ({ ...baseRequest, ...data }));
  mocks.requestUpdateMany.mockResolvedValue({ count: 1 });
  mocks.requestFindMany.mockResolvedValue([]);
  mocks.eventCreate.mockResolvedValue({});
  mocks.userFind.mockResolvedValue({ id: "user-1", githubAccessToken: "x", githubRefreshToken: null });
  mocks.repoFindMany.mockResolvedValue([
    { fullName: "guchi-apps/car-care", name: "car-care" },
    { fullName: "guchi-apps/issue-deck", name: "issue-deck" },
  ]);
  mocks.findRepositoryByFullName.mockResolvedValue({ id: "repo-1", fullName: "guchi-apps/car-care" });
  mocks.convCreate.mockResolvedValue({ id: "conv-1", context: { repo: "guchi-apps/car-care", targets: [], actions: [] } });
  mocks.issueFindFirst.mockResolvedValue(null);
});

const msg = (over: object = {}) => ({ type: "message", user: "U1", ts: "100.1", channel: "C1", text: "改善したい", ...over });

describe("イベントの受け付け", () => {
  it("Bot投稿・編集/リンク展開・対象外チャンネル・未対応ユーザー・別Workspaceは無視する", async () => {
    await handleMessageEvent(ctx, "T1", msg({ bot_id: "B1" }));
    await handleMessageEvent(ctx, "T1", msg({ app_id: "A1" }));
    await handleMessageEvent(ctx, "T1", msg({ subtype: "message_changed" }));
    await handleMessageEvent(ctx, "T1", msg({ channel: "C9" }));
    await handleMessageEvent(ctx, "T1", msg({ user: "U9" }));
    await handleMessageEvent(ctx, "T9", msg());
    expect(mocks.requestCreate).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("新規投稿には👀と選択UIを返し、確定前はIssueも調査も始めない。返信は依頼者メンション付き", async () => {
    await handleMessageEvent(ctx, "T1", msg({ text: "car-careのホームに車検の期限表示がほしい" }));
    expect(call.mock.calls.some(([m, b]) => m === "reactions.add" && (b as { name: string }).name === "eyes")).toBe(true);
    const texts = postedTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0].startsWith("<@U1> ")).toBe(true);
    const blocks = (call.mock.calls.find(([m]) => m === "chat.postMessage")![1] as { blocks: { elements?: { initial_option?: { value: string } }[] }[] }).blocks;
    expect(JSON.stringify(blocks)).toContain("guchi-apps/car-care");
    expect(mocks.handleChatMessage).not.toHaveBeenCalled();
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
  });

  it("同じ親投稿の再処理（一意制約違反）では何も投稿しない", async () => {
    mocks.requestCreate.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    await handleMessageEvent(ctx, "T1", msg());
    expect(call.mock.calls.filter(([m]) => m === "chat.postMessage")).toHaveLength(0);
  });

  it("処理済みイベントは2回目をfalseにする", async () => {
    mocks.eventCreate.mockResolvedValueOnce({}).mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    expect(await claimEvent("event:E1", "1.0")).toBe(true);
    expect(await claimEvent("event:E1", "1.0")).toBe(false);
  });
});

const dup = () => new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });

describe("ack前の受付と、ack後の処理の再開（#4488）", () => {
  it("ack前はDBへの保存だけを行い、処理済み記録と依頼（received）を同じトランザクションで書く", async () => {
    const accepted = await acceptMessageEvent(config, "T1", "E1", msg({ text: "改善したい" }));
    expect(accepted).toEqual({ kind: "queued", requestId: "req-1" });
    expect(mocks.eventCreate).toHaveBeenCalledWith({ data: { eventKey: "event:E1", messageTs: "100.1" } });
    expect(mocks.requestCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "received", text: "改善したい", parentTs: "100.1" }) });
    // Slack APIはack前に呼ばない（3秒制限）
    expect(call).not.toHaveBeenCalled();
  });

  it("保存前にDBが落ちていたら例外を投げる（受け口が非2xxを返し、Slackが再送する）", async () => {
    mocks.eventCreate.mockRejectedValueOnce(new Error("connection refused"));
    await expect(acceptMessageEvent(config, "T1", "E1", msg())).rejects.toThrow("connection refused");
    mocks.requestCreate.mockRejectedValueOnce(new Error("connection lost"));
    await expect(acceptMessageEvent(config, "T1", "E1", msg())).rejects.toThrow("connection lost");
    expect(call).not.toHaveBeenCalled();
  });

  it("重複配信（同じイベントID・同じ親投稿の別イベント）は依頼を作らず何も投稿しない", async () => {
    mocks.eventCreate.mockRejectedValueOnce(dup());
    expect(await acceptMessageEvent(config, "T1", "E1", msg())).toEqual({ kind: "duplicate" });
    mocks.requestCreate.mockRejectedValueOnce(dup());
    expect(await acceptMessageEvent(config, "T1", "E2", msg())).toEqual({ kind: "duplicate" });
    expect(call).not.toHaveBeenCalled();
  });

  it("ack後に依頼を進めると選択UIを出し、awaiting_repoへ進める", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, status: "received", permalink: null, selectorTs: null });
    await processPendingRequest(ctx, "req-1");
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "req-1", status: "received", updatedAt: baseRequest.updatedAt } }),
    );
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { permalink: "https://slack.example/p100" } }));
    expect(mocks.requestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "awaiting_repo", selectorTs: "200.1", selectedRepo: null } }),
    );
    expect(postedTexts()).toHaveLength(1);
  });

  it("他で処理中（処理権を取れない）・待ち状態でない・巡回時点でまだ新しい行は進めない", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, status: "received" });
    mocks.requestUpdateMany.mockResolvedValueOnce({ count: 0 });
    await processPendingRequest(ctx, "req-1");
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, status: "awaiting_repo" });
    await processPendingRequest(ctx, "req-1");
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, status: "received", updatedAt: new Date("2026-10-12T00:10:00Z") });
    await processPendingRequest(ctx, "req-1", new Date("2026-10-12T00:05:00Z"));
    expect(call).not.toHaveBeenCalled();
  });

  it("ack後にプロセスが止まって受付のまま残った依頼は、巡回が拾い直して選択UIを出す", async () => {
    const now = new Date("2026-10-12T01:00:00Z");
    mocks.requestFindMany.mockImplementation(async ({ where }: { where: { status: string } }) =>
      where.status === "received" ? [{ id: "req-1" }] : [],
    );
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, status: "received", updatedAt: new Date("2026-10-12T00:00:00Z") });
    expect(await resumeStalePendingRequests(ctx, now)).toBe(1);
    expect(mocks.requestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "received", updatedAt: { lt: new Date("2026-10-12T00:58:00Z") } } }),
    );
    expect(mocks.requestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "resuming", updatedAt: { lt: new Date("2026-10-12T00:30:00Z") } } }),
    );
    expect(postedTexts().some((t) => t.includes("対象リポジトリ"))).toBe(true);
  });

  it("ack後の処理が失敗したら失敗状態で残し、「再開」の返信から続けられる", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    call.mockImplementation(async (method: string) => {
      if (method === "chat.postMessage") throw new Error("slack down");
      return {};
    });
    await handleMessageEvent(ctx, "T1", msg());
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));

    // 再開: ack前に`resuming`へ書き、ack後に選択UIを出し直す
    call.mockImplementation(async () => ({ ts: "300.1" }));
    mocks.requestUpdate.mockClear();
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, status: "failed" });
    const accepted = await acceptMessageEvent(config, "T1", "E-resume", msg({ ts: "101.1", thread_ts: "100.1", text: "再開" }));
    expect(accepted).toEqual({ kind: "queued", requestId: "req-1" });
    expect(mocks.requestUpdate).toHaveBeenCalledWith({ where: { id: "req-1" }, data: { status: "resuming", failure: null } });
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, status: "resuming" });
    await processPendingRequest(ctx, "req-1");
    expect(mocks.requestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "awaiting_repo", selectorTs: "300.1", selectedRepo: null } }),
    );
  });

  it("起案前の補足はack前にDBへ足して終える", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, status: "awaiting_repo" });
    const accepted = await acceptMessageEvent(config, "T1", "E5", msg({ ts: "101.1", thread_ts: "100.1", text: "スマホでも" }));
    expect(accepted).toEqual({ kind: "handled" });
    expect(mocks.requestUpdate).toHaveBeenCalledWith({ where: { id: "req-1" }, data: { text: `${baseRequest.text}\n\n（補足）スマホでも` } });
    expect(call).not.toHaveBeenCalled();
  });
});

describe("対象の確定と起案", () => {
  const confirmPayload = (over: object = {}) => ({
    type: "block_actions",
    team: { id: "T1" },
    user: { id: "U1" },
    channel: { id: "C1" },
    state: { values: { "repo:req-1": { slack_repo_select: { selected_option: { value: "guchi-apps/car-care" } } } } },
    actions: [{ action_id: "slack_repo_confirm", value: "req-1" }],
    ...over,
  });

  it("依頼者以外の操作・権限の無いリポジトリの選択では調査を始めない", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest });
    await handleInteraction(ctx, confirmPayload({ user: { id: "U2" } }));
    expect(mocks.requestUpdateMany).not.toHaveBeenCalled();
    await handleInteraction(
      ctx,
      confirmPayload({ state: { values: { "repo:req-1": { slack_repo_select: { selected_option: { value: "other/private" } } } } } }),
    );
    expect(mocks.requestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.handleChatMessage).not.toHaveBeenCalled();
    expect(postedTexts().some((t) => t.includes("起案できません"))).toBe(true);
  });

  it("確定した対象で調査し、Issue案を確認ボタン付きで出す（まだ作らない）", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest });
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.handleChatMessage.mockResolvedValue({ text: "案です", cards: [issueCard], needsConfirm: true, nextContext: { repo: "guchi-apps/car-care", targets: [], actions: [] } });
    await handleInteraction(ctx, confirmPayload());
    expect(mocks.findRepositoryByFullName).toHaveBeenCalledWith("user-1", "guchi-apps/car-care");
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    const proposalPost = postedTexts().find((t) => t.includes("この案で起案する"));
    expect(proposalPost?.startsWith("<@U1> ")).toBe(true);
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "awaiting_confirm", confirmState: "pending" }) }));
  });

  it("連打: 確定済み（updateMany=0）なら2回目は調査も投稿もしない", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest });
    mocks.requestUpdateMany.mockResolvedValue({ count: 0 });
    await handleInteraction(ctx, confirmPayload());
    expect(mocks.handleChatMessage).not.toHaveBeenCalled();
    expect(call.mock.calls.filter(([m]) => m === "chat.postMessage")).toHaveLength(0);
  });

  it("元投稿のpermalinkで既に起案済みなら新規Issueを作らず既存を返す", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest });
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.issueFindFirst.mockResolvedValue({ number: 212, title: "既存", htmlUrl: "https://github.com/guchi-apps/car-care/issues/212", state: "OPEN" });
    await handleInteraction(ctx, confirmPayload());
    expect(mocks.handleChatMessage).not.toHaveBeenCalled();
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(postedTexts().some((t) => t.includes("起案済み") && t.includes("212"))).toBe(true);
  });
});

describe("Issueの作成・追記", () => {
  const proposed = {
    ...baseRequest,
    selectedRepo: "guchi-apps/car-care",
    status: "awaiting_confirm",
    confirmState: "pending",
    conversationId: "conv-1",
    proposal: { card: issueCard, splitFrom: null },
  };
  const click = (actionId: string, value = "req-1") => ({
    type: "block_actions",
    team: { id: "T1" },
    user: { id: "U1" },
    channel: { id: "C1" },
    actions: [{ action_id: actionId, value }],
  });

  it("「この案で起案する」は1回だけ作成し、元投稿のpermalinkを本文へ入れる", async () => {
    mocks.requestFindUnique.mockResolvedValue(proposed);
    mocks.requestUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    mocks.convFind.mockResolvedValue({ id: "conv-1", context: { repo: "guchi-apps/car-care", targets: [], actions: [] } });
    mocks.executeConfirmedCard.mockResolvedValue({
      ok: true,
      text: "Issue #300 を作成しました。",
      card: { type: "result", ok: true, title: "t", detail: null, htmlUrl: null },
      action: { type: "create_issue", status: "created", repo: "guchi-apps/car-care", number: 300, at: "", message: "" },
    });
    await handleInteraction(ctx, click("slack_issue_confirm"));
    await handleInteraction(ctx, click("slack_issue_confirm"));
    expect(mocks.executeConfirmedCard).toHaveBeenCalledTimes(1);
    const overrides = mocks.executeConfirmedCard.mock.calls[0][2] as { body: string };
    expect(overrides.body).toContain("https://slack.example/p100");
    expect(overrides.body).toContain("slack-intake: T1/C1/100.1");
    expect(postedTexts().some((t) => t.startsWith("<@U1> ✅") && t.includes("#300"))).toBe(true);
  });

  it("GitHubの作成に失敗したら完了とせず⚠️・理由・再開方法を返し、押し直せるよう戻す", async () => {
    mocks.requestFindUnique.mockResolvedValue(proposed);
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.executeConfirmedCard.mockResolvedValue({ ok: false, text: "作成に失敗しました", card: {}, action: { number: null } });
    await handleInteraction(ctx, click("slack_issue_confirm"));
    const text = postedTexts().find((t) => t.includes("完了していません"));
    expect(text).toContain("理由");
    expect(text).toContain("再開方法");
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { confirmState: "pending" } }));
    expect(call.mock.calls.some(([m, b]) => m === "reactions.add" && (b as { name: string }).name === "warning")).toBe(true);
  });

  it("「やめる」はIssueを作らない", async () => {
    mocks.requestFindUnique.mockResolvedValue(proposed);
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 });
    await handleInteraction(ctx, click("slack_issue_cancel"));
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(postedTexts()[0]).toContain("やめました");
  });
});

describe("スレッドの追加返信", () => {
  const done = { ...baseRequest, status: "done", selectedRepo: "guchi-apps/car-care", conversationId: "conv-1", issues: [{ repo: "guchi-apps/car-care", number: 300, role: "primary" }] };
  const reply = (text: string) => msg({ ts: "101.1", thread_ts: "100.1", text });

  it("補足は新しいIssueを作らず既存Issueへコメントで追記し、反映先を返す", async () => {
    mocks.requestFindUnique.mockResolvedValue(done);
    await handleMessageEvent(ctx, "T1", reply("スマホで押しやすいようにして"));
    expect(mocks.createComment).toHaveBeenCalledTimes(1);
    expect(mocks.createComment.mock.calls[0][2]).toBe(300);
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(postedTexts().some((t) => t.includes("#300") && t.includes("新しいIssueは作っていません"))).toBe(true);
  });

  it("お礼だけではIssueの作成も更新もしない", async () => {
    mocks.requestFindUnique.mockResolvedValue(done);
    await handleMessageEvent(ctx, "T1", reply("ありがとうございます！"));
    expect(mocks.createComment).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("質問には同じスレッドで回答する", async () => {
    mocks.requestFindUnique.mockResolvedValue(done);
    mocks.convFind.mockResolvedValue({ id: "conv-1", context: { repo: "guchi-apps/car-care", targets: [], actions: [] } });
    mocks.handleChatMessage.mockResolvedValue({ text: "来週です", cards: [], needsConfirm: false, nextContext: {} });
    await handleMessageEvent(ctx, "T1", reply("いつ頃反映されますか？"));
    expect(postedTexts()).toEqual(["<@U1> 来週です"]);
    expect(mocks.createComment).not.toHaveBeenCalled();
  });

  it("依頼者以外の返信は処理しない", async () => {
    mocks.requestFindUnique.mockResolvedValue(done);
    await handleMessageEvent(ctx, "T1", { ...reply("補足です"), user: "U1x" });
    expect(mocks.createComment).not.toHaveBeenCalled();
  });
});
