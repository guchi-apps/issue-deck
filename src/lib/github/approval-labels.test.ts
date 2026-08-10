import { describe, expect, it } from "vitest";

import {
  approveCommentBody,
  isLabelFilterPresetActive,
  isMergeApprovalPending,
  isQaOnlyApprovalPending,
  LABEL_FILTER_PRESETS,
  labelsAfterApproval,
  labelsAfterRejection,
  rejectCommentBody,
  requestPrFixCommentBody,
  withRollbackFailureNotice,
  withRollbackNotice,
} from "@/lib/github/approval-labels";
import type { IssueComment, IssueLabel } from "@/types/issue";

function makeLabel(name: string): IssueLabel {
  return { name, color: "000000", description: null };
}

function makeComment(body: string, login = "github-actions[bot]"): Pick<IssueComment, "body" | "author"> {
  return { body, author: { login } };
}

describe("LABEL_FILTER_PRESETS", () => {
  it("未着手プリセットは実装状況ラベル・00.check-userを除外条件に持つ", () => {
    const preset = LABEL_FILTER_PRESETS.find((item) => item.key === "not-started");
    expect(preset?.labels).toEqual([]);
    expect(preset?.excludeLabels).toEqual([
      "00.check-user",
      "01.planning",
      "02.wip",
      "03.d:marge",
      "05.develop",
      "07.m:marge",
      "09.main",
    ]);
  });

  it("実行中プリセットは01.planning/02.wip/03.d:margeを対象にする", () => {
    const preset = LABEL_FILTER_PRESETS.find((item) => item.key === "in-progress");
    expect(preset?.labels).toEqual(["01.planning", "02.wip", "03.d:marge"]);
  });

  it("本番反映待ちプリセットは05.develop/07.m:margeを対象にする", () => {
    const preset = LABEL_FILTER_PRESETS.find((item) => item.key === "release-pending");
    expect(preset?.labels).toEqual(["05.develop", "07.m:marge"]);
  });

  it("直近本番に反映したプリセットは09.mainを対象にする", () => {
    const preset = LABEL_FILTER_PRESETS.find((item) => item.key === "recently-merged");
    expect(preset?.labels).toEqual(["09.main"]);
  });
});

describe("isLabelFilterPresetActive", () => {
  it("excludeLabelsのみで定義されるプリセット（labelsが空）は常に非アクティブとして扱う", () => {
    const preset = LABEL_FILTER_PRESETS.find((item) => item.key === "not-started");
    expect(preset && isLabelFilterPresetActive([], preset)).toBe(false);
  });
});

describe("approveCommentBody", () => {
  it("21.plan-requiredが無い場合は汎用の確認文言を返し、no-triggerマーカーは付与しない", () => {
    const body = approveCommentBody([makeLabel("00.check-user")]);
    expect(body).toBe("@claude 確認しました。実装を進めてください。");
    expect(body).not.toContain("<!-- issue-deck:no-trigger -->");
  });

  it("21.plan-requiredがある場合は計画承認の文言を返し、no-triggerマーカーを付与する", () => {
    const body = approveCommentBody([makeLabel("00.check-user"), makeLabel("21.plan-required")]);
    expect(body).toBe(
      "@claude 計画を承認しました。実装を進めてください。\n<!-- issue-deck:no-trigger -->",
    );
  });

  it("textを渡した場合は入力内容の後に定型の補足文を続ける", () => {
    const body = approveCommentBody([makeLabel("00.check-user")], "  ここも直しておいて  ");
    expect(body).toBe("@claude ここも直しておいて\n\n確認しました。実装を進めてください。");
  });

  it("21.plan-requiredがある状態でtextを渡した場合は計画向けの補足文を続け、no-triggerマーカーを付与する", () => {
    const body = approveCommentBody(
      [makeLabel("00.check-user"), makeLabel("21.plan-required")],
      "ここも直しておいて",
    );
    expect(body).toBe(
      "@claude ここも直しておいて\n\n計画を承認しました。実装を進めてください。\n<!-- issue-deck:no-trigger -->",
    );
  });

  it("textが空白のみの場合はtext無し扱いで定型文のみを返す", () => {
    expect(approveCommentBody([makeLabel("00.check-user")], "   ")).toBe(
      "@claude 確認しました。実装を進めてください。",
    );
  });

  it("00.qa-answeredがある場合は質問への回答確認のみの文言を返す（#887）", () => {
    const body = approveCommentBody([makeLabel("00.check-user"), makeLabel("00.qa-answered")]);
    expect(body).toBe("@claude 回答を確認しました。");
  });

  it("00.qa-answeredと21.plan-requiredが両方ある場合は計画承認の文言を優先する", () => {
    const body = approveCommentBody([
      makeLabel("00.check-user"),
      makeLabel("00.qa-answered"),
      makeLabel("21.plan-required"),
    ]);
    expect(body).toBe(
      "@claude 計画を承認しました。実装を進めてください。\n<!-- issue-deck:no-trigger -->",
    );
  });
});

