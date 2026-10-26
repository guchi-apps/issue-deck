import { Prisma } from "@prisma/client";

import type { ClaudeApiFeature } from "@/lib/claude/api-usage";
import {
  abandonChatTurnJob,
  CHAT_TURN_CLAIM_WAIT_MS,
  CODEX_CLI_PROVIDER,
  isCodexCliModel,
  parseChatTurnErrorKind,
  pickChatCodexHost,
  type ChatTurnErrorKind,
  type ChatTurnRequest,
} from "@/lib/chat/codex-turn-common";
import { db } from "@/lib/db";
import { buildChatTurnActiveKey, CHAT_TURN_ISSUE_NUMBER, CHAT_TURN_REPOSITORY } from "@/lib/dispatch/dispatch-job";
import { notifyDispatchHostWake } from "@/lib/dispatch/wake-notify";

/**
 * アプリ内AIの定型処理（要約・検索・文章整理・Issue作成補助など）を、サブPCのログイン済みCodex CLI
 * （ChatGPTサブスク枠）で動かす（#5067）。設定でGPT系を選んだときだけ、共通入口`callClaudeMessages`から呼ばれる。
 *
 * **Claude APIもOpenAI APIも呼ばない。** 受け渡しはチャット調査と同じ`CHAT_TURN`ジョブと
 * `scripts/run-chat-codex.sh`（スキーマ付きの単発実行）を使い、プロンプトと結果は`AppAiCodexRun`に置く。
 * サブPC側は`mode`を付けない単発実行（#4109から対応済み）で、画像があるときだけ`--image`で添付する（#5068）。
 *
 * **画像はDBに書かない**（#5068）。待っているこのプロセスのメモリ（実行IDごとのMap）に置き、サブPCが
 * `GET /api/dispatch/chat-turn`で取りに来たときだけ渡す。実行が終われば必ず消す。チャット調査のセッション
 * （`findChatCodexSession`）と同じく、待ち手と受け口が同じプロセスにいる前提。
 *
 * 失敗は`AppAiCodexError`として投げ、**どの失敗でもClaudeへ戻さない**。呼び出し元の`catch`が
 * `error.message`をそのまま画面へ返すので、原因（オフライン・未ログイン・枠超過など）が利用者に見える。
 */

/** Codex経路ではClaudeの認証情報を使わない。呼び出し元の「未設定なら501」を通すための目印 */
export const CODEX_APP_AI_TOKEN = "codex-cli";

/** 呼び出し元が上限を渡さない（画面から待つ）ときの待ちの上限。サブPC側の上限（230秒）より短くする */
export const APP_AI_CODEX_DEFAULT_TIMEOUT_MS = 180_000;

const POLL_INTERVAL_MS = 1_000;
/** 再起動などで待ち手を失った行を消す目安 */
const STALE_RUN_MS = 60 * 60 * 1000;

export type AppAiCodexErrorKind =
  | ChatTurnErrorKind
  | "offline"
  | "unsupported_host"
  | "unsupported_model"
  | "not_claimed"
  | "document_unsupported"
  | "feature_unsupported";

export class AppAiCodexError extends Error {
  readonly kind: AppAiCodexErrorKind;
  constructor(kind: AppAiCodexErrorKind) {
    super(describeAppAiCodexError(kind));
    this.name = "AppAiCodexError";
    this.kind = kind;
  }
}

/** 利用者へ出す文言。Claudeへ切り替えていないことを必ず添える（代替経路と誤認させない） */
export function describeAppAiCodexError(kind: AppAiCodexErrorKind): string {
  const reason = {
    offline: "サブPCがオフラインです",
    unsupported_host: "サブPCのpollerがCodex実行に未対応です（サブPCのチェックアウトを更新してください）",
    unsupported_model: "選んだモデルはCodex CLIで動かせません",
    not_claimed: "サブPCがジョブを受け取りませんでした",
    document_unsupported: "PDFなどの文書を含む処理はCodex経路に未対応です。Claudeへ切り替えて実行してください",
    image_host_outdated: "サブPCのチェックアウトが画像の受け渡しに未対応です（サブPCのチェックアウトを更新してください）",
    feature_unsupported: "この機能はCodex経路に未対応です",
    not_logged_in: "サブPCのCodex CLIがログインしていません（`codex login`でChatGPTにログインしてください）",
    api_key_auth: "サブPCのCodex CLIがAPIキーでログインしています（従量課金になるため使いません）",
    usage_limit: "Codex（ChatGPTサブスク）の利用枠の上限に達しています",
    timeout: "Codexの応答が時間切れになりました",
    bad_output: "Codexの応答を読み取れませんでした",
    codex_error: "Codexの実行に失敗しました",
  }[kind];
  return `Codex CLIで実行できませんでした: ${reason}（Claudeへは切り替えていません）`;
}

