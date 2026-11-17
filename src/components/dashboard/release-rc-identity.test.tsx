// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReleaseRcRevisionHistory } from "@/components/dashboard/release-rc-identity";
import type { RcCandidateView, RcRevisionView } from "@/lib/release-rc-run";

function revision(overrides: Partial<RcRevisionView>): RcRevisionView {
  return {
    revision: 1,
    reason: "initial",
    reasonLabel: "作成",
    status: "applied",
    importedPrs: [],
    prNumber: 1028,
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    runUrl: null,
    failureReason: null,
    fixSeriesId: null,
    createdAt: "2026-11-17T05:00:00.000Z",
    appliedAt: null,
    ...overrides,
  };
}

function candidate(revisions: RcRevisionView[], currentRevision: number): RcCandidateView {
  return {
    label: "RC-50",
    currentRevision,
    frozenDevelopSha: "f".repeat(40),
    frozenPrs: [],
    migratedFromPrNumber: null,
    status: { status: "verifying", label: "検証中", reason: "", attention: null },
    revisions,
  } as unknown as RcCandidateView;
}

const REASON = "#1031 は元の候補 RC-50 に内容も履歴も既に含まれています。選択から外してください";

describe("ReleaseRcRevisionHistory（#5473）", () => {
  afterEach(cleanup);

  it("現在の候補に影響しない失敗は、赤でなく理由と「影響しません」を添えて控えめに出す", () => {
    render(
      <ReleaseRcRevisionHistory
        candidate={candidate(
          [
            revision({ revision: 1 }),
            revision({ revision: 2, reason: "fix_import", reasonLabel: "修正PRの取り込み" }),
            revision({ revision: 3, reason: "fix_import", reasonLabel: "修正PRの取り込み", status: "failed", headSha: null, failureReason: REASON }),
          ],
          2,
        )}
      />,
    );
    const r3 = screen.getByText("r3").closest("li") as HTMLElement;
    expect(within(r3).getByText("未適用")).toBeTruthy();
    expect(within(r3).queryByText("失敗（未適用）")).toBeNull();
    const reason = within(r3).getByText(`理由: ${REASON}`);
    expect(reason.className).not.toContain("text-destructive");
    expect(within(r3).getByTestId("rc-revision-no-impact").textContent).toBe("現在の候補（r2）には影響しません");
  });

  it("適用済みのrevisionが無い候補の失敗は、従来どおり失敗として出す", () => {
    render(
      <ReleaseRcRevisionHistory
        candidate={candidate([revision({ revision: 1, status: "failed", headSha: null, failureReason: "作成に失敗しました" })], 0)}
      />,
    );
    expect(screen.getByText("失敗（未適用）")).toBeTruthy();
    expect(screen.getByText("作成に失敗しました").className).toContain("text-destructive");
    expect(screen.queryByTestId("rc-revision-no-impact")).toBeNull();
  });
});