describe("isQaOnlyApprovalPending", () => {
  it("00.check-user + 00.qa-answeredの場合はtrueを返す", () => {
    expect(
      isQaOnlyApprovalPending([makeLabel("00.check-user"), makeLabel("00.qa-answered")]),
    ).toBe(true);
  });

  it("00.check-userが無ければfalseを返す", () => {
    expect(isQaOnlyApprovalPending([makeLabel("00.qa-answered")])).toBe(false);
  });

  it("00.qa-answeredが無ければfalseを返す", () => {
    expect(isQaOnlyApprovalPending([makeLabel("00.check-user")])).toBe(false);
  });

  it("21.plan-requiredが付いている間はfalseを返す（計画承認待ちを優先する）", () => {
    expect(
      isQaOnlyApprovalPending([
        makeLabel("00.check-user"),
        makeLabel("00.qa-answered"),
        makeLabel("21.plan-required"),
      ]),
    ).toBe(false);
  });
});

describe("labelsAfterApproval", () => {
  it("00.check-user・21.plan-required・00.qa-answeredを外す", () => {
    expect(
      labelsAfterApproval([
        makeLabel("00.check-user"),
        makeLabel("00.qa-answered"),
        makeLabel("21.plan-required"),
        makeLabel("bug"),
      ]),
    ).toEqual(["bug"]);
  });
});

describe("labelsAfterRejection", () => {
  it("00.check-user・00.qa-answeredを外し、21.plan-requiredは残す", () => {
    expect(
      labelsAfterRejection([
        makeLabel("00.check-user"),
        makeLabel("00.qa-answered"),
        makeLabel("21.plan-required"),
        makeLabel("bug"),
      ]),
    ).toEqual(["21.plan-required", "bug"]);
  });
});

