import {
  extractVerificationCommands,
  isSubpcManualStepDevice,
  type ManualStepCommand,
} from "@/lib/manual-step-command";
import { parseManualStepGuide, type ManualStepGuide } from "@/lib/manual-step-guide";

/**
 * openな手作業Issueの`## 完了の確認方法`を、人の操作なしに定期実行してよいかを決める（#2008）。
 *
 * 手作業Issueの完了判定は「人が実行して『手作業を完了してクローズ』を押す」ことだけに
 * 依存していて、**実行したのに押し忘れると誰も気づけない**（#1994が実例で、本文の
 * 完了条件を満たしているのにopenのまま残っていた）。確認コマンドを定期的に流せば、
 * 実施済みの可能性があるものを画面から拾えるようになる。
 *
 * ただし#1869の代行実行は**人が押した1回の承認**を前提にしていた。無人で回すぶん、
 * 押す人の目という歯止めが1つ外れるので、ここで対象を絞り直す。
 *
 * - **`## 完了の確認方法`のコマンドだけを流す。** `## やること`の手順は状態を変えるので、
 *   人の承認なしには一切実行しない
 * - **読み取りだけだと読めるコマンドに限る**（`isReadOnlyVerificationCommand`）。確認節が
 *   読み取りだけであることはテンプレート上の期待にすぎず、本文で強制されてはいない
 * - **終了コード0でもクローズはしない。** 判断するのは人（`manual-step-command.ts`の
 *   `extractVerificationCommands`と同じ取り決め）。画面に出すのは「完了済みの可能性」まで
 */

/**
 * 引数によらず読み取りだけのコマンド。
 *
 * **足すときは「どんな引数を与えても書き換えないか」で判断する。** `sed`（`-i`）・`awk`
 * （`print > "file"`）・`tee`・`xargs`のように、引数しだいで書き込めるものは入れない。
 * 取りこぼす側へ倒す——巡回できない手作業は、これまでどおり人が実行するだけで済む。
 */
const READ_ONLY_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "jq",
  "wc",
  "cut",
  "sort",
  "uniq",
  "tr",
  "ls",
  "stat",
  "readlink",
  "realpath",
  "dirname",
  "basename",
  "echo",
  "printf",
  "pwd",
  "whoami",
  "id",
  "hostname",
  "uname",
  "date",
  "df",
  "du",
  "free",
  "uptime",
  "env",
  "printenv",
  "which",
  "type",
  "test",
  "[",
  "true",
  "false",
  "diff",
  "cmp",
  "md5sum",
  "sha256sum",
  "getent",
  "ss",
  "ps",
  "pgrep",
]);

/**
 * サブコマンドまで見て許すコマンド。**先頭のサブコマンド1つだけを見る**（`git log`の
 * `log`）。フラグ（`--user`など）は読み飛ばす。
 *
 * `git tag`・`gh api`のように「読み取りにも書き込みにも使える」ものは入れない。
 * どちらなのかを引数から判定し始めると、判定漏れがそのまま無人実行の事故になる。
 */
const READ_ONLY_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  systemctl: new Set([
    "is-active",
    "is-enabled",
    "is-failed",
    "status",
    "show",
    "cat",
    "list-units",
    "list-unit-files",
    "list-timers",
  ]),
  git: new Set([
    "status",
    "log",
    "show",
    "diff",
    "rev-parse",
    "rev-list",
    "show-ref",
    "for-each-ref",
    "merge-base",
    "shortlog",
    "blame",
    "ls-files",
    "ls-remote",
    "describe",
    "cat-file",
    "branch",
    "remote",
  ]),
  gh: new Set(["view", "list", "status"]),
  docker: new Set(["ps", "images", "logs", "inspect"]),
  pm2: new Set(["list", "status", "describe", "info", "jlist"]),
};

/**
 * サブコマンドの前に置ける「値を取るフラグ」。**次の1語まで読み飛ばす**ための表。
 *
 * `git -C /home/guchi/apps/vps status`のパスのように、フラグの値はハイフンで始まらないため、
 * 読み飛ばさないとそれをサブコマンドとして読んでしまう（`status`まで届かない）。
 */
const OPTION_WITH_VALUE: Record<string, ReadonlySet<string>> = {
  git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]),
  systemctl: new Set(["-H", "--host", "-M", "--machine", "-t", "--type", "--state"]),
  gh: new Set(["-R", "--repo"]),
  docker: new Set(["-H", "--host", "--context"]),
};

/**
 * その確認コマンドを無人で流してよいか（読み取りだけだと読めるか）。
 *
 * **判定できないものはすべてfalse。** ここは「安全なものを見つける」判定であって
 * 「危険なものを見つける」判定ではない——後者にすると、知らない書き方が既定で通ってしまう。
 */
export function isReadOnlyVerificationCommand(command: string): boolean {
  const segments = splitCommandSegments(command);
  if (segments === null) return false;

  const meaningful = segments.map((segment) => segment.trim()).filter((segment) => segment !== "");
  if (meaningful.length === 0) return false;

  return meaningful.every(isReadOnlySegment);
}

