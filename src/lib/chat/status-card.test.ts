import { describe, expect, it } from "vitest";

import { buildIssueDraft } from "@/lib/chat/issue-draft";
import {
  buildIssueStatusCard,
  buildPullRequestStatusCard,
  relatedIssueFromBranch,
  type PullRequestStatusInput,
} from "@/lib/chat/status-card";

const base: PullRequestStatusInput = {
  repo: "guchi-apps/issue-deck",
  number: 3966,
  title: "レビュー修正を同一PRの再レビューへつなぐ",
  htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/3966",
  state: "open",
  merged: false,
  draft: false,
  headRef: "issue-3963",
  ciState: "success",
  mergeable: true,
  reviewVerdict: {
    reviewKind: "changes-requested",
    reviewLabel: "要修正",
    riskKind: "none",
    riskLabel: "",
    riskReasons: [],
    confirmLabel: null,
    reviewedSha: null,
  },
  activeRepair: null,
  repairKinds: ["review"],
};

const row = (card: ReturnType<typeof buildPullRequestStatusCard>, label: string) =>
  card.rows.find((r) => r.label === label);

describe("buildPullRequestStatusCard", () => {
  it("CI成功・レビュー要修正・コンフリクトなし・修復未実行を既存の判定値から写す", () => {
    const card = buildPullRequestStatusCard(base);
    expect(row(card, "CI")).toMatchObject({ value: "成功", tone: "ok" });
    expect(row(card, "レビュー")).toMatchObject({ value: "要修正", tone: "bad" });
    expect(row(card, "コンフリクト")).toMatchObject({ value: "なし", tone: "ok" });
    expect(row(card, "修復")).toMatchObject({ value: "未実行", tone: "mut" });
    expect(card.relatedIssue).toBe(3963);
    expect(card.repairKinds).toEqual(["review"]);
  });

  it("コンフリクト・判定中・修復実行中を区別する", () => {
    expect(row(buildPullRequestStatusCard({ ...base, mergeable: false }), "コンフリクト")?.tone).toBe("bad");
    expect(row(buildPullRequestStatusCard({ ...base, mergeable: null }), "コンフリクト")?.value).toBe("判定中");
    const repairing = buildPullRequestStatusCard({ ...base, activeRepair: { kind: "ci" } });
    expect(row(repairing, "修復")).toMatchObject({ value: "実行中（CIの失敗）", tone: "warn" });
  });

  it("判定が無いPRはレビュー「記録なし」", () => {
    expect(row(buildPullRequestStatusCard({ ...base, reviewVerdict: null }), "レビュー")?.value).toBe("記録なし");
  });
});

describe("relatedIssueFromBranch", () => {
  it("issue-<番号>ブランチだけ関連Issueとして読む", () => {
    expect(relatedIssueFromBranch("issue-12")).toBe(12);
    expect(relatedIssueFromBranch("feature/x")).toBeNull();
  });
});

describe("buildIssueStatusCard", () => {
  it("確認待ちラベルは警告色にする", () => {
    const card = buildIssueStatusCard({
      repo: "a/b",
      number: 1,
      title: "t",
      htmlUrl: "u",
      state: "OPEN",
      assigneeLogin: null,
      labels: ["00.check-user"],
      session: null,
    });
    expect(card.rows.find((r) => r.label === "ラベル")?.tone).toBe("warn");
  });
});

describe("buildIssueDraft", () => {
  it("確認していた対象と会話内容を材料にIssue案を作る", () => {
    const draft = buildIssueDraft({
      title: null,
      source: { repo: "a/b", number: 3966, kind: "pr", title: "修復の統合" },
      recentUserTexts: ["3966どうなってる？", "この問題は別Issueにして"],
    });
    expect(draft.title).toContain("修復の統合");
    expect(draft.body).toContain("#3966");
    expect(draft.body).toContain("- この問題は別Issueにして");
  });

  it("タイトルの指定があればそれを使う", () => {
    expect(buildIssueDraft({ title: "別件の対応", source: null, recentUserTexts: [] }).title).toBe("別件の対応");
  });
});
