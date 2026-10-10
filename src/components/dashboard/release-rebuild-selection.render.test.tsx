// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReleasePreparationAlert } from "@/components/dashboard/release-preparation-alert";
import { ReleaseRebuildButton } from "@/components/dashboard/release-rebuild-button";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const HEAD = "c".repeat(40);

function rebuildInfo(over: Record<string, unknown> = {}) {
  return {
    releasePullRequest: { number: 99, title: "v8.50.1をmainへリリースする", url: "https://github.com/o/r/pull/99", version: "8.50.1", headSha: HEAD },
    candidate: { aheadBy: 3, pullRequests: [] },
    selection: {
      supported: true,
      defaultSelected: [20],
      inProgress: null,
      options: [
        { number: 20, title: "修正A", issueNumber: 120, url: "https://github.com/o/r/pull/20", mergeSha: SHA_A, merged: true, ciState: "success", relatedFix: true, problem: null, problemLabel: null },
        { number: 21, title: "無関係B", issueNumber: 121, url: "https://github.com/o/r/pull/21", mergeSha: SHA_B, merged: true, ciState: "failure", relatedFix: false, problem: null, problemLabel: null },
        { number: 30, title: "未マージの修正", issueNumber: 130, url: "https://github.com/o/r/pull/30", mergeSha: null, merged: false, ciState: null, relatedFix: true, problem: "not_merged", problemLabel: "developへ未マージです。developへのレビュー・マージ（従来どおりの自動レビュー）が済むと選べます" },
      ],
    },
    ...over,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);
}

