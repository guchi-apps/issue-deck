import { describe, expect, it } from "vitest";

import {
  extractManualStepCommands,
  extractRunnableManualStepCommands,
  extractShellBlock,
  extractVerificationCommands,
  findInteractiveCommand,
  findManualStepCommand,
  findPlaceholder,
  isSubpcManualStepDevice,
  MANUAL_STEP_COMMAND_MAX_LENGTH,
  replaceManualStepCommand,
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

describe("extractVerificationCommands", () => {
  it("`## 完了の確認方法`のコマンドを、コードブロックの行番号付きで取り出す（#1869）", () => {
    const commands = extractVerificationCommands(REAL_BODY);

    expect(commands.map((entry) => entry.command)).toEqual([
      "git -C ~/apps/issue-deck rev-list --count HEAD..origin/develop",
    ]);
    expect(commands[0].kind).toBe("verification");
    // 行番号は開きフェンスの行（確認節にはチェック行が無いのでブロックそのものを指す）
    expect(REAL_BODY.split("\n")[commands[0].stepLine - 1].trim()).toBe("```bash");
  });

  // 手順と違い「どれを実行したのか」がチェック1つに対応しないという問題が起きない
  it("コードブロックが複数あっても全部返す", () => {
    const body = `## 完了の確認方法

\`\`\`bash
echo one
\`\`\`

\`\`\`bash
echo two
\`\`\`
`;

    expect(extractVerificationCommands(body).map((entry) => entry.command)).toEqual([
      "echo one",
      "echo two",
    ]);
  });

  it("言語の指定が無いコードブロック（出力例）は取り出さない", () => {
    const body = `## 完了の確認方法

\`\`\`
0
\`\`\`
`;

    expect(extractVerificationCommands(body)).toEqual([]);
  });

  it("確認節が無い本文・空の本文でも落ちない", () => {
    expect(extractVerificationCommands("## やること\n\n- [ ] 何かする")).toEqual([]);
    expect(extractVerificationCommands(null)).toEqual([]);
  });

  it("他の節（なぜエージェントが実施しないか）のコマンドは混ざらない", () => {
    expect(
      extractVerificationCommands(REAL_BODY).some((entry) =>
        entry.command.includes("対象にしない"),
      ),
    ).toBe(false);
  });
});

describe("extractRunnableManualStepCommands", () => {
  it("手順 → 完了の確認の順に並ぶ", () => {
    const commands = extractRunnableManualStepCommands(REAL_BODY);

    expect(commands.map((entry) => entry.kind)).toEqual(["step", "step", "verification"]);
  });
});

describe("findManualStepCommand（確認節）", () => {
  it("確認節の行番号でも引ける（#1869）", () => {
    const [verification] = extractVerificationCommands(REAL_BODY);

    expect(findManualStepCommand(REAL_BODY, verification.stepLine)?.command).toBe(
      verification.command,
    );
  });
});

describe("replaceManualStepCommand", () => {
  it("手順のコマンドだけを差し替える（インデント・フェンス・前後の行は変えない）", () => {
    const [, second] = extractManualStepCommands(REAL_BODY);
    const replaced = replaceManualStepCommand(
      REAL_BODY,
      second.stepLine,
      "systemctl --user restart issue-deck-poller.service",
    );

    expect(replaced).not.toBeNull();
    expect(replaced).toContain(
      "    systemctl --user restart issue-deck-poller.service\n    ```",
    );
    // 他の手順・確認節はそのまま
    expect(replaced).toContain("git pull --ff-only");
    expect(replaced).toContain("rev-list --count HEAD..origin/develop");
    // 書き換えた本文からも同じ行で引ける（画面・API・pollerの照合が通る形）
    expect(findManualStepCommand(replaced as string, second.stepLine)?.command).toBe(
      "systemctl --user restart issue-deck-poller.service",
    );
  });

  it("確認節のコマンドも差し替えられる", () => {
    const [verification] = extractVerificationCommands(REAL_BODY);
    const replaced = replaceManualStepCommand(REAL_BODY, verification.stepLine, "echo done");

    expect(findManualStepCommand(replaced as string, verification.stepLine)?.command).toBe(
      "echo done",
    );
  });

  it("複数行のコマンドへも差し替えられる", () => {
    const [first] = extractManualStepCommands(REAL_BODY);
    const replaced = replaceManualStepCommand(REAL_BODY, first.stepLine, "cd /tmp\nls -la");

    expect(findManualStepCommand(replaced as string, first.stepLine)?.command).toBe(
      "cd /tmp\nls -la",
    );
  });

  // 壊れた本文をGitHubへ送らないための歯止め
  it("フェンスを含むコマンド・空・長すぎるコマンドは差し替えない", () => {
    const [first] = extractManualStepCommands(REAL_BODY);

    expect(replaceManualStepCommand(REAL_BODY, first.stepLine, "```bash\nls\n```")).toBeNull();
    expect(replaceManualStepCommand(REAL_BODY, first.stepLine, "   ")).toBeNull();
    expect(
      replaceManualStepCommand(REAL_BODY, first.stepLine, "a".repeat(MANUAL_STEP_COMMAND_MAX_LENGTH + 1)),
    ).toBeNull();
  });

  it("手順でない行・本文が空のときは差し替えない", () => {
    expect(replaceManualStepCommand(REAL_BODY, 1, "ls")).toBeNull();
    expect(replaceManualStepCommand(null, 10, "ls")).toBeNull();
  });
});

/**
 * 対話が要るコマンドの検出（#2025）。
 *
 * 見落とせば代行実行が失敗するだけだが、**広く取りすぎると、いま代行できている手順が
 * 押せなくなる**。境目（コマンドの位置に現れたか）を中心に確かめる。
 */
describe("findInteractiveCommand", () => {
  it("op signinを含むコマンドを見つける", () => {
    expect(findInteractiveCommand("op signin")).toBe("op signin");
    expect(
      findInteractiveCommand("op signin\nscripts/sync-github-secrets.sh --dry-run"),
    ).toBe("op signin");
  });

  it("括弧・パイプの内側にあっても見つける", () => {
    expect(findInteractiveCommand('eval "$(op signin)"')).toBe("op signin");
    expect(findInteractiveCommand("cd ~/apps/issue-deck && op signin --account my")).toBe(
      "op signin",
    );
  });

  it("gh の対話的なログイン・スコープ追加も対象にする", () => {
    expect(findInteractiveCommand("gh auth login")).toBe("gh auth login");
    expect(findInteractiveCommand("gh auth refresh -s admin:org")).toBe("gh auth refresh");
  });

  // **広げすぎない。** 1Passwordのサービスアカウントで動くコマンドは対話にならない
  it("対話にならないコマンドは対象にしない", () => {
    expect(findInteractiveCommand("op item get Server --fields host")).toBeNull();
    expect(findInteractiveCommand("gh issue view 2025 --json body")).toBeNull();
    expect(findInteractiveCommand("git pull --ff-only")).toBeNull();
    expect(findInteractiveCommand(null)).toBeNull();
  });

  // 手順の説明としてコメントに書かれているだけなら、実行されるのは残りの行
  it("コメント行は見ない", () => {
    expect(findInteractiveCommand("# op signin は実行済みの前提\nscripts/x.sh")).toBeNull();
  });

  // 語の途中で当てない（`stop signin`のような別のコマンドを巻き込まない）
  it("語の一部には当てない", () => {
    expect(findInteractiveCommand("stop signing")).toBeNull();
    expect(findInteractiveCommand("./opsignin.sh")).toBeNull();
  });
});

/**
 * プレースホルダの検出（#2051）。
 *
 * `findInteractiveCommand`とは**倒す向きが逆**なので、拾えていること（取りこぼさないこと）を
 * 中心に確かめつつ、実在のシェル記法（リダイレクト・ヒアドキュメント・プロセス置換・
 * 環境変数参照）を巻き込んでいないことも確かめる。
 */
describe("findPlaceholder", () => {
  // guchi-apps/aide#103 の実例。`=<控えたkey>`はシェルのリダイレクトとして解釈されうる
  it("角括弧のプレースホルダを見つける", () => {
    expect(
      findPlaceholder(
        "AIDE_ZAIM_CONSUMER_KEY=<控えたkey> AIDE_ZAIM_CONSUMER_SECRET=<控えたsecret> \\\n  node src/core/connectors/zaim/scripts/oauth-token.mjs",
      ),
    ).toBe("<控えたkey>");
    expect(findPlaceholder("gh issue view <番号> --json body")).toBe("<番号>");
    expect(findPlaceholder("gh api repos/<owner>/<repo>/issues")).toBe("<owner>");
    expect(findPlaceholder("gh issue view ＜番号＞")).toBe("＜番号＞");
  });

  it("伏せ字・三点リーダ・埋め草も拾う", () => {
    expect(findPlaceholder("op item create --password '***'")).toBe("***");
    expect(findPlaceholder("gh issue list --search …")).toBe("…");
    expect(findPlaceholder("AIDE_TOKEN=xxx node scripts/x.mjs")).toBe("xxx");
    expect(findPlaceholder("curl https://XXXX.example.com")).toBe("XXXX");
  });

  // **ここを巻き込むと、いま代行できている手順が押せなくなる**
  it("実在のシェル記法は拾わない", () => {
    expect(findPlaceholder("grep foo < input.txt > output.txt")).toBeNull();
    expect(findPlaceholder("grep foo <input.txt >output.txt")).toBeNull();
    expect(findPlaceholder("cat <<EOF > /tmp/x\nbody\nEOF")).toBeNull();
    expect(findPlaceholder("diff <(sort a) <(sort b)")).toBeNull();
    expect(findPlaceholder("systemctl --user restart issue-deck-dispatch-poller.service")).toBeNull();
    expect(findPlaceholder("cd ~/apps/issue-deck && git pull --ff-only")).toBeNull();
    expect(findPlaceholder("ls *.log && ls **/*.ts")).toBeNull();
    expect(findPlaceholder("git diff main...HEAD")).toBeNull();
    expect(findPlaceholder(null)).toBeNull();
  });

  // **`${...}`・`$NAME`は実在の環境変数参照と区別できない**ので拾わない（#2051の決定）
  it("環境変数の参照は拾わない", () => {
    expect(findPlaceholder('gh api repos/o/r/issues/2051/sub_issues -F sub_issue_id="$CHILD_ID"')).toBeNull();
    expect(findPlaceholder("cd ${HOME}/apps/issue-deck")).toBeNull();
  });

  // 語の途中では当てない（16進の値・識別子を巻き込まない）
  it("語の一部には当てない", () => {
    expect(findPlaceholder("git show 0xxxabc")).toBeNull();
    expect(findPlaceholder("cat fooxxxbar.txt")).toBeNull();
  });

  it("コメント行は見ない", () => {
    expect(findPlaceholder("# <番号>は起票したIssueの番号\nscripts/x.sh")).toBeNull();
  });
});
