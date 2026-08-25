import { describe, expect, it } from "vitest";

import {
  approveCommentBody,
  canCompleteManualStep,
  checkUserReason,
  isCheckUserReasonLabel,
  isSessionRemovableCheckUserReason,
  labelsWithCheckUserReason,
  isLabelFilterPresetActive,
  isMergeApprovalPending,
  isQaOnlyApprovalPending,
  LABEL_FILTER_PRESETS,
  dismissCheckUserCommentBody,
  labelsAfterApproval,
  labelsAfterCheckUserDismissal,
  labelsAfterRejection,
  rejectCommentBody,
  requestPrFixCommentBody,
  withoutCheckUserLabels,
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
  // 進捗による絞り込みはProject Statusを見る（#991 Phase 5・#1010）。
  // ラベルが判断材料に残るのは条件系（00.check-user・71.manual-step）だけ。
  it("条件系プリセットだけがラベルを条件に持つ", () => {
    const withLabels = LABEL_FILTER_PRESETS.filter((item) => item.labels.length > 0);
    expect(withLabels.map((item) => item.key)).toEqual(["check-user", "manual-step"]);
    expect(withLabels[0].labels).toEqual(["00.check-user"]);
    expect(withLabels[1].labels).toEqual(["71.manual-step"]);
  });

  it("未着手プリセットはreadyかつ00.check-user・71.manual-stepを持たないIssueを対象にする", () => {
    const preset = LABEL_FILTER_PRESETS.find((item) => item.key === "not-started");
    expect(preset?.statuses).toEqual(["ready"]);
    expect(preset?.excludeLabels).toEqual(["00.check-user", "71.manual-step"]);
  });

  it("実行中プリセットはPlanning/Implementation/Develop PRを対象にする", () => {
    const preset = LABEL_FILTER_PRESETS.find((item) => item.key === "in-progress");
    expect(preset?.statuses).toEqual(["planning", "implementation", "develop-pr"]);
  });

  it("本番反映待ちプリセットはDevelop/Releaseを対象にする", () => {
    const preset = LABEL_FILTER_PRESETS.find((item) => item.key === "release-pending");
    expect(preset?.statuses).toEqual(["develop", "release"]);
  });

  it("直近本番に反映したプリセットはDoneを対象にし、state=allを要求する", () => {
    const preset = LABEL_FILTER_PRESETS.find((item) => item.key === "recently-merged");
    expect(preset?.statuses).toEqual(["done"]);
    expect(preset?.state).toBe("all");
  });
});

