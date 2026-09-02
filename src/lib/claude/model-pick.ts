/**
 * 「実装を開始」ダイアログの「おまかせ」（#2723）。**Issueの内容から使うモデルを選ぶ。**
 *
 * 選ぶのは起動する前で、**決まった時点で具体的なモデル名になる**——ジョブへ積むのは
 * `haiku`・`sonnet`・`opus`・`fable`のいずれかで、`auto`（`--model`を付けない）ではない。
 * そのため実行キューの印にも受付コメントにも、選ばれたモデルがそのまま出る。
 *
 * **判定は当たり外れのあるもので、押した人が上書きできることが前提。** 画面は選んだ理由を
 * 必ず出し、納得できなければ別のチップを押せる形にしてある（`start-implementation-dialog.tsx`）。
 *
 * 呼び出しに失敗したとき・応答を読めなかったときは**ラベルと分量からのルール**へ倒す
 * （`pickModelByRule`）。AIが使えないからといって起動そのものを止めない。
 */

import { callClaudeMessages } from "@/lib/claude/request";

/**
 * 自動選択が選べるモデル。`auto`（CLIの既定）は「選ばない」という選択なのでここには入れない。
 * **値は`ClaudeModel`の部分集合**なので、選ばれたものはそのままジョブへ積める。
 */
export const MODEL_PICK_CANDIDATES = ["haiku", "sonnet", "opus", "fable"] as const;

export type ModelPickCandidate = (typeof MODEL_PICK_CANDIDATES)[number];

/** プロンプトへ載せる本文の文字数。全文を載せても判断は変わらず、枠だけを食う */
export const MODEL_PICK_BODY_HEAD_LENGTH = 1200;

/** プロンプトへ載せる計画コメントの文字数。本文より長めなのは、実装の重さが具体的に書かれているため */
export const MODEL_PICK_PLAN_HEAD_LENGTH = 1500;

/** 画面へ出す理由の文字数上限 */
const MAX_REASON_LENGTH = 120;

export type ModelPickInput = {
  title: string;
  body: string;
  labels: string[];
  /** 付いているコメントの数。やり取りが多いほど込み入っている手がかりになる */
  commentCount: number;
  /** 承認済みの計画コメント（あれば）。無ければ空文字 */
  planComment?: string;
};

