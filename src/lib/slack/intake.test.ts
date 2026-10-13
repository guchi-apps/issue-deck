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
  fetchIssuesForRepo: vi.fn(),
  fetchCommentsForIssue: vi.fn(),
  githubForUser: vi.fn(),
  registerPlan: vi.fn(),
  resolveChatExecution: vi.fn(),
  createCodexSession: vi.fn(),
  runCreate: vi.fn(),
  runUpdate: vi.fn(),
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
    chatMessage: { create: vi.fn().mockResolvedValue({ id: "msg-user" }) },
    chatRun: { create: mocks.runCreate, update: mocks.runUpdate },
  };
  // 対話型トランザクションは同じモックをtxとして渡す（配列形式は何もしない）
  db.$transaction = vi.fn(async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => unknown)(db) : []));
  return { db };
});
vi.mock("@/lib/chat/investigation/model", () => ({ resolveChatExecution: mocks.resolveChatExecution }));
vi.mock("@/lib/chat/investigation/codex-model", () => ({
  CODEX_CLI_PROVIDER: "codex-cli",
  CODEX_INVESTIGATION_LIMITS: { maxDurationMs: 1, stepTimeoutMs: 1 },
  createCodexSession: mocks.createCodexSession,
}));
vi.mock("@/lib/chat/investigation/reply", () => ({
  describeUnavailable: (raw: string) => {
    const codex = /Codex\((\w+)\)/.exec(raw)?.[1];
    if (codex === "not_logged_in") return { kind: "codex_not_logged_in", label: "サブPCのCodex CLIが未ログインです", next: "サブPCで `codex login` を済ませてください。" };
    if (/HTTP 401/.test(raw)) return { kind: "auth_rejected", label: "AIの認証が拒否されました", next: "認証情報を確認してください。" };
    if (/時間切れ/.test(raw)) return { kind: "network", label: "AIとの通信に失敗しました", next: "少し待って再試行してください。" };
    return { kind: "other", label: "AIの調査を始められませんでした", next: "再試行してください。" };
  },
}));
vi.mock("@/lib/epic-draft/github", () => ({ githubForUser: mocks.githubForUser }));
vi.mock("@/lib/epic-draft/plan", () => ({ getEpicPlanRegistrar: () => mocks.registerPlan }));
vi.mock("@/lib/chat/handlers", () => ({
  handleChatMessage: mocks.handleChatMessage,
  executeConfirmedCard: mocks.executeConfirmedCard,
}));
vi.mock("@/lib/github/issue-create-service", () => ({ findRepositoryByFullName: mocks.findRepositoryByFullName }));
vi.mock("@/lib/github/issues-api", () => ({ createComment: mocks.createComment, fetchIssuesForRepo: mocks.fetchIssuesForRepo, fetchCommentsForIssue: mocks.fetchCommentsForIssue }));
vi.mock("@/lib/github/with-user-github-token", () => ({
  withUserGithubToken: async (_u: unknown, _c: string, fn: (t: string) => Promise<unknown>) => ({ value: await fn("gh-token") }),
}));

