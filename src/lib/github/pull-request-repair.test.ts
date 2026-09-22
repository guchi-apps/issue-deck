import { describe, expect, it } from "vitest";

import {
  CI_FIX_WORKFLOW_FILE,
  CONFLICT_RESOLVE_WORKFLOW_FILE,
  PR_REPAIR_WORKFLOW_FILE,
  REVIEW_FIX_WORKFLOW_FILE,
  canRepairFromDeck,
  isRepairWorkflowMissing,
  repairKindsFor,
  repairUnavailableNotices,
  resolveRepairDispatch,
  supportsRepairKind,
} from "@/lib/github/pull-request-repair";

describe("resolveRepairDispatch", () => {
  it("develop向けのissue-<番号>PRは既存のCI失敗修正ワークフローへIssue番号を渡す", () => {
    expect(
      resolveRepairDispatch({ number: 42, baseRef: "develop", headRef: "issue-123" }, "ci"),
    ).toEqual({
      workflowFile: CI_FIX_WORKFLOW_FILE,
      ref: "develop",
      inputs: { issue_number: "123" },
    });
  });

  it("develop向けのissue-<番号>PRは既存のコンフリクト解消ワークフローへIssue番号を渡す", () => {
    expect(
      resolveRepairDispatch({ number: 42, baseRef: "develop", headRef: "issue-123" }, "conflict"),
    ).toEqual({
      workflowFile: CONFLICT_RESOLVE_WORKFLOW_FILE,
      ref: "develop",
      inputs: { issue_number: "123" },
    });
  });

  it("develop向けのissue-<番号>PRのレビュー指摘はレビュー指摘修正ワークフローへIssue番号を渡す", () => {
    expect(
      resolveRepairDispatch({ number: 42, baseRef: "develop", headRef: "issue-123" }, "review"),
    ).toEqual({
      workflowFile: REVIEW_FIX_WORKFLOW_FILE,
      ref: "develop",
      inputs: { issue_number: "123" },
    });
  });

  it("develop→mainのリリースPRはIssueに紐づかないためPR番号を渡す", () => {
    expect(
      resolveRepairDispatch({ number: 900, baseRef: "main", headRef: "develop" }, "ci"),
    ).toEqual({
      workflowFile: PR_REPAIR_WORKFLOW_FILE,
      ref: "develop",
      inputs: { pr_number: "900", mode: "ci" },
    });
  });

  it("バンプPRもIssueに紐づかないためPR番号を渡す", () => {
    expect(
      resolveRepairDispatch({ number: 901, baseRef: "develop", headRef: "release/v1.2.3" }, "conflict"),
    ).toEqual({
      workflowFile: PR_REPAIR_WORKFLOW_FILE,
      ref: "develop",
      inputs: { pr_number: "901", mode: "conflict" },
    });
  });

  it("issue-<番号>ブランチでもbaseがdevelopでなければ既存ワークフローの対象外", () => {
    // 既存ワークフローはdevelop向けPRしか探さないため、渡しても何もせず終わる。
    expect(
      resolveRepairDispatch({ number: 902, baseRef: "main", headRef: "issue-123" }, "ci"),
    ).toEqual({
      workflowFile: PR_REPAIR_WORKFLOW_FILE,
      ref: "develop",
      inputs: { pr_number: "902", mode: "ci" },
    });
  });
});

describe("supportsRepairKind", () => {
  it("レビュー指摘の修正はdevelop向けのissue-<番号>PRだけ", () => {
    expect(supportsRepairKind({ number: 1, baseRef: "develop", headRef: "issue-9" }, "review")).toBe(true);
    // Issueに紐づかないPRへは起動先が無い（claude-pr-repair.ymlは受け持たない）
    expect(supportsRepairKind({ number: 1, baseRef: "main", headRef: "develop" }, "review")).toBe(false);
    expect(supportsRepairKind({ number: 1, baseRef: "develop", headRef: "release/v1.0.0" }, "review")).toBe(
      false,
    );
  });

  it("CI・コンフリクトはどのPRでも起動先がある", () => {
    expect(supportsRepairKind({ number: 1, baseRef: "main", headRef: "develop" }, "ci")).toBe(true);
    expect(supportsRepairKind({ number: 1, baseRef: "main", headRef: "develop" }, "conflict")).toBe(true);
  });
});

describe("canRepairFromDeck", () => {
  it("openかつdraftでないPRだけが対象", () => {
    expect(canRepairFromDeck({ state: "open", draft: false })).toBe(true);
    expect(canRepairFromDeck({ state: "open", draft: true })).toBe(false);
    expect(canRepairFromDeck({ state: "closed", draft: false })).toBe(false);
  });
});

