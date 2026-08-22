import { describe, expect, it } from "vitest";

import { isPlanningPhaseSkipped, resolvePlanningPhase } from "@/lib/github/planning-phase";
import type { IssueComment, IssueLabel } from "@/types/issue";

function labels(...names: string[]): IssueLabel[] {
  return names.map((name) => ({ name, color: "64748b", description: null }));
}

function comment(body: string, login = "issue-deck[bot]"): IssueComment {
  return {
    id: `${body.length}`,
    author: { login },
    createdAtLabel: "2026-08-22",
    body,
    reactionCount: 0,
  };
}

describe("resolvePlanningPhase", () => {
  it("計画フェーズより手前（未着手・計画検討中）は判定しない", () => {
    expect(
      resolvePlanningPhase({ labels: labels(), projectStatus: null, comments: [] }),
    ).toBe("unknown");
    expect(
      resolvePlanningPhase({ labels: labels(), projectStatus: "Planning", comments: [] }),
    ).toBe("unknown");
  });

  it("計画コメントが1件も無ければスキップと見なす", () => {
    expect(
      resolvePlanningPhase({
        labels: labels("51.improvement"),
        projectStatus: "Implementation",
        comments: [comment("🔧 実装を完了しました\n<!-- issue-deck-agent:implementer -->")],
      }),
    ).toBe("skipped");
  });

  /**
   * `21.plan-required`は承認時に外れる（`labelsAfterApproval`）ため、承認済みのIssueと
   * 最初から計画を求めなかったIssueはラベルでは区別できない。Issueに残り続ける計画コメントで
   * 見分ける。
   */
  it.each([
    ["無人実行の計画", "計画です\n<!-- issue-deck-plan-type:implement -->"],
    ["分割の計画", "分割します\n<!-- issue-deck-plan-type:split -->"],
    ["ローカルセッションが手で投稿した計画", "計画です\n<!-- issue-deck-agent:planner -->"],
    ["ExitPlanModeのフック経由の計画", "🗒️ **計画を提示しました。**\n<!-- issue-deck:session-plan -->"],
    ["マーカー導入前の計画", "🔍 計画を提示します"],
  ])("%s があれば通ったと見なす", (_name, body) => {
    expect(
      resolvePlanningPhase({
        labels: labels(),
        projectStatus: "Develop PR",
        comments: [comment(body)],
      }),
    ).toBe("planned");
  });

  it("21.plan-requiredが付いている間はコメントを見るまでもなくスキップではない", () => {
    expect(
      resolvePlanningPhase({
        labels: labels("21.plan-required", "00.check-user"),
        projectStatus: "Implementation",
        comments: [],
      }),
    ).toBe("planned");
  });

  it("コメント未取得（null）のうちは判定しない", () => {
    expect(
      resolvePlanningPhase({
        labels: labels(),
        projectStatus: "Implementation",
        comments: null,
      }),
    ).toBe("unknown");
  });
});

describe("isPlanningPhaseSkipped", () => {
  const issue = { labels: labels(), projectStatus: "Implementation", commentCount: 3 };

  it("コメントの取得中は判定しない（一瞬スキップと出てから戻るのを避ける）", () => {
    expect(isPlanningPhaseSkipped(issue, [], true)).toBe(false);
  });

  it("commentCountがあるのに空配列なら、まだ届いていないと見なす", () => {
    expect(isPlanningPhaseSkipped(issue, [], false)).toBe(false);
  });

  it("コメントが1件も無いIssueは、取得済みとして判定する", () => {
    expect(isPlanningPhaseSkipped({ ...issue, commentCount: 0 }, [], false)).toBe(true);
  });

  it("取得済みで計画コメントが無ければスキップ", () => {
    expect(isPlanningPhaseSkipped(issue, [comment("ただのコメント", "guchi")], false)).toBe(true);
  });

  it("取得済みで計画コメントがあればスキップではない", () => {
    expect(
      isPlanningPhaseSkipped(
        issue,
        [comment("計画です\n<!-- issue-deck-agent:planner -->")],
        false,
      ),
    ).toBe(false);
  });
});
