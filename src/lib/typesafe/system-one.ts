/**
 * TypeSafeのSystem Oneモデル（Jev）を呼ぶ唯一の入口（#3189）。
 *
 * **Jevは文章を書かない。** こちらが渡した選択肢・点数の段・はい/いいえに対して、
 * 選んだ答えと確率だけを返す（`POST https://api.typesafe.ai/v1/systemone`）。
 * そのため**候補に無い答えが構造上返らず**、応答を読み違える余地がない——
 * アプリ内AIに「JSONだけを出力してください」と頼んで読み取るのと違うのはここ。
 *
 * **公式SDK（`@typesafe-ai/sdk`）は使わない。** 依存を1つ増やしても得るのは型と再試行だけで、
 * 既存のAnthropic／OpenAI呼び出し（`src/lib/claude/request.ts`）が生の`fetch`で書かれている
 * ことと揃わない。仕様（エンドポイント・`Authorization: Bearer`・`model`/`state`/`questions`）は
 * 公開されているSDKの実装と同じものをここに写している。
 *
 * **失敗しても投げない。** キー未設定・エラー応答・タイムアウト・壊れた応答はいずれも`null`を
 * 返し、呼び出し元が従来の経路へ倒せるようにする（`src/lib/claude/model-pick.ts`）。
 */

import { recordClaudeApiCall } from "@/lib/claude/api-usage";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const SYSTEM_ONE_PATH = "/v1/systemone";

/**
 * 送信先。**`TYPESAFE_BASE_URL`で差し替えられる**（公式SDKと同じ環境変数）。
 * 本番で使うものではなく、キーを持たない環境から経路を通して確かめるための逃げ道。
 */
function systemOneUrl(): string {
  const base = process.env.TYPESAFE_BASE_URL?.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
  return `${base}${SYSTEM_ONE_PATH}`;
}

/**
 * 世代を固定しないエイリアス。TypeSafe側が最新版（現在は`jev-1.13.0`）へ解決する。
 * **計上するモデル名は応答が返す実体を優先する**ので、単価表とずれない。
 */
const DEFAULT_MODEL = "jev-latest";

/**
 * 応答を待つ上限。判定は1秒未満で返るのが売りのモデルで、ここが返らないと
 * 「実装を開始」ダイアログの開始ボタンが押せないまま待たされる。
 */
export const SYSTEM_ONE_TIMEOUT_MS = 8_000;

/** 選択肢から1つ選ばせる質問。`criteria`は「ラベル → 説明（`null`なら説明なし）」 */
export type ChoiceQuestion = {
  type: "choice";
  instructions?: string;
  criteria: Record<string, string | null>;
};

/** 点数を付けさせる質問。`criteria`は0点から順に並べた説明で、2つ以上必要 */
export type ScoreQuestion = {
  type: "score";
  instructions?: string;
  criteria: readonly (string | null)[];
};

/** はい/いいえの確率を返させる質問 */
export type NoulQuestion = {
  type: "noul";
  instructions?: string;
  criteria?: { true?: string; false?: string };
};

export type SystemOneQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type ScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
};

export type NoulAnswer = {
  type: "noul";
  /** はいの確率（0〜1） */
  noul: number;
};

export type SystemOneAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type SystemOneResponse = {
  model?: string;
  answers?: Record<string, SystemOneAnswer | undefined>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

/** キーが設定されているか。画面へ「使えない理由」を出すためにも使う */
export function hasTypeSafeApiKey(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

function readTokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 答えが期待した型かを確かめる。**形が違えば採らない**（呼び出し元が従来経路へ倒す） */
export function readChoiceAnswer(answer: SystemOneAnswer | undefined): ChoiceAnswer | null {
  if (!answer || answer.type !== "choice") return null;
  if (typeof answer.choice !== "string" || answer.choice.length === 0) return null;
  return answer;
}

export function readScoreAnswer(answer: SystemOneAnswer | undefined): ScoreAnswer | null {
  if (!answer || answer.type !== "score") return null;
  return typeof answer.score === "number" && Number.isFinite(answer.score) ? answer : null;
}

export function readNoulAnswer(answer: SystemOneAnswer | undefined): NoulAnswer | null {
  if (!answer || answer.type !== "noul") return null;
  return typeof answer.noul === "number" && Number.isFinite(answer.noul) ? answer : null;
}

/**
 * 状態と質問を渡して答えを受け取る。**失敗は例外ではなく`null`。**
 *
 * `state`は文字列でもJSONのオブジェクト・配列でもよい（Jevが受け付ける）。
 * 消費したトークンは、呼び出し元の機能名でアプリ内AIの集計（`api-usage.ts`）へ足す——
 * 提供元は違っても「issue-deckが外部のAIへ投げた分」として同じ画面で見えた方がよい。
 */
export async function askSystemOne(options: {
  feature: Parameters<typeof recordClaudeApiCall>[0]["feature"];
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
  timeoutMs?: number;
}): Promise<SystemOneResponse | null> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return null;

  let response: Response;
  try {
    response = await fetch(systemOneUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        state: options.state,
        questions: options.questions,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? SYSTEM_ONE_TIMEOUT_MS),
    });
  } catch {
    // タイムアウト・名前解決の失敗など。呼び出し元が従来経路へ倒せるようnullで返す
    return null;
  }

  if (!response.ok) return null;

  let json: SystemOneResponse;
  try {
    json = (await response.json()) as SystemOneResponse;
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || !json.answers) return null;

  recordClaudeApiCall({
    feature: options.feature,
    model: json.model ?? DEFAULT_MODEL,
    tokens: {
      inputTokens: readTokenCount(json.usage?.input_tokens),
      // Jevは文章を返さないため出力は常に0だが、応答が返す値をそのまま写す
      outputTokens: readTokenCount(json.usage?.output_tokens),
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  });

  return json;
}
