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
    status: { status: "ready_to_prepare", label: "公開準備可能", reason: "", attention: null, aiReviewWaivable: false },
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
    finalizeContract: { candidateId: "c1", sequence: 12, revision: 3, prNumber: 12, baseSha: BASE, headSha: PRE, frozenDevelopSha: PRE, includedPrs: [], requiresAiReviewWaiver: false },
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
      checks: { ciState: "pending", draft: false, pendingReverify: [], reverify: [], reverifyPhase: "done", readiness: { ready: false, reason: "ci_pending" }, readinessLabel: "バンプ後の最終CI・ビルドを実行中です", aiReviewWaived: false },
    });
    expect(pending[2]).toMatchObject({ tone: "run", badge: "実行中" });
    // 承認の記録が無い既存の候補は、推定で承認済みにしない
    expect(pending[4].badge).toBe("承認が必要");
    const failed = buildFinalizeSteps({
      phase: "preparing",
      current: view(),
      checks: { ciState: "failure", draft: false, pendingReverify: [], reverify: [], reverifyPhase: "done", readiness: { ready: false, reason: "ci_failed" }, readinessLabel: "バンプ後の最終CI・ビルドが失敗しています", aiReviewWaived: false },
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
  it("全体レビューだけが合格していない候補は、結果を承知で進む明示が無いと公開準備を始めない（#4807）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    const base = candidate();
    const waivable = candidate({
      status: { status: "needs_fix", label: "修正が必要", reason: "検証で指摘・失敗が出ています", attention: null, aiReviewWaivable: true },
      finalizeContract: { ...base.finalizeContract!, requiresAiReviewWaiver: true },
    });
    render(<ReleaseRcFinalizePanel candidate={waivable} finalization={overview()} repositoryFullName="o/r" onChanged={onChanged} />);
    expect(screen.getByTestId("release-rc-ai-review-waiver-note").textContent).toContain("全体レビューは公開の必須条件ではない");
    fireEvent.click(screen.getByText("全体レビューの結果を承知で本番公開へ進む（公開承認）"));
    const submit = screen.getByText("公開を承認して進める").closest("button")!;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("release-rc-ai-review-waiver"));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ action: "start", approvePublish: true, waiveAiReview: true });
    vi.unstubAllGlobals();
  });

  it("合格した候補では、予定の版を確定済みとして出さずに公開準備を始められる", () => {
    render(<ReleaseRcFinalizePanel candidate={candidate()} finalization={overview()} repositoryFullName="o/r" onChanged={vi.fn()} />);
    expect(screen.getByText("未確定")).toBeTruthy();
    // 確定前の見込みカード（「検証中の予定」）は出さず、「次のバージョン」1枚にまとめる（#4937）
    expect(screen.queryByText("検証中の予定（見込み）")).toBeNull();
    expect(screen.getByText(/からの差分を見て自動判定します/)).toBeTruthy();
    // 上げ幅は既定の自動判定のまま、リンクを押したときだけ選べる（#4858）
    expect(screen.queryByTestId("release-rc-bump-kind")).toBeNull();
    fireEvent.click(screen.getByText("手動で上げ幅を設定する"));
    expect(screen.getByLabelText("自動判定")).toHaveProperty("checked", true);
    expect(screen.getByLabelText("メジャー")).toBeTruthy();
    expect(screen.getByLabelText("パッチ")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("マイナー"));
    expect(screen.getByText("手動指定のマイナーで v2.14.0 になる見込みです")).toBeTruthy();
    expect(screen.getByText("次のバージョン")).toBeTruthy();
    expect(screen.getByText("未確定")).toBeTruthy();
  });

  it("確定した版は「次のバージョン」に上げ幅と版の変化を文で出し、押すと判定理由をモーダルで出す（#4937）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reason: "新機能としてXXXを追加したためminorと判定しました。" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<ReleaseRcFinalizePanel candidate={candidate({ phase: "preparing" })} finalization={overview({ current: view() })} repositoryFullName="o/r" onChanged={vi.fn()} />);
    const card = screen.getByTestId("release-rc-next-version");
    expect(card.textContent).toContain("v2.14.0");
    expect(card.textContent).toContain("予約済み");
    expect(card.textContent).toContain("自動判定の結果、マイナー（v2.13.4 → v2.14.0）になりました");
    expect(card.textContent).not.toContain("公開前の再試行では増やしません");
    fireEvent.click(card);
    await waitFor(() => expect(screen.getByTestId("release-rc-bump-reason").textContent).toBe("新機能としてXXXを追加したためminorと判定しました。"));
    expect(screen.getByText("v2.14.0 になった理由")).toBeTruthy();
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/repositories/release/finalize?owner=o&repo=r&finalizationId=f1");
    vi.unstubAllGlobals();
  });

  it("判定理由のコメントが見つからなくても、上げ幅と基準はモーダルに出す（#4937）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reason: null }) }));
    render(<ReleaseRcFinalizePanel candidate={candidate({ phase: "preparing" })} finalization={overview({ current: view({ bumpKind: "patch", version: "2.13.1" }) })} repositoryFullName="o/r" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId("release-rc-next-version"));
    await waitFor(() => expect(screen.getByText("判定理由の記録が見つかりませんでした")).toBeTruthy());
    expect(screen.getByText(/バグ修正・リファクタリング/)).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("合格した候補では公開ボタンをオレンジで出し、説明は1文にとどめる（#4858）", () => {
    render(<ReleaseRcFinalizePanel candidate={candidate()} finalization={overview()} repositoryFullName="o/r" onChanged={vi.fn()} />);
    expect(screen.getByText("本番公開へ進む（公開承認）").closest("button")!.className).toContain("bg-orange-600");
    expect(screen.getByText("revision 3 が全体レビュー・統合検証に合格しています。")).toBeTruthy();
    expect(screen.queryByText(/版ファイルと更新履歴だけを変更するコミットを候補へ積み/)).toBeNull();
  });

  it("全体レビューを承知で進む候補の公開ボタンは、オレンジにしない（#4807）", () => {
    const base = candidate();
    const waivable = candidate({ finalizeContract: { ...base.finalizeContract!, requiresAiReviewWaiver: true } });
    render(<ReleaseRcFinalizePanel candidate={waivable} finalization={overview()} repositoryFullName="o/r" onChanged={vi.fn()} />);
    expect(screen.getByText("全体レビューの結果を承知で本番公開へ進む（公開承認）").closest("button")!.className).not.toContain("bg-orange-600");
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

  it("確認はモーダルで出し、承認後は反映を確かめるまで閉じず、閉じても「本番公開へ進む」を出さない（#4917）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    const { rerender } = render(<ReleaseRcFinalizePanel candidate={candidate()} finalization={overview()} repositoryFullName="o/r" onChanged={onChanged} />);
    fireEvent.click(screen.getByText("本番公開へ進む（公開承認）"));
    const dialog = screen.getByTestId("release-rc-approval-dialog");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.textContent).toContain("本番公開を承認しますか？");
    fireEvent.click(screen.getByText("公開を承認して進める"));
    await waitFor(() => expect(screen.getByTestId("release-rc-approval-dialog").textContent).toContain("公開承認を受け付けました"));
    expect(onChanged).toHaveBeenCalledTimes(1);

    // 取り直した状況がまだ`review`のままなら、モーダルは開いたまま
    rerender(<ReleaseRcFinalizePanel candidate={candidate()} finalization={overview()} repositoryFullName="o/r" onChanged={onChanged} />);
    expect(screen.getByTestId("release-rc-approval-dialog")).toBeTruthy();

    // 閉じても送信中の表示が残り、「本番公開へ進む」は出さない
    fireEvent.click(screen.getByText("閉じる"));
    await waitFor(() => expect(screen.queryByTestId("release-rc-approval-dialog")).toBeNull());
    expect(screen.queryByText("本番公開へ進む（公開承認）")).toBeNull();
    expect(screen.queryByText("手動で上げ幅を設定する")).toBeNull();
    expect(screen.getByTestId("release-rc-approval-pending-button").textContent).toContain("反映を確認しています");

    // 公開準備へ進んだ状況が届いたら、送信中の表示を片付ける
    rerender(
      <ReleaseRcFinalizePanel
        candidate={candidate({ phase: "preparing", finalizeContract: null })}
        finalization={overview({ approval: approval() })}
        repositoryFullName="o/r"
        onChanged={onChanged}
      />,
    );
    expect(screen.queryByTestId("release-rc-approval-pending-button")).toBeNull();
    expect(screen.getByTestId("release-rc-approval")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("反映を確かめたらモーダルを自動で閉じる（#4917）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
    const onChanged = vi.fn();
    const { rerender } = render(<ReleaseRcFinalizePanel candidate={candidate()} finalization={overview()} repositoryFullName="o/r" onChanged={onChanged} />);
    fireEvent.click(screen.getByText("本番公開へ進む（公開承認）"));
    fireEvent.click(screen.getByText("公開を承認して進める"));
    await waitFor(() => expect(screen.getByTestId("release-rc-approval-dialog").textContent).toContain("公開承認を受け付けました"));
    rerender(
      <ReleaseRcFinalizePanel
        candidate={candidate({ phase: "preparing", finalizeContract: null })}
        finalization={overview({ approval: approval() })}
        repositoryFullName="o/r"
        onChanged={onChanged}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId("release-rc-approval-dialog")).toBeNull());
    vi.unstubAllGlobals();
  });

  it("送信が拒否されたらモーダルを閉じずに理由を出し、やり直せる（#4917）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ ok: false, error: "run_active" }) }));
    const onChanged = vi.fn();
    render(<ReleaseRcFinalizePanel candidate={candidate()} finalization={overview()} repositoryFullName="o/r" onChanged={onChanged} />);
    fireEvent.click(screen.getByText("本番公開へ進む（公開承認）"));
    fireEvent.click(screen.getByText("公開を承認して進める"));
    await waitFor(() => expect(screen.getByTestId("release-rc-approval-dialog").textContent).toContain("別の完了系列が進行中です"));
    expect(screen.getByText("公開を承認して進める").closest("button")!.disabled).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
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
    expect(screen.getByTestId("release-rc-next-version").textContent).toContain("v2.14.0");
    expect(screen.getByText("予約済み")).toBeTruthy();
    expect(screen.getAllByText("引継ぎ").length).toBe(2);
    expect(screen.getAllByText("再検証").length).toBe(2);
    expect(screen.getAllByText(/バンプ前 aaaaaaa/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/バンプ後 ccccccc/).length).toBeGreaterThan(0);
    expect(screen.queryByText("本番公開へ進む（公開承認）")).toBeNull();
  });

  it("済んだ状態のバッジにはチェック、実行中のバッジには回転するアイコンを文字の前に出す（#4918）", () => {
    render(
      <ReleaseRcFinalizePanel
        candidate={candidate({ phase: "preparing", finalizeContract: null })}
        finalization={overview({ current: view({ status: "requested", statusLabel: "バンプ中", finalHeadSha: null, appliedAt: null }) })}
        repositoryFullName="o/r"
        onChanged={vi.fn()}
      />,
    );
    const chip = (text: string) => screen.getAllByText(text)[0].closest("span")!;
    expect(chip("合格").querySelector(".lucide-check")).toBeTruthy();
    expect(chip("実行中").querySelector(".lucide-loader-circle, .lucide-loader2")).toBeTruthy();
    expect(chip("待機").querySelector("svg")).toBeNull();
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
