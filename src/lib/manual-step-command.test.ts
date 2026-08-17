import { describe, expect, it } from "vitest";

import {
  extractManualStepCommands,
  extractShellBlock,
  findManualStepCommand,
  isSubpcManualStepDevice,
  MANUAL_STEP_COMMAND_MAX_LENGTH,
} from "@/lib/manual-step-command";

/**
 * 代行実行するコマンドの取り出し（#1828）。
 *
 * ここが「画面から任意のコマンドを流せる口」にならないための一次の歯止めなので、
 * **取りこぼす側へ倒っていること**（曖昧な手順は代行しない）を中心に確かめる。
 */

/** #1823 の本文（実際に起票された手作業Issue）をそのまま使う */
const REAL_BODY = `## この作業でできるようになること

- **できるようになること**: pollerが新しい版になる。

## 前提条件

- 実行するデバイス: **サブPC**（メインPCからなら \`ssh subpc\`）
- カレントディレクトリ: \`~/apps/issue-deck\`
- Gitブランチ: \`develop\`（本体チェックアウトがdevelopのため）

## やること

- [ ] 本体チェックアウトを最新のdevelopへ更新する

    \`\`\`bash
    cd ~/apps/issue-deck
    git pull --ff-only
    \`\`\`

- [x] pollerを再起動する

    \`\`\`bash
    systemctl --user restart issue-deck-dispatch-poller.service
    \`\`\`

## 完了の確認方法

- 遅れが0になっていること

    \`\`\`bash
    git -C ~/apps/issue-deck rev-list --count HEAD..origin/develop
    \`\`\`

## なぜエージェントが実施しないか

\`~/apps/issue-deck\`は本体チェックアウトのため。

    \`\`\`bash
    echo "この節のコマンドは代行の対象にしない"
    \`\`\`
`;

describe("extractManualStepCommands", () => {
  it("`## やること`の手順からコマンドを取り出す（チェック済みの手順も含む）", () => {
    const commands = extractManualStepCommands(REAL_BODY);

    expect(commands.map((entry) => entry.command)).toEqual([
      "cd ~/apps/issue-deck\ngit pull --ff-only",
      "systemctl --user restart issue-deck-dispatch-poller.service",
    ]);
    // 行番号は`- [ ]`の行そのもの（画面のチェックと同じ行を指す）
    expect(commands[0].stepLine).toBe(REAL_BODY.split("\n").indexOf("- [ ] 本体チェックアウトを最新のdevelopへ更新する") + 1);
  });

  it("`## 完了の確認方法`・`## なぜエージェントが実施しないか`のコマンドは取り出さない", () => {
    const commands = extractManualStepCommands(REAL_BODY);

    expect(commands.some((entry) => entry.command.includes("rev-list"))).toBe(false);
    expect(commands.some((entry) => entry.command.includes("対象にしない"))).toBe(false);
  });

  it("チェックリストで書かれていない本文（節全体が1手順）は代行しない", () => {
    const body = `## やること

\`\`\`bash
echo hello
\`\`\`
`;

    expect(extractManualStepCommands(body)).toEqual([]);
  });

  it("本文が空でも落ちない", () => {
    expect(extractManualStepCommands(null)).toEqual([]);
    expect(extractManualStepCommands("")).toEqual([]);
  });
});

describe("extractShellBlock", () => {
  it("シェルのコードブロックがちょうど1つの手順だけを返す", () => {
    expect(extractShellBlock("更新する\n\n```bash\ngit pull\n```")).toBe("git pull");
    expect(extractShellBlock("```sh\ngit pull\n```")).toBe("git pull");
  });

  // 2つあると「どちらを実行したのか」がチェック1つに対応しない（片方だけ実行して成功すると、
  // 実行していないコマンドまで済んだことになる）
  it("コードブロックが2つある手順は代行しない", () => {
    expect(extractShellBlock("```bash\na\n```\n\n```bash\nb\n```")).toBeNull();
  });

  it("コードブロックが無い手順は代行しない", () => {
    expect(extractShellBlock("画面の設定を開いて保存する")).toBeNull();
  });

  // 出力例・設定ファイルの抜粋が同じ書き方で置かれるため、言語の指定が無いものは実行しない
  it("言語の指定が無いコードブロックは代行しない", () => {
    expect(extractShellBlock("```\ngit pull\n```")).toBeNull();
  });

  it("シェル以外の言語のコードブロックは代行しない", () => {
    expect(extractShellBlock("```json\n{}\n```")).toBeNull();
    expect(extractShellBlock("```text\ngit pull\n```")).toBeNull();
  });

  it("空のコードブロック・長すぎるコマンドは代行しない", () => {
    expect(extractShellBlock("```bash\n\n```")).toBeNull();
    const long = "a".repeat(MANUAL_STEP_COMMAND_MAX_LENGTH + 1);
    expect(extractShellBlock(`\`\`\`bash\n${long}\n\`\`\``)).toBeNull();
  });
});

describe("findManualStepCommand", () => {
  it("行番号でコマンドを引ける", () => {
    const [first] = extractManualStepCommands(REAL_BODY);

    expect(findManualStepCommand(REAL_BODY, first.stepLine)?.command).toBe(first.command);
  });

  it("手順でない行を指しても返さない", () => {
    expect(findManualStepCommand(REAL_BODY, 1)).toBeNull();
  });
});

describe("isSubpcManualStepDevice", () => {
  it("サブPCの手作業だけを代行対象とみなす", () => {
    expect(isSubpcManualStepDevice("サブPC")).toBe(true);
    expect(isSubpcManualStepDevice("サブ PC")).toBe(true);
    expect(isSubpcManualStepDevice("subpc")).toBe(true);
    expect(isSubpcManualStepDevice("sub-pc")).toBe(true);
  });

  // issue-deckから到達できない実行先。ボタンを出さず理由を出す
  it("VPS・1Password・GitHub・ブラウザは代行対象にしない", () => {
    expect(isSubpcManualStepDevice("VPS")).toBe(false);
    expect(isSubpcManualStepDevice("1Password")).toBe(false);
    expect(isSubpcManualStepDevice("GitHub")).toBe(false);
    expect(isSubpcManualStepDevice("ブラウザ")).toBe(false);
    expect(isSubpcManualStepDevice("メインPC")).toBe(false);
  });

  // 読み取れなければ代行しない側へ倒す
  it("記載が無ければ代行対象にしない", () => {
    expect(isSubpcManualStepDevice(null)).toBe(false);
  });
});
