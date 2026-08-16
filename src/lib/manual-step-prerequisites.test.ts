import { describe, expect, it } from "vitest";

import {
  extractManualStepReferences,
  formatManualStepReference,
  resolveManualStepPrerequisites,
  summarizeManualStepPrerequisites,
} from "@/lib/manual-step-prerequisites";
import type { Issue } from "@/types/issue";
import type { IssuePullRequest } from "@/types/pull-request";

const REPO = "guchi-apps/issue-deck";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: String(overrides.number ?? 1),
    number: 1,
    title: "サンプルIssue",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: REPO,
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "author-user" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    projectStatus: null,
    htmlUrl: `https://github.com/${REPO}/issues/${overrides.number ?? 1}`,
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

function makePullRequest(overrides: Partial<IssuePullRequest> = {}): IssuePullRequest {
  return {
    number: 1,
    htmlUrl: `https://github.com/${REPO}/pull/${overrides.number ?? 1}`,
    title: "サンプルPR",
    state: "open",
    draft: false,
    merged: false,
    ciStatus: null,
    linkedIssueNumber: null,
    ...overrides,
  };
}

const BODY = [
  "## 前提条件",
  "",
  "- 実行するデバイス: VPS",
  "- カレントディレクトリ: `/var/www/issue-deck`",
  "- Gitブランチ: `develop`",
  "- 先に完了している必要があるIssue・PR: #1690 がmainへ反映された後、#1704 がマージされた後",
  "",
  "## やること",
  "",
  "- [ ] .envを更新する",
  "",
  "```bash",
  "# コードブロックの中の #9999 は拾わない",
  "gh issue view 9999",
  "```",
  "",
  "## 関連",
  "",
  "- 起点Issue: #1662",
].join("\n");

describe("extractManualStepReferences", () => {
  it("前提条件の節の参照と起点Issueを拾う", () => {
    expect(extractManualStepReferences(BODY, REPO, 1712)).toEqual([
      { repositoryFullName: REPO, number: 1690, origin: false },
      { repositoryFullName: REPO, number: 1704, origin: false },
      { repositoryFullName: REPO, number: 1662, origin: true },
    ]);
  });

  it("前提条件の節のコードブロックの中は拾わない", () => {
    const body = [
      "## 前提条件",
      "",
      "```bash",
      "gh issue view 1 # 前提 #4242",
      "```",
      "",
      "- 先に完了している必要があるIssue・PR: なし",
    ].join("\n");

    expect(extractManualStepReferences(body, REPO, 1712)).toEqual([]);
  });

  it("別リポジトリを指した参照はそのリポジトリのものとして扱う", () => {
    const body = "## 前提条件\n\n- 先に完了している必要があるIssue・PR: guchi-apps/vps#88\n";

    expect(extractManualStepReferences(body, REPO, 1712)).toEqual([
      { repositoryFullName: "guchi-apps/vps", number: 88, origin: false },
    ]);
  });

  it("自分自身への参照と重複は除く", () => {
    const body = "## 前提条件\n\n- #1712 と #1690 と #1690\n";

    expect(extractManualStepReferences(body, REPO, 1712)).toEqual([
      { repositoryFullName: REPO, number: 1690, origin: false },
    ]);
  });

  it("前提条件にも書かれた起点Issueは1件にまとめ、起点として印を付ける", () => {
    const body = "## 前提条件\n\n- #1662 がmainへ反映された後\n\n## 関連\n\n- 起点Issue: #1662\n";

    expect(extractManualStepReferences(body, REPO, 1712)).toEqual([
      { repositoryFullName: REPO, number: 1662, origin: true },
    ]);
  });

  it("前提条件の節が無ければ起点Issueだけを返す", () => {
    const body = "## やること\n\n- [ ] 実行する\n\n## 関連\n\n- 起点Issue: #1662\n";

    expect(extractManualStepReferences(body, REPO, 1712)).toEqual([
      { repositoryFullName: REPO, number: 1662, origin: true },
    ]);
  });
});

