/**
 * 新規アプリの構想を固めるための相談（#2188）。
 *
 * **`lib/claude/`で唯一の多ターンの会話**。他は1往復で終わる（要約・提案・本文整形）ため、
 * ここだけ会話の履歴を受け取って`messages`へ積む。往復のたびにプラン枠を消費するので、
 * **往復数に上限を置き**（`MAX_CONSULT_TURNS`）、送るのは会話の本文だけにする
 * （リポジトリの中身やIssueの一覧は送らない）。
 *
 * 応答は「返事の文」と「仕様案」の2つを1つのJSONで受ける。仕様案は**まだ決まっていない
 * 項目をnullで返させる**——分からないところを埋めさせると、聞かれていない前提が
 * 既定値として設定ステップへ流れ込む。
 *
 * **形式はプロンプトの指示ではなく構造化出力（`output_config.format`）で縛る**（#2281）。
 * 多ターンだと、こちらが履歴へ積み直すassistantの発言は`reply`の地の文だけになる。
 * モデルは自分の直前の発言が地の文なのを見て3往復目あたりから地の文で返し始め、
 * 「Claudeの応答をJSONとして解析できませんでした」で会話が止まっていた
 * （実測で5回中4回。同じ会話をスキーマ付きで投げると5回中5回JSONで返る）。
 */

import {
  NEW_APP_BASE_DOMAIN,
  isValidRepositoryName,
  isValidSubdomain,
  type NewAppAuth,
  type NewAppKind,
} from "@/lib/new-app/spec";

const ANTHROPIC_API = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

/** 相談に使うモデル。`lib/claude/`の他の機能と同じ軽量モデルに揃える。 */
const MODEL = "claude-haiku-4-5";

/**
 * 相談の往復数の上限。**超えたら設定ステップへ進んでもらう。**
 *
 * 構想を固めるのが目的で、仕様を詰めきる場ではない。細かい決めごとは設定ステップの
 * 入力欄と、そこから起票される初期化Issueで扱う。
 */
export const MAX_CONSULT_TURNS = 8;

/** 1回の発言の長さの上限（文字）。長文はIssueへ書いてもらう。 */
export const MAX_CONSULT_MESSAGE_LENGTH = 2000;

export type ConsultRole = "user" | "assistant";

export type ConsultMessage = {
  role: ConsultRole;
  content: string;
};

/**
 * 相談から出てきた仕様案。**決まっていない項目はnull**で、設定ステップは
 * nullの欄を空のまま出す（勝手に埋めない）。
 */
export type NewAppDraft = {
  displayName: string | null;
  repositoryName: string | null;
  summary: string | null;
  kind: NewAppKind | null;
  subdomain: string | null;
  auth: NewAppAuth | null;
  usesDatabase: boolean | null;
};

export type ConsultResult = {
  /** 画面に出す返事 */
  reply: string;
  /** 現時点の仕様案。まだ何も決まっていなければ`null` */
  draft: NewAppDraft | null;
  /** 設定ステップへ進めるだけの材料が揃ったと判断したか */
  ready: boolean;
};

