import { FENCE_PATTERN, TASK_LINE_PATTERN } from "@/lib/markdown-task-list";
import {
  matchManualStepDeviceNames,
  parseManualStepGuide,
  type ManualStepGuide,
} from "@/lib/manual-step-guide";

/**
 * 手作業アシスタント（#1826）の手順を、サブPCで代行実行できる形へ取り出す（#1828）。
 *
 * 手作業Issueの本文は`## やること`が「1手順＝1つの`- [ ]`、コマンドはその下のコードブロック」
 * という決まりで書かれている（CLAUDE.md「ユーザーの手作業が残る場合は新規Issueとして起票する」）。
 * ここではその決まりに**厳密に沿っている手順だけ**を取り出す。推定はしない——実行するコマンドを
 * 推定で組み立てる余地を作ると、そのまま事故になる。
 *
 * **画面・API・pollerの3か所が同じコマンドを指していることを、この関数だけで担保する。**
 * 画面は「どの手順か（`stepLine`）」と「承認したコマンド」を送り、APIは本文から**抽出し直した**
 * ものと突き合わせ、一致したものだけをジョブに載せる。画面から届いた文字列がそのまま実行へ
 * 流れる経路は無い（サブPC側でもpollerがGitHubの本文を読み直して同じ照合を行う）。
 */

/** 代行実行できる1件 */
export type ManualStepCommand = {
  /**
   * 本文の中でこのコマンドを指す行番号（1始まり）。
   *
   * - `kind: "step"` … その手順の`- [ ]`の行。画面のチェックと、どの手順かの指定に使う
   * - `kind: "verification"` … そのコードブロックの**開きフェンスの行**（#1869）。確認節には
   *   チェック行が無いので、ブロックそのものの位置で指す
   *
   * どちらも同じ本文の行番号なので、ジョブ（`DispatchJob.manualStepLine`）・画面・pollerは
   * 種別を意識せずに扱える。
   */
  stepLine: number;
  /** 実行するコマンド（コードブロックの中身。前後の空行を落としたもの） */
  command: string;
  /** `## やること`の手順か、`## 完了の確認方法`のコマンドか */
  kind: ManualStepCommandKind;
};

export type ManualStepCommandKind = "step" | "verification";

/**
 * 実行するコマンドとして受け付けるコードブロックの言語。
 *
 * **空の情報文字列（```だけ）は受け付けない。** 出力例・設定ファイルの抜粋が同じ書き方で
 * 置かれることがあり、「コマンドかどうか」を書き手の意図に頼れないため。取りこぼす側へ倒す。
 */
const SHELL_FENCE_LANGUAGES = new Set(["bash", "sh", "shell", "zsh"]);

/** コマンドの上限。テンプレートのコピペ用コマンドはこれに収まる */
export const MANUAL_STEP_COMMAND_MAX_LENGTH = 2000;

/** 代行実行の出力の上限。**末尾を残して切る**（エラーは最後に出るため） */
export const MANUAL_STEP_OUTPUT_MAX_LENGTH = 8000;

/** 代行実行を打ち切るまでの秒数。サブPC側（`scripts/run-manual-step.sh`）の`timeout`と揃える */
export const MANUAL_STEP_TIMEOUT_SECONDS = 300;

/**
 * 手順のMarkdownから、シェルのコードブロックを取り出す。
 *
 * **ちょうど1つのときだけ返す。** 0個なら実行するものが無く、2個以上なら「どれを実行したのか」が
 * チェック1つに対応しない（片方だけ実行して成功した状態でチェックが付くと、実行していない
 * コマンドまで済んだことになる）。どちらも代行の対象から外し、人が手元で実行する。
 */
export function extractShellBlock(markdown: string): string | null {
  const blocks = collectShellBlocks(markdown);
  if (blocks.length !== 1) return null;
  const command = blocks[0];
  if (command === "" || command.length > MANUAL_STEP_COMMAND_MAX_LENGTH) return null;
  return command;
}

/**
 * 手順のMarkdownに含まれるシェルのコードブロックをすべて取り出す。
 *
 * `extractShellBlock`が「ちょうど1つ」に絞る前の生の一覧。本文の書式検査
 * （`manual-step-body-check.ts`）は**0個と2個以上を区別して伝える**必要があるため、
 * 数え方を持つのはここ1か所にする。
 */
