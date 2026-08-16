import { isAutoAssignableLabelName } from "@/lib/issue-status";

const ANTHROPIC_API = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

/** 提案生成に使うモデル。プラン枠消費を抑えるため軽量なモデルを使う。 */
const MODEL = "claude-haiku-4-5";

/** 本文が長大な場合に切り詰める上限文字数。 */
const MAX_BODY_LENGTH = 4000;

export type IssueSuggestLabelInput = {
  name: string;
  description: string | null;
};

export type IssueSuggestInput = {
  body: string;
  availableLabels: IssueSuggestLabelInput[];
};

export type IssueSuggestResult = {
  title: string;
  labels: string[];
};

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(省略)`;
}

// 自動生成の選択対象は30〜89番台（71番台を除く）のラベルだけ（#1662）。判定の実体は
// `isAutoAssignableLabelName`（`src/lib/issue-status.ts`）。`11.local`・`21.plan-required`〜
// `25.artifact-required`・`71.manual-step`・`90.Close: *`は、本文の内容ではなく運用の都合
// （誰が対応中か・どのゲートを通すか・なぜcloseしたか）で人やワークフローが付けるラベルで、
// 本文からの推定で付けてよいものではない。**この範囲は#1702で恒久的な仕様として据え置いた**
// （`71`を別の帯へ移す案・優先度を外す案をどちらも検討したうえで現状維持と決めた）。
// **プロンプトの候補一覧（buildIssueSuggestPrompt）と応答の後処理（generateIssueSuggestion）は
// 必ず同じ集合を使う。** プロンプト側だけ絞ると、Claudeが範囲外のラベル名を返したときに
// 後処理が素通ししてしまう。

/** Issue本文と選択可能なラベル一覧から、タイトル・ラベル提案生成用プロンプトを組み立てる。 */
export function buildIssueSuggestPrompt(input: IssueSuggestInput): string {
  const { body, availableLabels } = input;
  const selectableLabels = availableLabels.filter((label) => isAutoAssignableLabelName(label.name));

  const labelsText =
    selectableLabels.length > 0
      ? selectableLabels
          .map((label) => `- ${label.name}${label.description ? `: ${label.description}` : ""}`)
          .join("\n")
      : "(利用可能なラベルなし)";

  return `以下はこれから作成するGitHub Issueの本文です。この内容から、簡潔で分かりやすい日本語のタイトル案と、下記の「利用可能なラベル一覧」の中から内容に適合するものだけを選んだ配列を提案してください。

出力は前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。
{"title": "タイトル案", "labels": ["ラベル名1", "ラベル名2"]}

適合するラベルが無い場合は"labels"を空配列にしてください。"labels"には「利用可能なラベル一覧」に存在するラベル名のみを含めてください。

# 本文
${truncate(body, MAX_BODY_LENGTH)}

# 利用可能なラベル一覧
${labelsText}`;
}

type AnthropicMessageResponse = {
  content?: { type: string; text?: string }[];
};

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Issue本文からタイトル・ラベルの提案をClaudeに生成させる。
 *
 * `issue-summary.ts`と同様、`CLAUDE_CODE_OAUTH_TOKEN`（`user:inference`スコープ）で
 * `/v1/messages`を直接呼び出す。呼び出しごとにプラン枠を消費するため、
 * 呼び出し元でボタン操作等の明示的なトリガーに限定すること。
 */
export async function generateIssueSuggestion(
  token: string,
  input: IssueSuggestInput,
): Promise<IssueSuggestResult> {
  const prompt = buildIssueSuggestPrompt(input);

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
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Claudeの提案生成に失敗しました (${res.status})`);
  }

  const json = (await res.json()) as AnthropicMessageResponse;
  const text = json.content?.find((block) => block.type === "text")?.text?.trim();
  if (!text) {
    throw new Error("Claudeの応答から提案テキストを取得できませんでした");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(text));
  } catch {
    throw new Error("Claudeの応答をJSONとして解析できませんでした");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { title?: unknown }).title !== "string" ||
    !Array.isArray((parsed as { labels?: unknown }).labels)
  ) {
    throw new Error("Claudeの応答の形式が不正です");
  }

  const { title, labels: rawLabels } = parsed as { title: string; labels: unknown[] };

  const availableByLowerName = new Map(
    input.availableLabels
      .filter((label) => isAutoAssignableLabelName(label.name))
      .map((label) => [label.name.toLowerCase(), label.name]),
  );
  const labels = rawLabels
    .filter((label): label is string => typeof label === "string")
    .map((label) => availableByLowerName.get(label.toLowerCase()))
    .filter((label): label is string => label !== undefined);

  return { title: title.trim(), labels: [...new Set(labels)] };
}