/**
 * パイプ・連結・改行でコマンドを区切る。**引用符の中は区切らない。**
 *
 * `jq -r '.projects | keys[]' ~/.claude.json | grep claude-config`（#1994の確認コマンド）が
 * まさにそれで、素直に`|`で割ると`jq`の式の途中で切れて、先頭語が`keys[]'`になってしまう。
 *
 * @returns 区切った各区間。**静的に読み切れないものは`null`**（＝巡回の対象にしない）
 *   - `>`（`2>&1`を除く）… 書き込みのリダイレクト。読み取りコマンドの組み合わせでも書き込める
 *   - `$(`・`` ` `` … コマンド置換。中で何でも実行できる
 *   - 単独の`&` … バックグラウンド実行。終了コードが実行の成否を表さなくなる
 *   - 閉じていない引用符 … どこまでが引数なのかを決められない
 */
function splitCommandSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote !== null) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\") {
      // エスケープ・行継続。次の1文字は記号として読まない
      current += char + (command[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === "`") return null;
    if (char === "$" && command[index + 1] === "(") return null;
    if (char === ">") {
      // 標準エラーの合流（`2>&1`）だけは書き込みではないので通す
      if (command.slice(index - 1, index + 3) === "2>&1") {
        current += char;
        continue;
      }
      return null;
    }
    if (char === "&") {
      if (command[index + 1] === "&") {
        segments.push(current);
        current = "";
        index += 1;
        continue;
      }
      // `2>&1`の`&`はリダイレクト先の指定。それ以外の単独の`&`は非同期実行
      if (command.slice(index - 2, index + 2) === "2>&1") {
        current += char;
        continue;
      }
      return null;
    }
    if (char === "|" || char === ";" || char === "\n") {
      if (char === "|" && command[index + 1] === "|") index += 1;
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (quote !== null) return null;
  segments.push(current);
  return segments;
}

/** パイプ・連結で割った1区間。**先頭語（と必要ならサブコマンド）だけで判定する** */
function isReadOnlySegment(segment: string): boolean {
  // 行コメント（`# → 出力されれば完了`）は実行されないので、そこから先は見ない
  const withoutComment = segment.replace(/(^|\s)#.*$/, "").trim();
  if (withoutComment === "") return true;

  const tokens = withoutComment.split(/\s+/);
  // `VAR=value cmd`のような環境変数の前置きは、値そのものは何も実行しないので読み飛ばす
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  if (index >= tokens.length) return false;

  // パスで書かれていても実体は同じ（`/usr/bin/jq`）。ただしパス自体は許可の材料にしない
  const name = tokens[index].split("/").pop() ?? "";
  if (READ_ONLY_COMMANDS.has(name)) return true;

  const subcommands = READ_ONLY_SUBCOMMANDS[name];
  if (!subcommands) return false;

  const withValue = OPTION_WITH_VALUE[name] ?? new Set<string>();
  let cursor = index + 1;
  while (cursor < tokens.length && tokens[cursor].startsWith("-")) {
    const skipValue = withValue.has(tokens[cursor]);
    cursor += skipValue ? 2 : 1;
  }
  return cursor < tokens.length && subcommands.has(tokens[cursor]);
}

/** 巡回の対象にならなかった理由。画面には出さず、判定のテストと記録のために持つ */
export type ManualStepPatrolRejection =
  | "not_manual_step"
  | "device_not_subpc"
  | "no_verification_command"
  | "not_read_only";

export type ManualStepPatrolTarget =
  | { patrollable: true; commands: ManualStepCommand[] }
  | { patrollable: false; rejection: ManualStepPatrolRejection };

/**
 * その手作業Issueの確認コマンドを、定期巡回で流してよいか判定する。
 *
 * **1つでも読み取りだと読めないコマンドがあれば、そのIssueごと対象外にする。** 確認は
 * 上から順に全部流して初めて「通った」と言えるもので、一部だけ流しても結論が出ない。
 *
 * @param isManualStepIssue `71.manual-step`が付いているか（呼び出し側がラベルから渡す）
 */
export function resolveManualStepPatrolTarget(
  body: string | null,
  isManualStepIssue: boolean,
  guide: ManualStepGuide = parseManualStepGuide(body),
): ManualStepPatrolTarget {
  if (!isManualStepIssue) return { patrollable: false, rejection: "not_manual_step" };
  // **確認節にデバイスを書く場所は無い**ので、手作業の既定値で判定する（#2052）。端末が複数
  // 書かれていて既定値が決まらない本文は、巡回の対象から外れる（代行と同じ倒し方）
  if (!isSubpcManualStepDevice(guide.where.defaultDevice)) {
    return { patrollable: false, rejection: "device_not_subpc" };
  }

  const commands = extractVerificationCommands(body, guide);
  if (commands.length === 0) {
    return { patrollable: false, rejection: "no_verification_command" };
  }
  if (!commands.every((entry) => isReadOnlyVerificationCommand(entry.command))) {
    return { patrollable: false, rejection: "not_read_only" };
  }
  return { patrollable: true, commands };
}