const SYSTEM_PROMPT = `あなたは個人開発のアプリ立ち上げを手伝う相談相手です。相手はこのアプリ群のオーナー本人で、VPS1台の上でNext.js・FastAPI・静的サイトを運用しています。

会話の目的は「何を作るか」を固めることです。実装方法の詳細やコードの話には踏み込まないでください。

守ること:
- 一度に聞くのは1〜2点まで。相手の答えを受けて次を聞く
- 決まっていることを勝手に増やさない。聞いていないことはnullのままにする
- 技術構成は既定から外れる理由があるときだけ提案する。既定は次のとおり
  - 画面があってデータを保存するなら Next.js + MariaDB（種別 next-db）
  - 画面はあるが保存しないなら Next.js（種別 next）
  - APIやバックエンド処理が主なら FastAPI（種別 fastapi）
  - HTMLとJSだけで完結するなら 静的サイト（種別 static）
- 公開URLは ${NEW_APP_BASE_DOMAIN} のサブドメイン直下を既定とする
- リポジトリ名は英小文字・数字・ハイフンのみ。日本語のアプリ名からは自分で英語名を考えて提案する
- 相手が「これで進めたい」と言ったとき、または主要な点（何を作るか・データを保存するか・主な利用端末）が出そろったときに ready を true にする

出力は前置きや説明・コードフェンスを一切付けず、次の形のJSONだけを出力してください。

{"reply": "相手への返事（日本語。2〜4文）", "ready": false, "draft": {"displayName": null, "repositoryName": null, "summary": null, "kind": null, "subdomain": null, "auth": null, "usesDatabase": null}}

draft の各項目:
- displayName: 日本語のアプリ名
- repositoryName: 英小文字・数字・ハイフンのリポジトリ名
- summary: 何をするアプリかの1行
- kind: "next-db" | "next" | "fastapi" | "static"
- subdomain: 公開するサブドメインの先頭（例 kakei-report）。既定は repositoryName と同じ
- auth: "none" | "supabase-google" | "fastapi-google"
- usesDatabase: true | false`;

/** `draft`の各項目のスキーマ。**決まっていない項目はnull**を返せるようにする。 */
function nullableSchema(type: "string" | "boolean", values?: readonly string[]) {
  return {
    anyOf: [values ? { type, enum: [...values] } : { type }, { type: "null" }],
  };
}

/**
 * 応答の形を縛るJSONスキーマ（#2281）。
 *
 * **`additionalProperties: false`と`required`が構造化出力の必須条件**で、どちらかを外すと
 * APIがスキーマを受け付けない。`draft`はオブジェクトごとnullを許す（何も決まっていない段階）。
 */
export const CONSULT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    ready: { type: "boolean" },
    draft: {
      anyOf: [
        {
          type: "object",
          properties: {
            displayName: nullableSchema("string"),
            repositoryName: nullableSchema("string"),
            summary: nullableSchema("string"),
            kind: nullableSchema("string", ["next-db", "next", "fastapi", "static"]),
            subdomain: nullableSchema("string"),
            auth: nullableSchema("string", ["none", "supabase-google", "fastapi-google"]),
            usesDatabase: nullableSchema("boolean"),
          },
          required: [
            "displayName",
            "repositoryName",
            "summary",
            "kind",
            "subdomain",
            "auth",
            "usesDatabase",
          ],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
  },
  required: ["reply", "ready", "draft"],
  additionalProperties: false,
} as const;

/** 最初にこちらから話しかける一言。**APIを呼ばずに出す**（開いただけでプラン枠を使わない）。 */
export const CONSULT_OPENING_MESSAGE =
  "どんなアプリを作りたいですか。ざっくりで大丈夫です。";

/** 会話の往復数（ユーザーの発言の数）。 */
export function countConsultTurns(messages: ConsultMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

/** 上限に達したか。達していたら設定ステップへ促す。 */
export function isConsultExhausted(messages: ConsultMessage[]): boolean {
  return countConsultTurns(messages) >= MAX_CONSULT_TURNS;
}

/**
 * APIへ送る`messages`を組み立てる。
 *
 * **こちらから最初に出した一言は送らない。** 画面にだけ出している定型文で、履歴に混ぜると
 * 「assistantの発言」として毎回トークンを使う。
 */
export function buildConsultMessages(messages: ConsultMessage[]): ConsultMessage[] {
  return messages
    .filter((message) => message.content.trim())
    .filter((message) => !(message.role === "assistant" && message.content === CONSULT_OPENING_MESSAGE))
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, MAX_CONSULT_MESSAGE_LENGTH),
    }));
}

/** ```で囲まれていても中身を取り出す（他の`lib/claude/`と同じ扱い）。 */
function extractJsonText(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return body.trim();
  return body.slice(start, end + 1);
}

const KINDS = new Set<NewAppKind>(["next-db", "next", "fastapi", "static"]);
const AUTHS = new Set<NewAppAuth>(["none", "supabase-google", "fastapi-google"]);

function pickString(value: unknown, maxLength = 120): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

