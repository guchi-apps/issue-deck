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
 * Codexの候補。Claude側のsonnet/opus/fableに、標準（Terra）・高精度（Sol）・最上位（Astra）が当たる。
 * Lunaは軽い作業向け（`agent-model-color.ts`の段の対応と同じ物差し）。
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
  /** 候補ごとの確率（0〜1）。**Jevのときだけ入る。** キーは`model`と同じ候補集合 */
  probabilities?: Record<string, number>;
};

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...(省略)`;
}

/** 見出しにこの語が含まれる節は、後半にあっても判断材料として残す（#4106） */
const DECISION_HEADING = /決定|確定|方針|仕様|前提|完了条件|要件|制約|承認/;

/**
 * 判定へ渡す本文・計画の抜粋（#4106）。**先頭だけを切ると、後半に書かれた決定事項が落ちて**
 * 「まだ決まっていない」ように見え、難しさを過大評価する。上限を超えるときは
 * 先頭＋決定事項などの節（見出しに`DECISION_HEADING`を含むもの）＋末尾を残す。
 * 上限（`maxLength`）自体は変えない。
 */
export function excerptForPick(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;

  const headLength = Math.floor(maxLength * 0.5);
  const tailLength = Math.floor(maxLength * 0.2);
  const sectionBudget = maxLength - headLength - tailLength;

  const sections: string[] = [];
  let used = 0;
  const parts = text.split(/^(?=#{1,6}\s)/m);
  let offset = 0;
  for (const part of parts) {
    const start = offset;
    offset += part.length;
    const heading = part.match(/^#{1,6}\s+(.*)/)?.[1] ?? "";
    // 先頭の抜粋に入る節は重ねて載せない
    if (!DECISION_HEADING.test(heading) || start < headLength) continue;
    const body = part.replace(/\s+/g, " ").trim().slice(0, sectionBudget - used);
    if (!body) break;
    sections.push(body);
    used += body.length;
    if (used >= sectionBudget) break;
  }

  const head = normalized.slice(0, headLength);
  const tail = normalized.slice(normalized.length - tailLength);
  return [head, ...sections, tail].join(" ...(中略)... ");
}

/**
 * ラベル名から番号の接頭辞（`30.`）を落として小文字にする。
 * ラベルはリポジトリごとに番号がずれることがあるため、**番号ではなく名前で判定する**。
 */
function normalizeLabel(label: string): string {
  return label.replace(/^\d+\./, "").trim().toLowerCase();
}

/**
 * 本文に書かれた「未解決の判断」の手がかり（#4106）。**ラベル・本文の長さ・コメント数は見ない**
 * ——名称や分量だけでは難しさが分からず、明確な仕様の新規画面や修正方法の決まった不具合まで
 * 中級へ上がってしまうため。
 */
const UNRESOLVED_HINTS = [
  /原因(が|は)?(不明|わから|分から|未特定|特定できて)/,
  /切り分け/,
  /再現(し|でき)ない/,
  /複数(の)?(案|候補)|どちらにする|案[AＡ]|要検討|比較して(決|検討)/,
  /整合(性)?を(保|取|判断)/,
];

function hasUnresolvedHint(input: ModelPickInput): boolean {
  const text = `${input.title}\n${input.body}`;
  return UNRESOLVED_HINTS.some((hint) => hint.test(text));
}

/**
 * 本文から選ぶ（#2723・#4106）。**AIを呼べなかったときの逃げ道。**
 *
 * **ラベル・本文の長さ・コメント数だけでは昇格しない。** 中級へ上げるのは、本文に未解決の判断
 * （原因の切り分け・複数案の比較など）が書かれているときだけ。最上位（Fable）は選ばない
 * ——ここで一番高いものへ倒すと、AIが落ちている間ずっと重いモデルで走ることになる。
 * 迷ったら`sonnet`にする。
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

  if (hasUnresolvedHint(input)) {
    return {
      model: "opus",
      reason: "本文に原因の切り分けや案の比較など、未解決の判断が書かれているためです。",
    };
  }
  return { model: "sonnet", reason: "やることの範囲が読める通常の実装だと判断したためです。" };
}

/**
 * Codex版のルール（#3192・#4106）。考え方はClaude版と同じで、**ラベル・分量・コメント数では
 * 昇格しない**。**Lunaを選ぶのは文書だけの更新のような説明のつく場合に限り**、迷ったらTerraにする。
 * 最上位のAstraはClaude側のFableと同様にフォールバックで選ばない。
 */
function pickCodexModelByRule(
  input: ModelPickInput,
  has: (name: string) => boolean,
  bodyLength: number,
): { model: CodexLocalModel; reason: string } {
  if (hasUnresolvedHint(input)) {
    return {
      model: "gpt-6-sol",
      reason: "本文に原因の切り分けや案の比較など、未解決の判断が書かれているためです。",
    };
  }
  if (has("documentation") && bodyLength < 400) {
    return { model: "gpt-6-luna", reason: "文書だけの短い更新だと読めるためです。" };
  }
  return { model: "gpt-5.6-terra", reason: "やることの範囲が読める通常の実装だと判断したためです。" };
}

/**
 * 判定基準の共通方針（#4106）。**Jev・アプリ内AI・ルール、Claude・Codexで方向を揃える**ため、
 * 文面はここ1か所に置いて各所が参照する。
 */
const PICK_POLICY = `このIssueの実装と検証に十分な最小のモデルを選んでください。新規画面・デザイン・設計・調査という名称ではなく、**未解決の判断とリスク**を評価してください。仕様や承認済み計画で方針が決まっており、既存パターンで実装できる場合は軽量を選びます。既存コードを読むこと、作業量、本文の長さ、コメント数、ラベルだけでは上位を選ぶ根拠になりません。中級以上は、未確定のUI/UXの比較判断、相互依存する状態の整合、原因不明の不具合、重大な影響などの具体的根拠がある場合に選んでください。承認済みの計画がある場合は、解決済みの設計課題を難しさへ加算せず、残る実装・検証の難しさを評価してください（ただし計画済みでも難しい実装や重大な影響は過小評価しないでください）。本文や計画は途中を省略していることがあります。材料が足りないこと自体は難しさの根拠にならず、根拠が乏しければ軽量にしてください`;

const CODEX_PICK_OPTIONS = `- \`gpt-6-astra\`: 中級でも不足する、広範で複雑なアーキテクチャ判断や高い不確実性・リスクがある実装向け
- \`gpt-6-sol\`: 未確定のUI/UXの比較判断、相互依存する状態の整合、原因の切り分けが要る不具合、影響の大きい変更向け
- \`gpt-5.6-terra\`: 仕様・方針が明確な**通常の実装**向け（既定。迷ったらこれ）。仕様が決まった新規画面、既存パターンに沿う機能追加、修正方法が分かっている不具合を含む
- \`gpt-6-luna\`: 文言・設定値の修正や、決まった手順をなぞるだけの**軽い作業**向け`;