export function collectShellBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let openFence: string | null = null;
  let executable = false;
  let current: string[] = [];

  for (const line of markdown.split("\n")) {
    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (openFence === null) {
        openFence = marker;
        const language = line.slice(line.indexOf(fence[1]) + fence[1].length).trim().toLowerCase();
        executable = SHELL_FENCE_LANGUAGES.has(language);
        current = [];
        continue;
      }
      if (marker === openFence) {
        if (executable) blocks.push(current.join("\n").trim());
        openFence = null;
        executable = false;
        current = [];
      }
      continue;
    }
    if (openFence !== null) current.push(line);
  }

  return blocks;
}

/**
 * 本文から、代行実行できる手順の一覧を取り出す。
 *
 * `hasTemplate`でない本文（`## やること`をチェックリストで書いていないもの）は対象外。
 * 手順に割れていない本文をまとめて1コマンドとして実行すると、人が承認した単位と実行の単位が
 * ずれる（`parseManualStepGuide`はその場合、節全体を1手順として返す）。
 */
export function extractManualStepCommands(
  body: string | null,
  guide: ManualStepGuide = parseManualStepGuide(body),
): ManualStepCommand[] {
  if (!guide.hasTemplate) return [];

  const commands: ManualStepCommand[] = [];
  for (const step of guide.steps) {
    if (step.line === null) continue;
    const command = extractShellBlock(step.markdown);
    if (command === null) continue;
    commands.push({ stepLine: step.line, command, kind: "step" });
  }
  return commands;
}

/**
 * `## 完了の確認方法`から、代行実行できるコマンドを取り出す（#1869）。
 *
 * **手順と違い、ブロックが複数あっても全部返す。** 手順で「ちょうど1つ」に限っているのは、
 * チェック1つに対してどのコマンドを実行したのかが対応しなくなるためで、確認節には
 * チェックそのものが無い（実行しても本文は書き換わらない）。上から順に実行してよい。
 *
 * 実行結果は画面に出すだけで、**チェックもクローズもしない**。「期待する出力」との照合は
 * しないので、終了コードが0でも完了とは限らない——それを判断するのは人。
 *
 * 走査するのは**本文の生の行**（`guide.verification`ではない）。画面へ渡すMarkdownは
 * インデントと前後の空行を落とした後の文字列で、そこからは本文の行番号へ戻せない。
 */
export function extractVerificationCommands(
  body: string | null,
  guide: ManualStepGuide = parseManualStepGuide(body),
): ManualStepCommand[] {
  if (!body || guide.verificationRange === null) return [];

  const lines = body.split("\n");
  const { start, end } = guide.verificationRange;
  const commands: ManualStepCommand[] = [];

  for (const block of findShellBlocks(lines, start - 1, Math.min(end, lines.length))) {
    commands.push({ stepLine: block.fenceIndex + 1, command: block.command, kind: "verification" });
  }
  return commands;
}

/**
 * 本文から代行実行できるコマンドを、実行する順（手順 → 完了の確認）にすべて取り出す（#1869）。
 *
 * 画面・API・pollerが同じ並びを見るための唯一の入口。**確認節を含めるかどうかを
 * 呼び出し側の判断にしない**（含める側と含めない側が生まれると、画面で押せるのにAPIが拒否する）。
 */
export function extractRunnableManualStepCommands(
  body: string | null,
  guide: ManualStepGuide = parseManualStepGuide(body),
): ManualStepCommand[] {
  return [...extractManualStepCommands(body, guide), ...extractVerificationCommands(body, guide)];
}

/** `stepLine`が指すコマンドを引く。無ければ`null`（＝そこは代行できない） */
export function findManualStepCommand(
  body: string | null,
  stepLine: number,
): ManualStepCommand | null {
  return (
    extractRunnableManualStepCommands(body).find((entry) => entry.stepLine === stepLine) ?? null
  );
}

/**
 * `stepLine`が指すコマンドを、`nextCommand`へ差し替えた本文を返す（#1869）。
 *
 * 失敗した手順に対してClaudeが出した修正案を適用するための書き換え。**本文へ入るのは
 * コマンドの文字列だけ**で、原因の説明も実行時の出力も入れない（このリポジトリはPUBLICで、
 * 手作業の出力にはシークレットが混ざりうる）。置き換えるのはコードブロックの中身だけで、
 * フェンスの記号・インデント・前後の行はそのまま残す。
 *
 * **一意に特定できなければ`null`**（安全側へ倒す）。書き換えた結果からコマンドを取り出し直して
 * 元どおり読めることまで確かめてから返すので、壊れた本文をGitHubへ送らない。
 */