describe("isLabelFilterPresetActive", () => {
  it("ラベルを持たないプリセット（進捗Status・excludeLabelsで定義されるもの）は常に非アクティブとして扱う", () => {
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

/**
 * #1903。ローカルセッションが担当しているIssueの承認欄から押す「確認待ちを外す」。
 * 承認ではないので`21.plan-required`は残し、`@claude`も付けない（無人実行を起こさない）。
 */
describe("labelsAfterCheckUserDismissal", () => {
  it("00.check-userと理由ラベルだけを外し、21.plan-requiredは残す", () => {
    expect(
      labelsAfterCheckUserDismissal([
        makeLabel("00.check-user"),
        makeLabel("01.check-input"),
        makeLabel("21.plan-required"),
        makeLabel("11.local"),
      ]),
    ).toEqual(["21.plan-required", "11.local"]);
  });
});

describe("dismissCheckUserCommentBody", () => {
  it("@claudeを付けない（無人実行のトリガー条件に掛けない）", () => {
    expect(dismissCheckUserCommentBody()).not.toContain("@claude");
    expect(dismissCheckUserCommentBody("端末で回答済み")).not.toContain("@claude");
  });

  it("入力があれば本文の先頭に残す", () => {
    expect(dismissCheckUserCommentBody("端末で回答済み")).toContain("端末で回答済み");
  });
});

describe("isMergeApprovalPending", () => {
  it("00.check-userが無ければfalseを返す", () => {
    expect(isMergeApprovalPending({ labels: [], projectStatus: "Develop PR" })).toBe(false);
  });

  it("00.check-user + Develop PRの場合はtrueを返す", () => {
    expect(
      isMergeApprovalPending({ labels: [makeLabel("00.check-user")], projectStatus: "Develop PR" }),
    ).toBe(true);
  });

  it("00.check-user + Releaseの場合はtrueを返す", () => {
    expect(
      isMergeApprovalPending({ labels: [makeLabel("00.check-user")], projectStatus: "Release" }),
    ).toBe(true);
  });

  it("00.check-user + Implementationの場合はfalseを返す（コメントが無い場合）", () => {
    expect(
      isMergeApprovalPending({ labels: [makeLabel("00.check-user")], projectStatus: "Implementation" }),
    ).toBe(false);
  });

  it("00.check-user + Implementationでも、直近のbotコメントがclaude-review-develop発ならtrueを返す（#728: additionalモード再開時の進捗戻し直後にレビューが完了するレース）", () => {
    const labels = [makeLabel("00.check-user")];
    const comments = [
      makeComment("@claude コンフリクトを解消してください。", "m-guchi"),
      makeComment(
        "🔧 依頼を確認しました。追加コミットします。\n\n<!-- issue-deck-source:claude-issue-dispatch -->\n\n<!-- issue-deck-agent:implementer -->",
      ),
      makeComment(
        "⚠️ developへのマージ前にユーザーの確認が必要と判定しました。\n\n<!-- issue-deck-source:claude-review-develop -->",
      ),
    ];
    expect(isMergeApprovalPending({ labels, projectStatus: "Implementation" }, comments)).toBe(true);
  });

  it("00.check-user + Planningで、直近のbotコメントがclaude-review-develop以外発ならfalseを返す（計画承認待ち等）", () => {
    const labels = [makeLabel("00.check-user")];
    const comments = [
      makeComment("@claude 実装を開始してください", "m-guchi"),
      makeComment("計画本文\n\n<!-- issue-deck-plan-type:implement -->"),
    ];
    expect(isMergeApprovalPending({ labels, projectStatus: "Planning" }, comments)).toBe(false);
  });

  it("直近のbotコメントが発信元不明（マーカー無し）の場合は進捗の判定にフォールバックする", () => {
    const labels = [makeLabel("00.check-user")];
    const comments = [makeComment("マーカーの無いコメント")];
    expect(isMergeApprovalPending({ labels, projectStatus: "Develop PR" }, comments)).toBe(true);
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

describe("canCompleteManualStep", () => {
  it("openな手作業Issueでは完了の導線を出す", () => {
    expect(canCompleteManualStep({ state: "open", labels: [makeLabel("71.manual-step")] })).toBe(true);
  });

  it("手作業ラベルが無いIssueでは出さない", () => {
    expect(canCompleteManualStep({ state: "open", labels: [makeLabel("65.docs")] })).toBe(false);
  });

  it("closed済みのIssueでは出さない", () => {
    expect(canCompleteManualStep({ state: "closed", labels: [makeLabel("71.manual-step")] })).toBe(
      false,
    );
  });
});

describe("checkUserReason（#1490）", () => {
  it("00.check-userが無ければ、理由ラベルが残っていてもnullを返す", () => {
    // 外し忘れた理由ラベルが単独で残っていても、画面が誤った表示をしないようにするため
    expect(checkUserReason([makeLabel("01.check-plan")])).toBeNull();
  });

  it("00.check-userとのANDで理由を返す", () => {
    expect(checkUserReason([makeLabel("00.check-user"), makeLabel("01.check-merge")])).toBe("merge");
    expect(checkUserReason([makeLabel("00.check-user"), makeLabel("01.check-input")])).toBe("input");
    expect(checkUserReason([makeLabel("00.check-user"), makeLabel("01.check-blocked")])).toBe(
      "blocked",
    );
  });

  it("理由ラベルが配られていないリポジトリではnullを返す（従来の推測へフォールバックする）", () => {
    expect(checkUserReason([makeLabel("00.check-user")])).toBeNull();
  });

  it("リネーム移行中は旧名00.qa-answeredもansweredとして読む", () => {
    expect(checkUserReason([makeLabel("00.check-user"), makeLabel("00.qa-answered")])).toBe(
      "answered",
    );
    expect(checkUserReason([makeLabel("00.check-user"), makeLabel("01.check-answered")])).toBe(
      "answered",
    );
  });

  it("複数付いていた場合は優先順（plan > merge > blocked > input > answered）で1つに決める", () => {
    expect(
      checkUserReason([
        makeLabel("00.check-user"),
        makeLabel("01.check-answered"),
        makeLabel("01.check-merge"),
        makeLabel("01.check-plan"),
      ]),
    ).toBe("plan");
  });
});

describe("isSessionRemovableCheckUserReason（#1905）", () => {
  it("セッション自身が付ける理由なら外してよい", () => {
    expect(isSessionRemovableCheckUserReason("plan")).toBe(true);
    expect(isSessionRemovableCheckUserReason("input")).toBe(true);
    expect(isSessionRemovableCheckUserReason("blocked")).toBe(true);
  });

  it("別の実行体が付ける理由は外さない（人がマージ・確認の合図を失うため）", () => {
    expect(isSessionRemovableCheckUserReason("merge")).toBe(false);
    expect(isSessionRemovableCheckUserReason("answered")).toBe(false);
  });

  it("理由が読めない（ラベル未配布）ときは従来どおり外す", () => {
    expect(isSessionRemovableCheckUserReason(null)).toBe(true);
  });
});

describe("isCheckUserReasonLabel（#1490）", () => {
  it("01.check-*と旧名00.qa-answeredだけを理由ラベルとして扱う", () => {
    expect(isCheckUserReasonLabel("01.check-plan")).toBe(true);
    expect(isCheckUserReasonLabel("00.qa-answered")).toBe(true);
    expect(isCheckUserReasonLabel("00.check-user")).toBe(false);
    expect(isCheckUserReasonLabel("02.wip")).toBe(false);
  });
});

describe("labelsWithCheckUserReason（#1490）", () => {
  it("理由を1枚に付け替え、他の理由ラベル（旧名含む）を落とす", () => {
    expect(
      labelsWithCheckUserReason(
        [
          makeLabel("11.local"),
          makeLabel("00.check-user"),
          makeLabel("00.qa-answered"),
          makeLabel("01.check-input"),
        ],
        "blocked",
      ),
    ).toEqual(["11.local", "00.check-user", "01.check-blocked"]);
  });

  it("00.check-userが付いていなければ付ける", () => {
    expect(labelsWithCheckUserReason([makeLabel("bug")], "plan")).toEqual([
      "bug",
      "00.check-user",
      "01.check-plan",
    ]);
  });
});

describe("理由ラベルがある場合の既存判定（#1490）", () => {
  it("isMergeApprovalPendingは01.check-mergeだけでtrueになる（進捗・コメントを見ない）", () => {
    expect(
      isMergeApprovalPending({
        labels: [makeLabel("00.check-user"), makeLabel("01.check-merge")],
        projectStatus: "Implementation",
      }),
    ).toBe(true);
  });

  it("isMergeApprovalPendingは他の理由ラベルではfalseになる（進捗がDevelop PRでも）", () => {
    expect(
      isMergeApprovalPending({
        labels: [makeLabel("00.check-user"), makeLabel("01.check-plan")],
        projectStatus: "Develop PR",
      }),
    ).toBe(false);
  });

  it("answeredだけは従来の推測へフォールバックする（回答済みとマージ待ちは同時に成立しうる）", () => {
    // リネーム前の既存データ（00.qa-answered）でマージ待ちの表示が消えないようにするため
    expect(
      isMergeApprovalPending({
        labels: [makeLabel("00.check-user"), makeLabel("00.qa-answered")],
        projectStatus: "Develop PR",
      }),
    ).toBe(true);
    expect(
      isMergeApprovalPending({
        labels: [makeLabel("00.check-user"), makeLabel("01.check-answered")],
        projectStatus: "Develop PR",
      }),
    ).toBe(true);
  });

  it("isQaOnlyApprovalPendingは新名01.check-answeredでも成立する", () => {
    expect(
      isQaOnlyApprovalPending([makeLabel("00.check-user"), makeLabel("01.check-answered")]),
    ).toBe(true);
  });

  it("approveCommentBodyは01.check-planでも計画承認の文言になる", () => {
    expect(approveCommentBody([makeLabel("00.check-user"), makeLabel("01.check-plan")])).toBe(
      "@claude 計画を承認しました。実装を進めてください。",
    );
  });

  it("labelsAfterApproval・labelsAfterRejectionは01.check-*も外す", () => {
    const labels = [
      makeLabel("00.check-user"),
      makeLabel("01.check-plan"),
      makeLabel("21.plan-required"),
      makeLabel("bug"),
    ];
    expect(labelsAfterApproval(labels)).toEqual(["bug"]);
    expect(labelsAfterRejection(labels)).toEqual(["21.plan-required", "bug"]);
  });

  /**
   * #2341。画面が手元のIssueを描き直すのに使うので、**名前だけでなくラベルのまま**返す
   * （色と説明を落とすと、次のポーリングまで灰色のラベルが並ぶ）。
   */
  it("withoutCheckUserLabelsは00.check-userと01.check-*だけをラベルのまま落とす", () => {
    const labels = [
      makeLabel("00.check-user"),
      makeLabel("01.check-plan"),
      makeLabel("00.qa-answered"),
      makeLabel("21.plan-required"),
      makeLabel("bug"),
    ];
    expect(withoutCheckUserLabels(labels)).toEqual([
      makeLabel("21.plan-required"),
      makeLabel("bug"),
    ]);
  });

  it("withoutCheckUserLabelsは外すものが無ければそのまま返す", () => {
    const labels = [makeLabel("21.plan-required"), makeLabel("bug")];
    expect(withoutCheckUserLabels(labels)).toEqual(labels);
  });
});
