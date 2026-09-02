import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * auto modeのローカルセッションへ渡す許可規則（`scripts/lib/agent-allowed-tools.sh`・#2762）の
 * テスト。**シェルをそのまま起こして叩く**（`src/lib/prompts/kickoff-prompt.test.ts`と同じ形）。
 *
 * ここで一番効くのは**「入れてはいけないものが入っていないか」**の検知。許可規則は
 * auto modeのクラシファイアより先に評価されるため、ここへ書き込み系のコマンドを1行足すと、
 * issue-deckの後段の防御（Pull Request必須・`claude-review-develop.yml`のレビュー・
 * 自動マージ不可カテゴリ）より手前で無条件に通ってしまう。**足したことに気付かないまま
 * 増えていくのがいちばん危ない**ので、禁止側をテストで固定する。
 */
const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/lib/agent-allowed-tools.sh");

function allowedTools(...extraReadPaths: string[]): string {
  return execFileSync(
    "bash",
    // `bash -c <本文> <$0> <$1…>`。スクリプトのパスは`$0`に入るので、`"$@"`はそのまま
    // 追加の絶対パスだけを指す（`shift`は要らない）。
    ["-c", 'source "$0"; agent_allowed_tools "$@"', SCRIPT_PATH, ...extraReadPaths],
    { encoding: "utf-8" },
  );
}

const rules = allowedTools().split(",");

describe("agent_allowed_tools", () => {
  it("セッションが必ず使う定型コマンドを許可する", () => {
    // 起票とコメント（#2017・#1486・#2009・#1119）。拒否されると記録が残らないまま作業が進む。
    expect(rules).toContain("Bash(gh issue create:*)");
    expect(rules).toContain("Bash(gh issue comment:*)");
    // Issue・PRの読み取り。#2762で「セッション開始直後から承認待ちになる」と報告された側。
    expect(rules).toContain("Bash(gh issue view:*)");
    expect(rules).toContain("Bash(git log:*)");
    expect(rules).toContain("Bash(git diff:*)");
    // PR前に必ず走らせる検証。
    expect(rules).toContain("Bash(pnpm lint:*)");
    expect(rules).toContain("Bash(pnpm test:*)");
    expect(rules).toContain("Bash(pnpm build:*)");
    expect(rules).toContain("Bash(npx tsc:*)");
  });

  it("書き込み・破壊・本番へ出るコマンドは許可しない", () => {
    // ここに挙げたものが規則へ入った時点で落とす。**前方一致で当たるため、
    // `Bash(git:*)`のような広い規則も`git push`を通してしまう。**
    const forbidden = [
      "git push",
      "git commit",
      "git merge",
      "git reset",
      "git checkout",
      "git branch",
      "gh pr create",
      "gh pr merge",
      "gh issue edit",
      "gh issue close",
      "gh workflow run",
      "gh api",
      "gh secret",
      "rm",
      "sudo",
      "ssh",
      "op",
      "sed",
      "cat",
      "tee",
      "curl",
      "pkill",
      "killall",
    ];
    for (const command of forbidden) {
      const matched = rules.filter((rule) => {
        const inner = rule.replace(/^Bash\(/, "").replace(/:\*\)$/, "");
        // 規則は前方一致。`git`という規則は`git push`にも当たる。
        return command === inner || command.startsWith(`${inner} `);
      });
      expect(matched, `${command} を通す規則がある: ${matched.join(", ")}`).toEqual([]);
    }
  });

  it("すべてBash(...:*)の形で、すべてを通す規則を含まない", () => {
    for (const rule of rules) {
      expect(rule).toMatch(/^Bash\([^()*]+:\*\)$/);
    }
    // `Bash`単体・`Bash(*)`はBashコマンド全体を無条件に通す。
    expect(rules).not.toContain("Bash");
    expect(rules).not.toContain("Bash(*)");
  });

  it("重複が無い", () => {
    expect(new Set(rules).size).toBe(rules.length);
  });

  describe("起動時に読むworktree外のファイル（#2778）", () => {
    it("渡した絶対パスをRead規則として足す", () => {
      const withFiles = allowedTools(
        "/home/guchi/apps/issue-deck-worktrees/.prompts/issue-2778.md",
        "/home/guchi/apps/issue-deck-worktrees/.dev-servers/issue-2778.log",
      ).split(",");

      // **スラッシュ2つで始める。** 1つだと設定ファイルからの相対として扱われ、規則が当たらない
      // （`--permission-mode default`で実測）。
      expect(withFiles).toContain(
        "Read(//home/guchi/apps/issue-deck-worktrees/.prompts/issue-2778.md)",
      );
      expect(withFiles).toContain(
        "Read(//home/guchi/apps/issue-deck-worktrees/.dev-servers/issue-2778.log)",
      );
      // 既存の規則は消えない（追加であって置き換えではない）。
      expect(withFiles).toEqual(expect.arrayContaining(rules));
    });

    it("Read規則は1ファイルずつで、グロブを含まない", () => {
      // **`Read(//…/**)`のようなディレクトリごとの許可を入れない。** 他Issueの指示ファイルまで
      // 開くことになる。`Bash`側で`*`を禁じているのと同じ理由で、こちらも形で固定する。
      const withFiles = allowedTools(
        "/home/guchi/apps/issue-deck-worktrees/.prompts/issue-2778.md",
      ).split(",");
      for (const rule of withFiles.filter((r) => r.startsWith("Read("))) {
        expect(rule).toMatch(/^Read\(\/\/[^()*]+\)$/);
      }
    });

    it("ファイルを渡さなければRead規則は増えない", () => {
      expect(rules.filter((rule) => rule.startsWith("Read("))).toEqual([]);
    });

    it("規則として当たらないパス・区切りを壊すパス・広すぎるパスは落とす", () => {
      // 相対パスは設定ファイルからの相対になり、意図した場所に当たらない。空白とカンマは
      // `--allowedTools`の区切り（"Comma or space-separated list"）なので1つの規則が割れる。
      // `*`はグロブとして解釈され、渡した1ファイルより広い範囲を通す。
      const dropped = allowedTools(
        ".prompts/issue-2778.md",
        "/tmp/a,b/issue-2778.md",
        "/tmp/a b/issue-2778.md",
        "/tmp/issue-*.md",
      ).split(",");
      expect(dropped).toEqual(rules);
    });
  });
});
