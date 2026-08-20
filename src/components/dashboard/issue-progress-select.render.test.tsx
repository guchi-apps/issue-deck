// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueProgressSelect } from "@/components/dashboard/issue-progress-select";
import type { Issue } from "@/types/issue";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    number: 1920,
    title: "スマートフォンの画面でステータスを変更できるようにする",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "m-guchi" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
    projectStatus: "Implementation",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1920",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

/** Radix Selectはポインタ関連のAPIを触るため、jsdomに無いものだけ足す */
function stubPointerApis() {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/** セレクトを開いて選択肢を押す（Radixはpointerdownで開く） */
async function pick(label: string) {
  fireEvent.pointerDown(screen.getByLabelText("進捗"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  const option = await screen.findByRole("option", { name: label });
  fireEvent.click(option);
}

describe("IssueProgressSelect（#1350・#1920）", () => {
  beforeEach(() => {
    stubPointerApis();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("選ぶと進捗を書き込み、成功したら新しいStatusで親のIssueを差し替える", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ applied: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onIssueUpdated = vi.fn();
    render(<IssueProgressSelect issue={issue()} onIssueUpdated={onIssueUpdated} />);

    await pick("developへマージ");

    await waitFor(() => expect(onIssueUpdated).toHaveBeenCalledTimes(1));
    expect(onIssueUpdated.mock.calls[0][0].projectStatus).toBe("Develop PR");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/issues/progress-status");
    expect(JSON.parse(String(init?.body))).toEqual({
      repository: "guchi-apps/issue-deck",
      issue: 1920,
      status: "develop-pr",
    });
  });

  it("書けなかったら親へ返さず、理由を出す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })),
    );
    const onIssueUpdated = vi.fn();
    render(<IssueProgressSelect issue={issue()} onIssueUpdated={onIssueUpdated} />);

    await pick("developへマージ");

    expect(
      await screen.findByText("進捗を変更できませんでした。時間をおいて試してください。"),
    ).toBeTruthy();
    expect(onIssueUpdated).not.toHaveBeenCalled();
  });
});