export function replaceManualStepCommand(
  body: string | null,
  stepLine: number,
  nextCommand: string,
): string | null {
  if (!body) return null;

  const command = nextCommand.trim();
  if (command === "" || command.length > MANUAL_STEP_COMMAND_MAX_LENGTH) return null;
  // フェンスを含むコマンドはブロックを閉じてしまう（本文の構造が壊れる）
  if (command.split("\n").some((line) => FENCE_PATTERN.test(line))) return null;

  const current = findManualStepCommand(body, stepLine);
  if (current === null) return null;

  const lines = body.split("\n");
  const block = findBlockForCommand(lines, stepLine, current.kind);
  if (block === null) return null;

  const indent = " ".repeat(block.indent);
  const replaced = [
    ...lines.slice(0, block.fenceIndex + 1),
    ...command.split("\n").map((line) => (line === "" ? "" : `${indent}${line}`)),
    ...lines.slice(block.closeIndex),
  ].join("\n");

  // 書き換えた本文から同じ行を引き直せることまで確かめる。ここが通らない書き換えは
  // 画面・API・pollerの照合も通らないため、送る前に捨てる
  if (findManualStepCommand(replaced, stepLine)?.command !== command) return null;
  return replaced;
}

/** 差し替える対象のコードブロック（開き・閉じフェンスの位置とインデント） */
type ShellBlock = { fenceIndex: number; closeIndex: number; indent: number; command: string };

/** `stepLine`が指すコマンドのコードブロックを、本文の行の中から1つに定める */
function findBlockForCommand(
  lines: string[],
  stepLine: number,
  kind: ManualStepCommandKind,
): ShellBlock | null {
  if (kind === "verification") {
    // 確認節は開きフェンスの行そのものを指している
    const blocks = findShellBlocks(lines, stepLine - 1, lines.length);
    const block = blocks[0];
    return block && block.fenceIndex === stepLine - 1 ? block : null;
  }

  // 手順は`- [ ]`の行を指しているので、そこから次の手順（または節の終わり）までを見る
  const start = stepLine - 1;
  let end = lines.length;
  let openFence: string | null = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const fence = FENCE_PATTERN.exec(lines[index]);
    if (fence) {
      const marker = fence[1][0];
      if (openFence === null) openFence = marker;
      else if (marker === openFence) openFence = null;
      continue;
    }
    if (openFence !== null) continue;
    if (TASK_LINE_PATTERN.test(lines[index]) || HEADING_PATTERN.test(lines[index])) {
      end = index;
      break;
    }
  }

  const blocks = findShellBlocks(lines, start, end);
  // 手順は「ちょうど1つ」に限る（`extractShellBlock`と同じ判定）
  return blocks.length === 1 ? blocks[0] : null;
}

/** 行頭の見出し。手順の終わりの判定に使う（`lib/manual-step-guide.ts`と同じ形） */
const HEADING_PATTERN = /^#{1,6}\s+/;

/**
 * `[from, to)`の範囲にあるシェルのコードブロックを、開きフェンスの位置とともに取り出す。
 *
 * **インデントの深さでフェンスかどうかを変えない**（`lib/manual-step-guide.ts`の
 * `splitSections`・`extractShellBlock`と同じ）。テンプレートの手作業Issueはコマンドを
 * リスト項目の下に4スペース下げて書くため、CommonMarkの「4スペース＝インデント記法」を
 * ここで適用すると、実際の本文のコマンドがひとつも取り出せない。中身のインデントは
 * 開きフェンスのぶんだけ戻す。
 */
type OpenFence = { marker: string; indent: number; index: number; executable: boolean };

