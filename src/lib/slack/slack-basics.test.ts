import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { filterCandidates, guessRepo } from "@/lib/slack/candidates";
import { classifyFollowUp } from "@/lib/slack/classify";
import { createSlackClient, postBotReply, SlackApiError, withMention } from "@/lib/slack/client";
import { isAllowedLocation, isAllowedRepoOwner, loadSlackConfig, resolveIssueDeckUser } from "@/lib/slack/config";
import { verifySlackSignature } from "@/lib/slack/verify";

const SECRET = "test-signing-secret";
const NOW = 1_800_000_000;
const sign = (ts: string, body: string) => `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;

describe("verifySlackSignature", () => {
  const body = '{"type":"event_callback"}';
  const ts = String(NOW);
  it("正しい署名を受ける", () => {
    expect(verifySlackSignature({ rawBody: body, timestamp: ts, signature: sign(ts, body), signingSecret: SECRET, nowSec: NOW })).toBe(true);
  });
  it("不正な署名・改ざん・ヘッダー欠落・古い時刻を拒否する", () => {
    const base = { rawBody: body, timestamp: ts, signature: sign(ts, body), signingSecret: SECRET, nowSec: NOW };
    expect(verifySlackSignature({ ...base, signature: "v0=deadbeef" })).toBe(false);
    expect(verifySlackSignature({ ...base, rawBody: body + " " })).toBe(false);
    expect(verifySlackSignature({ ...base, signature: null })).toBe(false);
    expect(verifySlackSignature({ ...base, timestamp: null })).toBe(false);
    expect(verifySlackSignature({ ...base, nowSec: NOW + 301 })).toBe(false);
  });
});

describe("loadSlackConfig", () => {
  it("トークンか署名秘密が無ければ無効", () => {
    expect(loadSlackConfig({ SLACK_BOT_TOKEN: "x" })).toBeNull();
  });
  it("既定の許可Workspace・チャンネルと、ユーザー対応・Organization制限を読む", () => {
    const config = loadSlackConfig({
      SLACK_BOT_TOKEN: "t",
      SLACK_SIGNING_SECRET: "s",
      SLACK_USER_MAP: '{"U1":"user-1"}',
      SLACK_ALLOWED_REPO_OWNERS: "guchi-apps",
    })!;
    expect(isAllowedLocation(config, "T0C8GTB3CP6", "C0C873R7JTV")).toBe(true);
    expect(isAllowedLocation(config, "T0C8GTB3CP6", "CZZZ")).toBe(false);
    expect(isAllowedLocation(config, "TOTHER", "C0C873R7JTV")).toBe(false);
    expect(resolveIssueDeckUser(config, "U1")).toBe("user-1");
    expect(resolveIssueDeckUser(config, "U2")).toBeNull();
    expect(isAllowedRepoOwner(config, "guchi-apps/car-care")).toBe(true);
    expect(isAllowedRepoOwner(config, "other/car-care")).toBe(false);
  });
  it("壊れたユーザー対応は空として扱う", () => {
    const config = loadSlackConfig({ SLACK_BOT_TOKEN: "t", SLACK_SIGNING_SECRET: "s", SLACK_USER_MAP: "{" })!;
    expect(config.userMap).toEqual({});
  });
});

describe("リポジトリ候補", () => {
  const candidates = [
    { fullName: "guchi-apps/car-care", name: "car-care" },
    { fullName: "guchi-apps/car-care-api", name: "car-care-api" },
    { fullName: "guchi-apps/issue-deck", name: "issue-deck" },
  ];
  it("本文に一意に書かれた名前だけを事前選択する", () => {
    expect(guessRepo("issue-deckのチャット画面を直したい", candidates)).toBe("guchi-apps/issue-deck");
    expect(guessRepo("car-careのホーム", candidates)).toBe("guchi-apps/car-care");
    expect(guessRepo("car-care と issue-deck の両方", candidates)).toBeNull();
    expect(guessRepo("どのアプリにも触れていない", candidates)).toBeNull();
  });
  it("名称で絞り込める", () => {
    expect(filterCandidates(candidates, "car").map((c) => c.name)).toEqual(["car-care", "car-care-api"]);
    expect(filterCandidates(candidates, "", 2)).toHaveLength(2);
  });
});

describe("classifyFollowUp", () => {
  it.each([
    ["ありがとうございます！", "thanks"],
    ["👍", "thanks"],
    ["いつ頃反映されますか？", "question"],
    ["別件ですが、通知の設定画面も直したい", "split"],
    ["スマホで押しやすいようにバッジをタップで詳細へ飛べるようにして", "supplement"],
  ])("%s → %s", (text, kind) => {
    expect(classifyFollowUp(text)).toBe(kind);
  });
});

describe("Slackクライアント", () => {
  it("返信には依頼者へのメンションが必ず付く（二重には付けない）", async () => {
    expect(withMention("U1", "本文")).toBe("<@U1> 本文");
    expect(withMention("U1", "<@U1> 本文")).toBe("<@U1> 本文");
    const call = vi.fn().mockResolvedValue({ ts: "1.1" });
    await postBotReply({ call }, { channel: "C", threadTs: "1.0", slackUserId: "U1", text: "結果", blocks: [] });
    const sent = call.mock.calls[0][1] as { text: string; thread_ts: string; blocks: { text: { text: string } }[] };
    expect(sent.text.startsWith("<@U1> ")).toBe(true);
    expect(sent.blocks[0].text.text.startsWith("<@U1> ")).toBe(true);
    expect(sent.thread_ts).toBe("1.0");
    expect(sent).not.toHaveProperty("as_user");
    expect(sent).not.toHaveProperty("username");
  });
  it("失敗は理由コードと再試行可否を持ち、トークンを含めない", async () => {
    const token = "xoxb-secret-token";
    const client = createSlackClient(token, (async () => new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 200 })) as typeof fetch);
    const error = await client.call("chat.postMessage", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlackApiError);
    expect((error as SlackApiError).retryable).toBe(true);
    expect(String((error as Error).message)).not.toContain(token);
    const channelNotFound = createSlackClient(token, (async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))) as typeof fetch);
    expect(((await channelNotFound.call("x", {}).catch((e: unknown) => e)) as SlackApiError).retryable).toBe(false);
  });
  it("トークンはAuthorizationヘッダーにだけ載る", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    await createSlackClient("xoxb-abc", fetchImpl as unknown as typeof fetch).call("auth.test", { a: 1 });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-abc");
    expect(String(init.body)).not.toContain("xoxb-abc");
  });
});