describe("resolveManualStepPrerequisites", () => {
  const references = extractManualStepReferences(BODY, REPO, 1712);

  it("進捗から3段階（実装・develop・main）を割り出す", () => {
    const issues = [
      makeIssue({ number: 1690, projectStatus: "Develop" }),
      makeIssue({ number: 1662, projectStatus: "Done", state: "closed" }),
    ];
    const pullRequests = [makePullRequest({ number: 1704 })];

    expect(
      resolveManualStepPrerequisites(references, issues, pullRequests, REPO).map((prerequisite) => ({
        number: prerequisite.number,
        kind: prerequisite.kind,
        stage: prerequisite.stage,
        satisfied: prerequisite.satisfied,
        stepIndex: prerequisite.stepIndex,
      })),
    ).toEqual([
      { number: 1690, kind: "issue", stage: "develop", satisfied: false, stepIndex: 1 },
      { number: 1704, kind: "pull-request", stage: "open", satisfied: false, stepIndex: null },
      { number: 1662, kind: "issue", stage: "done-main", satisfied: true, stepIndex: 2 },
    ]);
  });

  // Doneに達したIssueはcloseされる。closedを先に見ると全部「クローズ済み」になる
  it("Doneでcloseされたissueはmainへ反映済みとして扱う", () => {
    const issues = [makeIssue({ number: 1690, projectStatus: "Done", state: "closed" })];
    const [first] = resolveManualStepPrerequisites(
      [{ repositoryFullName: REPO, number: 1690, origin: false }],
      issues,
      [],
      REPO,
    );

    expect(first.stage).toBe("done-main");
    expect(first.label).toBe("mainへ反映済み");
  });

  it("Doneまで行かずに閉じられたIssueは待たない", () => {
    const issues = [makeIssue({ number: 1690, state: "closed", stateReason: "not_planned" })];
    const [first] = resolveManualStepPrerequisites(
      [{ repositoryFullName: REPO, number: 1690, origin: false }],
      issues,
      [],
      REPO,
    );

    expect(first.stage).toBe("closed");
    expect(first.satisfied).toBe(true);
  });

  it("マージ済みPRは満たされたものとして扱い、3段階には載せない", () => {
    const [first] = resolveManualStepPrerequisites(
      [{ repositoryFullName: REPO, number: 1704, origin: false }],
      [],
      [makePullRequest({ number: 1704, state: "closed", merged: true })],
      REPO,
    );

    expect(first).toMatchObject({
      kind: "pull-request",
      stage: "merged",
      satisfied: true,
      stepIndex: null,
    });
  });

  // 取得範囲外というだけで実行できる手作業を止めない（manual-step-attentionと同じ向き）
  it("状態を取れなかった参照は待ちに数えない", () => {
    const [first] = resolveManualStepPrerequisites(
      [{ repositoryFullName: "guchi-apps/vps", number: 88, origin: false }],
      [],
      [],
      REPO,
    );

    expect(first).toMatchObject({ kind: "unknown", stage: "unknown", satisfied: true });
  });

  it("別リポジトリの同番号を取り違えない", () => {
    const issues = [
      makeIssue({ number: 88, repositoryFullName: "guchi-apps/car-care", title: "別リポジトリ" }),
      makeIssue({ number: 88, repositoryFullName: "guchi-apps/vps", title: "こちらが正しい" }),
    ];
    const [first] = resolveManualStepPrerequisites(
      [{ repositoryFullName: "guchi-apps/vps", number: 88, origin: false }],
      issues,
      [],
      REPO,
    );

    expect(first.title).toBe("こちらが正しい");
  });
});

describe("summarizeManualStepPrerequisites", () => {
  it("待つ相手が無ければ実行できる旨を返す", () => {
    const prerequisites = resolveManualStepPrerequisites(
      [{ repositoryFullName: REPO, number: 1662, origin: true }],
      [makeIssue({ number: 1662, projectStatus: "Done", state: "closed" })],
      [],
      REPO,
    );

    expect(summarizeManualStepPrerequisites(prerequisites, REPO)).toMatchObject({
      total: 1,
      satisfiedCount: 1,
      message: "前提はすべて満たされています。いま実行できます。",
    });
  });

  it("何を待っているのかまで含めた1行を返す", () => {
    const prerequisites = resolveManualStepPrerequisites(
      [
        { repositoryFullName: REPO, number: 1690, origin: true },
        { repositoryFullName: REPO, number: 1704, origin: false },
      ],
      [
        makeIssue({ number: 1690, projectStatus: "Develop" }),
        makeIssue({ number: 1704, projectStatus: "Implementation" }),
      ],
      [],
      REPO,
    );
    const summary = summarizeManualStepPrerequisites(prerequisites, REPO);

    expect(summary.satisfiedCount).toBe(0);
    expect(summary.blocking).toHaveLength(2);
    expect(summary.message).toBe(
      "まだ実行できません。#1690 がmainへ反映されるのを待ってください（ほか1件）。",
    );
  });
});

describe("formatManualStepReference", () => {
  it("同じリポジトリなら番号だけ、別リポジトリならfullNameを添える", () => {
    expect(
      formatManualStepReference({ repositoryFullName: REPO, number: 12, origin: false }, REPO),
    ).toBe("#12");
    expect(
      formatManualStepReference(
        { repositoryFullName: "guchi-apps/vps", number: 88, origin: false },
        REPO,
      ),
    ).toBe("guchi-apps/vps#88");
  });
});
