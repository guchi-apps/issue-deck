import { callClaudeMessages } from "@/lib/claude/request";
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

/**
 * 失敗した手作業の診断に使うモデル。他の機能（`issue-order.ts`など）と揃える。
 * 出すのは**提案まで**で、適用するかどうかは必ず人が決めるため、ここは軽量なもので足りる。
 */

/**
 * 手作業アシスタントで想定外のことが起きたときに、原因と直し案を出す（#1869・#2299・#2310）。
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
 *
 * #2310で**`steps`（この後にやること）**を足した。手順書を直しても進めない（`manual`）ときに
 * 返していたのは`cause`と自由記述の`advice`だけで、「確認してください」「必要に応じて〜」で
 * 終わることが多く、**読んだ人が次に何を打てばよいか決まらなかった**。`steps`は1件1行＋
 * コピーできるコマンドで、画面に並ぶだけ（本文へ入れず、実行もしない）。
 */

/** プロンプトへ載せる出力の長さ。**末尾を残して切る**（エラーは最後に出るため） */
export const MANUAL_STEP_FIX_OUTPUT_MAX_LENGTH = 4000;

/** 原因の説明として受け取る長さの上限 */
const MAX_CAUSE_LENGTH = 400;

/** 助言として受け取る長さの上限 */
const MAX_ADVICE_LENGTH = 400;

/**
 * 対処の手順として受け取る件数の上限（#2310）。
 *
 * **ここに並ぶのは「画面を閉じたあとに人が手でやること」**で、多いほど良いものではない。
 * 5つも6つも並ぶなら、それは1つの手順のつまずきではなく手順書ごと作り直す話になっている。
 */
export const MANUAL_STEP_FIX_STEPS_MAX_COUNT = 4;

/** 対処の手順1件の説明として受け取る長さの上限（#2310。テンプレートの「1手順＝1行」に合わせる） */
export const MANUAL_STEP_FIX_STEP_TEXT_MAX_LENGTH = MANUAL_STEP_INSTRUCTION_MAX_LENGTH;

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

/**
 * 人がこの後に手でやること1件（#2310）。
 *
 * **本文へは入らず、実行もしない。** 画面に並べてコピーできるようにするだけで、
 * 実行できるのは変わらず本文に書かれたコマンドだけ（docs/multi-agent/gates.md）。
 * 手順書そのものを直せるなら`command`・`instruction`の直し案が出ているはずで、
 * ここに並ぶのはそれでは届かない手元の作業。
 */
export type ManualStepFixStep = {
  /** 何をするかを1行で（命令形。文頭に`（サブPC）`のようにデバイスが付く） */
  text: string;
  /** その場で打てるコマンド。画面での操作などコマンドが無いものは`null` */
  command: string | null;
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
  /**
   * この後に人が手でやること（#2310）。**`manual`・`retry`では原則ここが埋まる。**
   * 原因を特定できなかった場合は「何を調べれば分かるか」が入る（空配列もありうる）
   */
  steps: ManualStepFixStep[];
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

  // 直し案として選べる種別。**選べないものは名前ごと出さない**（実行していない手順について
  // 修正コマンドを出させない、という#2299の線をこの節でも保つ）
  const fixableKinds = [
    canFixCommand ? "`command`" : null,
    canFixInstruction ? "`instruction`" : null,
  ].filter((name): name is string => name !== null);

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

# この後にやること（\`steps\`）

**画面を閉じたあと、実行する人が手でやることを順番に書いてください。** これを読む人は
${input.where.device ?? "作業する端末"}の前におり、「${input.issueTitle}」という手作業を途中まで進めて止まっています。
**「確認してください」「必要に応じて対処してください」のように、次に何を押すか・何を打つかが
決まらない書き方をしないでください。** それでは進められません。

- \`kind\`が \`manual\` か \`retry\` のときは**必ず1件以上**書いてください（最大${MANUAL_STEP_FIX_STEPS_MAX_COUNT}件）
${fixableKinds.length === 0 ? "" : `- \`kind\`が ${fixableKinds.join(" か ")} のときは、**画面のボタンで直る分は書かず**、それでも人がやることが残る場合だけ書いてください（無ければ空配列）\n`}- 1件は**改行を含まない1行**で、${MANUAL_STEP_FIX_STEP_TEXT_MAX_LENGTH}文字以内。命令形で「何をするか」を書いてください
- **どこでやるかを文頭に**\`（サブPC）\`\`（メインPC）\`\`（VPS）\`\`（ブラウザ）\`のいずれかで書いてください
- その場で打てるコマンドがあるものは \`steps[].command\` へ入れてください（無ければnull）。コードフェンスを含めず、対話的な入力を求めるコマンド・確認なしで広範囲を消すコマンド（\`rm -rf\`など）にしないでください
- **原因を特定できなかった場合は、「何を調べれば分かるか」を手順にしてください。** 状況を集めるコマンドを1件目に置き、最後の1件は「その出力を『うまくいかない』の貼り付け欄に貼って、もう一度『原因を調べる』を押す」にしてください
- 出力・画面から読み取った値（トークン・パスワード等）を書き込まないでください

# 出力

前置きや説明・コードフェンスを一切付けず、以下の形式のJSONのみを出力してください。

{"kind": ${[canFixCommand ? '"command"' : null, canFixInstruction ? '"instruction"' : null, '"retry"', '"manual"'].filter(Boolean).join(" | ")}, "cause": "何が起きたのかを日本語で1〜3文", "command": "コマンドの修正案（kindがcommandのときだけ。それ以外はnull）", "instruction": "手順の説明文の直し案（kindがinstructionのときだけ。それ以外はnull）", "advice": "補足があれば1〜2文（stepsに書いたことを繰り返さない。無ければnull）", "steps": [{"text": "（サブPC）この後にやること1件を1行で", "command": "そこで打つコマンド（無ければnull）"}]}`;
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
 * この後にやること（#2310）を取り出す。
 *
 * **1件ずつ形を見て、使えないものだけを落とす。** 直し案（`command`・`instruction`）と違い、
 * ここは本文へ書き戻すものではないので、1件が壊れていても全体を`manual`へ倒す必要はない。
 * 逆に、次に何をするかが1つも出せなかった場合は空配列で返し、画面が「調べ直す」導線を出す。
 */
