// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildFinalizeSteps, ReleaseRcFinalizePanel } from "@/components/dashboard/release-rc-finalize";
import type { RcFinalizationOverview, RcFinalizationView } from "@/lib/release-finalize-run";
import type { PublishApprovalView } from "@/lib/release-publish-approval-run";
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

function approval(over: Partial<PublishApprovalView> = {}): PublishApprovalView {
  return {
    id: "pa1",
    status: "active",
    statusLabel: "公開承認済み",
    approvedByUserId: "u1",
    approvedAt: "2026-10-12T00:00:00Z",
    expiresAt: "2026-10-13T00:00:00Z",
    revision: 3,
    prNumber: 12,
    baseSha: BASE,
    headSha: PRE,
    bumpPolicy: "auto",
    allowedChanges: ["version", "changelog"],
    contents: [],
    invalidReason: null,
    invalidMessage: null,
    invalidDiff: [],
    revokedAt: null,
    mergeSha: null,
    run: { id: "run1", status: "checking", statusLabel: "最終検証中", active: true, note: null, stopReason: null, stopMessage: null },
    progress: "final_checks",
    progressLabel: "最終検証中",
    ...over,
  };
}

afterEach(cleanup);

describe("buildFinalizeSteps", () => {
  it("バンプ後の最終CIが未実施・失敗の間は、公開へ進める状態にしない", () => {
    const pending = buildFinalizeSteps({
      phase: "preparing",
      current: view(),
      checks: { ciState: "pending", draft: false, pendingReverify: [], reverify: [], reverifyPhase: "done", readiness: { ready: false, reason: "ci_pending" }, readinessLabel: "バンプ後の最終CI・ビルドを実行中です" },
    });
    expect(pending[2]).toMatchObject({ tone: "run", badge: "実行中" });
    // 承認の記録が無い既存の候補は、推定で承認済みにしない
    expect(pending[4].badge).toBe("承認が必要");
    const failed = buildFinalizeSteps({
      phase: "preparing",
      current: view(),
      checks: { ciState: "failure", draft: false, pendingReverify: [], reverify: [], reverifyPhase: "done", readiness: { ready: false, reason: "ci_failed" }, readinessLabel: "バンプ後の最終CI・ビルドが失敗しています" },
    });
    expect(failed[2]).toMatchObject({ tone: "bad", badge: "失敗" });
  });

  it("公開承認済みの候補は、最終検証の後に二度目の承認を求めない", () => {
    const steps = buildFinalizeSteps({ phase: "awaiting_approval", current: view(), checks: null, approval: approval() });
    expect(steps[4]).toMatchObject({ label: "公開承認", badge: "承認済み", tone: "ok" });
    expect(steps.map((s) => s.badge)).not.toContain("承認待ち");
    expect(steps[5].detail).toContain("自動でマージ");
  });

  it("失効した承認は理由を出す", () => {
    const steps = buildFinalizeSteps({
      phase: "awaiting_approval",
      current: view(),
      checks: null,
      approval: approval({ status: "invalidated", invalidMessage: "承認した後にmainが進みました（bbbbbbb → ddddddd）" }),
    });
    expect(steps[4]).toMatchObject({ badge: "失効", tone: "bad" });
    expect(steps[4].detail).toContain("mainが進みました");
  });

  it("承認待ち・本番反映・完了の段階を分けて出す", () => {
    expect(buildFinalizeSteps({ phase: "awaiting_approval", current: view(), checks: null })[4].badge).toBe("承認が必要");
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
    fireEvent.click(screen.getByText("本番公開へ進む（公開承認）"));
    // 承認する前に、自動で本番公開することと承認の範囲を全部見せる
    const confirm = screen.getByTestId("release-rc-approval-confirm").textContent ?? "";
    expect(confirm).toContain("合格したら自動で本番公開します");
    expect(confirm).toContain("o/r");
    expect(confirm).toContain("RC-12 · revision 3");
    expect(confirm).toContain("最終公開差分から自動判定");
    expect(confirm).toContain("版ファイル・更新履歴だけ");
    fireEvent.click(screen.getByText("公開を承認して進める"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ action: "start", candidateId: "c1", expectedHeadSha: PRE, bumpKind: "auto", approvePublish: true });
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
    expect(screen.getAllByText("引継ぎ").length).toBe(2);
    expect(screen.getAllByText("再検証").length).toBe(2);
    expect(screen.getAllByText(/バンプ前 aaaaaaa/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/バンプ後 ccccccc/).length).toBeGreaterThan(0);
    expect(screen.queryByText("本番公開へ進む（公開承認）")).toBeNull();
  });

  it("承認の記録が無い公開準備済みの候補には、1回だけの承認を出す", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(
      <ReleaseRcFinalizePanel
        candidate={candidate({ phase: "awaiting_approval", finalizeContract: null })}
        finalization={overview({ current: view() })}
        repositoryFullName="o/r"
        onChanged={onChanged}
      />,
    );
    expect(screen.getByTestId("release-rc-legacy-approval").textContent).toContain("公開承認の記録がありません");
    fireEvent.click(screen.getByText("公開の承認内容を確認する"));
    fireEvent.click(screen.getByText("公開を承認する"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({ action: "approve", expectedHeadSha: POST });
    vi.unstubAllGlobals();
  });

  it("承認済みの候補は承認の内容・取消を出し、承認を求め直さない", () => {
    render(
      <ReleaseRcFinalizePanel
        candidate={candidate({ phase: "preparing", finalizeContract: null })}
        finalization={overview({ current: view(), approval: approval() })}
        repositoryFullName="o/r"
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByTestId("release-rc-approval").textContent).toContain("最終検証中");
    expect(screen.getByText("自動公開を取り消す")).toBeTruthy();
    expect(screen.queryByTestId("release-rc-legacy-approval")).toBeNull();
    expect(screen.queryByText("自動公開を再開")).toBeNull();
  });

  it("自動公開が止まったら理由と再開を出す", () => {
    render(
      <ReleaseRcFinalizePanel
        candidate={candidate({ phase: "awaiting_approval", finalizeContract: null })}
        finalization={overview({
          current: view(),
          approval: approval({
            progress: "stopped",
            progressLabel: "自動公開が停止",
            run: { id: "run1", status: "needs_attention", statusLabel: "操作が必要", active: false, note: null, stopReason: "ci_failed", stopMessage: "リリース候補の現在のHEADでCIが失敗しました。本番へはマージしません。" },
          }),
        })}
        repositoryFullName="o/r"
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByTestId("release-rc-approval-stop").textContent).toContain("CIが失敗しました");
    expect(screen.getByText("自動公開を再開")).toBeTruthy();
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
