// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestReadyButton } from "@/components/dashboard/pull-request-ready-button";
import type { PullRequestSummary } from "@/types/pull-request";

const pr = { repositoryFullName: "guchi-apps/subpc", number: 123, headSha: "sha1" } as PullRequestSummary;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PullRequestReadyButton", () => {
  it("押すと対象・head SHAを送り、成功したら最新状態を取り直す。連打では1回しか送らない", async () => {
    let resolve!: (value: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((r) => (resolve = r)));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<PullRequestReadyButton pullRequest={pr} onChanged={onChanged} />);

    const button = screen.getByRole("button", { name: "レビュー可能にする" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toEqual({
      owner: "guchi-apps",
      repo: "subpc",
      number: 123,
      headSha: "sha1",
    });
    expect((await screen.findByRole("button", { name: "切り替え中…" })).hasAttribute("disabled")).toBe(true);

    resolve({ ok: true, json: async () => ({ ok: true }) });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("権限不足では成功扱いにせず理由を出し、再び押せる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "permission_denied" }) })),
    );
    const onChanged = vi.fn();
    render(<PullRequestReadyButton pullRequest={pr} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "レビュー可能にする" }));
    expect((await screen.findByRole("alert")).textContent).toContain("権限");
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "レビュー可能にする" }).hasAttribute("disabled")).toBe(false);
  });

  it("通信失敗でも失敗として表示する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("net"))));
    render(<PullRequestReadyButton pullRequest={pr} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "レビュー可能にする" }));
    expect((await screen.findByRole("alert")).textContent).toContain("失敗");
  });
});
