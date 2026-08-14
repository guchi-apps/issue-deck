import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CI_FIX_WORKFLOW_FILE,
  CONFLICT_RESOLVE_WORKFLOW_FILE,
  PR_REPAIR_WORKFLOW_FILE,
} from "@/lib/github/pull-request-repair";

// issue-deckの画面の修復ボタン（#1293）が`workflow_dispatch`で起動するワークフローは、
// `claude-code-action`の`allowed_bots`に`issue-deck[bot]`を含めなければならない（#1328）。
//
// 起動はGitHub Appのインストールトークンで行うため、操作したのが人間でも実行のactorは
// 常に`issue-deck[bot]`になる。`claude-code-action`は自前の非人間アクター拒否
// （checkHumanActor）を`github.actor`だけで判定するため、ここに無いと
// `Workflow initiated by non-human actor: issue-deck (type: Bot)`で必ず失敗する。
//
// 実際に踏んだ事故: #1293でボタンを足した時点で、conflict-resolveとpr-repairは
// `claude[bot]`のみ、ci-fixは`allowed_bots`の指定自体が無く、3経路とも押しても効かなかった。
// ワークフロー自体は起動して途中まで進むため、画面上は正常に働いたように見えてしまう。
const BUTTON_WORKFLOWS = [
  CI_FIX_WORKFLOW_FILE,
  CONFLICT_RESOLVE_WORKFLOW_FILE,
  PR_REPAIR_WORKFLOW_FILE,
] as const;

function readWorkflow(name: string): string {
  return readFileSync(join(process.cwd(), ".github", "workflows", name), "utf8");
}

/**
 * トリガー定義だけを持つワークフローが呼び出す再利用可能ワークフローのファイル名（#1066）。
 * `claude-code-action`のステップは呼び出し先にあるため、そちらを見に行く必要がある。
 */
function resolveReusableWorkflow(name: string): string {
  const match = /uses:\s*\.\/\.github\/workflows\/(reusable-[\w.-]+\.yml)/.exec(readWorkflow(name));
  expect(match, `${name} が再利用可能ワークフローを呼んでいない`).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

describe("画面のボタンから起動するワークフローのallowed_bots", () => {
  it.each(BUTTON_WORKFLOWS)("%s の呼び出し先がissue-deck[bot]を許可している", (name) => {
    const source = readWorkflow(resolveReusableWorkflow(name));
    const allowedBots = source.match(/allowed_bots:\s*"([^"]*)"/g) ?? [];

    // ステップ数と指定数が揃っていること。片方のステップだけ指定が漏れると、
    // その経路だけが失敗するという分かりにくい壊れ方をする。
    const actionSteps = source.match(/uses:\s*anthropics\/claude-code-action@/g) ?? [];
    expect(allowedBots).toHaveLength(actionSteps.length);
    expect(allowedBots.length).toBeGreaterThan(0);

    for (const entry of allowedBots) {
      expect(entry).toContain("issue-deck[bot]");
    }
  });
});