import { SlackApiError } from "@/lib/slack/client";
import {
  acceptMessageEvent,
  acceptIssueConfirmation,
  claimEvent,
  handleInteraction,
  handleMessageEvent as handleWithEventId,
  processPendingRequest,
  resumeStalePendingRequests,
  setTargetModelForTest,
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
const issueCard = { type: "confirm_issue", repo: "guchi-apps/car-care", title: "車検の期限表示", body: "## 目的\n車検の期限をホームで確認したい\n\n## 要件\n- 期限を表示する", duplicates: [] };
const investigationCard = { type: "investigation", evidence: [{ label: "HomePage.tsx", url: "https://github.com/x", ref: null, fetchedAt: "" }], facts: [], inferences: [], unconfirmed: [], stopReason: null };
const emptyContext = { repo: "guchi-apps/car-care", targets: [], actions: [] };
/** 調査が成立し、案が揃った返信 */
const investigated = (card: object = issueCard, over: object = {}) => ({ text: "調べました", cards: [investigationCard, card], needsConfirm: true, nextContext: emptyContext, ...over });
const createdOutcome = (number = 300) => ({
  ok: true,
  text: `Issue #${number} を作成しました。`,
  card: { type: "result", ok: true, title: "t", detail: null, htmlUrl: null },
  action: { type: "create_issue", status: "created", repo: "guchi-apps/car-care", number, at: "", message: "" },
});
const ambiguousModel = async () => ({ ok: true as const, text: JSON.stringify({ repo: "", confidence: "low", candidates: ["guchi-apps/car-care", "guchi-apps/issue-deck"], reason: "手がかり不足" }) });

beforeEach(() => {
  vi.clearAllMocks();
  call.mockImplementation(async (method: string) => (method === "chat.getPermalink" ? { permalink: "https://slack.example/p100" } : { ts: "200.1" }));
  // 作った行を以後のfindUniqueで返す（受付→ack後の処理の順に読まれるため）
  mocks.requestCreate.mockImplementation(async ({ data }: { data: object }) => {
    const created = { ...baseRequest, permalink: null, selectorTs: null, ...data };
    mocks.requestFindUnique.mockResolvedValue(created);
    return created;
  });
  mocks.requestUpdate.mockImplementation(async ({ data }: { data: object }) => ({ ...((await mocks.requestFindUnique()) ?? baseRequest), ...data }));
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
  mocks.fetchIssuesForRepo.mockResolvedValue([]);
  mocks.fetchCommentsForIssue.mockResolvedValue([]);
  mocks.executeConfirmedCard.mockResolvedValue(createdOutcome());
  setTargetModelForTest(undefined);
  mocks.resolveChatExecution.mockResolvedValue({ mode: "api" });
  mocks.runCreate.mockResolvedValue({ id: "run-1" });
  mocks.runUpdate.mockResolvedValue({});
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

  it("リポジトリ名のある新規投稿は、選択も承認も無しで調査し、Issueを1件作って「起案しました」と返す", async () => {
    mocks.handleChatMessage.mockResolvedValue(investigated());
    await handleMessageEvent(ctx, "T1", msg({ text: "car-careのホームに車検の期限表示がほしい" }));
    expect(call.mock.calls.some(([m, b]) => m === "reactions.add" && (b as { name: string }).name === "eyes")).toBe(true);
    expect(mocks.handleChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.executeConfirmedCard).toHaveBeenCalledTimes(1);
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ selectedRepo: "guchi-apps/car-care", targetBasis: expect.stringContaining("car-care") }) }));
    const texts = postedTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0].startsWith("<@U1> ✅ こういう内容で起案しました")).toBe(true);
    expect(texts[0]).toContain("guchi-apps/car-care");
    expect(texts[0]).toContain("車検の期限表示");
    expect(texts[0]).toContain("guchi-apps/car-care/issues/300");
    expect(texts[0]).not.toContain("この案で起案する");
    const posted = call.mock.calls.find(([m]) => m === "chat.postMessage")![1] as { blocks?: unknown };
    expect(posted.blocks).toBeUndefined();
  });

  it("リポジトリ名を含まない依頼も、AIが許可候補から一意に判別できれば自動で起案する", async () => {
    setTargetModelForTest(async () => ({ ok: true, text: JSON.stringify({ repo: "guchi-apps/car-care", confidence: "high", candidates: [], reason: "車検は車の整備アプリの機能" }) }));
    mocks.handleChatMessage.mockResolvedValue(investigated());
    await handleMessageEvent(ctx, "T1", msg({ text: "愛車の車検の期限が分かりにくい" }));
    expect(mocks.executeConfirmedCard).toHaveBeenCalledTimes(1);
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ selectedRepo: "guchi-apps/car-care", targetBasis: expect.stringContaining("AIが候補から判別") }) }));
  });

  it("AIが候補外のリポジトリを答えても採用せず、対象を聞く", async () => {
    setTargetModelForTest(async () => ({ ok: true, text: JSON.stringify({ repo: "evil/other", confidence: "high", candidates: [], reason: "x" }) }));
    await handleMessageEvent(ctx, "T1", msg({ text: "改善したい" }));
    expect(mocks.handleChatMessage).not.toHaveBeenCalled();
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(postedTexts()[0]).toContain("絞れませんでした");
  });

  it("権限外・未接続のowner/repoが明示された依頼は、そのリポジトリでは起案しない", async () => {
    await handleMessageEvent(ctx, "T1", msg({ text: "guchi-apps/secret-app に機能を足したい" }));
    expect(mocks.handleChatMessage).not.toHaveBeenCalled();
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(postedTexts()[0]).toContain("起案できません");
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

  it("対象を絞れない依頼だけ、関連候補の選択メニューと名称検索を出してawaiting_repoへ進める", async () => {
    setTargetModelForTest(ambiguousModel);
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, text: "改善したい", status: "received", permalink: null, selectorTs: null });
    await processPendingRequest(ctx, "req-1");
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "req-1", status: "received", updatedAt: baseRequest.updatedAt } }),
    );
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { permalink: "https://slack.example/p100" } }));
    expect(mocks.requestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "awaiting_repo", selectorTs: "200.1", selectedRepo: null, targetBasis: expect.stringContaining("一意に決められなかった") } }),
    );
    const texts = postedTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("guchi-apps/car-care");
    expect(texts[0]).toContain("guchi-apps/issue-deck");
    const blocks = (call.mock.calls.find(([m]) => m === "chat.postMessage")![1] as { blocks: { block_id?: string }[] }).blocks;
    expect(blocks.map((b) => b.block_id)).toEqual([undefined, "repo:req-1", "repo_search:req-1"]);
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
  });

  it("AI判別が失敗しても無関係な先頭候補は並べず、失敗理由を示して名称検索を出す", async () => {
    setTargetModelForTest(async () => ({ ok: false, reason: "HTTP 401" }));
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, text: "改善したい", status: "received", permalink: null, selectorTs: null });
    await processPendingRequest(ctx, "req-1");
    const text = postedTexts()[0];
    expect(text).toContain("HTTP 401");
    expect(text).not.toContain("guchi-apps/car-care");
    const blocks = (call.mock.calls.find(([m]) => m === "chat.postMessage")![1] as { blocks: { block_id?: string }[] }).blocks;
    expect(blocks.map((b) => b.block_id)).toEqual([undefined, "repo_search:req-1"]);
  });

  it("選択メニューを選ぶだけで確定し、承認なしで調査・起案へ進む。連打（取得済み）では進まない", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, status: "awaiting_repo" });
    mocks.handleChatMessage.mockResolvedValue(investigated());
    const payload = { type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" }, actions: [{ action_id: "slack_repo_search", selected_option: { value: "guchi-apps/car-care" } }], state: { values: { "repo_search:req-1": {} } } };
    await handleInteraction(ctx, payload);
    expect(mocks.executeConfirmedCard).toHaveBeenCalledTimes(1);
    mocks.requestUpdateMany.mockResolvedValue({ count: 0 });
    mocks.executeConfirmedCard.mockClear();
    await handleInteraction(ctx, payload);
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
  });

  it("対象確認への回答（名前だけ）で確定し、再度の承認なしで調査・起案まで進む。以前の調査結果は流用しない", async () => {
    setTargetModelForTest(ambiguousModel);
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, text: "改善したい", status: "awaiting_repo", conversationId: "conv-old", proposal: { stale: true } });
    const accepted = await acceptMessageEvent(config, "T1", "E-ans", msg({ ts: "101.1", thread_ts: "100.1", text: "car-careです" }));
    expect(accepted).toEqual({ kind: "queued", requestId: "req-1" });
    expect(mocks.requestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: expect.objectContaining({ status: "resuming", selectedRepo: null, conversationId: null, text: "改善したい\n\n（補足）car-careです" }),
    });
    expect(call).not.toHaveBeenCalled();

    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, text: "改善したい\n\n（補足）car-careです", status: "resuming", targetBasis: "AIが一意に決められなかった" });
    mocks.handleChatMessage.mockResolvedValue(investigated());
    await processPendingRequest(ctx, "req-1");
    expect(mocks.executeConfirmedCard).toHaveBeenCalledTimes(1);
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ selectedRepo: "guchi-apps/car-care", targetBasis: expect.stringContaining("利用者の回答") }) }));
    expect(postedTexts().some((t) => t.includes("起案しました"))).toBe(true);
  });

  it("回答で権限外の対象が指定されたら、そのリポジトリでは起案しない", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, text: "改善したい\n\n（補足）guchi-apps/secret-app", status: "resuming", targetBasis: "x" });
    await processPendingRequest(ctx, "req-1");
    expect(mocks.handleChatMessage).not.toHaveBeenCalled();
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(postedTexts()[0]).toContain("起案できません");
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

  it("ack後にプロセスが止まって受付のまま残った依頼は、巡回が拾い直して対象を判別し直す", async () => {
    setTargetModelForTest(ambiguousModel);
    const now = new Date("2026-10-12T01:00:00Z");
    mocks.requestFindMany.mockImplementation(async ({ where }: { where: { status: string } }) =>
      where.status === "received" ? [{ id: "req-1" }] : [],
    );
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, text: "改善したい", status: "received", updatedAt: new Date("2026-10-12T00:00:00Z") });
    expect(await resumeStalePendingRequests(ctx, now)).toBe(1);
    expect(mocks.requestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "received", updatedAt: { lt: new Date("2026-10-12T00:58:00Z") } } }),
    );
    expect(mocks.requestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "resuming", updatedAt: { lt: new Date("2026-10-12T00:30:00Z") } } }),
    );
    expect(postedTexts().some((t) => t.includes("対象のリポジトリを一つに絞れません"))).toBe(true);
  });

  it("調査中（investigating）のまま止まった依頼は、巡回が拾い直して調査をやり直し、承認なしで1件作る", async () => {
    mocks.requestFindMany.mockImplementation(async ({ where }: { where: { status: string } }) =>
      where.status === "investigating" ? [{ id: "req-1" }] : [],
    );
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, status: "investigating", selectedRepo: "guchi-apps/car-care" });
    mocks.handleChatMessage.mockResolvedValue(investigated());
    expect(await resumeStalePendingRequests(ctx, new Date("2026-10-12T01:00:00Z"))).toBe(1);
    expect(mocks.handleChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.executeConfirmedCard).toHaveBeenCalledTimes(1);
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "confirming", confirmState: "queued", proposal: expect.objectContaining({ confirmationId: expect.any(String) }) }) }));
  });

  it("処理権を取れなかった行は再開した件数に数えない", async () => {
    mocks.requestFindMany.mockImplementation(async ({ where }: { where: { status: string } }) =>
      where.status === "received" ? [{ id: "req-1" }] : [],
    );
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, status: "received" });
    mocks.requestUpdateMany.mockResolvedValueOnce({ count: 0 });
    expect(await resumeStalePendingRequests(ctx, new Date("2026-10-12T01:00:00Z"))).toBe(0);
    expect(call).not.toHaveBeenCalled();
  });

  it("ack後の処理が失敗したら失敗状態で残し、「再開」の返信から続けられる", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    call.mockImplementation(async (method: string) => {
      if (method === "chat.postMessage") throw new Error("slack down");
      return {};
    });
    await handleMessageEvent(ctx, "T1", msg({ text: "改善したい" }));
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));

    // 再開: ack前に`resuming`へ書き、ack後に選択UIを出し直す
    call.mockImplementation(async () => ({ ts: "300.1" }));
    mocks.requestUpdate.mockClear();
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, status: "failed" });
    const accepted = await acceptMessageEvent(config, "T1", "E-resume", msg({ ts: "101.1", thread_ts: "100.1", text: "再開" }));
    expect(accepted).toEqual({ kind: "queued", requestId: "req-1" });
    expect(mocks.requestUpdate).toHaveBeenCalledWith({ where: { id: "req-1" }, data: { status: "resuming", failure: null } });
    setTargetModelForTest(ambiguousModel);
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, text: "改善したい", status: "resuming" });
    await processPendingRequest(ctx, "req-1");
    expect(mocks.requestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "awaiting_repo", selectorTs: "300.1", selectedRepo: null }) }),
    );
  });

  it("調査中の補足はack前にDBへ足して終える", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest, status: "investigating" });
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

  it("旧フローの対象選択ボタンも、確定後は承認なしで調査・起案まで進む", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest });
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.handleChatMessage.mockResolvedValue(investigated());
    await handleInteraction(ctx, confirmPayload());
    expect(mocks.findRepositoryByFullName).toHaveBeenCalledWith("user-1", "guchi-apps/car-care");
    expect(mocks.executeConfirmedCard).toHaveBeenCalledTimes(1);
    expect(postedTexts().some((t) => t.startsWith("<@U1> ✅") && t.includes("起案しました"))).toBe(true);
    expect(postedTexts().some((t) => t.includes("この案で起案する"))).toBe(false);
  });

  it("AIが別リポジトリの案を返したら作成せず、再調査を案内する", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...baseRequest });
    mocks.handleChatMessage.mockResolvedValue(investigated({ ...issueCard, repo: "guchi-apps/issue-deck" }));
    await handleInteraction(ctx, confirmPayload());
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(postedTexts().some((t) => t.includes("起案先が一致しません") && t.includes("再開"))).toBe(true);
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

