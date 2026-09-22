import { callClaudeMessages } from "@/lib/claude/request";
import { isAutoAssignableLabelName } from "@/lib/issue-status";
import {
  askSystemOne,
  readChoiceAnswer,
  readNoulAnswer,
  type SystemOneQuestion,
  type SystemOneResponse,
} from "@/lib/typesafe/system-one";

/** 提案生成に使うモデル。プラン枠消費を抑えるため軽量なモデルを使う。 */

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

/**
 * 本文が「やってほしい作業」なのか「聞きたいこと」なのかの判定（#1890）。
 *
 * **判定結果で種別を切り替えることはしない。** 作成フォームは`question`のときだけ
 * 「質問に切り替えますか」という提案を出し、切り替えるかどうかは押した人が決める。
 * #1641で本文からの自動判定を見送った理由（誤判定が押した本人から見えないまま
 * 実装フローに乗る）は、提案にとどめることで避けている。
 */
export type IssueSuggestKind = "issue" | "question";

export type IssueSuggestResult = {
  /** 応答に含まれない・知らない値だったときは`issue`（提案を出さない側）へ倒す */
  kind: IssueSuggestKind;
  title: string;
  labels: string[];
};

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(省略)`;
}

// 自動生成の選択対象は30〜89番台（71番台を除く）のラベルだけ（#1662）。判定の実体は
// `isAutoAssignableLabelName`（`src/lib/issue-status.ts`）。`11.local`・`21.plan-required`〜
// `25.artifact-required`・`71.manual-step`・`9x.Close: *`は、本文の内容ではなく運用の都合
// （誰が対応中か・どのゲートを通すか・なぜcloseしたか）で人やワークフローが付けるラベルで、
// 本文からの推定で付けてよいものではない。**この範囲は#1702で恒久的な仕様として据え置いた**
// （`71`を別の帯へ移す案・優先度を外す案をどちらも検討したうえで現状維持と決めた）。
// **プロンプトの候補一覧（buildIssueSuggestPrompt）と応答の後処理（generateIssueSuggestion）は
// 必ず同じ集合を使う。** プロンプト側だけ絞ると、Claudeが範囲外のラベル名を返したときに
// 後処理が素通ししてしまう。

export type IssueSuggestPromptOptions = {
  /**
   * ラベルの選択までAIに頼むか（既定`true`）。**Jevがラベルを判定したときは`false`**にして、
   * プロンプトからラベルの節を外す（#3245。タイトルと種別だけを聞く）。
   */
  includeLabels?: boolean;
};

/** Issue本文と選択可能なラベル一覧から、タイトル・ラベル提案生成用プロンプトを組み立てる。 */
export function buildIssueSuggestPrompt(
  input: IssueSuggestInput,
  options: IssueSuggestPromptOptions = {},
): string {
  const { body, availableLabels } = input;
  const includeLabels = options.includeLabels ?? true;
  const selectableLabels = availableLabels.filter((label) => isAutoAssignableLabelName(label.name));

  const labelsText =
    selectableLabels.length > 0
      ? selectableLabels
          .map((label) => `- ${label.name}${label.description ? `: ${label.description}` : ""}`)
          .join("\n")
      : "(利用可能なラベルなし)";

  const kindRules = `"kind"のルール:
- "issue" … 何かを直したい・作りたい・変えたい・調べて対応してほしい、という作業の依頼。不具合の報告もこちら。
- "question" … 「〜とは何ですか」「なぜ〜なのですか」「〜はできますか」「〜と〜の違いは」のように、**答えを聞くことが目的**で、コードを変える依頼が含まれていないもの。
- **迷ったら"issue"にしてください。** 作業の依頼と読める部分が少しでもあれば"issue"です。`;

  if (!includeLabels) {
    return `以下はこれから作成するGitHub Issueの本文です。この内容から、この本文が「作業の依頼」なのか「質問」なのかの判定と、簡潔で分かりやすい日本語のタイトル案を提案してください。

出力は前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。
{"kind": "issue", "title": "タイトル案"}

${kindRules}

本文に画像のURLが含まれていても、そこからは判断できないので無視してください。

# 本文
${truncate(body, MAX_BODY_LENGTH)}`;
  }

  return `以下はこれから作成するGitHub Issueの本文です。この内容から、この本文が「作業の依頼」なのか「質問」なのかの判定と、簡潔で分かりやすい日本語のタイトル案と、下記の「利用可能なラベル一覧」の中から内容に適合するものを選んだ配列を提案してください。

出力は前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。
{"kind": "issue", "title": "タイトル案", "labels": ["ラベル名1", "ラベル名2"]}