export type ModelPickResult = {
  model: ModelPickCandidate;
  /** なぜそのモデルなのか（日本語1〜2文） */
  reason: string;
  /** AIが選んだのか、ルールへ倒れたのか。画面がそのまま出す */
  source: "ai" | "rule";
};

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...(省略)`;
}

/**
 * ラベル名から番号の接頭辞（`30.`）を落として小文字にする。
 * ラベルはリポジトリごとに番号がずれることがあるため、**番号ではなく名前で判定する**。
 */
function normalizeLabel(label: string): string {
  return label.replace(/^\d+\./, "").trim().toLowerCase();
}

/**
 * ラベルと分量から選ぶ（#2723）。**AIを呼べなかったときの逃げ道。**
 *
 * 読めるのは「どの種類の作業か」と「どれだけ書かれているか」までなので、**最上位（Fable）は
 * 選ばない**——ここで一番高いものへ倒すと、AIが落ちている間ずっと重いモデルで走ることになる。
 * 判定の根拠が説明できることを優先し、迷ったら`sonnet`にする。
 */
export function pickModelByRule(input: ModelPickInput): {
  model: ModelPickCandidate;
  reason: string;
} {
  const labels = input.labels.map(normalizeLabel);
  const has = (name: string) => labels.some((label) => label === name);
  const bodyLength = input.body.replace(/\s+/g, "").length;

  if (has("bug") || has("unexpected")) {
    return { model: "opus", reason: "不具合のIssueで、原因の調査から始まるためです。" };
  }
  if (has("plan-required") || bodyLength >= 800 || input.commentCount >= 10) {
    return {
      model: "opus",
      reason: "計画や長いやり取りがあり、決めることが多いIssueだと読めるためです。",
    };
  }
  if (bodyLength <= 200 && (has("docs") || has("improvement") || has("chore"))) {
    return { model: "haiku", reason: "短く書かれた改善・整備のIssueで、判断が少ないためです。" };
  }
  return { model: "sonnet", reason: "やることの範囲が読める通常の実装だと判断したためです。" };
}

/** Issueの内容から使うモデルを選ばせるプロンプトを組み立てる。 */
export function buildModelPickPrompt(input: ModelPickInput): string {
  const labels = input.labels.length > 0 ? input.labels.join(", ") : "（なし）";
  const body = input.body.trim()
    ? truncate(input.body, MODEL_PICK_BODY_HEAD_LENGTH)
    : "（本文なし）";
  const plan = input.planComment?.trim()
    ? `\n# 承認済みの計画\n${truncate(input.planComment, MODEL_PICK_PLAN_HEAD_LENGTH)}\n`
    : "";

  return `以下は、これから実装エージェント（Claude Code）に実装させるGitHubのIssueです。**このIssueの実装に使うモデル**を1つ選んでください。

# 選択肢

- \`haiku\`: 文言の修正・定型的な追記など、**判断がほとんど要らない**作業向け
- \`sonnet\`: やることがはっきりしている**通常の実装**向け（既定。迷ったらこれ）
- \`opus\`: 既存の作りを**調べたうえでの判断**が要る実装、原因の切り分けが要る不具合向け
- \`fable\`: 原因がまるで読めない不具合や、**設計から考える**必要がある実装向け

# 選び方

- **内容の難しさで選んでください。** 分量が多いだけのIssue（列挙されているだけ・手順が長いだけ）は難しいとは限りません
- \`fable\`は「調べても分からなそうか」「作りそのものを決める必要があるか」に当てはまるときだけにしてください
- 迷ったら\`sonnet\`にしてください

# 出力

前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。

{"model": "sonnet", "reason": "そのモデルを選んだ理由"}

- \`model\`は\`haiku\`・\`sonnet\`・\`opus\`・\`fable\`のいずれか
- \`reason\`は日本語で1〜2文。**Issueの何を見てそう判断したのか**が伝わるように書いてください

# Issue

タイトル: ${input.title}
ラベル: ${labels}
コメント数: ${input.commentCount}

${body}
${plan}`;
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
 * 応答テキストからモデルと理由を取り出す。**候補に無いモデルは採らない**（`null`を返し、
 * 呼び出し側がルールへ倒す）。理由が空でも、モデルさえ読めれば採用する。
 */
export function parseModelPick(
  text: string,
): { model: ModelPickCandidate; reason: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(text));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { model, reason } = parsed as { model?: unknown; reason?: unknown };
  if (typeof model !== "string") return null;

  const matched = MODEL_PICK_CANDIDATES.find(
    (candidate) => candidate === model.trim().toLowerCase(),
  );
  if (!matched) return null;

  return {
    model: matched,
    reason: typeof reason === "string" ? truncate(reason, MAX_REASON_LENGTH) : "",
  };
}

/**
 * Issueの内容から使うモデルを選ぶ（#2723）。**失敗してもここでは投げない。**
 *
 * 呼び出しの失敗・読めない応答・候補に無いモデルは、いずれも`pickModelByRule`へ倒す。
 * 起動そのものを止めるより、説明のつくモデルで立てる方が軽い。
 */
export async function pickModelForIssue(
  token: string,
  input: ModelPickInput,
): Promise<ModelPickResult> {
  const fallback = (): ModelPickResult => ({ ...pickModelByRule(input), source: "rule" });

  let text: string | undefined;
  try {
    const { response: res, json } = await callClaudeMessages<AnthropicMessageResponse>({
      feature: "model_pick",
      token,
      body: {
        max_tokens: 512,
        messages: [{ role: "user", content: buildModelPickPrompt(input) }],
      },
    });
    if (!res.ok) return fallback();
    text = json?.content?.find((block) => block.type === "text")?.text?.trim();
  } catch {
    return fallback();
  }

  if (!text) return fallback();
  const picked = parseModelPick(text);
  if (!picked) return fallback();

  return { ...picked, source: "ai" };
}