function findShellBlocks(lines: string[], from: number, to: number): ShellBlock[] {
  const blocks: ShellBlock[] = [];
  let open: OpenFence | null = null;
  let current: string[] = [];

  for (let index = Math.max(0, from); index < Math.min(to, lines.length); index += 1) {
    const line = lines[index];
    const indent = line.length - line.trimStart().length;
    const fence: RegExpExecArray | null = FENCE_PATTERN.exec(line);

    if (fence) {
      const marker: string = fence[1][0];
      if (open === null) {
        const language = line.slice(line.indexOf(fence[1]) + fence[1].length).trim().toLowerCase();
        open = { marker, indent, index, executable: SHELL_FENCE_LANGUAGES.has(language) };
        current = [];
        continue;
      }
      if (marker === open.marker) {
        const opened = open;
        const command = current
          .map((entry) =>
            entry.slice(Math.min(opened.indent, entry.length - entry.trimStart().length)),
          )
          .join("\n")
          .trim();
        if (opened.executable && command !== "" && command.length <= MANUAL_STEP_COMMAND_MAX_LENGTH) {
          blocks.push({
            fenceIndex: opened.index,
            closeIndex: index,
            indent: opened.indent,
            command,
          });
        }
        open = null;
        current = [];
      }
      continue;
    }
    if (open !== null) current.push(line);
  }

  return blocks;
}

/**
 * 標準入力が無いと必ず失敗する、対話が要るコマンド（#2025）。
 *
 * 代行実行は`scripts/run-manual-step.sh`が`</dev/null`で走らせる（答える相手が居ないまま
 * 待ち続けないため）。ここに挙げたものは端末の前に人が居ることを前提にしているので、積んでも
 * 失敗するか打ち切り（`MANUAL_STEP_TIMEOUT_SECONDS`）を待つだけになる。**押す前に「あなたが
 * 実行」と出す**ためのもので、実行を止める壁ではない（壁は本文との照合）。
 *
 * **必ず対話が要るものだけを挙げる。** 「設定によっては対話になる」ものまで広げると、いま
 * 代行できている手順が押せなくなる。逆に、ここに挙げそこねたコマンドは失敗として止まるだけで、
 * 人が手元で実行すれば進む——**迷ったら挙げない側**ではなく、**代行しない側**へ倒す。
 */
const INTERACTIVE_COMMANDS = [
  // 1Passwordの個人アカウントへのサインイン。セッションは実行したシェルの環境変数にしか
  // 残らないため、**同じブロックにある後続のコマンドまで含めて人が実行する**必要がある
  // （人が手元で`op signin`だけ実行しても、代行実行のシェルはそのセッションを引き継げない）
  "op signin",
  // GitHub CLIの対話的なログイン・スコープの追加（ブラウザでコードを入力する）
  "gh auth login",
  "gh auth refresh",
] as const;

/**
 * コマンドの中に対話が要るコマンドがあれば、その表記を返す（無ければ`null`）。
 *
 * 見るのは**コマンドの文字列だけ**で、実行してみて判断することはしない。行頭が`#`の行は
 * コメントなので見ない。`eval "$(op signin)"`のように括弧・パイプの内側にあるものは拾う。
 * 文字列リテラルの中（`echo "op signin してください"`）まで見分けはしないが、**誤検知しても
 * 「あなたが実行」になるだけ**で、人が実行すればそのまま先へ進める。
 */
export function findInteractiveCommand(command: string | null): string | null {
  if (!command) return null;
  const lines = command
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));
  if (lines.length === 0) return null;

  const body = lines.join("\n");
  return INTERACTIVE_COMMANDS.find((entry) => interactivePattern(entry).test(body)) ?? null;
}

/** `op signin`のような語の並びを、コマンドの位置に現れたときだけ当たる正規表現にする */
function interactivePattern(command: string): RegExp {
  const words = command
    .split(" ")
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  // 直前が行頭・空白・パイプ・`;`・`&`・`(`・バッククォート・`$(`のときだけコマンドとみなす
  return new RegExp(`(?:^|[\\s;&|(\`])${words}\\b`, "m");
}

/**
 * その手順を実行する端末がサブPCか。
 *
 * **サブPC以外は一律で代行しない。** VPS・1Password・GitHub App・ブラウザでの設定は
 * issue-deckから到達できず、pollerが居るのはサブPCだけ。表記の揺れ（`サブPC`・`sub pc`・
 * `subpc`）は吸収するが、**読み取れなければ代行しない側へ倒す**（`null`はfalse）。
 *
 * **端末名の定義は`manual-step-guide.ts`の1か所から引く**（#2052）。ここに独自の文字列一致を
 * 持っていたために「ブラウザとサブPC」で真になり、ブラウザ作業まで代行対象になっていた。
 * 1つに絞れないものはfalseにするので、**渡すのは`resolveManualStepDevice`で解決済みの値**。
 */
