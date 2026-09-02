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

function allowedTools(): string {
  return execFileSync("bash", ["-c", 'source "$0"; agent_allowed_tools', SCRIPT_PATH], {
    encoding: "utf-8",
  });
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
});
