import { describe, expect, it } from "vitest";

import {
  buildIosDistributionFailureIssueBody,
  buildIosDistributionFixIssueDraft,
  buildIosDistributionFailureIssueTitle,
  decideIosDistributionFailure,
  parseIosDistributionFailureMeta,
  type IosDistributionFailureMeta,
} from "@/lib/ios-distribution-failure";
import { parseDeployFailureMeta } from "@/lib/deploy-failure";

const now = new Date("2026-10-02T12:00:00Z");
const run = (over: Partial<Parameters<typeof decideIosDistributionFailure>[0]["run"] & object> = {}) => ({
  id: 10,
  status: "completed",
  conclusion: "failure",
  htmlUrl: "https://github.com/o/r/actions/runs/10",
  updatedAt: "2026-10-02T11:00:00Z",
  runAttempt: 1,
  ...over,
});

const meta: IosDistributionFailureMeta = {
  repositoryFullName: "guchi-apps/kurashio",
  runId: 10,
  runUrl: "https://github.com/o/r/actions/runs/10",
  failedStage: "署名",
  failedJobs: ["sign"],
  detectedAt: "2026-10-02T12:00:00.000Z",
};

describe("decideIosDistributionFailure", () => {
  it("猶予を過ぎた失敗は起票する", () => {
    expect(decideIosDistributionFailure({ run: run(), tracked: null, now })).toEqual({ kind: "create" });
  });
  it("猶予内は見送る", () => {
    const r = run({ updatedAt: "2026-10-02T11:59:00Z" });
    expect(decideIosDistributionFailure({ run: r, tracked: null, now })).toEqual({
      kind: "skip",
      reason: "within_grace",
    });
  });
  it("別のrunが落ちたら既存Issueへ書き足す", () => {
    expect(
      decideIosDistributionFailure({ run: run(), tracked: { issueNumber: 5, runId: 9 }, now }),
    ).toEqual({ kind: "update", issueNumber: 5 });
  });
  it("成功したら閉じる", () => {
    expect(
      decideIosDistributionFailure({
        run: run({ conclusion: "success" }),
        tracked: { issueNumber: 5, runId: 9 },
        now,
      }),
    ).toEqual({ kind: "close", issueNumber: 5 });
  });
});

describe("iOS配布失敗Issueの本文", () => {
  it("マーカーが往復する", () => {
    expect(parseIosDistributionFailureMeta(buildIosDistributionFailureIssueBody(meta))).toEqual(meta);
  });
  it("Webのデプロイ失敗のマーカーとは取り違えない", () => {
    const body = buildIosDistributionFailureIssueBody(meta);
    expect(parseDeployFailureMeta(body)).toBeNull();
  });
  it("壊れたマーカーはnull", () => {
    expect(parseIosDistributionFailureMeta("<!-- ios-distribution-failure: {oops -->")).toBeNull();
  });
  it("タイトルに段階が入り、不明なら省く", () => {
    expect(buildIosDistributionFailureIssueTitle(meta)).toContain("（署名）");
    expect(buildIosDistributionFailureIssueTitle({ ...meta, failedStage: null })).not.toContain("（");
  });
});

describe("buildIosDistributionFixIssueDraft", () => {
  const base = {
    repositoryFullName: "o/r",
    version: "1.8.0",
    sha: "abcdef1234567",
    runUrl: "https://github.com/o/r/actions/runs/10",
    failedStage: "署名",
    notes: ["更新が必要と判定"],
  };

  it("版・コミット・実行URL・段階・注記を入れる", () => {
    const draft = buildIosDistributionFixIssueDraft(base);
    expect(draft.repositoryFullName).toBe("o/r");
    expect(draft.title).toBe("[iOS配布失敗] o/r: v1.8.0のTestFlight配布の失敗を修正する（署名）");
    expect(draft.body).toContain("abcdef1");
    expect(draft.body).toContain(base.runUrl);
    expect(draft.body).toContain("失敗した段階: 署名");
    expect(draft.body).toContain("実行の注記: 更新が必要と判定");
  });

  it("自動起票のマーカーを入れない（取り違え防止）", () => {
    const draft = buildIosDistributionFixIssueDraft(base);
    expect(parseIosDistributionFailureMeta(draft.body)).toBeNull();
  });

  it("版・段階・注記が無くても組み立てられる", () => {
    const draft = buildIosDistributionFixIssueDraft({ ...base, version: null, failedStage: null, notes: [] });
    expect(draft.title).toBe("[iOS配布失敗] o/r: TestFlight配布の失敗を修正する");
    expect(draft.body).not.toContain("失敗した段階");
  });
});