describe("調査が成立しないときは自動作成しない（#4527）", () => {
  const investigating = { ...baseRequest, status: "investigating", selectedRepo: "guchi-apps/car-care" };
  const run = async () => {
    mocks.requestFindUnique.mockResolvedValue(investigating);
    await processPendingRequest(ctx, "req-1");
  };
  const expectStopped = () => {
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(mocks.requestUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "confirming" }) }));
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
    const text = postedTexts().at(-1) ?? "";
    expect(text).toContain("未調査の案は作成していません");
    expect(text).toContain("再開");
  };

  it("AI停止（調査に入れなかった）では、理由と再開方法を返してIssueを作らない", async () => {
    mocks.handleChatMessage.mockResolvedValue({ text: "回答できませんでした：AIの利用上限", cards: [], needsConfirm: false, nextContext: emptyContext, unavailable: true });
    await run();
    expectStopped();
  });

  it("Codex設定では共通のCodexセッションで調査し、失敗理由（未ログイン）を根拠不足に置き換えず設定を直す案内を返す", async () => {
    mocks.resolveChatExecution.mockResolvedValue({ mode: "codex", model: "gpt-5.5" });
    const session = vi.fn().mockResolvedValue({ ok: false, reason: "Codex(not_logged_in) サブPCのCodex CLIがログインしていません" });
    mocks.createCodexSession.mockReturnValue(session);
    mocks.handleChatMessage.mockImplementation(async (params: { investigationDeps?: { session: (i: unknown) => Promise<unknown> } }) => {
      await params.investigationDeps!.session({});
      return { text: "回答できませんでした", cards: [], needsConfirm: false, nextContext: emptyContext, unavailable: true };
    });
    await run();
    expect(mocks.createCodexSession).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", model: "gpt-5.5" }));
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    const text = postedTexts().at(-1) ?? "";
    expect(text).toContain("未ログイン");
    expect(text).toContain("待っても直らない");
    expect(text).not.toContain("根拠を得られず");
    expect(mocks.runUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed", failureKind: "codex_not_logged_in" }) }));
  });

  it("Codex設定でセッションが成功すれば、Claudeと同じく起案まで進む", async () => {
    mocks.resolveChatExecution.mockResolvedValue({ mode: "codex", model: "gpt-5.5" });
    mocks.createCodexSession.mockReturnValue(vi.fn());
    mocks.handleChatMessage.mockResolvedValue(investigated());
    await run();
    expect(mocks.executeConfirmedCard).toHaveBeenCalledTimes(1);
    expect(mocks.runUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "succeeded" }) }));
  });

  it("調査が途中で止まった（stopReasonあり）案は作成しない", async () => {
    mocks.handleChatMessage.mockResolvedValue(investigated(issueCard, { cards: [{ ...investigationCard, stopReason: "時間切れ" }, issueCard] }));
    await run();
    expectStopped();
  });

  it("定型フォールバックの案（調査していない案）は作成しない", async () => {
    mocks.handleChatMessage.mockResolvedValue({ text: "会話から作った案", cards: [issueCard], needsConfirm: true, nextContext: emptyContext, draftFallback: true });
    await run();
    expectStopped();
  });

  it("実装・Issueを読んだ根拠が無い案は作成しない", async () => {
    mocks.handleChatMessage.mockResolvedValue(investigated(issueCard, { cards: [{ ...investigationCard, evidence: [] }, issueCard] }));
    await run();
    expectStopped();
  });

  it("似た既存Issueがあるときは作らず、リンクと状態を返し、先頭を追記先として残す", async () => {
    const duplicates = [{ number: 250, title: "車検の期限を出す", htmlUrl: "https://github.com/guchi-apps/car-care/issues/250", state: "OPEN" }];
    mocks.handleChatMessage.mockResolvedValue(investigated({ ...issueCard, duplicates }));
    await run();
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done", issues: [expect.objectContaining({ number: 250, role: "reused" })] }) }));
    const text = postedTexts().at(-1) ?? "";
    expect(text).toContain("新しいIssueは作りませんでした");
    expect(text).toContain("issues/250");
  });

  it("案にならなかった（既存の対応で足りる等）ときは作らず、調査の説明を返す", async () => {
    mocks.handleChatMessage.mockResolvedValue({ text: "#180 で本番反映済みです", cards: [investigationCard], needsConfirm: false, nextContext: emptyContext });
    await run();
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(postedTexts().at(-1)).toContain("#180 で本番反映済み");
  });

  it("作成直前に権限を失っていたら、GitHubを更新しない", async () => {
    mocks.handleChatMessage.mockResolvedValue(investigated());
    mocks.repoFindMany.mockResolvedValueOnce([{ fullName: "guchi-apps/car-care", name: "car-care" }]).mockResolvedValueOnce([]);
    await run();
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
  });

  it("並行実行で処理権を取れなかったら作成しない（二重作成の防止）", async () => {
    mocks.handleChatMessage.mockResolvedValue(investigated());
    mocks.requestUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await run();
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
  });
});