/** 共通入口からCodexへ回さない機能。理由はそれぞれのコメント */
export const CODEX_EXCLUDED_FEATURES: ReadonlySet<ClaudeApiFeature> = new Set<ClaudeApiFeature>([
  // Claudeのプラン枠（5時間・週間）そのものを測る探り。Codexで代わりにできるものではない
  "plan_usage",
  // チャット調査は既存のCodex経路（`createCodexSession`）を持ち、ここへは来ない
  "chat_investigation",
]);

/**
 * Codexで実行すると明示的に失敗させる機能。モデルの自動選択は起動ダイアログの応答を待たせないため、
 * Codex指定時はルール判定に倒す（呼び出し元がこの失敗を`pickModelByRule`へ倒す）
 */
const CODEX_UNSUPPORTED_FEATURES: ReadonlySet<ClaudeApiFeature> = new Set<ClaudeApiFeature>(["model_pick"]);

/** 自由文を返す機能は、`--output-schema`が要るので`{text}`1欄のJSONで包んで受け取る */
const TEXT_WRAPPER_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
} as const;

type ContentBlock = { type?: unknown; text?: unknown; source?: unknown } & Record<string, unknown>;

/** サブPCへ渡す画像。`codex exec --image`で添付する順に並べる */
export type AppAiCodexImage = { mediaType: string; data: string };

/** `--image`で渡せる形式。`image-extract.ts`が送る形式（png・jpeg・gif・webp）と揃える */
const CODEX_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** 画像ブロックを、何枚目かの目印へ置き換える。添付は会話に出てきた順 */
export function codexImageMarker(index: number): string {
  return `［添付画像${index + 1}］`;
}

function toCodexImage(block: ContentBlock): AppAiCodexImage {
  const source = block.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
  if (
    source?.type !== "base64" ||
    typeof source.media_type !== "string" ||
    !CODEX_IMAGE_MEDIA_TYPES.has(source.media_type) ||
    typeof source.data !== "string" ||
    source.data === ""
  ) {
    throw new AppAiCodexError("document_unsupported");
  }
  return { mediaType: source.media_type, data: source.data };
}

function blocksToText(content: unknown, images: AppAiCodexImage[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .map((block) => {
      if (block?.type === "document") throw new AppAiCodexError("document_unsupported");
      if (block?.type === "image") {
        images.push(toCodexImage(block));
        return codexImageMarker(images.length - 1);
      }
      return typeof block?.text === "string" ? block.text : "";
    })
    .filter((text) => text !== "")
    .join("\n\n");
}

/**
 * Codexの`--output-schema`（OpenAIの構造化出力）は、オブジェクトの全項目が`required`で
 * `additionalProperties: false`でないと拒否する。Claude向けに書いたスキーマをその形へ寄せる。
 * 任意だった項目は値の型に`null`を足して「無いならnull」を許す
 */
export function normalizeCodexSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeCodexSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    out[key] = key === "properties" ? value : normalizeCodexSchema(value);
  }
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    const props = out.properties as Record<string, unknown>;
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    const normalizedProps: Record<string, unknown> = {};
    for (const [name, prop] of Object.entries(props)) {
      const normalized = normalizeCodexSchema(prop);
      normalizedProps[name] = required.has(name) ? normalized : allowNull(normalized);
    }
    out.properties = normalizedProps;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

function allowNull(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const s = schema as Record<string, unknown>;
  if (typeof s.type === "string") return s.type === "null" ? s : { ...s, type: [s.type, "null"] };
  if (Array.isArray(s.type)) return s.type.includes("null") ? s : { ...s, type: [...s.type, "null"] };
  return { anyOf: [s, { type: "null" }] };
}