export function isSubpcManualStepDevice(device: string | null): boolean {
  const names = matchManualStepDeviceNames(device);
  return names.length === 1 && names[0] === "サブPC";
}

/**
 * 人が値を埋めてから実行する「プレースホルダ」の書き方（#2051）。
 *
 * 手作業Issueの`## やること`には、**値を埋めてから実行するコマンド**が書かれることがある
 * （`AIDE_ZAIM_CONSUMER_KEY=<控えたkey> node scripts/oauth-token.mjs`）。それは実行できる
 * コマンドとまったく同じ`bash`フェンスで書かれるため、**代行実行は穴が空いたまま実行しに行く**。
 * 実害は失敗だけではない——上の例の`=<控えたkey>`は**シェルのリダイレクトとして解釈されうる形**で、
 * 意図しない失敗の仕方をする。
 *
 * **`findInteractiveCommand`とは倒す向きが逆**（#2025との違い）。あちらは「必ず対話が要るものだけを
 * 挙げる／迷ったら挙げない」で、挙げそこねても失敗して止まるだけだった。こちらは取りこぼすと
 * **穴あきのコマンドがそのまま走る**一方、誤検知しても「あなたが実行」になるだけで人が実行すれば
 * 進む。被害が非対称なので、**迷ったら拾う側**へ倒す。
 *
 * 挙げないものもここに書いておく。
 *
 * - **`${...}`・`$NAME`**… 実在の環境変数参照と区別できない（`$HOME`・`"$CHILD_ID"`が誤検知になる）
 * - **`...`（ASCIIのピリオド3つ）**… `git diff main...HEAD`のような実在の記法と衝突する
 *   （全角の`…`は実在のコマンドに現れないので拾う）
 * - **`（…）`（全角丸括弧）**… `gh issue comment --body "…（詳細はPRを参照）"`のように、
 *   日本語を含む実在のコマンドに現れる
 */
const PLACEHOLDER_PATTERNS = [
  // `<控えたkey>`・`＜番号＞`。**内側が空白で始まらない・終わらないものだけ**を拾うことで、
  // リダイレクト（`cmd < in.txt > out.txt`）・ヒアドキュメント（`cat <<EOF > f`）・
  // プロセス置換（`diff <(a) <(b)`）を外す。改行をまたぐものも拾わない
  /[<＜](?!\s)[^<>＜＞\n]*[^<>＜＞\s][>＞]/,
  // 伏せ字。`***`は実在のグロブ（`*`・`**`）より1つ多い
  /[*＊]{3,}/,
  // 全角の三点リーダ。実在のコマンドには現れない
  /…/,
  // `KEY=xxx`のような埋め草。**語として現れたときだけ**（`0xxx`・`abcxxx`は拾わない）
  /\bx{3,}\b/i,
] as const;

/** 画面へ出す表記の上限。長い行がそのまま説明文に流れ込まないよう切る */
const PLACEHOLDER_LABEL_MAX_LENGTH = 40;

/**
 * コマンドの中にプレースホルダがあれば、その表記を返す（無ければ`null`）。#2051
 *
 * 見るのは**コマンドの文字列だけ**で、実行してみて判断することはしない。行頭が`#`の行は
 * 実行されないコメントなので見ない（`findInteractiveCommand`と同じ）。
 *
 * **止める壁ではない。** 壁は本文との照合（`enqueueManualStepJob`の`body_changed`）で、
 * これは押す前に「あなたが実行」と理由を出すためのもの。
 */
export function findPlaceholder(command: string | null): string | null {
  if (!command) return null;
  const body = command
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  if (body.trim() === "") return null;

  for (const pattern of PLACEHOLDER_PATTERNS) {
    const found = pattern.exec(body);
    if (!found) continue;
    const label = found[0];
    return label.length > PLACEHOLDER_LABEL_MAX_LENGTH
      ? `${label.slice(0, PLACEHOLDER_LABEL_MAX_LENGTH)}…`
      : label;
  }
  return null;
}