describe("結果返信の失敗からの再開（#4527）", () => {
  const confirming = {
    ...baseRequest,
    status: "confirming",
    confirmState: "queued",
    selectedRepo: "guchi-apps/car-care",
    proposal: { card: issueCard, splitFrom: null, attachTo: null, confirmationId: "op-1" },
  };

  it("GitHub成功後にSlack返信が失敗しても、Issueは作成済みで返信待ち（reply_pending）に残り、再作成しない", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    call.mockImplementation(async (method: string) => {
      if (method === "chat.postMessage") throw new Error("slack down");
      return {};
    });
    mocks.requestFindUnique.mockResolvedValue(confirming);
    await processPendingRequest(ctx, "req-1");
    expect(mocks.executeConfirmedCard).toHaveBeenCalledTimes(1);
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done", confirmState: "reply_pending", issues: [expect.objectContaining({ number: 300 })] }) }));
    expect(mocks.requestUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: { confirmState: "done" } }));
  });

  it("巡回は返信だけを再送し、Issueを作り直さない", async () => {
    const pending = { ...confirming, status: "done", confirmState: "reply_pending", issues: [{ repo: "guchi-apps/car-care", number: 300, role: "primary" }], updatedAt: new Date("2026-10-12T00:00:00Z") };
    mocks.requestFindMany.mockImplementation(async ({ where }: { where: { status: string } }) => (where.status === "done" ? [pending] : []));
    expect(await resumeStalePendingRequests(ctx, new Date("2026-10-12T01:00:00Z"))).toBe(1);
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(mocks.fetchIssuesForRepo).not.toHaveBeenCalled();
    expect(postedTexts().some((t) => t.includes("起案しました") && t.includes("issues/300"))).toBe(true);
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { confirmState: "done" } }));
  });
});

