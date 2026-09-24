import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 計画レビュー・PRレビューのエージェントにも、Issueの添付画像の読み方を案内していることの確認（#3456）。
 * 案内が抜けると、画像つきのIssueで「画像の内容と計画・PRが合っているか」を確かめられない。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(repoRoot, file), "utf8");

describe("レビュー系プロンプトの添付画像の案内", () => {
  it.each([
    "scripts/prompts/plan-review-agent.md",
    "scripts/prompts/generic-plan-review-agent.md",
    "scripts/prompts/review-agent.md",
  ])("%s は取得スクリプトと認証が要ることを案内する", (file) => {
    const body = read(file);
    expect(body).toContain("## Issue本文・コメントに画像が貼られている場合");
    expect(body).toContain("fetch-issue-images.sh");
    expect(body).toContain("401");
  });

  it("無人実行の計画レビューは事前取得済みの保存先を案内する", () => {
    const body = read(".github/prompts/plan-review.md");
    expect(body).toContain("/tmp/issue-images/");
  });

  it("汎用テンプレートの{{ISSUE_DECK_SCRIPTS_DIR}}は生のまま渡らない", () => {
    const out = execFileSync(
      "bash",
      [
        "-c",
        `source scripts/lib/plan-review-prompt.sh
f=$(mktemp); echo snap >"$f"
plan_review_render_prompt scripts/prompts/generic-plan-review-agent.md 1 o/r /w co "$f" /launcher/scripts`,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(out).toContain("/launcher/scripts/fetch-issue-images.sh");
    expect(out).not.toContain("{{ISSUE_DECK_SCRIPTS_DIR}}");
  });
});