${kindRules}

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

function suggestionGenerationError(status: number, code: string | null | undefined): Error {
  if (code === "insufficient_quota") {
    return new Error(`OpenAI APIの利用枠が不足しています。請求設定を確認してください (${status}: ${code})`);
  }
  if (code === "rate_limit_exceeded") {
    return new Error(`AIのリクエスト上限に達しました。少し待ってから再試行してください (${status}: ${code})`);
  }
  const detail = code ? `: ${code}` : "";
  return new Error(`AIによる提案生成に失敗しました (${status}${detail})`);
}

/**
 * Issue本文からタイトル・ラベルの提案をClaudeに生成させる。
 *
 * `issue-summary.ts`と同様、`CLAUDE_CODE_OAUTH_TOKEN`（`user:inference`スコープ）で
 * `/v1/messages`を呼び出す（送信は`request.ts`が担う）。呼び出しごとにプラン枠を消費するため、
 * 呼び出し元でボタン操作等の明示的なトリガーに限定すること。
 */
export async function generateIssueSuggestion(
  token: string,
  input: IssueSuggestInput,
  options: IssueSuggestPromptOptions = {},
): Promise<IssueSuggestResult> {
  const includeLabels = options.includeLabels ?? true;
  const prompt = buildIssueSuggestPrompt(input, { includeLabels });

  const { response: res, json, error } = await callClaudeMessages<AnthropicMessageResponse>({
    feature: "issue_suggest",
    token,
    body: {
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    },
  });

  if (!res.ok) {
    throw suggestionGenerationError(res.status, error?.code);
  }

  const text = json?.content?.find((block) => block.type === "text")?.text?.trim();
  if (!text) {
    throw new Error("AIの応答から提案テキストを取得できませんでした");
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
    // ラベルをAIに頼まなかったとき（Jevが判定したとき）は、応答に`labels`が無くてよい
    (includeLabels && !Array.isArray((parsed as { labels?: unknown }).labels))
  ) {
    throw new Error("Claudeの応答の形式が不正です");
  }

  const {
    kind: rawKind,
    title,
    labels: rawLabels,
  } = parsed as { kind?: unknown; title: string; labels?: unknown[] };

  const labels = includeLabels
    ? matchSuggestedLabels(rawLabels ?? [], input.availableLabels)
    : [];

  return { kind: normalizeSuggestedKind(rawKind), title: title.trim(), labels };
}

/**
 * Claudeが返した種別を、扱える値へ落とす（#1890）。
 *
 * **`question`と読めたときだけ`question`で、それ以外は全て`issue`。** 欠けていても
 * 例外にはしない——種別は「提案を出すかどうか」を決めるだけの追加情報で、タイトル・ラベルの
 * 生成をここで失敗させると、質問の判定を足したことで従来の機能まで止まることになる。
 */
