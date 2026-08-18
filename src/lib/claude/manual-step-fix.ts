import { FENCE_PATTERN } from "@/lib/markdown-task-list";
import {
  MANUAL_STEP_COMMAND_MAX_LENGTH,
  type ManualStepCommandKind,
} from "@/lib/manual-step-command";

const ANTHROPIC_API = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

/**
 * 失敗した手作業の診断に使うモデル。他の機能（`issue-order.ts`など）と揃える。
 * 出すのは**提案まで**で、適用するかどうかは必ず人が決めるため、ここは軽量なもので足りる。
 */
const MODEL = "claude-haiku-4-5";

/**
 * 手作業アシスタントの代行実行（#1828）が失敗したときに、原因と修正コマンド案を出す（#1869）。
 *
 * これまでは終了コードと出力を画面に出して人に委ねるだけで、原因を調べるのも本文を直すのも
 * 手作業だった。いちばん多いのは**本文に書かれたコマンドが実際の環境と食い違っている**
 * （ユニット名・パスの間違い）ケースで、これは出力を読めば直せる。
 *
 * **ここが返すのは提案まで。** 実行するかどうかは人が押し、押した場合も
 * **Issue本文のコマンドを書き換えてから**既存の経路で実行する
 * （`lib/manual-step-command.ts`の`replaceManualStepCommand`）。
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
  /** 失敗したのが`## やること`の手順か、`## 完了の確認方法`のコマンドか */
  kind: ManualStepCommandKind;
  where: { device: string | null; directory: string | null; branch: string | null };
  /** その手順・確認として本文に書かれている内容（Markdownのまま） */
  markdown: string;
  /** 実際に実行したコマンド */
  command: string;
  /** 終了コード。打ち切り（124/137）もそのまま渡す */
  exitCode: number | null;
  /** 実行の出力（末尾）。**シークレットが混ざりうるので、渡すかどうかは人が決める** */
  output: string;
};

export type ManualStepFixResult = {
  /**
   * - `command` … コマンドを直せば通る。`command`に修正案が入る
   * - `retry` … 一時的な失敗。同じコマンドをもう一度実行すればよい
   * - `manual` … コマンドでは直せない（権限・別デバイスでの作業・まだ反映されていない等）
   */
  kind: "command" | "retry" | "manual";
  /** 何が起きたのか（1〜3文） */
  cause: string;
  /** `kind: "command"`のときの修正案。それ以外は`null` */
  command: string | null;
  /** 人がやることの助言。無ければ`null` */
  advice: string | null;
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

/** 失敗したコマンドと出力から、原因と修正案を求めるプロンプトを組み立てる。 */
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

  return `あなたはLinuxの運用作業を手伝うアシスタントです。手作業の手順書に書かれていたコマンドを実行したところ失敗しました。**原因**と、**コマンドを直せば通るかどうか**を判断してください。

# 実行した状況

- 手作業のタイトル: ${input.issueTitle}
- これは${target}
${where === "" ? "" : `${where}\n`}
実行したコマンドは、ホームディレクトリを起点に \`bash -c\` で1回だけ実行されます（標準入力は閉じています。対話的な入力はできません）。

# 手順書に書かれている内容

${truncate(input.markdown, 2000)}

# 実行したコマンド

\`\`\`
${input.command}
\`\`\`

# 結果

終了コード: ${input.exitCode ?? "不明"}

出力:
\`\`\`
${tailOutput(input.output)}
\`\`\`

# 判断の仕方

- **コマンドの書き間違い・環境との食い違い**（サービス名・パス・オプションの誤りなど）で、書き直せば通るなら \`command\`
- **一時的な失敗**（ネットワーク・ロック・まだ起動していない等）で、同じコマンドをもう一度実行すれば通る見込みがあるなら \`retry\`
- **コマンドでは直せない**（権限が足りない・別のデバイスで作業する必要がある・前提の変更がまだ反映されていない・出力から原因を特定できない）なら \`manual\`
- 迷ったら \`manual\` にしてください。**確信が持てない修正案を出さないでください**

# 修正案（\`command\`のとき）の条件

- **元のコマンドと同じことを、直した形で行うもの**にしてください。作業の内容そのものを変えないでください
- 出力に含まれていた値（トークン・パスワード等）をコマンドへ埋め込まないでください
- 対話的な入力を求めるコマンド、確認なしで広範囲を消すコマンド（\`rm -rf\`など）にしないでください
- コードフェンス（\`\`\`）を含めず、コマンドだけを書いてください

# 出力

前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。

{"kind": "command" | "retry" | "manual", "cause": "何が起きたのかを日本語で1〜3文", "command": "修正案（kindがcommandのときだけ。それ以外はnull）", "advice": "人がやること（あれば。無ければnull）"}`;
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
 * **修正案は形だけを検証する**（本文へ書き戻せる形か、元と違うか）。中身が正しいかどうかを
 * ここで判定する術は無く、判断するのは画面で差分を見た人。読めない応答・条件を満たさない
 * 修正案は`manual`へ倒す——コマンドを提示できないことより、壊れたコマンドを提示することの方が悪い。
 */
export function pickManualStepFix(text: string, currentCommand: string): ManualStepFixResult {
  const fallback: ManualStepFixResult = {
    kind: "manual",
    cause: "",
    command: null,
    advice: null,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(text));
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;

  const { kind, cause, command, advice } = parsed as {
    kind?: unknown;
    cause?: unknown;
    command?: unknown;
    advice?: unknown;
  };

  const result: ManualStepFixResult = {
    kind: kind === "command" || kind === "retry" ? kind : "manual",
    cause: typeof cause === "string" ? truncate(cause, MAX_CAUSE_LENGTH) : "",
    command: null,
    advice: typeof advice === "string" && advice.trim() !== "" ? truncate(advice, MAX_ADVICE_LENGTH) : null,
  };

  if (result.kind !== "command") return result;

  const proposed = typeof command === "string" ? command.trim() : "";
  const usable =
    proposed !== "" &&
    proposed.length <= MANUAL_STEP_COMMAND_MAX_LENGTH &&
    !proposed.split("\n").some((line) => FENCE_PATTERN.test(line)) &&
    proposed !== currentCommand.trim();
  if (!usable) return { ...result, kind: "manual" };

  return { ...result, command: proposed };
}

/**
 * 失敗した代行実行をClaudeに読ませ、原因と修正案を返す（#1869）。
 *
 * 呼ぶのは**失敗したときだけ**で、押した人が同意している場合に限る（出力にシークレットが
 * 混ざりうるため。画面の同意チェックと`POST /api/manual-steps/fix`が入口）。
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
  if (!text) return { kind: "manual", cause: "", command: null, advice: null };
  return pickManualStepFix(text, input.command);
}
