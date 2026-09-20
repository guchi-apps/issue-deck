/**
 * 「実装を開始」ダイアログの「おまかせ」（#2723）。**Issueの内容から使うモデルを選ぶ。**
 *
 * 選ぶのは起動する前で、**決まった時点で具体的なモデル名になる**——ジョブへ積むのは
 * `sonnet`・`opus`・`fable`のいずれかで、`auto`（`--model`を付けない）ではない。
 * そのため実行キューの印にも受付コメントにも、選ばれたモデルがそのまま出る。
 *
 * **判定は当たり外れのあるもので、押した人が上書きできることが前提。** 画面は選んだ理由を
 * 必ず出し、納得できなければ別のチップを押せる形にしてある（`start-implementation-dialog.tsx`）。
 *
 * 呼び出しに失敗したとき・応答を読めなかったときは**ラベルと分量からのルール**へ倒す
 * （`pickModelByRule`）。AIが使えないからといって起動そのものを止めない。
 */

import { CODEX_LOCAL_MODEL_VALUES, type CodexLocalModel } from "@/lib/app-settings";
import { callClaudeMessages } from "@/lib/claude/request";
import {
  askSystemOne,
  readChoiceAnswer,
  readNoulAnswer,
  readScoreAnswer,
  type SystemOneQuestion,
} from "@/lib/typesafe/system-one";

/**
 * 自動選択が選べるモデル。`auto`（CLIの既定）は「選ばない」という選択なのでここには入れない。
 * **値は`ClaudeModel`の部分集合**なので、選ばれたものはそのままジョブへ積める。
 *
 * **`haiku`は入れない**（#2756）。ここで選んだモデルはサブPCのローカルセッション
 * （`--permission-mode auto`で起動）にしか使われず、Haikuはauto modeで動作しない
 * （https://github.com/anthropics/claude-code/issues/43235）。
 */
export const MODEL_PICK_CANDIDATES = ["sonnet", "opus", "fable"] as const;

export type ModelPickCandidate = (typeof MODEL_PICK_CANDIDATES)[number];

/**
 * 「おまかせ」で選ぶ対象のエージェント（#3192）。**判定を行うのはどちらもアプリ内AI**（Claude）で、
 * Codexのモデルを選ぶときも変わらない——変わるのは候補・プロンプト・ルールだけ。
 */
export type ModelPickAgent = "claude" | "codex";

/**
 * Codexの候補。Claude側のsonnet/opusに、標準（Terra）と重い（Sol）が当たる。Claude側にFableのような
 * 最上位は無く、代わりに軽い作業向けのLunaがある（`agent-model-color.ts`の段の対応と同じ物差し）。
 */
export const CODEX_MODEL_PICK_CANDIDATES = CODEX_LOCAL_MODEL_VALUES;

/** エージェントごとの候補。`parseModelPick`が候補外の応答を弾くのに使う */
const CANDIDATES_BY_AGENT: Readonly<Record<ModelPickAgent, readonly string[]>> = {
  claude: MODEL_PICK_CANDIDATES,
  codex: CODEX_MODEL_PICK_CANDIDATES,
};

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
  /** `agent`がclaudeなら`ModelPickCandidate`、codexなら`CodexLocalModel`（どちらもジョブへそのまま積める） */
  model: ModelPickCandidate | CodexLocalModel;
  /** なぜそのモデルなのか（日本語1〜2文） */
  reason: string;
  /**
   * 誰が選んだのか。画面がそのまま出す。
   * `jev`は判定専用モデル（#3189）、`ai`はアプリ内AI、`rule`はラベルと分量からのルール。
   */
  source: "ai" | "jev" | "rule";
  /** 選んだ答えへの確信度（0〜1）。**Jevのときだけ入る** */
  confidence?: number;
  /** 候補ごとの確率（0〜1）。**Jevのときだけ入る。** キーは`model`と同じ候補集合 */
  probabilities?: Record<string, number>;
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
export function pickModelByRule(
  input: ModelPickInput,
  agent: ModelPickAgent = "claude",
): {
  model: ModelPickCandidate | CodexLocalModel;
  reason: string;
} {
  const labels = input.labels.map(normalizeLabel);
  const has = (name: string) => labels.some((label) => label === name);
  const bodyLength = input.body.replace(/\s+/g, "").length;

  if (agent === "codex") return pickCodexModelByRule(input, has, bodyLength);

  if (has("bug") || has("unexpected")) {
    return { model: "opus", reason: "不具合のIssueで、原因の調査から始まるためです。" };
  }
  if (has("plan-required") || bodyLength >= 800 || input.commentCount >= 10) {
    return {
      model: "opus",
      reason: "計画や長いやり取りがあり、決めることが多いIssueだと読めるためです。",
    };
  }
  return { model: "sonnet", reason: "やることの範囲が読める通常の実装だと判断したためです。" };
}

