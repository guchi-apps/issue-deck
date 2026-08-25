import { FENCE_PATTERN } from "@/lib/markdown-task-list";
import {
  MANUAL_STEP_COMMAND_MAX_LENGTH,
  MANUAL_STEP_INSTRUCTION_MAX_LENGTH,
  type ManualStepCommandKind,
} from "@/lib/manual-step-command";
import {
  describeManualStepTroubleCategory,
  type ManualStepTroubleReport,
} from "@/lib/manual-step-trouble";

const ANTHROPIC_API = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

/**
 * 失敗した手作業の診断に使うモデル。他の機能（`issue-order.ts`など）と揃える。
 * 出すのは**提案まで**で、適用するかどうかは必ず人が決めるため、ここは軽量なもので足りる。
 */
const MODEL = "claude-haiku-4-5";

/**
 * 手作業アシスタントで想定外のことが起きたときに、原因と直し案を出す（#1869・#2299）。
 *
 * #1869では**代行実行（#1828）が0以外で終わったとき**だけを見ていた。いちばん多い失敗が
 * 「本文に書かれたコマンドが実際の環境と食い違っている」（ユニット名・パスの誤り）で、
 * これは出力を読めば直せるため。
 *
 * ただし**手作業の多くは代行できない**（ブラウザでの操作、メインPC・VPSでの作業、値を
 * 埋めてから実行するコマンド）。そこで想定外が起きても、画面には終了コードも出力も届かない。
 * #2299では**人が書いた状況**（分類・自由記述・任意の貼り付け）からも同じ診断を行い、
 * コマンドだけでなく**手順の説明文**も直せるようにした——外部ツールの画面が変わったときに
 * ずれているのはコマンドではなく文言だから。
 *
 * **ここが返すのは提案まで。** 適用するかどうかは人が押し、押した場合も
 * **Issue本文を書き換えてから**既存の経路で実行する（`lib/manual-step-command.ts`の
 * `replaceManualStepCommand`・`replaceManualStepInstruction`）。
 * 「実行するのは本文に書かれたコマンドだけ」という歯止め（docs/multi-agent/gates.md）を、
 * この機能でも崩さないための形。
 */

/** プロンプトへ載せる出力の長さ。**末尾を残して切る**（エラーは最後に出るため） */
export const MANUAL_STEP_FIX_OUTPUT_MAX_LENGTH = 4000;

/** 原因の説明として受け取る長さの上限 */
const MAX_CAUSE_LENGTH = 400;

/** 助言として受け取る長さの上限 */
const MAX_ADVICE_LENGTH = 400;

export type ManualStepFixInput = {
  issueTitle: string;
  /** 対象が`## やること`の手順か、`## 完了の確認方法`のコマンドか */
  kind: ManualStepCommandKind;
  where: { device: string | null; directory: string | null; branch: string | null };
  /** その手順・確認として本文に書かれている内容（Markdownのまま） */
  markdown: string;
  /**
   * 実行したコマンド。**代行できない手順では`null`**（#2299）。`null`のときは
   * コマンドの直し案（`kind: "command"`）を出させない
   */
  command: string | null;
  /** 終了コード。打ち切り（124/137）もそのまま渡す。代行実行が無ければ`null` */
  exitCode: number | null;
  /** 実行の出力（末尾）。**シークレットが混ざりうるので、渡すかどうかは人が決める** */
  output: string;
  /**
   * その手順の説明文（`- [ ]`の行の本文。#2299）。文言の直し案を出させる材料で、
   * **空文字なら直せる文言が無い**（確認節・チェックリストでない本文）ものとして扱う
   */
  instruction: string;
  /**
   * 人が書いたつまずきの内容（#2299）。代行実行の失敗だけから呼ばれた場合は`null`。
   * `pasted`は**同意があるときだけ**入っている
   */
  report: ManualStepTroubleReport | null;
};

export type ManualStepFixResult = {
  /**
   * - `command` … コマンドを直せば通る。`command`に修正案が入る
   * - `instruction` … 手順の説明文が実態とずれている。`instruction`に直し案が入る（#2299）
   * - `retry` … 一時的な失敗。同じコマンドをもう一度実行すればよい
   * - `manual` … どちらの書き換えでも直せない（権限・別デバイスでの作業・まだ反映されていない等）
   */
  kind: "command" | "instruction" | "retry" | "manual";
  /** 何が起きたのか（1〜3文） */
  cause: string;
  /** `kind: "command"`のときの修正案。それ以外は`null` */
  command: string | null;
  /** `kind: "instruction"`のときの手順の直し案（1行）。それ以外は`null` */
  instruction: string | null;
  /** 人がやることの助言。無ければ`null` */
  advice: string | null;
};

