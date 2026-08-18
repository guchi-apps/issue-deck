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

  return `以下はこれから作成するGitHub Issueの本文です。この内容から、簡潔で分かりやすい日本語のタイトル案と、下記の「利用可能なラベル一覧」の中から内容に適合するものを選んだ配列を提案してください。

出力は前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。
{"title": "タイトル案", "labels": ["ラベル名1", "ラベル名2"]}

"labels"のルール:
- 「利用可能なラベル一覧」に書かれているラベル名を、説明を付けずそのまま書いてください。
- **一覧が空でない限り、Issueの種別を表すラベルを必ず1つは選んでください**（不具合の報告なら不具合を表すもの、新しく作りたいものなら新機能を表すもの、既にあるものの改善なら改善を表すもの、といった対応です）。判断に迷う場合も、最も近いものを1つ選んでください。
- 優先度のように内容から判断できないものは、本文にはっきり書かれているときだけ選んでください。
- 「利用可能なラベル一覧」が「(利用可能なラベルなし)」の場合だけ、空配列にしてください。

本文に画像のURLが含まれていても、そこからは判断できないので無視してください。

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

  const labels = matchSuggestedLabels(rawLabels, input.availableLabels);

  return { title: title.trim(), labels };
}

/**
 * Claudeが返したラベル名を、実在するラベル名へ突き合わせる（#1710）。
 *
 * **表記の揺れで落とさない。** プロンプトでは`- 30.bug: 不具合`の形で候補を渡しているため、
 * モデルが箇条書きの記号や説明を付けたまま返すことがある。以前は完全一致だけを見ており、
 * その場合はラベルが1つも付かないまま、タイトルだけが入った状態になっていた。
 * 一方で、**候補に無いラベル名は依然として採らない**（存在しないラベルでの作成はGitHub側で失敗する）。
 */
export function matchSuggestedLabels(
  rawLabels: unknown[],
  availableLabels: IssueSuggestLabelInput[],
): string[] {
  const availableByLowerName = new Map(
    availableLabels
      .filter((label) => isAutoAssignableLabelName(label.name))
      .map((label) => [label.name.toLowerCase(), label.name]),
  );

  const matched = rawLabels
    .filter((label): label is string => typeof label === "string")
    .map((label) => {
      // `- 30.bug: 不具合` のような形で返ってきても拾えるよう、記号と説明を落として突き合わせる
      const normalized = label.trim().replace(/^[-*・]\s*/, "");
      const candidates = [normalized, normalized.split(/[:：]/)[0].trim()];
      for (const candidate of candidates) {
        const found = availableByLowerName.get(candidate.toLowerCase());
        if (found) return found;
      }
      return undefined;
    })
    .filter((label): label is string => label !== undefined);

  return [...new Set(matched)];
}