function pickSteps(raw: unknown): ManualStepFixStep[] {
  if (!Array.isArray(raw)) return [];

  const steps: ManualStepFixStep[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { text, command } = entry as { text?: unknown; command?: unknown };

    const label = typeof text === "string" ? text.trim() : "";
    // 空・複数行・長すぎ・フェンス入りは「1手順＝1行」の形を崩している
    if (
      label === "" ||
      label.includes("\n") ||
      label.length > MANUAL_STEP_FIX_STEP_TEXT_MAX_LENGTH ||
      FENCE_PATTERN.test(label)
    ) {
      continue;
    }

    const proposed = typeof command === "string" ? command.trim() : "";
    // コマンドだけが使えない場合は、説明文だけを残す（やることは伝わる）
    const usable =
      proposed !== "" &&
      proposed.length <= MANUAL_STEP_COMMAND_MAX_LENGTH &&
      !proposed.split("\n").some((line) => FENCE_PATTERN.test(line));

    steps.push({ text: label, command: usable ? proposed : null });
    if (steps.length >= MANUAL_STEP_FIX_STEPS_MAX_COUNT) break;
  }
  return steps;
}

/**
 * 応答から診断結果を取り出す。
 *
 * **直し案は形だけを検証する**（本文へ書き戻せる形か、元と違うか）。中身が正しいかどうかを
 * ここで判定する術は無く、判断するのは画面で差分を見た人。読めない応答・条件を満たさない
 * 直し案は`manual`へ倒す——提示できないことより、壊れたものを提示することの方が悪い。
 *
 * **`manual`へ倒すときも`steps`（#2310）は残す。** 手順書を直せないことと、人が手元で何を
 * すればよいかが分からないことは別で、後者まで落とすと画面に助言だけが残る。
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
    steps: [],
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(text));
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;

  const { kind, cause, command, instruction, advice, steps } = parsed as {
    kind?: unknown;
    cause?: unknown;
    command?: unknown;
    instruction?: unknown;
    advice?: unknown;
    steps?: unknown;
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
    steps: pickSteps(steps),
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
  const { response: res, json } = await callClaudeMessages<AnthropicMessageResponse>({
    feature: "manual_step_fix",
    token,
    body: {
      // `steps`（#2310）のぶんだけ応答が長くなる。途中で切れるとJSONとして読めず`manual`へ倒れる
      max_tokens: 1536,
      messages: [{ role: "user", content: buildManualStepFixPrompt(input) }],
    },
  });

  if (!res.ok) {
    throw new Error(`Claudeによる原因の調査に失敗しました (${res.status})`);
  }

  const text = json?.content?.find((block) => block.type === "text")?.text?.trim();
  if (!text) {
    return { kind: "manual", cause: "", command: null, instruction: null, advice: null, steps: [] };
  }
  return pickManualStepFix(text, { command: input.command, instruction: input.instruction });
}
