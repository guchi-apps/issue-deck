import { CODEX_LOCAL_MODEL_VALUES } from "@/lib/app-settings";
import { type ClaudeApiFeature, recordClaudeApiCall } from "@/lib/claude/api-usage";
import { db } from "@/lib/db";
import { isDispatchHostOnline } from "@/lib/dispatch/dispatch-job";

/**
 * `CHAT_TURN`ジョブ（サブPCのCodex CLIへの1回の依頼）の共通部分（#4109・#5067）。
 *
 * チャット調査（`investigation/codex-model.ts`）とアプリ内AIの定型処理（`claude/app-ai-codex.ts`）の
 * 両方が使う。チャット調査側は読み取りツール群（GitHub App認証など）を読み込むため、アプリ内AIの
 * 共通入口（`claude/request.ts`）からそれを辿らないよう、軽い部分だけをここへ切り出してある。
 */

/** 実行先の表記。利用状況・診断に残す（OpenAI APIの`gpt-*`と混ぜない） */
export const CODEX_CLI_PROVIDER = "codex-cli";

/** 積んだジョブがこの時間内に受け取られなければ、サブPCへ届いていないと判断する */
export const CHAT_TURN_CLAIM_WAIT_MS = 30_000;

/** サブPC側（`scripts/run-chat-codex.sh`）が返す失敗の種別。受け口で既知の語だけを通す */
export const CHAT_TURN_ERROR_KINDS = [
  "not_logged_in",
  "api_key_auth",
  "usage_limit",
  "timeout",
  "bad_output",
  "codex_error",
  // 画像付きの依頼を、画像の受け渡しに未対応の古い`run-chat-codex.sh`が取りに来た（受け口が書く。#5068）
  "image_host_outdated",
] as const;
export type ChatTurnErrorKind = (typeof CHAT_TURN_ERROR_KINDS)[number];

export function parseChatTurnErrorKind(value: unknown): ChatTurnErrorKind | null {
  return (CHAT_TURN_ERROR_KINDS as readonly unknown[]).includes(value) ? (value as ChatTurnErrorKind) : null;
}

/** Codex CLIで動かせるモデルか。`-m`へ渡すのはこの4つだけ（計画レビュー指摘2） */
export function isCodexCliModel(model: string): boolean {
  return (CODEX_LOCAL_MODEL_VALUES as readonly string[]).includes(model);
}

/** ジョブの本文。pollerは`GET /api/dispatch/chat-turn`でこれを受け取る */
export type ChatTurnRequest = {
  model: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  schema: unknown;
  /** `session`＝1回の起動でMCPブリッジ経由のツールを使って最終回答まで進める（#4199） */
  mode?: "session";
  /** セッション型でCodexへ見せる読み取りツール（名前と説明だけ。引数の形はブリッジ側が持つ） */
  tools?: { name: string; description: string }[];
};

type HostCheck = { ok: true; hostName: string } | { ok: false; reason: string };

/** オンラインかつ`CHAT_TURN`に対応したホストを1台選ぶ（最後に申告したもの） */
export async function pickChatCodexHost(now: Date = new Date()): Promise<HostCheck> {
  const hosts = await db.dispatchHost.findMany({ orderBy: { lastSeenAt: "desc" } });
  const online = hosts.filter((host) => isDispatchHostOnline(host.lastSeenAt, now));
  if (online.length === 0) {
    return { ok: false, reason: "Codex(offline) サブPCがオフラインです" };
  }
  const capable = online.find((host) => host.chatCodexCapable === true);
  if (!capable) {
    return { ok: false, reason: "Codex(unsupported) サブPCのpollerがチャットのCodex実行に未対応です" };
  }
  return { ok: true, hostName: capable.name };
}

/** 待つのをやめたジョブを閉じる。遅れて届いた結果は`currentJobId`の不一致で捨てられる */
export async function abandonChatTurnJob(jobId: string, message: string): Promise<void> {
  await db.dispatchJob.updateMany({
    where: { id: jobId, status: { in: ["QUEUED", "CLAIMED", "RUNNING"] } },
    data: { status: "CANCELED", activeKey: null, finishedAt: new Date(), message },
  });
}

/**
 * サブPCの`codex exec --json`が返した使用量を、OpenAI APIとは別の実行先として計上する。
 * アプリ内AIの定型処理（#5067）も同じ経路なので、呼び出した機能を渡せるようにしてある
 */
export function recordCodexChatUsage(model: string, usage: unknown, feature: ClaudeApiFeature = "chat_investigation"): void {
  const u = (usage && typeof usage === "object" ? usage : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  recordClaudeApiCall({
    feature,
    model: `${CODEX_CLI_PROVIDER}/${model}`,
    tokens: {
      inputTokens: n(u.input_tokens),
      outputTokens: n(u.output_tokens),
      cacheReadTokens: n(u.cached_input_tokens),
      cacheCreationTokens: 0,
    },
  });
}