/**
 * 応答の`draft`を、こちらで扱える値だけに絞る。
 *
 * **知らない値・形式に合わない値はnullへ落とす。** リポジトリ名やサブドメインは
 * 設定ステップの初期値になるので、`My_App`のような使えない文字列をそのまま入れると
 * 「直すまで進めない」状態で画面が開く。
 */
export function normalizeDraft(value: unknown): NewAppDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const repositoryName = pickString(raw.repositoryName, 80);
  const subdomain = pickString(raw.subdomain, 60);
  const kind = typeof raw.kind === "string" && KINDS.has(raw.kind as NewAppKind) ? (raw.kind as NewAppKind) : null;
  const auth = typeof raw.auth === "string" && AUTHS.has(raw.auth as NewAppAuth) ? (raw.auth as NewAppAuth) : null;

  const draft: NewAppDraft = {
    displayName: pickString(raw.displayName),
    repositoryName: repositoryName && isValidRepositoryName(repositoryName) ? repositoryName : null,
    summary: pickString(raw.summary, 200),
    kind,
    subdomain: subdomain && isValidSubdomain(subdomain) ? subdomain : null,
    auth,
    usesDatabase: typeof raw.usesDatabase === "boolean" ? raw.usesDatabase : null,
  };

  const hasAnything = Object.values(draft).some((entry) => entry !== null);
  return hasAnything ? draft : null;
}

/**
 * 応答のJSONを`ConsultResult`へ落とす。**返事の文が取れなければ失敗**とする。
 *
 * **JSONでない地の文が返ってきたら、それを返事として扱って会話を続ける**（#2281）。
 * 構造化出力を入れたので通常は起きないが、起きたときに詰まるのは会話の途中で、
 * そこで止めても利用者にできることが無い（仕様案が進まないだけで、設定ステップへは進める）。
 * 途中で切れたJSON（`{`を含むのに読めないもの）は取り違えると内容が壊れるので、従来どおり失敗させる。
 */
export function parseConsultResponse(text: string): ConsultResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(text));
  } catch {
    const prose = pickString(text, 1200);
    if (prose && !text.includes("{")) {
      return { reply: prose, draft: null, ready: false };
    }
    throw new Error("Claudeの応答をJSONとして解析できませんでした");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Claudeの応答の形式が不正です");
  }
  const raw = parsed as Record<string, unknown>;
  const reply = pickString(raw.reply, 1200);
  if (!reply) {
    throw new Error("Claudeの応答から返事を取得できませんでした");
  }
  return {
    reply,
    draft: normalizeDraft(raw.draft),
    ready: raw.ready === true,
  };
}

/**
 * 相談を1往復進める。
 *
 * `issue-summary.ts`などと同じく`CLAUDE_CODE_OAUTH_TOKEN`（`user:inference`スコープ）で
 * `/v1/messages`を直接呼ぶ。**呼び出しごとにプラン枠を消費する**ので、呼び出し元は
 * 送信ボタンの操作に限定すること。
 */
export async function continueNewAppConsult(
  token: string,
  messages: ConsultMessage[],
): Promise<ConsultResult> {
  const res = await fetch(`${ANTHROPIC_API}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      // 返事＋仕様案で1024では足りないことがある。**途中で切れるとJSONが読めなくなる**ため余裕を持たせる
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: buildConsultMessages(messages),
      output_config: { format: { type: "json_schema", schema: CONSULT_RESPONSE_SCHEMA } },
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Claudeへの相談に失敗しました (${res.status})`);
  }

  const json = (await res.json()) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
  };
  const text = json.content?.find((block) => block.type === "text")?.text?.trim();
  if (!text) {
    throw new Error("Claudeの応答から本文を取得できませんでした");
  }
  // 打ち切られた応答は必ず壊れたJSONになる。「解析できませんでした」より原因の分かる文言で返す
  if (json.stop_reason === "max_tokens") {
    throw new Error("Claudeの応答が長すぎて途中で切れました。短く言い直して送ってください");
  }
  return parseConsultResponse(text);
}
