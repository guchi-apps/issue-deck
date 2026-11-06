// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decideArmedAction, ReleaseAutoProceedPanel, shouldShowAutoProceed } from "@/components/dashboard/release-auto-proceed-panel";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const finding = (id: string, title: string, severity: "high" | "medium" | "low" = "high") => ({
  id,
  title,
  severity,
  detail: "",
  file: null,
  line: null,
  impact: null,
  evidence: null,
  recommendation: null,
  pullRequests: [],
});
const draft = (reason: string) => ({ reason, impact: null, scope: null, timing: null, followUpTitle: null });

function verification(): ReleaseVerificationSummary {
  return {
    target: { baseSha: BASE, headSha: HEAD },
    aiReview: {
      state: "needs_check",
      findings: [finding("R-0000aa", "旧候補への公開承認が残る"), finding("R-0000bb", "READMEの手順が古い", "medium")],
      suggestions: [],
      decisions: {
        byFinding: {},
        detached: [],
        counts: { undecidedBlocking: 2, fixNow: 0, postRelease: 0, deferred: 0, rejected: 0, stale: 0 },
        cleared: false,
        postReleaseWork: [],
        next: "",
      },
    },
  } as unknown as ReleaseVerificationSummary;
}

const recommendations = {
  status: "ready",
  failures: {},
  byFinding: {
    "R-0000aa": {
      id: "rec1",
      findingId: "R-0000aa",
      baseSha: BASE,
      headSha: HEAD,
      recommended: "post_release",
      rationale: "既存の挙動",
      drafts: {
        fix_now: draft("直す"),
        post_release: { ...draft("今回の変更で悪化しない"), timing: "次のリリースまで", followUpTitle: "承認の失効を直す" },
        defer: draft(""),
        reject: draft("対象外"),
      },
      missing: [],
      createdAt: "2026-10-31T00:00:00Z",
    },
  },
};

type Call = { url: string; body: Record<string, unknown> };

function mockFetch(responses: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      const response = responses[url] ?? { status: 404, body: {} };
      return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
    }),
  );
  return calls;
}

describe("ReleaseAutoProceedPanel（#5138）", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(cleanup);

  it("未判断の止める指摘があり、修正の自動継続が動いていないときだけ出す", () => {
    expect(shouldShowAutoProceed(verification(), false)).toBe(true);
    expect(shouldShowAutoProceed(verification(), true)).toBe(false);
    expect(shouldShowAutoProceed(null, false)).toBe(false);
  });

  it("推奨と安全側の判定を表に並べ、押すと一括確定してから修正の自動継続を始める", async () => {
    const calls = mockFetch({
      "/api/repositories/release/review-recommendations": { body: recommendations },
      "/api/repositories/release/review-decisions/bulk": { body: { ok: true, failed: 0, results: [] } },
      "/api/repositories/release/completion": { body: { run: { id: "r1", active: true } } },
    });
    const onReload = vi.fn();
    const onRunStarted = vi.fn();
    render(
      <ReleaseAutoProceedPanel
        repositoryFullName="guchi-apps/issue-deck"
        pullRequestNumber={5160}
        verification={verification()}
        onReload={onReload}
        onRunStarted={onRunStarted}
      />,
    );
    await waitFor(() => expect(screen.getByText("今回の変更で悪化しない")).toBeTruthy());
    expect(screen.getByText("AIが判断できなかったため安全側")).toBeTruthy();
    expect((screen.getByLabelText("旧候補への公開承認が残るの判定") as HTMLSelectElement).value).toBe("post_release");
    expect((screen.getByLabelText("READMEの手順が古いの判定") as HTMLSelectElement).value).toBe("fix_now");

    fireEvent.click(screen.getByTestId("release-auto-proceed-start"));
    await waitFor(() => expect(onRunStarted).toHaveBeenCalled());
    const bulk = calls.find((c) => c.url.endsWith("/bulk"));
    expect(bulk?.body.items).toEqual([
      expect.objectContaining({ findingId: "R-0000aa", decision: "post_release", recommendationId: "rec1", followUp: { kind: "create", title: "承認の失効を直す" } }),
      expect.objectContaining({ findingId: "R-0000bb", decision: "fix_now", recommendationId: null, fallback: true }),
    ]);
    const completion = calls.find((c) => c.url === "/api/repositories/release/completion");
    expect(completion?.body).toMatchObject({ scope: "until_ready", baseSha: BASE, headSha: HEAD });
    expect(calls.findIndex((c) => c.url.endsWith("/bulk"))).toBeLessThan(calls.findIndex((c) => c.url === "/api/repositories/release/completion"));
    expect(onReload).toHaveBeenCalled();
  });

  it("一部の判定を確定できなければ、自動修正は始めない", async () => {
    const calls = mockFetch({
      "/api/repositories/release/review-recommendations": { body: recommendations },
      "/api/repositories/release/review-decisions/bulk": {
        body: { ok: false, failed: 1, results: [{ findingId: "R-0000aa", ok: false, message: "Issueを作れませんでした" }] },
      },
    });
    render(<ReleaseAutoProceedPanel repositoryFullName="guchi-apps/issue-deck" pullRequestNumber={5160} verification={verification()} onReload={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("今回の変更で悪化しない")).toBeTruthy());
    fireEvent.click(screen.getByTestId("release-auto-proceed-start"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("1件の判定を確定できませんでした"));
    expect(calls.some((c) => c.url === "/api/repositories/release/completion")).toBe(false);
  });
});

