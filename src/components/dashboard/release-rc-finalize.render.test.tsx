// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildFinalizeSteps, ReleaseRcFinalizePanel } from "@/components/dashboard/release-rc-finalize";
import type { RcFinalizationOverview, RcFinalizationView } from "@/lib/release-finalize-run";
import type { RcCandidateView } from "@/lib/release-rc-run";

const PRE = "a".repeat(40);
const POST = "c".repeat(40);
const BASE = "b".repeat(40);

function candidate(over: Partial<RcCandidateView> = {}): RcCandidateView {
  return {
    id: "c1",
    sequence: 12,
    label: "RC-12",
    branch: "release-rc/12",
    phase: "review",
    status: { status: "ready_to_prepare", label: "公開準備可能", reason: "", attention: null },
    frozenDevelopSha: PRE,
    frozenPrs: [],
    approvedExtraPrs: [],
    currentRevision: 3,
    prNumber: 12,
    revisions: [],
    migratedFromPrNumber: null,
    cancelReason: null,
    cancelledAt: null,
    createdAt: "2026-10-12T00:00:00Z",
    finalizeContract: { candidateId: "c1", sequence: 12, revision: 3, prNumber: 12, baseSha: BASE, headSha: PRE, frozenDevelopSha: PRE, includedPrs: [] },
    ...over,
  };
}

function view(over: Partial<RcFinalizationView> = {}): RcFinalizationView {
  return {
    id: "f1",
    status: "applied",
    statusLabel: "バンプ済み",
    revision: 3,
    prNumber: 12,
    preBaseSha: BASE,
    preHeadSha: PRE,
    finalBaseSha: BASE,
    finalHeadSha: POST,
    version: "2.14.0",
    versionReservation: "reserved",
    bumpKind: "minor",
    bumpKindSource: "auto",
    evidence: [
      { kind: "ai_review", action: "inherit", reason: "バンプで変わったのは版と更新履歴だけのため、バンプ前の合格を引き継ぎます", fromBaseSha: BASE, fromHeadSha: PRE, toBaseSha: BASE, toHeadSha: POST, files: ["package.json"], decidedAt: "" },
      { kind: "integration", action: "rerun", reason: "このリポジトリはiOS（Mac）検証が必要なため、バンプ後のheadで最終検証を再実行します", fromBaseSha: BASE, fromHeadSha: PRE, toBaseSha: BASE, toHeadSha: POST, files: ["package.json"], decidedAt: "" },
    ],
    files: [{ path: "package.json", category: "version" }],
    runUrl: null,
    failureReason: null,
    createdAt: "2026-10-12T00:00:00Z",
    appliedAt: "2026-10-12T00:01:00Z",
    ...over,
  };
}

function overview(over: Partial<RcFinalizationOverview> = {}): RcFinalizationOverview {
  return {
    caller: { supported: true, versionFile: "package.json", versionQuery: ".version", bumpCommand: false, reasonLabel: null },
    mainVersion: "2.13.4",
    current: null,
    checks: null,
    history: [],
    ...over,
  };
}

afterEach(cleanup);

describe("buildFinalizeSteps", () => {
  it("バンプ後の最終CIが未実施・失敗の間は、公開へ進める状態にしない", () => {
    const pending = buildFinalizeSteps({
      phase: "preparing",
      current: view(),
      checks: { ciState: "pending", draft: false, pendingReverify: [], readiness: { ready: false, reason: "ci_pending" }, readinessLabel: "バンプ後の最終CI・ビルドを実行中です" },
    });
    expect(pending[2]).toMatchObject({ tone: "run", badge: "実行中" });
    expect(pending[4].badge).toBe("待機");
    const failed = buildFinalizeSteps({
      phase: "preparing",
      current: view(),
      checks: { ciState: "failure", draft: false, pendingReverify: [], readiness: { ready: false, reason: "ci_failed" }, readinessLabel: "バンプ後の最終CI・ビルドが失敗しています" },
    });
    expect(failed[2]).toMatchObject({ tone: "bad", badge: "失敗" });
  });

  it("承認待ち・本番反映・完了の段階を分けて出す", () => {
    expect(buildFinalizeSteps({ phase: "awaiting_approval", current: view(), checks: null })[4].badge).toBe("承認待ち");
    expect(buildFinalizeSteps({ phase: "verifying_production", current: view(), checks: null })[5].badge).toBe("稼働確認中");
    expect(buildFinalizeSteps({ phase: "completed", current: view(), checks: null })[5].badge).toBe("完了");
  });
});

describe("ReleaseRcFinalizePanel", () => {
  it("合格した候補では、予定の版を確定済みとして出さずに公開準備を始められる", () => {
    render(<ReleaseRcFinalizePanel candidate={candidate()} finalization={overview()} repositoryFullName="o/r" onChanged={vi.fn()} />);
    expect(screen.getByText("未確定")).toBeTruthy();
    expect(screen.getByText("自動判定")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/上げ幅/), { target: { value: "minor" } });
    expect(screen.getByText("v2.14.0")).toBeTruthy();
    expect(screen.getByText("確定した正式版")).toBeTruthy();
    expect(screen.getByText("未確定")).toBeTruthy();
  });

  it("押した時点の候補のheadと要求キーを送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<ReleaseRcFinalizePanel candidate={candidate()} finalization={overview()} repositoryFullName="o/r" onChanged={onChanged} />);
    fireEvent.click(screen.getByText("公開準備へ進む"));
    fireEvent.click(screen.getByText("公開準備を始める"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ action: "start", candidateId: "c1", expectedHeadSha: PRE, bumpKind: "auto" });
    expect(body.requestKey).toMatch(/^[A-Za-z0-9]{8,48}$/);
    vi.unstubAllGlobals();
  });

  it("バンプ後は確定した版・引継ぎと再検証の別・元のheadを出す", () => {
    render(
      <ReleaseRcFinalizePanel
        candidate={candidate({ phase: "preparing", finalizeContract: null })}
        finalization={overview({ current: view() })}
        repositoryFullName="o/r"
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText("v2.14.0", { selector: "p" })).toBeTruthy();
    expect(screen.getByText("予約済み")).toBeTruthy();
    expect(screen.getByText("引継ぎ")).toBeTruthy();
    expect(screen.getByText("再検証")).toBeTruthy();
    expect(screen.getByText(/バンプ前 aaaaaaa/)).toBeTruthy();
    expect(screen.getByText(/バンプ後 ccccccc/)).toBeTruthy();
    expect(screen.queryByText("公開準備へ進む")).toBeNull();
  });

  it("公開前の失敗は修正工程へ戻し、版は増やさないと伝える", () => {
    render(
      <ReleaseRcFinalizePanel
        candidate={candidate({ finalizeContract: null })}
        finalization={overview({ current: view({ status: "failed", statusLabel: "失敗", failureReason: "バンプ後の最終検証が失敗したため" }) })}
        repositoryFullName="o/r"
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("版は増やしません");
  });

  it("関係の無い段階・記録の無い候補ではパネルを出さない", () => {
    const { container } = render(
      <ReleaseRcFinalizePanel candidate={candidate({ finalizeContract: null })} finalization={overview()} repositoryFullName="o/r" onChanged={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