/**
 * Codex版のルール（#3192）。考え方はClaude版と同じで、**Lunaを選ぶのは文書だけの更新のような
 * 説明のつく場合に限り**、迷ったらTerraにする。重い判定（Sol）へ倒すのも同じ条件。
 */
function pickCodexModelByRule(
  input: ModelPickInput,
  has: (name: string) => boolean,
  bodyLength: number,
): { model: CodexLocalModel; reason: string } {
  if (has("bug") || has("unexpected")) {
    return { model: "gpt-5.6-sol", reason: "不具合のIssueで、原因の調査から始まるためです。" };
  }
  if (has("plan-required") || bodyLength >= 800 || input.commentCount >= 10) {
    return {
      model: "gpt-5.6-sol",
      reason: "計画や長いやり取りがあり、決めることが多いIssueだと読めるためです。",
    };
  }
  if (has("documentation") && bodyLength < 400) {
    return { model: "gpt-5.6-luna", reason: "文書だけの短い更新だと読めるためです。" };
  }
  return { model: "gpt-5.6-terra", reason: "やることの範囲が読める通常の実装だと判断したためです。" };
}

const CODEX_PICK_OPTIONS = `- \`gpt-5.6-terra\`: やることがはっきりしている**通常の実装**向け（既定。迷ったらこれ）
- \`gpt-5.6-sol\`: 既存の作りを**調べたうえでの判断**が要る実装、原因の切り分けが要る不具合、**設計から考える**必要がある実装向け
- \`gpt-5.6-luna\`: 文言・設定値の修正や、決まった手順をなぞるだけの**軽い作業**向け`;

const CODEX_PICK_GUIDE = `- **内容の難しさで選んでください。** 分量が多いだけのIssue（列挙されているだけ・手順が長いだけ）は難しいとは限りません
- \`gpt-5.6-sol\`は「調べても分からなそうか」「作りそのものを決める必要があるか」に当てはまるときだけにしてください
- \`gpt-5.6-luna\`は変更の範囲が数行〜1ファイルに収まると読めるときだけにしてください
- 迷ったら\`gpt-5.6-terra\`にしてください`;