describe("Issueの作成・追記", () => {
  const proposed = {
    ...baseRequest,
    selectedRepo: "guchi-apps/car-care",
    status: "awaiting_confirm",
    confirmState: "pending",
    conversationId: "conv-1",
    proposal: { card: issueCard, splitFrom: null, confirmationId: "op-1" },
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

  it.each(["slack_issue_confirm", "slack_issue_attach"])("保存済みの起案先が違う場合は %s でもGitHubを更新しない", async (actionId) => {
    mocks.requestFindUnique.mockResolvedValue({ ...proposed, proposal: { card: { ...issueCard, repo: "guchi-apps/issue-deck" }, splitFrom: null } });
    await handleInteraction(ctx, click(actionId, actionId === "slack_issue_attach" ? "req-1:300" : "req-1"));
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(mocks.createComment).not.toHaveBeenCalled();
    expect(mocks.requestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
    expect(postedTexts().some((t) => t.includes("起案先が一致しません") && t.includes("再開"))).toBe(true);
  });

  it("作成結果が不明ならconfirmingのまま残し、巡回による既存更新の照合を案内する", async () => {
    mocks.requestFindUnique.mockResolvedValue(proposed);
    mocks.executeConfirmedCard.mockResolvedValue({ ok: false, text: "作成に失敗しました", action: { number: null } });
    await handleInteraction(ctx, click("slack_issue_confirm"));
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "confirming", confirmState: "queued" }) }));
    expect(mocks.requestUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done" }) }));
    expect(mocks.requestUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ confirmState: "pending" }) }));
    expect(postedTexts().some((t) => t.includes("巡回") && t.includes("保存済み"))).toBe(true);
  });

  it("承認をack前に保存し、その時点ではSlack・GitHubを呼ばない。再送は二重保存しない", async () => {
    mocks.requestFindUnique.mockResolvedValue(proposed);
    mocks.requestUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await acceptIssueConfirmation(config, click("slack_issue_confirm"))).toBe("req-1");
    expect(await acceptIssueConfirmation(config, click("slack_issue_confirm"))).toBeNull();
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "confirming", confirmState: "queued", proposal: expect.objectContaining({ confirmationId: "op-1", attachTo: null }) }) }));
    expect(call).not.toHaveBeenCalled();
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(mocks.fetchIssuesForRepo).not.toHaveBeenCalled();
  });

  it("承認保存のDB失敗はackせず再送できるよう例外を返す", async () => {
    mocks.requestFindUnique.mockResolvedValue(proposed);
    mocks.requestUpdateMany.mockRejectedValueOnce(new Error("db down"));
    await expect(acceptIssueConfirmation(config, click("slack_issue_confirm"))).rejects.toThrow("db down");
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
  });

  it.each(["queued", "processing"])("%sで中断しても巡回が拾い、GitHubに作成済みならclosedでも再起案しない", async (confirmState) => {
    mocks.requestFindUnique.mockResolvedValue({ ...proposed, status: "confirming", confirmState });
    mocks.requestFindMany.mockImplementation(async ({ where }: { where: { status: string } }) => where.status === "confirming" ? [{ id: "req-1" }] : []);
    mocks.fetchIssuesForRepo.mockResolvedValue([{ number: 300, state: "closed", body: "<!-- slack-intake-confirm: req-1/op-1 -->" }]);
    expect(await resumeStalePendingRequests(ctx, new Date("2026-10-12T01:00:00Z"))).toBe(1);
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done", confirmState: "reply_pending", issues: [expect.objectContaining({ repo: "guchi-apps/car-care", number: 300 })] }) }));
  });

  it("承認後GitHub更新前に停止した依頼は、巡回が保存済み案を1回作成する", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...proposed, status: "confirming", confirmState: "queued" });
    mocks.executeConfirmedCard.mockResolvedValue({ ok: true, text: "作成しました", action: { number: 301 } });
    await processPendingRequest(ctx, "req-1");
    expect(mocks.executeConfirmedCard).toHaveBeenCalledTimes(1);
    expect(mocks.executeConfirmedCard.mock.calls[0][2].body).toContain("<!-- slack-intake-confirm: req-1/op-1 -->");
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done", confirmState: "reply_pending" }) }));
  });

  it("再開時のGitHub一覧取得失敗は未作成と解釈せず、起案しない", async () => {
    mocks.requestFindUnique.mockResolvedValue({ ...proposed, status: "confirming", confirmState: "processing" });
    mocks.fetchIssuesForRepo.mockRejectedValue(new Error("github down"));
    await processPendingRequest(ctx, "req-1");
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(mocks.requestUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done" }) }));
  });

  it("追記先も承認時に保存し、追記成功後に停止しても同じコメントを二重投稿しない", async () => {
    mocks.requestFindUnique.mockResolvedValue(proposed);
    await acceptIssueConfirmation(config, click("slack_issue_attach", "req-1:300"));
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ proposal: expect.objectContaining({ attachTo: 300, confirmationId: "op-1" }) }) }));
    mocks.requestFindUnique.mockResolvedValue({ ...proposed, status: "confirming", confirmState: "processing", proposal: { ...proposed.proposal, attachTo: 300 } });
    mocks.fetchCommentsForIssue.mockResolvedValue([{ body: "<!-- slack-intake-confirm: req-1/op-1 -->" }]);
    await processPendingRequest(ctx, "req-1");
    expect(mocks.createComment).not.toHaveBeenCalled();
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done", confirmState: "reply_pending", issues: [expect.objectContaining({ number: 300, role: "reused" })] }) }));
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

