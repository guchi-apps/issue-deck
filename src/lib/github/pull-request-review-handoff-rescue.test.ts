import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/dispatch/review-fix-jobs", () => ({
  fetchAllComments: vi.fn(),
  selectReviewFixComments: vi.fn(),
  trustedComment: (c: { author_association?: string }) => c.author_association === "OWNER",
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/github/pull-request-auto-repair-start", () => ({ startPullRequestAutoRepairLoop: vi.fn() }));
vi.mock("@/lib/github/repair-workflow-cache", () => ({ fetchRepairWorkflowAvailability: vi.fn() }));

import {
  HANDOFF_RESCUE_GRACE_MS,
  decideHandoffRescue,
  findHandoffAt,
  type HandoffRescueInput,
} from "@/lib/github/pull-request-review-handoff-rescue";

const now = new Date("2026-10-10T12:00:00Z");
const base: HandoffRescueInput = {
  now,
  pullRequest: { state: "open", draft: false, baseRef: "develop", headRef: "issue-1", headSha: "abc" },
  verdict: { reviewKind: "changes-requested", reviewedSha: "abc" },
  autofixOk: true,
  handoffAt: new Date(now.getTime() - HANDOFF_RESCUE_GRACE_MS - 1000),
  loop: null,
  fixJobExists: false,
  repairStartedAfterHandoff: false,
  workflow: "available",
};

describe("decideHandoffRescue", () => {
  it("猶予を過ぎても修正が始まっていなければ起動する", () => {
    expect(decideHandoffRescue(base)).toEqual({ action: "start" });
    expect(decideHandoffRescue({ ...base, workflow: undefined })).toEqual({ action: "start" });
  });

  it("猶予内・handoff無し・古い判定は見送る", () => {
    expect(decideHandoffRescue({ ...base, handoffAt: new Date(now.getTime() - 1000) })).toMatchObject({ action: "skip", reason: "within_grace" });
    expect(decideHandoffRescue({ ...base, handoffAt: null })).toMatchObject({ reason: "no_handoff" });
    expect(decideHandoffRescue({ ...base, autofixOk: false })).toMatchObject({ reason: "no_handoff" });
    expect(decideHandoffRescue({ ...base, verdict: { reviewKind: "changes-requested", reviewedSha: "old" } })).toMatchObject({ reason: "no_current_changes_requested" });
    expect(decideHandoffRescue({ ...base, verdict: { reviewKind: "ok", reviewedSha: "abc" } })).toMatchObject({ action: "skip" });
  });

  it("二重起動しない: 系列の実行中・同HEADで停止済み・修正ジョブ・修復記録", () => {
    expect(decideHandoffRescue({ ...base, loop: { status: "running", headSha: "x" } })).toMatchObject({ reason: "loop_active" });
    expect(decideHandoffRescue({ ...base, loop: { status: "dispatching", headSha: "x" } })).toMatchObject({ reason: "loop_active" });
    expect(decideHandoffRescue({ ...base, loop: { status: "stopped", headSha: "abc" } })).toMatchObject({ reason: "loop_settled" });
    expect(decideHandoffRescue({ ...base, fixJobExists: true })).toMatchObject({ reason: "fix_started" });
    expect(decideHandoffRescue({ ...base, repairStartedAfterHandoff: true })).toMatchObject({ reason: "fix_started" });
  });

  it("古いHEADで止まった系列は新しいHEADで拾い直せる", () => {
    expect(decideHandoffRescue({ ...base, loop: { status: "stopped", headSha: "old" } })).toEqual({ action: "start" });
  });

  it("未配布・配布対象外は原因を残して止める", () => {
    expect(decideHandoffRescue({ ...base, workflow: "missing" })).toEqual({ action: "stop", reason: "handoff_workflow_missing" });
    expect(decideHandoffRescue({ ...base, workflow: "unsupported" })).toEqual({ action: "stop", reason: "handoff_unsupported" });
  });

  it("対象外のPR（draft・base違い・ブランチ名違い）は見送る", () => {
    expect(decideHandoffRescue({ ...base, pullRequest: { ...base.pullRequest, draft: true } })).toMatchObject({ action: "skip" });
    expect(decideHandoffRescue({ ...base, pullRequest: { ...base.pullRequest, baseRef: "main" } })).toMatchObject({ reason: "unsupported_pull_request" });
    expect(decideHandoffRescue({ ...base, pullRequest: { ...base.pullRequest, headRef: "feature" } })).toMatchObject({ reason: "unsupported_pull_request" });
  });
});

describe("findHandoffAt", () => {
  it("現在のHEADの信頼できるhandoffコメントの最新時刻を返す", () => {
    const c = (body: string, at: string, assoc = "OWNER") => ({ body, created_at: at, author_association: assoc });
    const marker = "<!-- issue-deck-review-fix:handoff sha=abc -->";
    expect(findHandoffAt([c(marker, "2026-10-10T10:00:00Z"), c(marker, "2026-10-10T11:00:00Z"), c(marker, "2026-10-10T11:30:00Z", "NONE")], "abc")?.toISOString()).toBe("2026-10-10T11:00:00.000Z");
    expect(findHandoffAt([c("<!-- issue-deck-review-fix:handoff sha=old -->", "2026-10-10T10:00:00Z")], "abc")).toBeNull();
  });
});