/** 応答の検証に使う「いま本文に書かれているもの」 */
export type ManualStepFixCurrent = {
  command: string | null;
  instruction: string;
};

function truncate(text: string, maxLength: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...(省略)`;
}

/** 出力は**末尾**を残して切る（エラーは最後に出る） */
function tailOutput(output: string): string {
  const trimmed = output.trimEnd();
  if (trimmed.length <= MANUAL_STEP_FIX_OUTPUT_MAX_LENGTH) return trimmed;
  return `...(先頭を省略)\n${trimmed.slice(-MANUAL_STEP_FIX_OUTPUT_MAX_LENGTH)}`;
}

/** 代行実行の結果。実行していない（人が自分で実行した）場合は節ごと出さない */
function describeRun(input: ManualStepFixInput): string {
  if (input.command === null) {
    return `# 実行の結果

このIssueの手順は${input.where.device === null ? "この環境" : input.where.device}で人が実行するもので、issue-deckからは実行していません。終了コードも出力もありません。
`;
  }
  return `# 実行したコマンド

\`\`\`
${input.command}
\`\`\`

# 結果

終了コード: ${input.exitCode ?? "不明（実行していない・結果が届いていない）"}

出力:
\`\`\`
${input.output.trim() === "" ? "(出力はありません)" : tailOutput(input.output)}
\`\`\`
`;
}

/** 人が書いたつまずき（#2299）。書かれていなければ節ごと出さない */
function describeReport(report: ManualStepTroubleReport | null): string {
  if (report === null) return "";
  const category = describeManualStepTroubleCategory(report.category);
  const pasted =
    report.pasted.trim() === ""
      ? ""
      : `\n実行した人が貼り付けた出力・画面の文言:\n\`\`\`\n${tailOutput(report.pasted)}\n\`\`\`\n`;
  return `# 実行した人が報告した内容

${category === null ? "" : `分類: ${category}\n`}起きたこと:
${truncate(report.detail, 2000)}
${pasted}
`;
}

