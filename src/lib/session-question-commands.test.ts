import { describe, expect, it } from "vitest";

import {
  circledNumber,
  describeQuestionCommandTarget,
  extractQuestionCommandBlocks,
} from "@/lib/session-question-commands";

const command = (value: string, device: string | null = null) => ({
  command: value,
  device,
  info: "",
});

describe("extractQuestionCommandBlocks", () => {
  it("コマンドが無ければ地の文をそのまま返す", () => {
    expect(extractQuestionCommandBlocks("計画どおりに進めてよいですか？")).toEqual({
      segments: [{ type: "text", value: "計画どおりに進めてよいですか？" }],
      commands: [],
    });
  });

  // Issue #5652の添付スクリーンショットの実例
  it("1個のバッククォートのコマンドを抜き出し、位置の印に置き換える", () => {
    const ssh = "ssh -t subpc 'cd ~ && ~/.local/bin/hermes -p morrow mcp login aide'";

    expect(extractQuestionCommandBlocks(`手元の端末で\`${ssh}\` を実行してください`)).toEqual({
      segments: [
        { type: "text", value: "手元の端末で" },
        { type: "command", index: 0 },
        { type: "text", value: " を実行してください" },
      ],
      commands: [command(ssh)],
    });
  });

  it("引数の無い語はコマンドにしない", () => {
    expect(extractQuestionCommandBlocks("`scope`と`git`の確認です")).toEqual({
      segments: [
        { type: "code", value: "scope" },
        { type: "text", value: "と" },
        { type: "code", value: "git" },
        { type: "text", value: "の確認です" },
      ],
      commands: [],
    });
  });

  it("フェンスは分割せず1件にし、添えられた端末を読む", () => {
    const question =
      "次を実行してよいですか？ ```bash VPS\ncd /var/www/app && pm2 restart app\npm2 status\n```";

    expect(extractQuestionCommandBlocks(question)).toEqual({
      segments: [{ type: "text", value: "次を実行してよいですか？" }],
      commands: [
        {
          command: "cd /var/www/app && pm2 restart app\npm2 status",
          device: "VPS",
          info: "bash VPS",
        },
      ],
    });
  });

  it("複数のフェンスがあれば順に並べる", () => {
    const { commands } = extractQuestionCommandBlocks(
      "1つ目 ```bash\ncmd1\n``` と2つ目 ```bash サブPC\ncmd2\n``` を実行しますか？",
    );

    expect(commands.map((c) => [c.command, c.device])).toEqual([
      ["cmd1", null],
      ["cmd2", "DeskMini"],
    ]);
  });

  it("閉じが切れたフェンスは地の文のまま残す", () => {
    const question = "実行しますか？ ```bash\nssh subpc";

    expect(extractQuestionCommandBlocks(question).commands).toEqual([]);
  });
});

describe("describeQuestionCommandTarget", () => {
  it("端末の指定を優先する", () => {
    expect(describeQuestionCommandTarget(command("gh auth status", "VPS"))).toEqual({
      title: "VPSで実行",
      note: null,
    });
  });

  it("指定が無くてもsshなら手元の端末とし、接続先を添える", () => {
    expect(describeQuestionCommandTarget(command("ssh -p 22 -t subpc 'ls'"))).toEqual({
      title: "手元の端末で実行",
      note: "このコマンドが subpc へSSH接続します",
    });
  });

  it("指定が無くsshでもなければ推測しない", () => {
    expect(describeQuestionCommandTarget(command("gh auth status")).title).toBe(
      "実行する端末の指定なし",
    );
  });
});

describe("circledNumber", () => {
  it("丸数字にする", () => {
    expect([circledNumber(1), circledNumber(2), circledNumber(21)]).toEqual(["①", "②", "(21)"]);
  });
});
