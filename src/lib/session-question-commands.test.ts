import { describe, expect, it } from "vitest";

import { extractQuestionCommandBlocks } from "@/lib/session-question-commands";

describe("extractQuestionCommandBlocks", () => {
  it("フェンスが無ければ地の文をそのまま返す", () => {
    expect(extractQuestionCommandBlocks("計画どおりに進めてよいですか？")).toEqual({
      text: "計画どおりに進めてよいですか？",
      commands: [],
    });
  });

  // Issue #2818の添付スクリーンショットの実例
  it("bashフェンスをコマンドの一覧として取り出し、地の文からは取り除く", () => {
    const question =
      "前提条件（PR #231・#239 のマージ状況）を確認するため、次の読み取り専用コマンドを実行してよいですか？ ```bash\n" +
      "gh api repos/guchi-apps/aide/pulls/231 --jq '.number, .state, .merged, .base.ref'\n" +
      "gh api repos/guchi-apps/aide/pulls/239 --jq '.number, .state, .merged, .base.ref'\n" +
      "git -C /home/guchi/apps/aide fetch origin develop --quiet && git -C /home/guchi/apps/aide grep -c IMAGE_MAIL origin/develop -- .github/secrets-manifest.tsv\n" +
      "```";

    expect(extractQuestionCommandBlocks(question)).toEqual({
      text: "前提条件（PR #231・#239 のマージ状況）を確認するため、次の読み取り専用コマンドを実行してよいですか？",
      commands: [
        "gh api repos/guchi-apps/aide/pulls/231 --jq '.number, .state, .merged, .base.ref'",
        "gh api repos/guchi-apps/aide/pulls/239 --jq '.number, .state, .merged, .base.ref'",
        "git -C /home/guchi/apps/aide fetch origin develop --quiet",
        "git -C /home/guchi/apps/aide grep -c IMAGE_MAIL origin/develop -- .github/secrets-manifest.tsv",
      ],
    });
  });

  it("複数のフェンスがあれば順につなげる", () => {
    const question = "1つ目 ```bash\ncmd1\n``` と2つ目 ```bash\ncmd2\n``` を実行しますか？";

    expect(extractQuestionCommandBlocks(question)).toEqual({
      text: "1つ目 と2つ目 を実行しますか？",
      commands: ["cmd1", "cmd2"],
    });
  });
});