describe("isMergeApprovalPending", () => {
  it("00.check-userが無ければfalseを返す", () => {
    expect(isMergeApprovalPending({ labels: [makeLabel("03.d:marge")], projectStatus: null })).toBe(false);
  });

  it("00.check-user + 03.d:margeの場合はtrueを返す", () => {
    expect(isMergeApprovalPending({ labels: [makeLabel("00.check-user"), makeLabel("03.d:marge")], projectStatus: null })).toBe(true);
  });

  it("00.check-user + 07.m:margeの場合はtrueを返す", () => {
    expect(isMergeApprovalPending({ labels: [makeLabel("00.check-user"), makeLabel("07.m:marge")], projectStatus: null })).toBe(true);
  });

  it("00.check-user + 02.wipの場合はfalseを返す（コメントが無い場合）", () => {
    expect(isMergeApprovalPending({ labels: [makeLabel("00.check-user"), makeLabel("02.wip")], projectStatus: null })).toBe(false);
  });

  it("00.check-user + 02.wipでも、直近のbotコメントがclaude-review-develop発ならtrueを返す（#728: additionalモード再開時のラベル戻し直後にレビューが完了するレース）", () => {
    const labels = [makeLabel("00.check-user"), makeLabel("02.wip")];
    const comments = [
      makeComment("@claude コンフリクトを解消してください。", "m-guchi"),
      makeComment(
        "🔧 依頼を確認しました。追加コミットします。\n\n<!-- issue-deck-source:claude-issue-dispatch -->\n\n<!-- issue-deck-agent:implementer -->",
      ),
      makeComment(
        "⚠️ developへのマージ前にユーザーの確認が必要と判定しました。\n\n<!-- issue-deck-source:claude-review-develop -->",
      ),
    ];
    expect(isMergeApprovalPending({ labels, projectStatus: null }, comments)).toBe(true);
  });

  it("00.check-user + 02.wipで、直近のbotコメントがclaude-review-develop以外発ならfalseを返す（計画承認待ち等）", () => {
    const labels = [makeLabel("00.check-user"), makeLabel("01.planning")];
    const comments = [
      makeComment("@claude 実装を開始してください", "m-guchi"),
      makeComment("計画本文\n\n<!-- issue-deck-plan-type:implement -->"),
    ];
    expect(isMergeApprovalPending({ labels, projectStatus: null }, comments)).toBe(false);
  });

  it("直近のbotコメントが発信元不明（マーカー無し）の場合はラベルの判定にフォールバックする", () => {
    const labels = [makeLabel("00.check-user"), makeLabel("03.d:marge")];
    const comments = [makeComment("マーカーの無いコメント")];
    expect(isMergeApprovalPending({ labels, projectStatus: null }, comments)).toBe(true);
  });
});

describe("rejectCommentBody", () => {
  it("21.plan-requiredが無く入力がある場合はその内容を@claudeメンションに続けて返し、マーカーは付与しない", () => {
    const body = rejectCommentBody([makeLabel("00.check-user")], "  ここを直してください  ");
    expect(body).toBe("@claude ここを直してください");
    expect(body).not.toContain("<!-- issue-deck:no-trigger -->");
  });

  it("入力が空の場合は定型文を返す", () => {
    expect(rejectCommentBody([makeLabel("00.check-user")], "")).toBe("@claude 内容を見直してください。");
  });

  it("21.plan-requiredがある場合はno-triggerマーカーを付与する", () => {
    const body = rejectCommentBody(
      [makeLabel("00.check-user"), makeLabel("21.plan-required")],
      "ここを直してください",
    );
    expect(body).toBe("@claude ここを直してください\n<!-- issue-deck:no-trigger -->");
  });
});

describe("requestPrFixCommentBody", () => {
  it("修正依頼の入力がある場合はその内容を@claudeメンションに続けて返す", () => {
    expect(requestPrFixCommentBody("  ここを直してください  ")).toBe(
      "@claude ここを直してください",
    );
  });

  it("入力が空の場合は定型文を返す", () => {
    expect(requestPrFixCommentBody("")).toBe("@claude PRの内容を見直して修正してください。");
  });

  it("空白のみの入力も定型文を返す", () => {
    expect(requestPrFixCommentBody("   ")).toBe("@claude PRの内容を見直して修正してください。");
  });
});

describe("withRollbackNotice", () => {
  it("元のエラーメッセージにラベルロールバックの案内を追記する", () => {
    expect(withRollbackNotice("GitHub連携が必要です。再ログインしてください。")).toBe(
      "GitHub連携が必要です。再ログインしてください。 ラベルの変更は取り消しました。GitHubからログアウトし、再度ログインしてからもう一度お試しください。",
    );
  });
});

describe("withRollbackFailureNotice", () => {
  it("元のエラーメッセージにラベル復元失敗の案内を追記する", () => {
    expect(withRollbackFailureNotice("GitHub連携が必要です。再ログインしてください。")).toBe(
      "GitHub連携が必要です。再ログインしてください。 ラベルの復元にも失敗しました。手動でご確認ください。",
    );
  });
});