/** Issueの内容から使うモデルを選ばせるプロンプトを組み立てる。 */
export function buildModelPickPrompt(
  input: ModelPickInput,
  agent: ModelPickAgent = "claude",
): string {
  const labels = input.labels.length > 0 ? input.labels.join(", ") : "（なし）";
  const body = input.body.trim()
    ? truncate(input.body, MODEL_PICK_BODY_HEAD_LENGTH)
    : "（本文なし）";
  const plan = input.planComment?.trim()
    ? `\n# 承認済みの計画\n${truncate(input.planComment, MODEL_PICK_PLAN_HEAD_LENGTH)}\n`
    : "";

  const isCodex = agent === "codex";
  const agentName = isCodex ? "Codex CLI" : "Claude Code";
  const options = isCodex
    ? CODEX_PICK_OPTIONS
    : `- \`sonnet\`: やることがはっきりしている**通常の実装**向け（既定。迷ったらこれ）
- \`opus\`: 既存の作りを**調べたうえでの判断**が要る実装、原因の切り分けが要る不具合向け
- \`fable\`: 原因がまるで読めない不具合や、**設計から考える**必要がある実装向け`;
  const guide = isCodex
    ? CODEX_PICK_GUIDE
    : `- **内容の難しさで選んでください。** 分量が多いだけのIssue（列挙されているだけ・手順が長いだけ）は難しいとは限りません
- \`fable\`は「調べても分からなそうか」「作りそのものを決める必要があるか」に当てはまるときだけにしてください
- 迷ったら\`sonnet\`にしてください`;
  const example = isCodex ? "gpt-5.6-terra" : "sonnet";
  const modelList = isCodex
    ? "`gpt-5.6-sol`・`gpt-5.6-terra`・`gpt-5.6-luna`"
    : "`sonnet`・`opus`・`fable`";

  return `以下は、これから実装エージェント（${agentName}）に実装させるGitHubのIssueです。**このIssueの実装に使うモデル**を1つ選んでください。

# 選択肢

${options}

# 選び方

${guide}

# 出力

前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。

{"model": "${example}", "reason": "そのモデルを選んだ理由"}

- \`model\`は${modelList}のいずれか
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
  agent: ModelPickAgent = "claude",
): { model: ModelPickCandidate | CodexLocalModel; reason: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(text));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { model, reason } = parsed as { model?: unknown; reason?: unknown };
  if (typeof model !== "string") return null;

  const matched = CANDIDATES_BY_AGENT[agent].find(
    (candidate) => candidate === model.trim().toLowerCase(),
  );
  if (!matched) return null;

  return {
    model: matched as ModelPickCandidate | CodexLocalModel,
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
  agent: ModelPickAgent = "claude",
): Promise<ModelPickResult> {
  const fallback = (): ModelPickResult => ({ ...pickModelByRule(input, agent), source: "rule" });

  let text: string | undefined;
  try {
    const { response: res, json } = await callClaudeMessages<AnthropicMessageResponse>({
      feature: "model_pick",
      token,
      body: {
        max_tokens: 512,
        messages: [{ role: "user", content: buildModelPickPrompt(input, agent) }],
      },
    });
    if (!res.ok) return fallback();
    text = json?.content?.find((block) => block.type === "text")?.text?.trim();
  } catch {
    return fallback();
  }

  if (!text) return fallback();
  const picked = parseModelPick(text, agent);
  if (!picked) return fallback();

  return { ...picked, source: "ai" };
}

// ---------------------------------------------------------------------------
// Jev（TypeSafeのSystem Oneモデル）で選ぶ（#3189）
// ---------------------------------------------------------------------------

/**
 * 難しさの段（`score`質問の`criteria`）。**0から順に並べる。**
 * 4段にしてあるのは、候補のモデルが3つ＋「そもそも軽い」を分けたいため。
 */
const DIFFICULTY_LEVELS = [
  "やることがはっきりしていて、決めることがほとんどない",
  "既存の作りを少し読めば決められる",
  "既存の作りを調べたうえでの判断が要る",
  "調べても読めず、設計そのものから決める必要がある",
] as const;

const MAX_DIFFICULTY = DIFFICULTY_LEVELS.length - 1;

/** Jevへ渡す状態。**文章ではなくJSONで渡す**（Jevは構造化された入力をそのまま受け付ける） */
export function buildModelPickState(input: ModelPickInput): Record<string, unknown> {
  return {
    タイトル: input.title,
    ラベル: input.labels,
    コメント数: input.commentCount,
    本文: input.body.trim() ? truncate(input.body, MODEL_PICK_BODY_HEAD_LENGTH) : "（本文なし）",
    ...(input.planComment?.trim()
      ? { 承認済みの計画: truncate(input.planComment, MODEL_PICK_PLAN_HEAD_LENGTH) }
      : {}),
  };
}

/**
 * 候補ごとの説明。**アプリ内AI向けのプロンプト（`CODEX_PICK_OPTIONS`など）と同じ切り分け**にする
 * ——同じIssueで判定元を切り替えたときに、選ばれ方の基準まで変わってしまわないようにするため。
 */
const CHOICE_CRITERIA_BY_AGENT: Readonly<
  Record<ModelPickAgent, Readonly<Record<string, string>>>
> = {
  claude: {
    sonnet: "やることがはっきりしている通常の実装。既定で、迷ったときもこれ",
    opus: "既存の作りを調べたうえでの判断が要る実装、原因の切り分けが要る不具合",
    fable: "原因がまるで読めない不具合や、設計そのものから考える必要がある実装",
  },
  codex: {
    "gpt-5.6-terra": "やることがはっきりしている通常の実装。既定で、迷ったときもこれ",
    "gpt-5.6-sol":
      "既存の作りを調べたうえでの判断が要る実装、原因の切り分けが要る不具合、設計から考える必要がある実装",
    "gpt-5.6-luna": "文言・設定値の修正や、決まった手順をなぞるだけの軽い作業",
  },
};

/**
 * Jevへ渡す質問。**モデルの選択に加えて、理由を組み立てるための2問を足す。**
 *
 * Jevは文章を返さないため、`model`だけを聞くと画面に出す理由が「確率」しか無くなる。
 * 難しさの段と「調査から始まるか」を一緒に聞いておけば、**判定と同じ根拠から**
 * 理由の1行を組み立てられる（後付けの説明にならない）。3問まとめて1回の呼び出しで済む。
 */
export function buildModelPickQuestions(
  agent: ModelPickAgent = "claude",
): Record<string, SystemOneQuestion> {
  const isCodex = agent === "codex";
  return {
    model: {
      type: "choice",
      instructions: `これから実装エージェント（${
        isCodex ? "Codex CLI" : "Claude Code"
      }）にこのIssueを実装させます。使うモデルを選んでください。分量が多いだけのIssue（列挙されているだけ・手順が長いだけ）は難しいとは限りません。迷ったら${
        isCodex ? "gpt-5.6-terra" : "sonnet"
      }にしてください。`,
      criteria: CHOICE_CRITERIA_BY_AGENT[agent],
    },
    difficulty: {
      type: "score",
      instructions: "このIssueの実装はどれだけ難しいですか。",
      criteria: DIFFICULTY_LEVELS,
    },
    investigation: {
      type: "noul",
      instructions: "このIssueは、原因や既存の作りの調査から始める必要がありますか。",
      criteria: {
        true: "どこを直すかが決まっておらず、調べるところから始まる",
        false: "直す場所・作る場所が最初から分かっている",
      },
    },
  };
}

/** 確率（0〜1）を画面へ出す百分率の整数にする */
function toPercent(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

/** 期待値は段の間の小数になりうる。整数なら小数点を付けない */
function formatScore(score: number): string {
  const clamped = Math.min(MAX_DIFFICULTY, Math.max(0, score));
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Jevの答えから理由の1行を組み立てる。**Jevは文章を返さないので、ここはコードが書く。**
 *
 * 補助の2問が読めなかった場合でも、確信度だけで1行にして返す——理由を出す方針
 * （`start-implementation-dialog.tsx`）を、答えが減ったからといって落とさない。
 */
export function formatJevReason(parts: {
  difficulty: number | null;
  investigation: number | null;
  confidence: number | null;
}): string {
  const pieces: string[] = [];
  if (parts.difficulty !== null) {
    pieces.push(`難しさ ${formatScore(parts.difficulty)}/${MAX_DIFFICULTY}`);
  }
  if (parts.investigation !== null) {
    pieces.push(`原因の調査から始まる見込み ${toPercent(parts.investigation)}%`);
  }
  if (pieces.length > 0) return `${pieces.join("・")}と判定したためです。`;
  if (parts.confidence !== null) {
    return `確信度 ${toPercent(parts.confidence)}%で選びました。`;
  }
  return "";
}

/** 候補のぶんだけ確率を拾う。候補に無いラベルは捨てる */
function readProbabilities(
  probabilities: Record<string, number> | undefined,
  agent: ModelPickAgent,
): Record<string, number> | undefined {
  if (!probabilities || typeof probabilities !== "object") return undefined;
  const picked: Record<string, number> = {};
  for (const candidate of CANDIDATES_BY_AGENT[agent]) {
    const value = probabilities[candidate];
    if (typeof value === "number" && Number.isFinite(value)) picked[candidate] = value;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/**
 * Issueの内容から使うモデルをJevに選ばせる（#3189）。**選べなければ`null`。**
 *
 * `null`を返すのはキー未設定・呼び出しの失敗・答えの形が違ったときで、呼び出し元
 * （`POST /api/issues/model-pick`）がアプリ内AI→ルールの従来経路へ倒す。
 * **候補外のモデルは構造上返らない**ので、ここで弾くのは通信と設定の問題だけになる。
 */
export async function pickModelByJev(
  input: ModelPickInput,
  agent: ModelPickAgent = "claude",
): Promise<ModelPickResult | null> {
  const response = await askSystemOne({
    feature: "model_pick",
    state: buildModelPickState(input),
    questions: buildModelPickQuestions(agent),
  });
  if (!response) return null;

  const choice = readChoiceAnswer(response.answers?.model);
  if (!choice) return null;

  const model = CANDIDATES_BY_AGENT[agent].find(
    (candidate) => candidate === choice.choice.trim().toLowerCase(),
  );
  if (!model) return null;

  const difficulty = readScoreAnswer(response.answers?.difficulty);
  const investigation = readNoulAnswer(response.answers?.investigation);
  const confidence =
    typeof choice.confidence === "number" && Number.isFinite(choice.confidence)
      ? choice.confidence
      : null;

  const probabilities = readProbabilities(choice.probabilities, agent);

  return {
    model: model as ModelPickCandidate | CodexLocalModel,
    reason: truncate(
      formatJevReason({
        difficulty: difficulty?.score ?? null,
        investigation: investigation?.noul ?? null,
        confidence,
      }),
      MAX_REASON_LENGTH,
    ),
    source: "jev",
    ...(confidence === null ? {} : { confidence }),
    ...(probabilities ? { probabilities } : {}),
  };
}
