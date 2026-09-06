import { describe, expect, it } from "vitest";

import { splitShellCommandLines } from "@/lib/shell-command-lines";

describe("splitShellCommandLines", () => {
  it("1行だけのコマンドはそのまま1件で返す", () => {
    expect(splitShellCommandLines("git pull --ff-only")).toEqual(["git pull --ff-only"]);
  });

  it("改行区切りの複数コマンドを行ごとに分ける", () => {
    const command = [
      "gh api repos/guchi-apps/aide/pulls/231 --jq '.number, .state'",
      "gh api repos/guchi-apps/aide/pulls/239 --jq '.number, .state'",
    ].join("\n");

    expect(splitShellCommandLines(command)).toEqual([
      "gh api repos/guchi-apps/aide/pulls/231 --jq '.number, .state'",
      "gh api repos/guchi-apps/aide/pulls/239 --jq '.number, .state'",
    ]);
  });

  it("&&で繋いだコマンドを個別のコマンドへ分ける", () => {
    const command =
      "git -C /home/guchi/apps/aide fetch origin develop --quiet && git -C /home/guchi/apps/aide grep -c IMAGE_MAIL origin/develop -- .github/secrets-manifest.tsv";

    expect(splitShellCommandLines(command)).toEqual([
      "git -C /home/guchi/apps/aide fetch origin develop --quiet",
      "git -C /home/guchi/apps/aide grep -c IMAGE_MAIL origin/develop -- .github/secrets-manifest.tsv",
    ]);
  });

  // 引用符の中の && はコマンドの一部なので分割しない
  it("引用符の中の&&は分割しない", () => {
    const command = 'git commit -m "foo && bar"';

    expect(splitShellCommandLines(command)).toEqual(['git commit -m "foo && bar"']);
  });

  it("改行と&&が両方あるコマンドをまとめて分ける", () => {
    const command = ["cmd1 && cmd2", "cmd3"].join("\n");

    expect(splitShellCommandLines(command)).toEqual(["cmd1", "cmd2", "cmd3"]);
  });

  // 実行されないコメント行は結果に含めない（`#`始まりの行）
  it("コメント行・空行は含めない", () => {
    const command = ["# 説明", "", "git status"].join("\n");

    expect(splitShellCommandLines(command)).toEqual(["git status"]);
  });

  it("空文字は空配列を返す", () => {
    expect(splitShellCommandLines("")).toEqual([]);
  });
});