export function normalizeSuggestedKind(raw: unknown): IssueSuggestKind {
  return raw === "question" ? "question" : "issue";
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

// ---------------------------------------------------------------------------
// Jev（TypeSafeのSystem Oneモデル）でラベルを判定する（#3245）
// ---------------------------------------------------------------------------
// タイトルと種別（issue／question）はアプリ内AIのまま。**ラベルだけ**をJevへ移す。
// ラベルは複数付けられるので、**ラベル1つずつに「付けるか」をnoulで聞く**。ただし優先度
// （`80.`〜`89.`）は同時に2つ付くと意味が食い違うため、**1つしか選ばれない`choice`**にして
// 「付けない」を選択肢へ入れる（優先度は本文にはっきり書かれているときだけ付けたい）。
// 対象のラベルは`isAutoAssignableLabelName`の集合で、AIの経路と同じ（プロンプトの候補と
// 後処理で集合がずれると範囲外のラベルが付くため）。

/** 「付ける」とみなす確率の下限。下回ったラベルは付けない（ただし種別は最低1つ付ける） */
export const JEV_LABEL_THRESHOLD = 0.5;

/** 優先度ラベルの番号帯（`80.Priority: High`〜`89.Priority: Low`） */
const PRIORITY_PATTERN = /^8\d\./;

/** 優先度の`choice`で「どれも付けない」を表す選択肢。ラベル名と衝突しない語にする */
export const JEV_NO_PRIORITY = "付けない";

/** 優先度の質問のキー。ラベルごとのnoul質問のキーは`label_<連番>` */
const PRIORITY_QUESTION_KEY = "priority";

export type LabelSuggestQuestions = {
  questions: Record<string, SystemOneQuestion>;
  /** noul質問のキー → ラベル名。**ラベル名をそのままキーにしない**（`.`・`:`・空白を含むため） */
  noulKeyToLabel: Map<string, string>;
  /** 優先度の`choice`が返しうるラベル名（「付けない」を含まない） */
  priorityLabels: string[];
};

/** 判定の対象になるラベルから、Jevへ渡す質問を組み立てる。対象が無ければ`null` */
export function buildLabelSuggestQuestions(
  availableLabels: IssueSuggestLabelInput[],
): LabelSuggestQuestions | null {
  const selectable = availableLabels.filter((label) => isAutoAssignableLabelName(label.name));
  if (selectable.length === 0) return null;

  const priority = selectable.filter((label) => PRIORITY_PATTERN.test(label.name));
  const others = selectable.filter((label) => !PRIORITY_PATTERN.test(label.name));

  const questions: Record<string, SystemOneQuestion> = {};
  const noulKeyToLabel = new Map<string, string>();

  others.forEach((label, index) => {
    const key = `label_${index}`;
    noulKeyToLabel.set(key, label.name);
    const description = label.description ? `（${label.description}）` : "";
    questions[key] = {
      type: "noul",
      instructions: `この本文のIssueに、ラベル「${label.name}」${description}を付けるべきですか。本文の内容に当てはまるときだけ「はい」にしてください。`,
    };
  });

  if (priority.length > 0) {
    questions[PRIORITY_QUESTION_KEY] = {
      type: "choice",
      instructions: `この本文のIssueに付ける優先度を選んでください。優先度は本文に緊急性や期限がはっきり書かれているときだけ選び、書かれていなければ「${JEV_NO_PRIORITY}」にしてください。`,
      criteria: {
        ...Object.fromEntries(priority.map((label) => [label.name, label.description])),
        [JEV_NO_PRIORITY]: "本文から優先度を判断できない",
      },
    };
  }

  return { questions, noulKeyToLabel, priorityLabels: priority.map((label) => label.name) };
}

/**
 * Jevの答えからラベルを取り出す。**読める答えが1つも無ければ`null`**（呼び出し元がAIへ倒す）。
 *
 * - noul: `JEV_LABEL_THRESHOLD`以上のものを付ける。**1つも届かなければ何も付けない**（#3367）。
 *   noulの対象は`isAutoAssignableLabelName`の30〜70番台全体で、`31.security`・
 *   `54.data-migration`・`70.needs-decision`のような、Issueの種別ではなく状態や性質を表す
 *   ラベルも含む。以前は「AIの経路の『種別を必ず1つは選ぶ』を保つ」ため確率最大の1つを
 *   強制的に付けていたが、AIの経路が必ず選ばせているのは種別を表すラベルに限られ、その集合を
 *   コード側で判定する手段が無いため、決められない以上は何も付けない側へ倒す
 * - 優先度: 選ばれたラベルだけを付ける。「付けない」・候補外の答えは付けない
 */
export function readLabelSuggestAnswers(
  response: SystemOneResponse,
  built: LabelSuggestQuestions,
): string[] | null {
  const chosen: string[] = [];
  let answered = false;

  for (const [key, label] of built.noulKeyToLabel) {
    const answer = readNoulAnswer(response.answers?.[key]);
    if (!answer) continue;
    answered = true;
    if (answer.noul >= JEV_LABEL_THRESHOLD) chosen.push(label);
  }

  if (built.priorityLabels.length > 0) {
    const answer = readChoiceAnswer(response.answers?.[PRIORITY_QUESTION_KEY]);
    if (answer) {
      answered = true;
      const picked = built.priorityLabels.find((label) => label === answer.choice.trim());
      if (picked) chosen.push(picked);
    }
  }

  return answered ? [...new Set(chosen)] : null;
}

/**
 * 本文からラベルをJevに判定させる（#3245）。**判定できなければ`null`。**
 *
 * `null`はキー未設定・呼び出しの失敗・答えが読めなかったとき・対象のラベルが無いとき。
 * 呼び出し元（`POST /api/issues/suggest`）がアプリ内AIにラベルも選ばせる従来の経路へ倒す。
 */
export async function suggestLabelsByJev(
  input: IssueSuggestInput,
): Promise<string[] | null> {
  const built = buildLabelSuggestQuestions(input.availableLabels);
  if (!built) return null;

  const response = await askSystemOne({
    feature: "issue_suggest",
    // 文章ではなくJSONで渡す（`buildModelPickState`と同じ）
    state: { 本文: truncate(input.body, MAX_BODY_LENGTH) },
    questions: built.questions,
  });
  if (!response) return null;

  return readLabelSuggestAnswers(response, built);
}