export type AppAiCodexRequest = ChatTurnRequest & {
  /** 自由文の機能を`{text}`で包んだか（受け取った後に外す） */
  textWrapped: boolean;
  /** 添付する画像の枚数。画像そのものはDBへ書かず、`AppAiCodexImage`としてメモリに持つ（#5068） */
  imageCount?: number;
};

/**
 * Claude Messages APIの本文を、Codexへ渡す形へ変える。画像は目印へ置き換えて`images`へ分け、
 * PDFなどの文書・base64以外の画像は送る前に断る
 */
export function toCodexRequest(
  model: string,
  body: Record<string, unknown>,
): { request: AppAiCodexRequest; images: AppAiCodexImage[] } {
  const images: AppAiCodexImage[] = [];
  const system = blocksToText(body.system, images);
  const rawMessages = Array.isArray(body.messages) ? (body.messages as { role?: unknown; content?: unknown }[]) : [];
  const messages = rawMessages.map((m) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: blocksToText(m.content, images),
  }));
  const format = (body.output_config as { format?: { type?: unknown; schema?: unknown } } | undefined)?.format;
  const structured = format?.type === "json_schema" && format.schema !== undefined;
  return {
    request: {
      model,
      system,
      messages,
      schema: structured ? normalizeCodexSchema(format.schema) : TEXT_WRAPPER_SCHEMA,
      textWrapped: !structured,
      imageCount: images.length,
    },
    images,
  };
}

/** 実行中の画像。キーは`AppAiCodexRun.id`。開発時の再読み込みで消えないよう`globalThis`に置く */
const pendingImages: Map<string, AppAiCodexImage[]> =
  ((globalThis as { __issueDeckAppAiCodexImages?: Map<string, AppAiCodexImage[]> }).__issueDeckAppAiCodexImages ??=
    new Map());

/** 受け口（`codex-turn-report.ts`）が、サブPCへ渡す画像を引く。実行が終わっていれば`null` */
export function findAppAiCodexImages(runId: string): AppAiCodexImage[] | null {
  return pendingImages.get(runId) ?? null;
}

/**
 * Codexへ渡すプロンプト。チャット調査用（`buildCodexPrompt`）とは約束が違う（ツールの指定も無い）ので分ける
 */
export function buildAppAiCodexPrompt(
  request: Pick<AppAiCodexRequest, "system" | "messages" | "textWrapped" | "imageCount">,
): string {
  const turns = request.messages
    .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
    .join("\n\n");
  return [
    request.system,
    "# 実行環境の約束",
    "- あなたはファイルを読まず、シェルのコマンドも実行しない。必要な情報は下の会話にあるものだけを使う",
    request.imageCount
      ? `- このメッセージには画像を${request.imageCount}枚添付している。会話中の${codexImageMarker(0)}は添付した1枚目の画像を指す（以降も同じ順）`
      : "",
    request.textWrapped
      ? "- 依頼への回答（依頼が指定する書式のまま）を、JSONオブジェクトの text 欄に文字列として入れて返す。text 以外の欄は作らない"
      : "- 出力は指定されたJSONスキーマに合う1つのJSONオブジェクトだけ",
    "# 会話（古い順。最後が今回の依頼）",
    turns,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** 受け取った最終メッセージを、呼び出し元が読むテキストへ戻す。読めなければ`bad_output` */
export function readCodexOutput(output: string, textWrapped: boolean): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new AppAiCodexError("bad_output");
  }
  if (!textWrapped) return output;
  const text = parsed && typeof parsed === "object" ? (parsed as { text?: unknown }).text : undefined;
  if (typeof text !== "string" || text.trim() === "") throw new AppAiCodexError("bad_output");
  return text;
}

/** 受け口（`codex-turn-report.ts`）が保存済みの依頼を読み戻す */
export function parseStoredAppAiRequest(value: unknown): AppAiCodexRequest | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<AppAiCodexRequest>;
  if (typeof v.model !== "string" || typeof v.system !== "string" || !Array.isArray(v.messages)) return null;
  return {
    ...(v as AppAiCodexRequest),
    textWrapped: v.textWrapped === true,
    imageCount: typeof v.imageCount === "number" && v.imageCount > 0 ? v.imageCount : 0,
  };
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export type AppAiCodexResult = {
  /** 呼び出し元が`content[0].text`として読むもの */
  text: string;
  /** 記録・画面に出す実行先（`codex-cli/<model>`）。Claudeのモデル名・OpenAI APIの`gpt-*`と混ぜない */
  model: string;
};