describe("repairKindsFor", () => {
  const open = { state: "open", draft: false } as const;

  it("CI失敗のみならCIの1種類", () => {
    expect(repairKindsFor({ ...open, ciState: "failure" }, true)).toEqual(["ci"]);
  });

  it("コンフリクトのみならコンフリクトの1種類", () => {
    expect(repairKindsFor({ ...open, ciState: "success" }, false)).toEqual(["conflict"]);
  });

  it("両方あるときはコンフリクトを先に出す", () => {
    // developを取り込まないままCIを直しても再度CIが走るため、先に解消させたい。
    expect(repairKindsFor({ ...open, ciState: "failure" }, false)).toEqual(["conflict", "ci"]);
  });

  it("mergeableが判定中（null）の間はコンフリクトのボタンを出さない", () => {
    expect(repairKindsFor({ ...open, ciState: "success" }, null)).toEqual([]);
    expect(repairKindsFor({ ...open, ciState: "success" }, undefined)).toEqual([]);
  });

  it("CIが実行中・不明・成功のときはCIのボタンを出さない", () => {
    expect(repairKindsFor({ ...open, ciState: "pending" }, true)).toEqual([]);
    expect(repairKindsFor({ ...open, ciState: "unknown" }, true)).toEqual([]);
    expect(repairKindsFor({ ...open, ciState: null }, true)).toEqual([]);
  });

  describe("レビュー指摘（#3363）", () => {
    const issuePr = { ...open, ciState: "success", baseRef: "develop", headRef: "issue-3" } as const;
    const verdict = (reviewKind: string) => ({ reviewKind });

    it("自動レビューが要修正ならレビュー指摘の修正を出す", () => {
      expect(repairKindsFor({ ...issuePr, reviewVerdict: verdict("changes-requested") }, true)).toEqual([
        "review",
      ]);
    });

    it("要確認・LGTM・判定なしでは出さない", () => {
      expect(repairKindsFor({ ...issuePr, reviewVerdict: verdict("needs-check") }, true)).toEqual([]);
      expect(repairKindsFor({ ...issuePr, reviewVerdict: verdict("lgtm") }, true)).toEqual([]);
      expect(repairKindsFor({ ...issuePr, reviewVerdict: null }, true)).toEqual([]);
    });

    it("Issueに紐づかないPR・ブランチ名を渡さない呼び出し元では出さない", () => {
      expect(
        repairKindsFor(
          { ...open, ciState: "success", baseRef: "main", headRef: "develop", reviewVerdict: verdict("changes-requested") },
          true,
        ),
      ).toEqual([]);
      expect(
        repairKindsFor({ ...open, ciState: "success", reviewVerdict: verdict("changes-requested") }, true),
      ).toEqual([]);
    });
  });

  it("draft・closedのPRでは何も出さない", () => {
    expect(repairKindsFor({ state: "open", draft: true, ciState: "failure" }, false)).toEqual([]);
    expect(repairKindsFor({ state: "closed", draft: false, ciState: "failure" }, false)).toEqual([]);
  });
});

describe("isRepairWorkflowMissing", () => {
  it("配布されていないと分かっている種類だけ押せなくする", () => {
    expect(isRepairWorkflowMissing({ ci: "missing" }, "ci")).toBe(true);
    expect(isRepairWorkflowMissing({ ci: "unsupported" }, "ci")).toBe(true);
    expect(isRepairWorkflowMissing({ ci: "available" }, "ci")).toBe(false);
  });

  it("判定していない種類・そもそも判定していない経路は押せる扱いにする", () => {
    // 存在確認に失敗した種類はキーごと落ちる。無効化の誤爆でユーザーの手を止めない（#1960）。
    expect(isRepairWorkflowMissing({ conflict: "missing" }, "ci")).toBe(false);
    expect(isRepairWorkflowMissing({}, "ci")).toBe(false);
    expect(isRepairWorkflowMissing(undefined, "ci")).toBe(false);
  });
});

describe("repairUnavailableNotices", () => {
  it("押せない種類が無ければ何も添えない", () => {
    expect(repairUnavailableNotices(["ci"], { ci: "available" })).toEqual([]);
    expect(repairUnavailableNotices(["ci", "conflict"], {})).toEqual([]);
    expect(repairUnavailableNotices([], { ci: "missing" })).toEqual([]);
  });

  it("出している種類が全部未配布ならまとめて言い、配り先を添える", () => {
    expect(
      repairUnavailableNotices(["conflict", "ci"], { conflict: "missing", ci: "missing" }),
    ).toEqual([
      "自動修復ワークフローが未配布です。設定 › フリート運用 から、このリポジトリへ配布できます。",
    ]);
  });

  it("片方だけ未配布ならどちらが無いのかを名指しする", () => {
    // `claude-ci-fix.yml`だけ配られている、といった状態が実際にありうる（#1948）。
    expect(
      repairUnavailableNotices(["conflict", "ci"], { conflict: "missing", ci: "available" }),
    ).toEqual([
      "コンフリクト解消のワークフローが未配布です。設定 › フリート運用 から、このリポジトリへ配布できます。",
    ]);
  });

  it("配布の対象ですらないリポジトリでは設定画面へ送らない", () => {
    // 前提ワークフローが無いリポジトリは配布の一覧に出ない（#1948）。そこへ「配布できます」と
    // 案内すると行き止まりになる。
    expect(
      repairUnavailableNotices(["conflict", "ci"], {
        conflict: "unsupported",
        ci: "unsupported",
      }),
    ).toEqual([
      "自動修復ワークフローが未配布です。このリポジトリは配布の対象外のため、必要なら手動で追加してください。",
    ]);
  });

  it("理由が違う種類が混ざったら行を分ける", () => {
    expect(
      repairUnavailableNotices(["conflict", "ci"], { conflict: "missing", ci: "unsupported" }),
    ).toEqual([
      "コンフリクト解消のワークフローが未配布です。設定 › フリート運用 から、このリポジトリへ配布できます。",
      "CI失敗修正のワークフローが未配布です。このリポジトリは配布の対象外のため、必要なら手動で追加してください。",
    ]);
  });
});
