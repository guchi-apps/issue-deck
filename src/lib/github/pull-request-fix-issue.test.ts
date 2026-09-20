import { describe, expect, it } from "vitest";

import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import {
  buildPullRequestFixIssueDraft,
  buildPullRequestFixReason,
  resolvePullRequestFixIssueTone,
  resolvePullRequestFixRoute,
  selectOpenChangeRequests,
  showsPullRequestFixIssueBar,
} from "@/lib/github/pull-request-fix-issue";
import type { PullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import type { IssueLabel } from "@/types/issue";
import type { PullRequestEvent } from "@/types/pull-request";

function labels(...names: string[]): IssueLabel[] {
  return names.map((name) => ({ name, color: "ededed", description: null }));
}

function session(
  state: DispatchSessionView["state"],
  host = "subpc",
  codexThreadKnown: DispatchSessionView["codexThreadKnown"] = null,
) {
  return { host, state, codexThreadKnown };
}

function review(
  id: string,
  authorLogin: string,
  reviewState: PullRequestEvent["reviewState"],
  body = "",
): PullRequestEvent {
  return { id, kind: "review", authorLogin, body, createdAt: "2026-09-14T00:00:00Z", reviewState, path: null, line: null };
}

function verdict(reviewKind: PullRequestReviewVerdict["reviewKind"], reviewLabel: string): PullRequestReviewVerdict {
  return {
    reviewKind,
    reviewLabel,
    riskKind: "none",
    riskLabel: "該当なし",
    riskReasons: [],
    confirmLabel: null,
    reviewedSha: null,
  };
}

const basePullRequest = {
  repositoryFullName: "guchi-apps/issue-deck",
  number: 2957,
  title: "リリース履歴の未確認件数を表示する",
  baseRef: "develop",
  headRef: "issue-2951",
  headSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
  merged: false,
  state: "open" as const,
  linkedIssueNumbers: [2951],
  reviewVerdict: null,
};

describe("showsPullRequestFixIssueBar", () => {
  it("リリースPRには出さない", () => {
    expect(showsPullRequestFixIssueBar({ kind: "release" })).toBe(false);
    expect(showsPullRequestFixIssueBar({ kind: "issue" })).toBe(true);
    expect(showsPullRequestFixIssueBar({ kind: "other" })).toBe(true);
  });
});

describe("selectOpenChangeRequests", () => {
  it("レビュアーごとに最後の判定が変更要求のものだけ残す", () => {
    const events = [
      review("r1", "alice", "changes_requested", "直して"),
      review("r2", "alice", "approved"),
      review("r3", "bob", "changes_requested", "ここも"),
      review("r4", "bob", "commented", "補足"),
    ];
    expect(selectOpenChangeRequests(events).map((event) => event.id)).toEqual(["r3"]);
  });

  it("会話コメントは見ない", () => {
    const comment: PullRequestEvent = { ...review("c1", "alice", null, "本文"), kind: "comment" };
    expect(selectOpenChangeRequests([comment])).toEqual([]);
  });
});

describe("resolvePullRequestFixIssueTone", () => {
  it("自動レビューの要修正・人の変更要求は赤、要確認は黄、それ以外は控えめ", () => {
    expect(resolvePullRequestFixIssueTone({ reviewVerdict: verdict("changes-requested", "要修正") }, [])).toBe(
      "changes-requested",
    );
    expect(
      resolvePullRequestFixIssueTone({ reviewVerdict: verdict("ok", "問題なし（LGTM）") }, [
        review("r1", "alice", "changes_requested"),
      ]),
    ).toBe("changes-requested");
    expect(resolvePullRequestFixIssueTone({ reviewVerdict: verdict("needs-check", "要確認") }, [])).toBe(
      "needs-check",
    );
    expect(resolvePullRequestFixIssueTone({ reviewVerdict: verdict("ok", "問題なし（LGTM）") }, [])).toBe("none");
    expect(resolvePullRequestFixIssueTone({ reviewVerdict: null }, [])).toBe("none");
  });
});

describe("buildPullRequestFixIssueDraft", () => {
  it("自動レビューは「気になった点」以降を、人の変更要求は本文を引用する", () => {
    const draft = buildPullRequestFixIssueDraft({
      pullRequest: { ...basePullRequest, reviewVerdict: verdict("changes-requested", "要修正") },
      review: {
        body: "## 総評\n良い変更です。\n\n## 気になった点\n- 既読のタイミングが早い",
        verdictLabel: "要修正",
        isStale: false,
      },
      openChangeRequests: [review("r1", "alice", "changes_requested", "スマホで件数が消えない")],
    });

    expect(draft.repositoryFullName).toBe("guchi-apps/issue-deck");
    expect(draft.title).toBe("リリース履歴の未確認件数を表示する の修正（レビュー指摘）");
    expect(draft.body).toContain("PR #2957 のレビューで修正を求められた指摘です。");
    expect(draft.body).toContain("- 元Issue: #2951");
    expect(draft.body).toContain("- 対象PR: #2957（develop ← issue-2951・未マージ）");
    expect(draft.body).toContain("> ## 気になった点\n> - 既読のタイミングが早い");
    expect(draft.body).not.toContain("良い変更です");
    expect(draft.body).toContain("**変更を要求（alice）**\n\n> スマホで件数が消えない");
  });

  it("指摘を取り込めなかったときは、PRを読んで書く旨を入れる", () => {
    const draft = buildPullRequestFixIssueDraft({
      pullRequest: { ...basePullRequest, merged: true, linkedIssueNumbers: [] },
      review: null,
      openChangeRequests: [],
    });

    expect(draft.body).toContain("PR #2957 に対する修正です。");
    expect(draft.body).toContain("- 元Issue: （記録なし）");
    expect(draft.body).toContain("マージ済み");
    expect(draft.body).toContain("レビューの指摘は取り込めませんでした。");
  });

  it("古いコミットへのレビューにはその旨を添える", () => {
    const draft = buildPullRequestFixIssueDraft({
      pullRequest: basePullRequest,
      review: { body: "指摘", verdictLabel: "要確認", isStale: true },
      openChangeRequests: [],
    });
    expect(draft.body).toContain("**自動レビュー（要確認）**（PRの最新コミットより前のコミットへのレビューです）");
  });
});

describe("buildPullRequestFixReason", () => {
  it("自動レビューと変更要求の引用を、新規Issue下書きと同じ組み立てで並べる", () => {
    const reason = buildPullRequestFixReason({
      pullRequestNumber: 2957,
      review: {
        body: "## 気になった点\n- 既読のタイミングが早い",
        verdictLabel: "要修正",
        isStale: false,
      },
      openChangeRequests: [review("r1", "alice", "changes_requested", "スマホで件数が消えない")],
    });
    expect(reason).toContain("PR #2957 のレビューで指摘された次の点を修正してください。");
    expect(reason).toContain("> ## 気になった点\n> - 既読のタイミングが早い");
    expect(reason).toContain("**変更を要求（alice）**\n\n> スマホで件数が消えない");
  });

  it("指摘を取り込めなかったときは、PRを読んで書く旨を入れる", () => {
    const reason = buildPullRequestFixReason({
      pullRequestNumber: 2957,
      review: null,
      openChangeRequests: [],
    });
    expect(reason).toContain("レビューの指摘は取り込めませんでした。");
  });
});

describe("resolvePullRequestFixRoute", () => {
  const pullRequest = { merged: false, state: "open" as const, linkedIssueNumbers: [2951] };

  it("マージ済みなら常に新規Issue作成（PRを更新できないため）", () => {
    expect(
      resolvePullRequestFixRoute({
        pullRequest: { merged: true, state: "closed", linkedIssueNumbers: [2951] },
        targetIssueLabels: labels("11.local"),
        session: session("ALIVE"),
      }),
    ).toEqual({ kind: "create-issue" });
  });

  it("クローズ済みの未マージPRも新規Issue作成へ倒す（追加コミットしてもPRが更新されないため。計画レビュー指摘1）", () => {
    expect(
      resolvePullRequestFixRoute({
        pullRequest: { merged: false, state: "closed", linkedIssueNumbers: [2951] },
        targetIssueLabels: labels("11.local"),
        session: session("ALIVE"),
      }),
    ).toEqual({ kind: "create-issue" });
  });

  it("元Issueが複数・0件なら新規Issue作成へ倒す", () => {
    expect(
      resolvePullRequestFixRoute({
        pullRequest: { merged: false, state: "open", linkedIssueNumbers: [2951, 2952] },
        targetIssueLabels: labels("11.local"),
        session: session("ALIVE"),
      }),
    ).toEqual({ kind: "create-issue" });
    expect(
      resolvePullRequestFixRoute({
        pullRequest: { merged: false, state: "open", linkedIssueNumbers: [] },
        targetIssueLabels: null,
        session: null,
      }),
    ).toEqual({ kind: "create-issue" });
  });

  it("元Issueが一覧に見つからない（ラベル未解決）ときも新規Issue作成へ倒す", () => {
    expect(
      resolvePullRequestFixRoute({ pullRequest, targetIssueLabels: null, session: null }),
    ).toEqual({ kind: "create-issue" });
  });

  it("未マージで元Issueが1件に絞れれば、resolvePrFixRequestRouteの判定へそのまま委ねる", () => {
    expect(
      resolvePullRequestFixRoute({
        pullRequest,
        targetIssueLabels: labels("11.local"),
        session: session("ALIVE", "subpc"),
      }),
    ).toEqual({ kind: "session", host: "subpc" });
    expect(
      resolvePullRequestFixRoute({ pullRequest, targetIssueLabels: labels("51.improvement"), session: null }),
    ).toEqual({ kind: "actions" });
  });
});
