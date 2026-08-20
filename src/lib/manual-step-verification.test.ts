import { describe, expect, it } from "vitest";

import {
  isReadOnlyVerificationCommand,
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

describe("resolveManualStepPatrolTarget", () => {
  it("確認コマンドだけを対象にする（`## やること`の手順は含めない）", () => {
    const target = resolveManualStepPatrolTarget(BODY, true);
    expect(target.patrollable).toBe(true);
    if (!target.patrollable) return;
    expect(target.commands).toHaveLength(1);
    expect(target.commands[0].command).toBe(
      "systemctl --user is-active issue-deck-dispatch-poller.service",
    );
    expect(target.commands[0].kind).toBe("verification");
  });

  it("手作業Issueでなければ対象外", () => {
    expect(resolveManualStepPatrolTarget(BODY, false)).toEqual({
      patrollable: false,
      rejection: "not_manual_step",
    });
  });

  it("サブPC以外のデバイスは対象外", () => {
    const body = BODY.replace("**サブPC**（メインPCからなら `ssh subpc`）", "VPS");
    expect(resolveManualStepPatrolTarget(body, true)).toEqual({
      patrollable: false,
      rejection: "device_not_subpc",
    });
  });

  it("確認コマンドが無ければ対象外", () => {
    const body = BODY.split("## 完了の確認方法")[0];
    expect(resolveManualStepPatrolTarget(body, true)).toEqual({
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

    const target = resolveManualStepPatrolTarget(body, true);
    expect(target.patrollable).toBe(true);
    if (!target.patrollable) return;
    expect(target.commands.map((entry) => entry.command)).toEqual([
      "jq -r '.projects | keys[]' ~/.claude.json | grep claude-config",
    ]);
  });

  it("読み取りだけと読めないコマンドが1つでもあればIssueごと対象外", () => {
    const body = `${BODY}\n\n\`\`\`bash\nsystemctl --user restart issue-deck-dispatch-poller.service\n\`\`\`\n`;
    expect(resolveManualStepPatrolTarget(body, true)).toEqual({
      patrollable: false,
      rejection: "not_read_only",
    });
  });
});
