// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PullRequestFileList } from "@/components/dashboard/pull-request-file-list";
import type { PullRequestFile } from "@/types/pull-request";

function makeFile(overrides: Partial<PullRequestFile> = {}): PullRequestFile {
  return {
    path: "src/components/dashboard/pull-request-detail.tsx",
    change: "modified",
    additions: 34,
    deletions: 1,
    blobUrl: "https://github.com/guchi-apps/issue-deck/blob/abc/src/x.tsx",
    previousPath: null,
    ...overrides,
  };
}

function mockFiles(files: PullRequestFile[], truncated = false) {
  const requestedUrls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return { ok: true, json: async () => ({ files, truncated }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requestedUrls };
}

/**
 * 一覧取得（`/api/pull-requests/files`）と個別ファイルの差分取得
 * （`/api/pull-requests/file-diff`）をURLで振り分けてモックする。`diffs`は
 * `{ [path]: 応答内容 }`で、指定が無いパスは`{ patch: null }`を返す。
 */
function mockFilesAndDiff(
  files: PullRequestFile[],
  diffs: Record<string, { ok: boolean; status?: number; body: unknown }> = {},
) {
  const requestedUrls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("/api/pull-requests/file-diff")) {
      const path = new URL(url, "http://localhost").searchParams.get("path") ?? "";
      const response = diffs[path] ?? { ok: true, body: { patch: null } };
      return { ok: response.ok, status: response.status, json: async () => response.body };
    }
    return { ok: true, json: async () => ({ files, truncated: false }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requestedUrls };
}

function renderList(props: Partial<React.ComponentProps<typeof PullRequestFileList>> = {}) {
  return render(
    <PullRequestFileList
      pullRequestId="guchi-apps/issue-deck#42"
      htmlUrl="https://github.com/guchi-apps/issue-deck/pull/42"
      changedFiles={2}
      additions={390}
      deletions={11}
      refreshKey="2026-08-19T00:00:00.000Z"
      {...props}
    />,
  );
}

/** 見出し（開閉のトリガー）を押す */
function toggle() {
  fireEvent.click(screen.getByRole("button", { name: /変更ファイル/ }));
}

describe("PullRequestFileList", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("既定では畳まれていて、ファイル一覧を取りに行かない", async () => {
    const { fetchMock } = mockFiles([makeFile()]);
    renderList();

    // 畳んでいてもファイル数と増減は出す（PR詳細が既に持っている値なので取得は要らない）
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("+390")).toBeTruthy();
    expect(screen.queryByText("pull-request-detail.tsx")).toBeNull();
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("開くと一覧を取得して、変更の種別とパスを出す", async () => {
    const { fetchMock, requestedUrls } = mockFiles([
      makeFile(),
      makeFile({ path: "src/hooks/use-pull-request-files.ts", change: "added", deletions: 0 }),
    ]);
    renderList();
    toggle();

    await waitFor(() => expect(screen.getByText("pull-request-detail.tsx")).toBeTruthy());
    expect(screen.getByText("use-pull-request-files.ts")).toBeTruthy();
    expect(screen.getByText("変更")).toBeTruthy();
    expect(screen.getByText("追加")).toBeTruthy();
    expect(screen.getByText("src/hooks/")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrls[0]).toContain(
      "/api/pull-requests/files?owner=guchi-apps&repo=issue-deck&number=42",
    );
  });

  it("畳んで開き直しても取得し直さない", async () => {
    const { fetchMock } = mockFiles([makeFile()]);
    renderList();
    toggle();
    await waitFor(() => expect(screen.getByText("pull-request-detail.tsx")).toBeTruthy());

    toggle();
    toggle();
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("pull-request-detail.tsx")).toBeTruthy();
  });

  it("取得に失敗したらエラーと再試行を出し、押すと取り直す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({ error: "github_api_error", message: "GitHubへ接続できません" }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ files: [makeFile()], truncated: false }) });
    vi.stubGlobal("fetch", fetchMock);

    renderList();
    toggle();

    await waitFor(() => expect(screen.getByText("GitHubへ接続できません")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));

    await waitFor(() => expect(screen.getByText("pull-request-detail.tsx")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("打ち切った場合はGitHubで残りを見るよう促す", async () => {
    mockFiles([makeFile()], true);
    renderList({ changedFiles: 312 });
    toggle();

    await waitFor(() => expect(screen.getByText(/先頭1件を表示しています/)).toBeTruthy());
    const link = screen.getByRole("link", { name: "GitHubのFiles changed" });
    expect(link.getAttribute("href")).toBe("https://github.com/guchi-apps/issue-deck/pull/42/files");
  });

  describe("差分の表示（#3383）", () => {
    const path = "src/components/dashboard/pull-request-detail.tsx";

    it("行のシェブロンを押すまで差分を取得しない", async () => {
      const { fetchMock } = mockFilesAndDiff([makeFile({ path })], {
        [path]: { ok: true, body: { patch: "@@ -1 +1 @@\n-old\n+new" } },
      });
      renderList();
      toggle();
      await waitFor(() => expect(screen.getByText("pull-request-detail.tsx")).toBeTruthy());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("+new")).toBeNull();
    });

    it("シェブロンを押すと差分を取得して表示し、再度押しても取り直さない", async () => {
      const { fetchMock, requestedUrls } = mockFilesAndDiff([makeFile({ path })], {
        [path]: { ok: true, body: { patch: "@@ -1 +1 @@\n-old\n+new" } },
      });
      renderList();
      toggle();
      await waitFor(() => expect(screen.getByText("pull-request-detail.tsx")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: `${path} の差分を表示` }));
      await waitFor(() => expect(screen.getByText("+new")).toBeTruthy());
      expect(screen.getByText("-old")).toBeTruthy();
      expect(requestedUrls[1]).toContain(
        `/api/pull-requests/file-diff?owner=guchi-apps&repo=issue-deck&number=42&path=${encodeURIComponent(path)}`,
      );

      // 閉じて開き直しても取得し直さない
      fireEvent.click(screen.getByRole("button", { name: `${path} の差分を閉じる` }));
      expect(screen.queryByText("+new")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: `${path} の差分を表示` }));
      await waitFor(() => expect(screen.getByText("+new")).toBeTruthy());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("差分が無いファイルはGitHubへの誘導を出す", async () => {
      mockFilesAndDiff([makeFile({ path })]);
      renderList();
      toggle();
      await waitFor(() => expect(screen.getByText("pull-request-detail.tsx")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: `${path} の差分を表示` }));
      await waitFor(() => expect(screen.getByText(/差分を表示できません/)).toBeTruthy());
      const link = screen.getByRole("link", { name: "GitHubで確認してください" });
      expect(link.getAttribute("href")).toBe(makeFile().blobUrl);
    });

    it("差分の取得に失敗したらエラーと再試行を出す", async () => {
      const { fetchMock } = mockFilesAndDiff([makeFile({ path })], {
        [path]: {
          ok: false,
          status: 502,
          body: { error: "github_api_error", message: "GitHubへ接続できません" },
        },
      });
      renderList();
      toggle();
      await waitFor(() => expect(screen.getByText("pull-request-detail.tsx")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: `${path} の差分を表示` }));
      await waitFor(() => expect(screen.getByText("GitHubへ接続できません")).toBeTruthy());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