const CODEX_PICK_GUIDE = `- ${PICK_POLICY}
- \`gpt-6-astra\`は中級でも不足する具体的な根拠があるときだけにしてください
- \`gpt-6-luna\`は変更の範囲が数行〜1ファイルに収まると読めるときだけにしてください
- 迷ったら\`gpt-5.6-terra\`にしてください`;

/** Issueの内容から使うモデルを選ばせるプロンプトを組み立てる。 */
export function buildModelPickPrompt(
  input: ModelPickInput,
  agent: ModelPickAgent = "claude",
): string {
  const labels = input.labels.length > 0 ? input.labels.join(", ") : "（なし）";
  const body = input.body.trim()
    ? excerptForPick(input.body, MODEL_PICK_BODY_HEAD_LENGTH)
    : "（本文なし）";
  const plan = input.planComment?.trim()
    ? `\n# 承認済みの計画\n${excerptForPick(input.planComment, MODEL_PICK_PLAN_HEAD_LENGTH)}\n`
    : "";

  const isCodex = agent === "codex";
  const agentName = isCodex ? "Codex CLI" : "Claude Code";
  const options = isCodex
    ? CODEX_PICK_OPTIONS
    : `- \`sonnet\`: 仕様・方針が明確な**通常の実装**向け（既定。迷ったらこれ）。色・余白・文言など小さな見た目の調整、仕様が決まった新規画面、既存パターンに沿う機能追加、修正方法が分かっている不具合を含む
- \`opus\`: 未確定のUI/UXの**比較判断**、相互依存する状態の整合、原因の**切り分け**が要る不具合、影響の大きい変更向け
- \`fable\`: 中級でも不足する、広範で複雑な**アーキテクチャ判断**や高い不確実性・リスクがある実装向け`;
  const guide = isCodex
    ? CODEX_PICK_GUIDE
    : `- ${PICK_POLICY}
- \`fable\`は中級でも不足する具体的な根拠があるときだけにしてください
- 迷ったら\`sonnet\`にしてください`;
  const example = isCodex ? "gpt-5.6-terra" : "sonnet";
  const modelList = isCodex
    ? "`gpt-6-astra`・`gpt-6-sol`・`gpt-5.6-terra`・`gpt-6-luna`"
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

/** Jevへ渡す状態。**文章ではなくJSONで渡す**（Jevは構造化された入力をそのまま受け付ける） */
export function buildModelPickState(input: ModelPickInput): Record<string, unknown> {
  return {
    タイトル: input.title,
    ラベル: input.labels,
    コメント数: input.commentCount,
    本文: input.body.trim() ? excerptForPick(input.body, MODEL_PICK_BODY_HEAD_LENGTH) : "（本文なし）",
    ...(input.planComment?.trim()
      ? { 承認済みの計画: excerptForPick(input.planComment, MODEL_PICK_PLAN_HEAD_LENGTH) }
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
    sonnet:
      "仕様・方針が明確な通常の実装（小さな見た目の調整、仕様が決まった新規画面、既存パターンに沿う機能追加、修正方法が分かっている不具合を含む）。既定で、迷ったときもこれ",
    opus: "未確定のUI/UXの比較判断、相互依存する状態の整合、原因の切り分けが要る不具合、影響の大きい変更",
    fable:
      "中級でも不足する、広範で複雑なアーキテクチャ判断や高い不確実性・リスクがある実装",
  },
  codex: {
    "gpt-6-astra":
      "中級でも不足する、広範で複雑なアーキテクチャ判断や高い不確実性・リスクがある実装",
    "gpt-5.6-terra":
      "仕様・方針が明確な通常の実装（仕様が決まった新規画面、既存パターンに沿う機能追加、修正方法が分かっている不具合を含む）。既定で、迷ったときもこれ",
    "gpt-6-sol":
      "未確定のUI/UXの比較判断、相互依存する状態の整合、原因の切り分けが要る不具合、影響の大きい変更",
    "gpt-6-luna": "文言・設定値の修正や、決まった手順をなぞるだけの軽い作業",
  },
};

/**
 * Jevへ渡す質問。**聞くのは`model`の1問だけ**（#3255）。
 *
 * #3189では、画面に出す理由の1行を組み立てるために「難しさ」（`score`）と
 * 「調査から始まるか」（`noul`）を一緒に聞いていた。**どちらもモデルの選択には使っておらず**、
 * 選ぶのは`model`の答えだけだったため、文面の側でこの2つを出すのをやめたのに合わせて
 * 聞くのもやめた。選んだ結果は候補ごとの確率（`probabilities`）が画面で示す。
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
      }）にこのIssueを実装させます。${PICK_POLICY.replace(/\*\*/g, "")}。迷ったら${
        isCodex ? "gpt-5.6-terra" : "sonnet"
      }にしてください。`,
      criteria: CHOICE_CRITERIA_BY_AGENT[agent],
    },
  };
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

  const probabilities = readProbabilities(choice.probabilities, agent);

  return {
    model: model as ModelPickCandidate | CodexLocalModel,
    // Jevは文章を返さず、組み立てていた1行も出すのをやめたので空にする（#3255）
    reason: "",
    source: "jev",
    ...(probabilities ? { probabilities } : {}),
  };
}