describe("修正を入れて作り直す：PRの選択（#4335）", () => {
  it("既定で当該リリースの修正PRだけを選び、無関係・未マージのPRは選ばない", async () => {
    fetchMock.mockImplementation(() => json(rebuildInfo()));
    render(<ReleaseRebuildButton repositoryFullName="o/r" hasChanges />);
    fireEvent.click(screen.getByRole("button", { name: /修正を入れて作り直す/ }));

    const a = await screen.findByRole("checkbox", { name: /#20 修正A/ });
    expect(a.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: /#21 無関係B/ }).getAttribute("aria-checked")).toBe("false");
    const unmerged = screen.getByRole("checkbox", { name: /#30 未マージの修正/ });
    expect(unmerged.hasAttribute("disabled")).toBe(true);
    // 状態と利用条件を明示する
    expect(screen.getByText(/developへ未マージです/)).toBeTruthy();
    expect(screen.getAllByText("このリリースの修正").length).toBe(2);
    expect(screen.getByText("CI失敗")).toBeTruthy();
    // 追加範囲の確認
    expect(screen.getByText(/追加される範囲:/).closest("p")?.textContent).toContain("#20");
    expect(screen.getByRole("button", { name: "選んだ1件で作り直す" })).toBeTruthy();
  });

  it("選んだPRとマージコミット・元の候補のheadを送る（無関係なPRを勝手に足さない）", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ ok: true, selective: true }) : json(rebuildInfo()),
    );
    render(<ReleaseRebuildButton repositoryFullName="o/r" hasChanges />);
    fireEvent.click(screen.getByRole("button", { name: /修正を入れて作り直す/ }));
    await screen.findByRole("checkbox", { name: /#20 修正A/ });

    fireEvent.click(screen.getByRole("button", { name: "選んだ1件で作り直す" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(JSON.parse(init.body as string)).toMatchObject({
      pullRequestNumber: 99,
      headSha: HEAD,
      selectedPullRequests: [{ number: 20, mergeSha: SHA_A }],
    });
  });

  it("何も選ばなければ作り直せない", async () => {
    fetchMock.mockImplementation(() => json(rebuildInfo()));
    render(<ReleaseRebuildButton repositoryFullName="o/r" hasChanges />);
    fireEvent.click(screen.getByRole("button", { name: /修正を入れて作り直す/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /#20 修正A/ }));

    expect(screen.getByRole("button", { name: "選んだ0件で作り直す" }).hasAttribute("disabled")).toBe(true);
  });

  it("同じ候補への作り直しが進行中なら、選択を出さずに知らせる（二重操作の防止）", async () => {
    const info = rebuildInfo();
    info.selection.inProgress = { createdAt: "2026-10-10T10:00:00Z", selection: [{ number: 20, mergeSha: SHA_A, title: "修正A" }] } as never;
    fetchMock.mockImplementation(() => json(info));
    render(<ReleaseRebuildButton repositoryFullName="o/r" hasChanges />);
    fireEvent.click(screen.getByRole("button", { name: /修正を入れて作り直す/ }));

    expect(await screen.findByText(/既に起動しています（#20）/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("選べないPRがあったときはPRごとの理由を出す", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ ok: false, error: "invalid_selection", problems: [{ number: 20, problem: "sha_changed", label: "選んだ後にPRのマージコミットが変わりました。選び直してください" }] }, 409)
        : json(rebuildInfo()),
    );
    render(<ReleaseRebuildButton repositoryFullName="o/r" hasChanges />);
    fireEvent.click(screen.getByRole("button", { name: /修正を入れて作り直す/ }));
    await screen.findByRole("checkbox", { name: /#20 修正A/ });
    fireEvent.click(screen.getByRole("button", { name: "選んだ1件で作り直す" }));

    expect(await screen.findByText(/#20 選んだ後にPRのマージコミットが変わりました/)).toBeTruthy();
  });

  it("未対応のリポジトリでは従来の作り直し（developの最新）の説明のまま", async () => {
    fetchMock.mockImplementation(() =>
      json(rebuildInfo({ selection: { supported: false, options: [], defaultSelected: [], inProgress: null }, candidate: { aheadBy: 1, pullRequests: [{ number: 20, title: "修正A", issueNumber: null }] } })),
    );
    render(<ReleaseRebuildButton repositoryFullName="o/r" hasChanges />);
    fireEvent.click(screen.getByRole("button", { name: /修正を入れて作り直す/ }));

    expect(await screen.findByText(/developの最新の内容でバージョンバンプからやり直します/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("リリース準備の失敗（#4335）", () => {
  const failure = {
    id: "f1",
    runUrl: "https://github.com/o/r/actions/runs/38064982157",
    event: "workflow_dispatch",
    bumpKind: "minor",
    jobName: "release / release",
    stepName: "バージョンをbumpしてdevelop向けPRを作成する",
    errorExcerpt: "バンプを取り消した後の版（8.50.0）がmain（8.49.0）と一致しません。",
    rebuildSelection: null,
    createdAt: "2026-10-10T15:47:33Z",
    nextAction: "エラーに出ているコミット・ファイルをdevelopで確認してから「再開」してください。",
  };

  it("失敗した工程・根拠・実行ログ・再開を1か所に出し、個別Issueは本番反映待ちのままと伝える", async () => {
    fetchMock.mockImplementation(() => json({ failure }));
    render(<ReleasePreparationAlert repositoryFullName="o/r" />);

    expect(await screen.findByText("リリース準備に失敗しました")).toBeTruthy();
    expect(screen.getByText(failure.stepName)).toBeTruthy();
    expect(screen.getByText(failure.errorExcerpt)).toBeTruthy();
    expect(screen.getByText(/個別のIssueは本番反映待ちのままです/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /実行ログ/ }).getAttribute("href")).toBe(failure.runUrl);
    // 根拠の無いGitHub障害の案内は出さない
    expect(document.body.textContent).not.toContain("githubstatus");
  });

  it("再開は記録のIDを付けて起動し、押しただけでは表示を消さない", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ ok: true }) : json({ failure }),
    );
    render(<ReleasePreparationAlert repositoryFullName="o/r" />);
    fireEvent.click(await screen.findByRole("button", { name: "再開" }));

    expect(await screen.findByText(/準備が進むとこの表示は消えます/)).toBeTruthy();
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(JSON.parse(init.body as string)).toEqual({ owner: "o", repo: "r", failureId: "f1" });
    expect(screen.getByText("リリース準備に失敗しました")).toBeTruthy();
  });

  it("失敗が無ければ何も出さない", async () => {
    fetchMock.mockImplementation(() => json({ failure: null }));
    const { container } = render(<ReleasePreparationAlert repositoryFullName="o/r" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