/**
 * 手順の説明文（`- [ ]`の行）として受け付ける長さの上限。
 *
 * テンプレートの決まりは「1手順＝1行で何をするかを書く」なので、ここに収まらない直し案は
 * 手順の形を崩している（複数手順へ割るべきもの）と見なして捨てる。
 */
export const MANUAL_STEP_INSTRUCTION_MAX_LENGTH = 300;

/**
 * `stepLine`が指す手順の説明文（`- [ ]`の後ろの1行）を引く（#2299）。
 *
 * 直し案の差分に出す「いまの本文」と、Claudeへ渡す材料。**手順として読めている行だけ**を
 * 返す（コードブロックの中のタスク風の行は`parseManualStepGuide`が手順に数えない）。
 * 直せる文言が無ければ`null`——確認節・チェックリストでない本文がこれにあたる。
 */
export function findManualStepInstruction(
  body: string | null,
  stepLine: number,
): string | null {
  if (!body) return null;
  if (!parseManualStepGuide(body).steps.some((step) => step.line === stepLine)) return null;

  const line: string | undefined = body.split("\n")[stepLine - 1];
  if (line === undefined) return null;
  const task = TASK_LINE_PATTERN.exec(line);
  if (task === null) return null;

  const text = line.slice(task[1].length + "[ ]".length).trim();
  return text === "" ? null : text;
}

/**
 * `stepLine`が指す手順の説明文を、`nextText`へ差し替えた本文を返す（#2299）。
 *
 * 外部ツールの画面が変わったときに直すべきなのは**コマンドではなく手順の文言**で、
 * `replaceManualStepCommand`では届かない（コードブロックしか書き換えない）。ここでは
 * チェックボックスとリストマーカーを残したまま、その後ろの1行だけを差し替える。
 *
 * **歯止めは`replaceManualStepCommand`と同じ。** 書き換えるのはこの1行だけで、原因の説明も
 * 貼り付けた出力も入らない。差分を見た人が押したときにだけ呼ばれ、書き換えた本文から
 * 同じ手順とコマンドを読み直せることまで確かめてから返す（`null`なら適用しない）。
 */
export function replaceManualStepInstruction(
  body: string | null,
  stepLine: number,
  nextText: string,
): string | null {
  if (!body) return null;

  const text = nextText.trim();
  if (text === "" || text.length > MANUAL_STEP_INSTRUCTION_MAX_LENGTH) return null;
  // 複数行・フェンスは手順の形（1行＋その下のコードブロック）を壊す
  if (text.includes("\n") || FENCE_PATTERN.test(text)) return null;

  const lines = body.split("\n");
  const line: string | undefined = lines[stepLine - 1];
  if (line === undefined) return null;
  const task = TASK_LINE_PATTERN.exec(line);
  if (task === null) return null;

  // いま手順として読めている行だけを対象にする（コードブロックの中のタスク風の行を除く）
  const before = parseManualStepGuide(body);
  const current = before.steps.find((step) => step.line === stepLine);
  if (current === undefined) return null;

  const replaced = [
    ...lines.slice(0, stepLine - 1),
    `${task[1]}[${task[2]}] ${text}`,
    ...lines.slice(stepLine),
  ].join("\n");

  // 書き換えた本文を読み直して、手順の数もこの手順の位置も、下のコマンドも変わっていないこと
  const after = parseManualStepGuide(replaced);
  if (after.steps.length !== before.steps.length) return null;
  const next = after.steps.find((step) => step.line === stepLine);
  if (next === undefined) return null;
  if (findManualStepCommand(replaced, stepLine)?.command !== findManualStepCommand(body, stepLine)?.command) {
    return null;
  }

  // **文頭のデバイスの印を落とさせない**（#2299）。手順の実行端末は`（ブラウザ）`のような
  // 括弧書きだけから読み、書かれていない手順は`where.defaultDevice`へ落ちる
  // （`resolveManualStepDevice`）。印が消えると、既定値がサブPCのIssueでは**ブラウザ手順が
  // 代行実行の対象へ反転する**（代行の可否は`ManualStepRunEntry.device`ひとつで決まる）。
  // コマンドを引き直せるかの確認ではこの反転を検出できないので、ここで別に確かめる。
  if (next.device !== current.device) return null;
  // チェック状態は組み立てで保っているが、読み直しても同じであることまで確かめる
  if (next.checked !== current.checked) return null;
  return replaced;
}
