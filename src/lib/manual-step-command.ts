import { FENCE_PATTERN } from "@/lib/markdown-task-list";
import { parseManualStepGuide, type ManualStepGuide } from "@/lib/manual-step-guide";

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

/** 代行実行できる手順1件 */
export type ManualStepCommand = {
  /** その手順の`- [ ]`の行番号（1始まり）。画面のチェックと、どの手順かの指定に使う */
  stepLine: number;
  /** 実行するコマンド（コードブロックの中身。前後の空行を落としたもの） */
  command: string;
};

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

  if (blocks.length !== 1) return null;
  const command = blocks[0];
  if (command === "" || command.length > MANUAL_STEP_COMMAND_MAX_LENGTH) return null;
  return command;
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
    commands.push({ stepLine: step.line, command });
  }
  return commands;
}

/** `stepLine`の手順のコマンドを引く。無ければ`null`（＝その手順は代行できない） */
export function findManualStepCommand(
  body: string | null,
  stepLine: number,
): ManualStepCommand | null {
  return extractManualStepCommands(body).find((entry) => entry.stepLine === stepLine) ?? null;
}

/**
 * `## 前提条件`の「実行するデバイス」がサブPCか。
 *
 * **サブPC以外は一律で代行しない。** VPS・1Password・GitHub App・ブラウザでの設定は
 * issue-deckから到達できず、pollerが居るのはサブPCだけ。表記の揺れ（`サブPC`・`sub pc`・
 * `subpc`）は吸収するが、**読み取れなければ代行しない側へ倒す**（`null`はfalse）。
 */
export function isSubpcManualStepDevice(device: string | null): boolean {
  if (device === null) return false;
  const normalized = device
    .toLowerCase()
    .replace(/[\s　_-]/g, "")
    .replace(/ｻﾌﾞ/g, "サブ");
  return normalized.includes("サブpc") || normalized.includes("subpc");
}
