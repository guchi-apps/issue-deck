import { describe, expect, it } from "vitest";

import { findQuestionPremise } from "@/lib/dispatch/question-premise";
import type { IssueComment } from "@/types/issue";

function comment(
  body: string,
  overrides: Partial<IssueComment> & { login?: string } = {},
): IssueComment {
  const { login = "m-guchi", ...rest } = overrides;
  return {
    id: body.slice(0, 8),
    author: { login },
    createdAtLabel: "3分前",
    body,
    reactionCount: 0,
    ...rest,
  };
}

const PLAN = "## 要約\n\n**内訳を直せるようにする**\n\n<!-- issue-deck-agent:planner -->";
const REPORT = "実装が終わりました\n\n<!-- issue-deck-agent:implementer -->";
const GUIDE = "🖥️ **サブPCのローカルセッションで対応を開始します。**\n\n<!-- issue-deck-agent:guide -->";

describe("findQuestionPremise", () => {
  it("エージェントが書いた最新のコメントを前提として返す", () => {
    const premise = findQuestionPremise([comment(REPORT), comment(PLAN)]);

    expect(premise?.role).toBe("planner");
    expect(premise?.roleLabel).toBe("計画ボット");
    expect(premise?.body).toContain("内訳を直せるようにする");
    expect(premise?.createdAtLabel).toBe("3分前");
  });

  it("案内ボットの受付コメントは前提にしない（「対応を開始します」が出てしまうため）", () => {
    const premise = findQuestionPremise([comment(PLAN), comment(GUIDE)]);

    expect(premise?.role).toBe("planner");
  });

  it("質問への回答コメントは前提にしない（前の回答が今の質問の前提として出てしまうため）", () => {
    const answer = "🙋 **質問に回答しました**（issue-deckの画面から）。\n\n<!-- issue-deck-qa-answer -->";

    expect(findQuestionPremise([comment(PLAN), comment(answer)])?.role).toBe("planner");
  });

  it("人が書いたコメントは前提にしない（マーカーが無いものは自動投稿と断定できない）", () => {
    expect(findQuestionPremise([comment("🔧 これは自分で書いたコメント")])).toBeNull();
  });

  it("前提にできるコメントが無ければnullを返す", () => {
    expect(findQuestionPremise([comment(GUIDE)])).toBeNull();
    expect(findQuestionPremise([])).toBeNull();
    expect(findQuestionPremise(null)).toBeNull();
  });
});