describe("親子Issueの起案（#4537）", () => {
  const epicDraft = {
    parent: { repo: "guchi-apps/car-care", title: "車検の期限表示を整える", objective: "期限を一目で分かるようにする", completionCriteria: ["本番で期限が表示される"], scope: "ホームと詳細" },
    children: [
      { key: "c1", repo: "guchi-apps/car-care", title: "共通仕様", body: "要件1", dependsOn: [] },
      { key: "c2", repo: "guchi-apps/issue-deck", title: "画面", body: "要件2", dependsOn: [{ key: "c1", conditions: ["merged"] }] },
      { key: "c3", repo: "guchi-apps/car-care", title: "配布", body: "要件3", dependsOn: [{ key: "c2", conditions: ["verified"] }] },
    ],
  };
  const epicCard = (over: object = {}) => ({ type: "confirm_epic", repo: "guchi-apps/car-care", draft: epicDraft, duplicates: {}, ...over });

  /** GitHubのメモリ実装（本文の識別子照合まで本物の`createEpic`が通る） */
  function fakeGithub() {
    const repos = new Map<string, { number: number; id: number; state: "open"; body: string | null }[]>();
    let id = 1;
    return {
      repos,
      github: {
        listIssues: async (repo: string) => (repos.get(repo) ?? []).map((i) => ({ ...i })),
        createIssue: async (repo: string, input: { body: string }) => {
          const list = repos.get(repo) ?? [];
          const created = { number: 400 + list.length, id: id++, state: "open" as const, body: input.body };
          list.push(created);
          repos.set(repo, list);
          return { number: created.number, id: created.id };
        },
        updateBody: async (repo: string, number: number, body: string) => {
          repos.get(repo)!.find((i) => i.number === number)!.body = body;
        },
        listSubIssues: async () => [],
        addSubIssue: async () => {},
      },
    };
  }
  const total = (f: ReturnType<typeof fakeGithub>) => [...f.repos.values()].flat().length;
  const confirmingRequest = (proposal: unknown, over: object = {}) => ({ ...baseRequest, status: "investigating", selectedRepo: "guchi-apps/car-care", ...over, proposal });

  async function runWith(card: object) {
    mocks.handleChatMessage.mockResolvedValue(investigated(card));
    await handleMessageEvent(ctx, "T1", msg({ text: "car-careで車検の期限表示を、共通仕様の後に実行と画面、最後に配布で整えたい" }));
  }

  it("分割すべき依頼は承認なしで親子を作り、リンク・実行順序・実行開始の案内を返す（子は開始しない）", async () => {
    const f = fakeGithub();
    mocks.githubForUser.mockReturnValue(f.github);
    mocks.registerPlan.mockResolvedValue({ ok: true, version: 1 });
    await runWith(epicCard());
    expect(mocks.executeConfirmedCard).not.toHaveBeenCalled();
    expect(total(f)).toBe(4);
    const texts = postedTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("親子Issueとして起案しました");
    expect(texts[0]).toContain("guchi-apps/car-care/issues/400");
    expect(texts[0]).toContain("guchi-apps/issue-deck/issues/400");
    expect(texts[0]).toContain("進む条件");
    expect(texts[0]).toContain("自動では実装を開始しません");
    expect(mocks.registerPlan).toHaveBeenCalledWith(expect.objectContaining({ children: expect.arrayContaining([expect.objectContaining({ repo: "guchi-apps/issue-deck" })]) }));
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done", confirmState: "reply_pending" }) }));
  });

  it("計画登録に失敗したら完了とせず、再開で作成済みを作り直さず計画だけ登録する", async () => {
    const f = fakeGithub();
    mocks.githubForUser.mockReturnValue(f.github);
    mocks.registerPlan.mockResolvedValueOnce({ ok: false, message: "計画の検証に失敗" });
    await runWith(epicCard());
    expect(postedTexts()[0]).toContain("完了していません");
    expect(postedTexts()[0]).toContain("実行計画の登録");
    expect(postedTexts()[0]).not.toContain("起案しました");
    const created = total(f);
    expect(created).toBe(4);
    const claim = mocks.requestUpdateMany.mock.calls.find(([a]) => (a as { data: { proposal?: unknown } }).data.proposal)![0] as { data: { proposal: unknown } };
    const failedIssues = (mocks.requestUpdate.mock.calls.map(([a]) => (a as { data: { issues?: unknown } }).data.issues).filter(Boolean).at(-1)) as unknown[];
    expect(failedIssues).toHaveLength(4);
    // 再開（保存済みの案から続け、調査し直さない）
    call.mockClear();
    mocks.handleChatMessage.mockClear();
    mocks.registerPlan.mockResolvedValue({ ok: true, version: 1 });
    mocks.requestFindUnique.mockResolvedValue(confirmingRequest(claim.data.proposal, { status: "resuming", issues: failedIssues }));
    await processPendingRequest(ctx, "req-1");
    expect(mocks.handleChatMessage).not.toHaveBeenCalled();
    expect(total(f)).toBe(created);
    expect(postedTexts()[0]).toContain("親子Issueとして起案しました");
  });

  it("似た既存のIssueがある子があれば、何も作らずリンクと状態を返す", async () => {
    const f = fakeGithub();
    mocks.githubForUser.mockReturnValue(f.github);
    await runWith(epicCard({ duplicates: { c2: [{ number: 12, title: "画面を直す", htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/12", state: "OPEN" }] } }));
    expect(total(f)).toBe(0);
    expect(postedTexts()[0]).toContain("親子Issueは作りませんでした");
    expect(postedTexts()[0]).toContain("issues/12");
  });

  it("権限内にないリポジトリの子があれば、何も作らず理由を返す", async () => {
    const f = fakeGithub();
    mocks.githubForUser.mockReturnValue(f.github);
    const draft = { ...epicDraft, children: [...epicDraft.children.slice(0, 2), { ...epicDraft.children[2], repo: "evil/other" }] };
    await runWith(epicCard({ draft }));
    expect(total(f)).toBe(0);
    expect(postedTexts()[0]).toContain("権限内にないリポジトリ");
  });

  it("親のリポジトリが選択済みの対象と違えば作らない", async () => {
    const f = fakeGithub();
    mocks.githubForUser.mockReturnValue(f.github);
    await runWith(epicCard({ repo: "guchi-apps/issue-deck" }));
    expect(total(f)).toBe(0);
    expect(postedTexts()[0]).toContain("起案先が一致しません");
  });

  it("Slackの返信に失敗しても作成済みで返信待ちに残り、親子を増やさない", async () => {
    const f = fakeGithub();
    mocks.githubForUser.mockReturnValue(f.github);
    mocks.registerPlan.mockResolvedValue({ ok: true, version: 1 });
    call.mockImplementation(async (method: string) => {
      if (method === "chat.getPermalink") return { permalink: "https://slack.example/p100" };
      if (method === "chat.postMessage") throw new SlackApiError("chat.postMessage", "ratelimited", true);
      return { ts: "200.1" };
    });
    await runWith(epicCard());
    expect(total(f)).toBe(4);
    expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done", confirmState: "reply_pending" }) }));
    expect(mocks.requestUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: { confirmState: "done" } }));
  });
});
