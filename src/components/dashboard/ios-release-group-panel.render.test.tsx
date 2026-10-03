// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IosFixIssueDraftContext, IosReleaseGroupPanel } from "@/components/dashboard/ios-release-group-panel";

const SHA = "abcdef1234567890";

function stubTestflight(trackedIssue: { number: number; htmlUrl: string } | null) {
  const body = {
    available: true,
    latestDeliveredBuild: null,
    trackedIssue,
    release: { sha: SHA, merged: true, isMainTip: true, webDeploy: "success", deliveredBuild: null },
    runs: [
      {
        id: 10,
        htmlUrl: "https://github.com/o/r/actions/runs/10",
        headSha: SHA,
        headBranch: "main",
        event: "workflow_dispatch",
        createdAt: "2026-10-03T00:00:00Z",
        updatedAt: "2026-10-03T00:10:00Z",
        status: "completed",
        conclusion: "failure",
        verdict: { kind: "failed", failedStage: "署名" },
        stages: [
          { key: "detect", label: "変更判定", state: "success", startedAt: null, completedAt: null },
          { key: "sign", label: "署名", state: "failure", startedAt: null, completedAt: null },
        ],
        notes: [],
      },
    ],
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const panel = <IosReleaseGroupPanel owner="guchi-apps" repo="kurashio" prNumber={5} version="1.8.0" />;

describe("IosReleaseGroupPanel 修正Issueを起案", () => {
  it("失敗時にボタンが出て、押すと下書きと起案元を渡す", async () => {
    stubTestflight(null);
    const onDraft = vi.fn();
    render(<IosFixIssueDraftContext.Provider value={onDraft}>{panel}</IosFixIssueDraftContext.Provider>);
    fireEvent.click(await screen.findByRole("button", { name: /修正Issueを起案/ }));
    expect(onDraft).toHaveBeenCalledTimes(1);
    const [draft, origin] = onDraft.mock.calls[0];
    expect(draft.title).toContain("[iOS配布失敗] guchi-apps/kurashio: v1.8.0");
    expect(origin).toMatchObject({ repositoryFullName: "guchi-apps/kurashio", runId: 10, failedStage: "署名" });
  });

  it("追跡Issueがあればボタンの代わりに「起票済み」のリンクを出す", async () => {
    stubTestflight({ number: 42, htmlUrl: "https://github.com/guchi-apps/kurashio/issues/42" });
    render(<IosFixIssueDraftContext.Provider value={vi.fn()}>{panel}</IosFixIssueDraftContext.Provider>);
    expect(await screen.findByText(/起票済み（#42）/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /修正Issueを起案/ })).toBeNull();
  });

  it("起案の送り先が無ければボタンを出さない", async () => {
    stubTestflight(null);
    render(panel);
    await screen.findByText(/iOS配布に失敗/);
    expect(screen.queryByRole("button", { name: /修正Issueを起案/ })).toBeNull();
  });
});

describe("IosReleaseGroupPanel 手動配布（#3840）", () => {
  function stubSkipped() {
    const body = {
      available: true,
      latestDeliveredBuild: null,
      trackedIssue: null,
      release: { sha: SHA, merged: true, isMainTip: true, webDeploy: "success", deliveredBuild: null },
      runs: [
        {
          id: 11,
          htmlUrl: "https://github.com/o/r/actions/runs/11",
          headSha: SHA,
          headBranch: "main",
          event: "workflow_dispatch",
          createdAt: "2026-10-03T00:00:00Z",
          updatedAt: "2026-10-03T00:01:00Z",
          status: "completed",
          conclusion: "success",
          verdict: { kind: "skipped" },
          stages: [{ key: "detect", label: "変更判定", state: "success", startedAt: null, completedAt: null }],
          notes: [],
        },
      ],
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ ok: true, sha: SHA }), { status: 200 })
        : new Response(JSON.stringify(body), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("更新不要のときだけ「手動で配布」が出て、確認後にforce付きでPOSTする", async () => {
    const fetchMock = stubSkipped();
    render(panel);
    fireEvent.click(await screen.findByRole("button", { name: "手動で配布" }));
    fireEvent.click(await screen.findByRole("button", { name: "手動で配布する" }));
    await vi.waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ owner: "guchi-apps", repo: "kurashio", prNumber: 5, force: true });
    });
  });

  it("失敗時は手動配布ではなく「再実行」を出す", async () => {
    stubTestflight(null);
    render(panel);
    expect(await screen.findByRole("button", { name: "再実行" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "手動で配布" })).toBeNull();
  });
});