/** 失敗した状況から、原因と直し案を求めるプロンプトを組み立てる。 */
export function buildManualStepFixPrompt(input: ManualStepFixInput): string {
  const where = [
    input.where.device === null ? null : `実行するデバイス: ${input.where.device}`,
    input.where.directory === null ? null : `カレントディレクトリ: ${input.where.directory}`,
    input.where.branch === null ? null : `Gitブランチ: ${input.where.branch}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const target =
    input.kind === "step"
      ? "作業手順の1つ（実行すると環境が変わります）"
      : "作業が終わったことを確かめるための確認コマンド（環境は変えません）";

  const canFixCommand = input.command !== null;
  const canFixInstruction = input.instruction.trim() !== "";

  const kinds = [
    canFixCommand
      ? "- **コマンドの書き間違い・環境との食い違い**（サービス名・パス・オプションの誤りなど）で、書き直せば通るなら `command`"
      : null,
    canFixInstruction
      ? "- **手順の説明文が実際と食い違っている**（外部ツールの画面・ボタン名・メニューの位置が変わった、書かれている場所や名前が実物と違う）ため、文言を直せば実行できるなら `instruction`"
      : null,
    "- **一時的な失敗**（ネットワーク・ロック・まだ起動していない等）で、同じことをもう一度試せば通る見込みがあるなら `retry`",
    "- **本文を直しても解決しない**（権限が足りない・別のデバイスで作業する必要がある・前提の変更がまだ反映されていない・情報が足りず原因を特定できない）なら `manual`",
    "- 迷ったら `manual` にしてください。**確信が持てない直し案を出さないでください**",
  ].filter((line): line is string => line !== null);

  const conditions = [
    canFixCommand
      ? `## \`command\`（コマンドの修正案）

- **元のコマンドと同じことを、直した形で行うもの**にしてください。作業の内容そのものを変えないでください
- 出力に含まれていた値（トークン・パスワード等）をコマンドへ埋め込まないでください
- 対話的な入力を求めるコマンド、確認なしで広範囲を消すコマンド（\`rm -rf\`など）にしないでください
- コードフェンス（\`\`\`）を含めず、コマンドだけを書いてください`
      : null,
    canFixInstruction
      ? `## \`instruction\`（手順の説明文の直し案）

いま本文に書かれている説明文:
${input.instruction}

- **改行を含まない1行**で、${MANUAL_STEP_INSTRUCTION_MAX_LENGTH}文字以内にしてください（チェックボックス \`- [ ]\` は含めません）
- **文頭のデバイスの印（\`（ブラウザ）\`・\`（サブPC）\`など）は元のまま残してください**
- **やること自体は変えないでください。** 変えるのは、実物と食い違っている呼び名・場所・操作の言い方だけです
- 実行時の出力・画面から読み取った値（トークン・パスワード等）を書き込まないでください`
      : null,
  ].filter((line): line is string => line !== null);

  return `あなたはLinuxの運用作業と、Webサービスの管理画面での設定作業を手伝うアシスタントです。手作業の手順書のとおりに進めたところ、想定していないことが起きました。**原因**と、**手順書のどこを直せば進めるか**を判断してください。

# 状況

- 手作業のタイトル: ${input.issueTitle}
- これは${target}
${where === "" ? "" : `${where}\n`}
コマンドを実行する場合、ホームディレクトリを起点に \`bash -c\` で1回だけ実行されます（標準入力は閉じています。対話的な入力はできません）。

# 手順書に書かれている内容

${truncate(input.markdown, 2000)}

${describeRun(input)}
${describeReport(input.report)}
# 判断の仕方

${kinds.join("\n")}

# 直し案の条件

${conditions.length === 0 ? "本文を直して解決できる余地はありません（`retry` か `manual` を選んでください）。" : conditions.join("\n\n")}

# 出力

前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。

{"kind": ${[canFixCommand ? '"command"' : null, canFixInstruction ? '"instruction"' : null, '"retry"', '"manual"'].filter(Boolean).join(" | ")}, "cause": "何が起きたのかを日本語で1〜3文", "command": "コマンドの修正案（kindがcommandのときだけ。それ以外はnull）", "instruction": "手順の説明文の直し案（kindがinstructionのときだけ。それ以外はnull）", "advice": "人がやること（あれば。無ければnull）"}`;
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
 * 応答から診断結果を取り出す。
 *
 * **直し案は形だけを検証する**（本文へ書き戻せる形か、元と違うか）。中身が正しいかどうかを
 * ここで判定する術は無く、判断するのは画面で差分を見た人。読めない応答・条件を満たさない
 * 直し案は`manual`へ倒す——提示できないことより、壊れたものを提示することの方が悪い。
 */
export function pickManualStepFix(
  text: string,
  current: ManualStepFixCurrent,
): ManualStepFixResult {
  const fallback: ManualStepFixResult = {
    kind: "manual",
    cause: "",
    command: null,
    instruction: null,
    advice: null,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(text));
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;

  const { kind, cause, command, instruction, advice } = parsed as {
    kind?: unknown;
    cause?: unknown;
    command?: unknown;
    instruction?: unknown;
    advice?: unknown;
  };

  const result: ManualStepFixResult = {
    kind:
      kind === "command" || kind === "instruction" || kind === "retry"
        ? kind
        : "manual",
    cause: typeof cause === "string" ? truncate(cause, MAX_CAUSE_LENGTH) : "",
    command: null,
    instruction: null,
    advice:
      typeof advice === "string" && advice.trim() !== ""
        ? truncate(advice, MAX_ADVICE_LENGTH)
        : null,
  };

  if (result.kind === "command") {
    const proposed = typeof command === "string" ? command.trim() : "";
    const usable =
      current.command !== null &&
      proposed !== "" &&
      proposed.length <= MANUAL_STEP_COMMAND_MAX_LENGTH &&
      !proposed.split("\n").some((line) => FENCE_PATTERN.test(line)) &&
      proposed !== current.command.trim();
    return usable ? { ...result, command: proposed } : { ...result, kind: "manual" };
  }

  if (result.kind === "instruction") {
    const proposed = typeof instruction === "string" ? instruction.trim() : "";
    const usable =
      current.instruction.trim() !== "" &&
      proposed !== "" &&
      proposed.length <= MANUAL_STEP_INSTRUCTION_MAX_LENGTH &&
      !proposed.includes("\n") &&
      !FENCE_PATTERN.test(proposed) &&
      proposed !== current.instruction.trim();
    return usable ? { ...result, instruction: proposed } : { ...result, kind: "manual" };
  }

  return result;
}

/**
 * 想定外だった手作業をClaudeに読ませ、原因と直し案を返す（#1869・#2299）。
 *
 * 呼ぶのは**代行実行が失敗したとき**か、**人が「うまくいかない」から状況を書いて押したとき**
 * だけ。どちらも出力・貼り付けを送ることへの同意が要る（`POST /api/manual-steps/fix`が入口）。
 */
export async function diagnoseManualStepFailure(
  token: string,
  input: ManualStepFixInput,
): Promise<ManualStepFixResult> {
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
      messages: [{ role: "user", content: buildManualStepFixPrompt(input) }],
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Claudeによる原因の調査に失敗しました (${res.status})`);
  }

  const json = (await res.json()) as AnthropicMessageResponse;
  const text = json.content?.find((block) => block.type === "text")?.text?.trim();
  if (!text) {
    return { kind: "manual", cause: "", command: null, instruction: null, advice: null };
  }
  return pickManualStepFix(text, { command: input.command, instruction: input.instruction });
}
