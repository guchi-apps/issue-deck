// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SecretsSyncSection } from "@/components/dashboard/secrets-sync-section";
import type { SecretsSyncRepository } from "@/hooks/use-secrets-sync";

function repository(overrides: Partial<SecretsSyncRepository> = {}): SecretsSyncRepository {
  return {
    fullName: "guchi-apps/issue-deck",
    latestRun: {
      id: "run-1",
      repositoryFullName: "guchi-apps/issue-deck",
      only: "",
      status: "SUCCEEDED",
      startedAt: "2026-08-14T10:00:00.000Z",
      finishedAt: "2026-08-14T10:01:00.000Z",
      syncedCount: 26,
      skippedCount: 2,
      failedCount: 0,
      failedKeys: [],
      runUrl: null,
      message: null,
    },
    ...overrides,
  };
}

function mockFetch(repositories: SecretsSyncRepository[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    return { ok: true, json: async () => ({ repositories }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * リポジトリ名は`guchi-apps/`と本体で濃さを変えるため2つの要素に分かれており、
 * 既定の文字列マッチでは引けない（#1942）。全体の文字列で引くための補助。
 */
function findRepositoryName(fullName: string) {
  return screen.findByText(
    (_, element) => element?.tagName === "SPAN" && element.textContent === fullName,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  // 相対表記（「2時間前」）を固定するため、実行時刻を止める
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-14T10:30:00.000Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SecretsSyncSection", () => {
  it("リポジトリごとの直近の結果を件数で出す", async () => {
    mockFetch([repository()]);
    render(<SecretsSyncSection open />);

    expect(await findRepositoryName("guchi-apps/issue-deck")).toBeTruthy();
    expect(screen.getByText("同期 26")).toBeTruthy();
    expect(screen.getByText("スキップ 2")).toBeTruthy();
    expect(screen.getByText("失敗 0")).toBeTruthy();
  });

  it("リポジトリ名は結果に押されて省略されない（#1942）", async () => {
    mockFetch([repository({ fullName: "guchi-apps/subscription-tracker" })]);
    render(<SecretsSyncSection open />);

    const name = await findRepositoryName("guchi-apps/subscription-tracker");
    expect(name.classList.contains("truncate")).toBe(false);
  });

  it("最後に実行した時期を相対表記で出す（押してよいかを押す前に判断できる）", async () => {
    vi.setSystemTime(new Date("2026-08-14T13:00:00.000Z"));
    mockFetch([repository()]);
    render(<SecretsSyncSection open />);

    expect(await screen.findByText("2時間前")).toBeTruthy();
  });

  it("失敗は項目名だけを出す（値も値の長さも出さない）", async () => {
    mockFetch([
      repository({
        latestRun: {
          ...repository().latestRun!,
          status: "FAILED",
          failedCount: 1,
          failedKeys: ["SIGNALY_WEBHOOK_URL"],
        },
      }),
    ]);
    render(<SecretsSyncSection open />);

    expect(await screen.findByText("失敗: SIGNALY_WEBHOOK_URL")).toBeTruthy();
  });

  it("同期処理が始まる前に落ちた失敗（件数が全て0）はmessageを出す", async () => {
    mockFetch([
      repository({
        latestRun: {
          ...repository().latestRun!,
          status: "FAILED",
          syncedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          failedKeys: [],
          message: "sync-secrets.yml がこのリポジトリで見つかりませんでした。",
        },
      }),
    ]);
    render(<SecretsSyncSection open />);

    // 横へはみ出さず折り返すこと。以前は縮まない指定のまま1行に置かれ、
    // スマホでは横スクロールしないと理由を読めなかった（#1942）
    const message = await screen.findByText(
      "sync-secrets.yml がこのリポジトリで見つかりませんでした。",
    );
    expect(message.classList.contains("break-words")).toBe(true);
  });

  it("実行中は同期ボタンを押せない（二重起動の防止）", async () => {
    mockFetch([
      repository({ latestRun: { ...repository().latestRun!, status: "QUEUED", finishedAt: null } }),
    ]);
    render(<SecretsSyncSection open />);

    await screen.findByText("実行中...");
    expect(screen.getByRole("button", { name: /同期/ }).hasAttribute("disabled")).toBe(true);
  });

  it("押すとすぐ起動せず、日次枠の消費を伝える確認を挟む", async () => {
    const fetchMock = mockFetch([repository()]);
    render(<SecretsSyncSection open />);

    fireEvent.click(await screen.findByRole("button", { name: /同期/ }));

    // 確認ダイアログ自身が、押すと何件ぶんの枠を使うのかを伝える
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("1,000件/日");
    expect(dialog.textContent).toContain("マニフェスト全件");
    // 確認しただけでは起動しない
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === "POST")).toBe(
      false,
    );

    fireEvent.click(await screen.findByRole("button", { name: "同期する" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit)?.method === "POST",
      );
      expect(post?.[0]).toBe("/api/secrets-sync");
    });
  });

  it("KEY名として不正な絞り込みは、起動する前にボタンを止める", async () => {
    mockFetch([repository()]);
    render(<SecretsSyncSection open />);

    await findRepositoryName("guchi-apps/issue-deck");
    fireEvent.change(screen.getByLabelText(/対象キー/), {
      target: { value: "op://apps/Server/host" },
    });

    expect(screen.getByRole("button", { name: /同期/ }).hasAttribute("disabled")).toBe(true);
  });
});