describe("おまかせの事前予約（#5229）", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(cleanup);

  const armedTarget = { baseSha: BASE, headSha: HEAD, findingIds: "R-0000aa,R-0000bb" };
  const base = { armed: armedTarget, target: { baseSha: BASE, headSha: HEAD }, findingIds: "R-0000aa,R-0000bb", loading: false, error: null, hasView: true, fallbackCount: 0 };

  it("発火条件: 取得が完了し、対象が一致し、フォールバックが0件のときだけ進める", () => {
    expect(decideArmedAction(base)).toEqual({ action: "fire" });
    expect(decideArmedAction({ ...base, loading: true })).toEqual({ action: "wait" });
    expect(decideArmedAction({ ...base, hasView: false })).toEqual({ action: "wait" });
    expect(decideArmedAction({ ...base, error: "失敗" })).toEqual({ action: "cancel", reason: "error" });
    expect(decideArmedAction({ ...base, fallbackCount: 1 })).toEqual({ action: "cancel", reason: "fallback" });
    expect(decideArmedAction({ ...base, target: { baseSha: BASE, headSha: "c".repeat(40) } })).toEqual({ action: "cancel", reason: "target_changed" });
    expect(decideArmedAction({ ...base, findingIds: "R-0000aa" })).toEqual({ action: "cancel", reason: "target_changed" });
  });

  function gatedFetch(recBody: unknown) {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
        if (url.endsWith("/review-recommendations")) {
          await gate;
          return new Response(JSON.stringify(recBody), { status: 200 });
        }
        if (url.endsWith("/bulk")) return new Response(JSON.stringify({ ok: true, failed: 0, results: [] }), { status: 200 });
        if (url.endsWith("/completion")) return new Response(JSON.stringify({ run: { id: "r1", active: true } }), { status: 200 });
        return new Response("{}", { status: 404 });
      }),
    );
    return { calls, release };
  }

  const fullRecommendations = {
    ...recommendations,
    byFinding: {
      ...recommendations.byFinding,
      "R-0000bb": { ...recommendations.byFinding["R-0000aa"], id: "rec2", findingId: "R-0000bb", recommended: "fix_now" },
    },
  };

  it("取得中に押すと予約中になり、推奨が全件そろったら自動で確定・開始する（1回だけ）", async () => {
    const { calls, release } = gatedFetch(fullRecommendations);
    const onRunStarted = vi.fn();
    render(<ReleaseAutoProceedPanel repositoryFullName="guchi-apps/issue-deck" pullRequestNumber={5160} verification={verification()} onReload={vi.fn()} onRunStarted={onRunStarted} />);
    const button = screen.getByTestId("release-auto-proceed-start") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(screen.getByText(/予約中/)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/bulk"))).toBe(false);
    release();
    await waitFor(() => expect(onRunStarted).toHaveBeenCalled());
    expect(calls.filter((c) => c.url.endsWith("/bulk"))).toHaveLength(1);
    expect(calls.filter((c) => c.url === "/api/repositories/release/completion")).toHaveLength(1);
  });

  it("推奨が無い指摘があれば、自動では進めず予約を解除する", async () => {
    const { calls, release } = gatedFetch(recommendations);
    render(<ReleaseAutoProceedPanel repositoryFullName="guchi-apps/issue-deck" pullRequestNumber={5160} verification={verification()} onReload={vi.fn()} />);
    fireEvent.click(screen.getByTestId("release-auto-proceed-start"));
    release();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("予約を解除しました"));
    expect(calls.some((c) => c.url.endsWith("/bulk"))).toBe(false);
    expect((screen.getByTestId("release-auto-proceed-start") as HTMLButtonElement).disabled).toBe(false);
  });

  it("予約を取り消すと、推奨が届いても進めない", async () => {
    const { calls, release } = gatedFetch(fullRecommendations);
    render(<ReleaseAutoProceedPanel repositoryFullName="guchi-apps/issue-deck" pullRequestNumber={5160} verification={verification()} onReload={vi.fn()} />);
    fireEvent.click(screen.getByTestId("release-auto-proceed-start"));
    fireEvent.click(screen.getByTestId("release-auto-proceed-cancel"));
    release();
    await waitFor(() => expect(screen.getByText("今回の変更で悪化しない")).toBeTruthy());
    expect(calls.some((c) => c.url.endsWith("/bulk"))).toBe(false);
  });
});