/**
 * 1回ぶんを実行する。ジョブを積み、サブPCの結果をDBで待つ。時間切れ・受け取られない場合は
 * ジョブを取り消し（遅れて届いた結果は`currentJobId`の不一致で捨てられる）、行は最後に消す
 */
export async function runAppAiOnCodex(params: {
  feature: ClaudeApiFeature;
  model: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
  sleep?: Sleep;
  clock?: () => number;
}): Promise<AppAiCodexResult> {
  const sleep = params.sleep ?? defaultSleep;
  const clock = params.clock ?? Date.now;
  const timeoutMs = params.timeoutMs ?? APP_AI_CODEX_DEFAULT_TIMEOUT_MS;

  if (CODEX_UNSUPPORTED_FEATURES.has(params.feature)) throw new AppAiCodexError("feature_unsupported");
  if (!isCodexCliModel(params.model)) throw new AppAiCodexError("unsupported_model");
  const { request, images } = toCodexRequest(params.model, params.body);

  const host = await pickChatCodexHost();
  if (!host.ok) throw new AppAiCodexError(host.reason.startsWith("Codex(offline)") ? "offline" : "unsupported_host");

  await db.appAiCodexRun
    .deleteMany({ where: { createdAt: { lt: new Date(clock() - STALE_RUN_MS) } } })
    .catch(() => undefined);
  const run = await db.appAiCodexRun.create({
    data: {
      feature: params.feature,
      model: params.model,
      status: "running",
      stepRequest: JSON.parse(JSON.stringify(request)) as Prisma.InputJsonValue,
    },
  });
  if (images.length > 0) pendingImages.set(run.id, images);
  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: CHAT_TURN_REPOSITORY,
        issueNumber: CHAT_TURN_ISSUE_NUMBER,
        targetHost: host.hostName,
        kind: "CHAT_TURN",
        agent: "codex",
        codexModel: params.model,
        status: "QUEUED",
        activeKey: buildChatTurnActiveKey(run.id),
        message: `アプリ内AI（${params.feature}）をCodexで実行します`,
      },
    });
    await db.appAiCodexRun.update({ where: { id: run.id }, data: { currentJobId: job.id } });
    notifyDispatchHostWake(job.targetHost);
    const output = await waitForRun({ runId: run.id, jobId: job.id, timeoutMs, sleep, clock });
    return { text: readCodexOutput(output, request.textWrapped), model: `${CODEX_CLI_PROVIDER}/${params.model}` };
  } finally {
    pendingImages.delete(run.id);
    await db.appAiCodexRun.delete({ where: { id: run.id } }).catch(() => undefined);
  }
}

async function waitForRun(params: {
  runId: string;
  jobId: string;
  timeoutMs: number;
  sleep: Sleep;
  clock: () => number;
}): Promise<string> {
  const startedAt = params.clock();
  for (;;) {
    await params.sleep(POLL_INTERVAL_MS);
    const [run, job] = await Promise.all([
      db.appAiCodexRun.findUnique({
        where: { id: params.runId },
        select: { stepResult: true, stepError: true, currentJobId: true },
      }),
      db.dispatchJob.findUnique({ where: { id: params.jobId }, select: { status: true } }),
    ]);
    if (!run || run.currentJobId !== params.jobId || !job) throw new AppAiCodexError("codex_error");
    if (run.stepResult !== null) return run.stepResult;
    if (run.stepError !== null) throw new AppAiCodexError(parseChatTurnErrorKind(run.stepError) ?? "codex_error");
    if (job.status === "TIMEOUT") throw new AppAiCodexError("not_claimed");
    if (["FAILED", "SKIPPED", "CANCELED"].includes(job.status)) throw new AppAiCodexError("codex_error");
    const elapsed = params.clock() - startedAt;
    if (job.status === "QUEUED" && elapsed >= CHAT_TURN_CLAIM_WAIT_MS) {
      await abandonChatTurnJob(params.jobId, "サブPCに受け取られませんでした");
      throw new AppAiCodexError("not_claimed");
    }
    if (elapsed >= params.timeoutMs) {
      await abandonChatTurnJob(params.jobId, "アプリ内AIの応答待ちが時間切れになりました");
      throw new AppAiCodexError("timeout");
    }
  }
}
