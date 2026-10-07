import { describe, expect, it } from "vitest";

import {
  type CiGateCandidate,
  backupRunCandidate,
  chooseCiGateCandidate,
  evaluateActionsRun,
  selectCiWorkflowRun,
} from "@/lib/backup-ci/gate";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const current = { headSha: HEAD, baseSha: BASE };

function candidate(source: "actions" | "backup", ref: string | null, startedAt: Date | null, state: CiGateCandidate["decision"]["state"]): CiGateCandidate {
  return { source, sourceRef: ref, startedAt, decision: { state, description: "" }, targetUrl: null };
}

describe("selectCiWorkflowRun", () => {
  const base = { path: ".github/workflows/ci.yml", event: "pull_request", headSha: HEAD, headBranch: "issue-1" };
  it("同じheadを持つ別のPR（main向けなど）の実行を拾わない", () => {
    const runs = [
      { ...base, id: 1, pullRequestNumbers: [1] },
      { ...base, id: 2, pullRequestNumbers: [99] },
    ];
    expect(selectCiWorkflowRun(runs, { number: 1, headSha: HEAD, headRef: "issue-1" })?.id).toBe(1);
  });
  it("push起動の実行・別のワークフローは数えない", () => {
    const runs = [
      { ...base, id: 1, event: "push", pullRequestNumbers: [] },
      { ...base, id: 2, path: ".github/workflows/other.yml", pullRequestNumbers: [1] },
    ];
    expect(selectCiWorkflowRun(runs, { number: 1, headSha: HEAD, headRef: "issue-1" })).toBeNull();
  });
});

describe("evaluateActionsRun", () => {
  it("実行が無ければpending（未開始）", () => {
    expect(evaluateActionsRun(null, ["lint-and-build"]).decision.state).toBe("pending");
  });
  it("実行中に必須ジョブがまだ作られていなければpending、終わっても無ければerror", () => {
    const run = { id: 1, runAttempt: 1, status: "in_progress", startedAt: null, htmlUrl: null, jobs: [] };
    expect(evaluateActionsRun(run, ["lint-and-build"]).decision.state).toBe("pending");
    expect(evaluateActionsRun({ ...run, status: "completed" }, ["lint-and-build"]).decision.state).toBe("error");
  });
  it("キャンセルは成功にしない", () => {
    const run = {
      id: 1,
      runAttempt: 1,
      status: "completed",
      startedAt: null,
      htmlUrl: null,
      jobs: [{ name: "lint-and-build", status: "completed", conclusion: "cancelled" }],
    };
    expect(evaluateActionsRun(run, ["lint-and-build"]).decision.state).toBe("error");
  });
});

describe("backupRunCandidate", () => {
  const run = {
    id: "r1",
    status: "passed",
    headSha: HEAD,
    baseSha: BASE,
    statusReason: null,
    logUrl: null,
    requestedAt: new Date(),
  };
  it("Actionsを写すときは、今のbaseを検査していない合格を候補にしない", () => {
    expect(backupRunCandidate(run, { headSha: HEAD, baseSha: "e".repeat(40) }, { actionsMirrored: true })).toBeNull();
    expect(backupRunCandidate(run, current, { actionsMirrored: true })?.decision.state).toBe("success");
  });
  it("写さないリポジトリでは従来どおり、更新されたらpendingを出す", () => {
    expect(
      backupRunCandidate(run, { headSha: HEAD, baseSha: "e".repeat(40) }, { actionsMirrored: false })?.decision.state,
    ).toBe("pending");
  });
  it("起動を拒否された試行は、Actionsを写すときは候補にしない", () => {
    expect(backupRunCandidate({ ...run, status: "trigger_failed" }, current, { actionsMirrored: true })).toBeNull();
  });
});

describe("chooseCiGateCandidate", () => {
  const t = (minutes: number) => new Date(Date.UTC(2026, 9, 7, 12, minutes));

  it("最後に始まった試行を採用する（開始していないものは最も古い）", () => {
    const choice = chooseCiGateCandidate(
      [candidate("actions", null, null, "pending"), candidate("backup", "r1", t(0), "success")],
      null,
      current,
    );
    expect(choice?.candidate.source).toBe("backup");
  });

  it("同じ試行が完了から検査中へ戻る読み取りでは、前回の採用を保つ", () => {
    const previous = { headSha: HEAD, baseSha: BASE, source: "actions", sourceRef: "10:1", sourceStartedAt: t(0), state: "success" };
    const choice = chooseCiGateCandidate([candidate("actions", "10:1", t(0), "pending")], previous, current);
    expect(choice?.keptPrevious).toBe(true);
  });

  it("同じ経路で前回より古い試行が見えても、前回の採用を保つ", () => {
    const previous = { headSha: HEAD, baseSha: BASE, source: "actions", sourceRef: "10:2", sourceStartedAt: t(10), state: "failure" };
    const choice = chooseCiGateCandidate([candidate("actions", "10:1", t(0), "success")], previous, current);
    expect(choice?.keptPrevious).toBe(true);
  });

  it("baseが変わったら前回の採用には縛られない", () => {
    const previous = { headSha: HEAD, baseSha: "e".repeat(40), source: "backup", sourceRef: "r1", sourceStartedAt: t(0), state: "success" };
    const choice = chooseCiGateCandidate([candidate("backup", "r1", t(0), "pending")], previous, current);
    expect(choice?.keptPrevious).toBe(false);
  });
});
