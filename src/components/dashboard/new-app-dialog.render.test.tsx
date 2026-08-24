// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NewAppDialog } from "@/components/dashboard/new-app-dialog";

/**
 * 新規アプリ立ち上げのウィザード（#2188）。
 *
 * 確かめるのは**画面が「どこまでが自動か」を実行前に見せること**と、
 * **相談で決まった値が設定へ引き渡されること**の2つ。
 */

type FetchCall = { url: string; body: unknown };

const calls: FetchCall[] = [];

function mockFetch(handlers: Record<string, ((body: unknown) => unknown) | undefined>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      calls.push({ url, body });
      const handler = handlers[url];
      return {
        ok: Boolean(handler),
        status: handler ? 200 : 404,
        json: async () => (handler ? handler(body) : { error: "not_found" }),
      } as Response;
    }),
  );
}

const PREFLIGHT_OK = {
  repository: { name: "kakei-report", taken: false },
  hostname: { value: "kakei-report.gucchii.com", taken: false },
  port: { suggested: 3112, note: "使用中: 3101・3111", used: [3101, 3111] },
  localPortBand: {
    base: 25000,
    alreadyListed: false,
    note: "ベース値 25000 を確保します（開発サーバーは 25000 + Issue番号）",
  },
  githubApp: { repositorySelection: "all", needsRepositoryAdd: false },
  vpsRead: true,
};

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 相談 → 基本 → 配置 と進めて、配置ステップまで到達させる。 */
async function advanceToPlacement() {
  render(<NewAppDialog open onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "設定に進む" }));

  fireEvent.change(screen.getByLabelText("アプリ名"), { target: { value: "家計レポート" } });
  fireEvent.change(screen.getByLabelText("リポジトリ"), { target: { value: "kakei-report" } });
  fireEvent.blur(screen.getByLabelText("リポジトリ"));
  await waitFor(() => expect(screen.getByText("この名前は空いています")).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: /次へ/ }));
  await waitFor(() => expect(screen.getByText("種別")).toBeTruthy());
}

describe("NewAppDialog", () => {
  it("開いた直後は相談ステップで、こちらから話しかける（この時点ではAPIを呼ばない）", () => {
    mockFetch({});
    render(<NewAppDialog open onOpenChange={() => {}} />);

    expect(screen.getByText("どんなアプリを作りたいですか。ざっくりで大丈夫です。")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("相談で決まった値を設定ステップの初期値にする", async () => {
    mockFetch({
      "/api/new-app/consult": () => ({
        reply: "DBが要りますね。",
        ready: true,
        draft: {
          displayName: "家計レポート",
          repositoryName: "kakei-report",
          summary: "家計の月次推移",
          kind: "next-db",
          subdomain: "kakei-report",
          auth: "supabase-google",
          usesDatabase: true,
        },
      }),
      "/api/new-app/preflight": () => PREFLIGHT_OK,
    });
    render(<NewAppDialog open onOpenChange={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("続けて相談する…"), {
      target: { value: "家計の月次推移を見たい" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() => expect(screen.getByText("DBが要りますね。")).toBeTruthy());
    expect(screen.getByText("仕様案（設定ステップで直せます）")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "設定に進む" }));

    expect((screen.getByLabelText("アプリ名") as HTMLInputElement).value).toBe("家計レポート");
    expect((screen.getByLabelText("リポジトリ") as HTMLInputElement).value).toBe("kakei-report");
  });

  it("リポジトリ名の空きを確かめ、使われていれば先へ進ませない", async () => {
    mockFetch({
      "/api/new-app/preflight": () => ({
        ...PREFLIGHT_OK,
        repository: { name: "kakei-report", taken: true },
      }),
    });
    render(<NewAppDialog open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "設定に進む" }));

    fireEvent.change(screen.getByLabelText("リポジトリ"), { target: { value: "kakei-report" } });
    fireEvent.blur(screen.getByLabelText("リポジトリ"));

    await waitFor(() =>
      expect(screen.getByText("すでに使われています。別の名前にしてください")).toBeTruthy(),
    );
    expect((screen.getByRole("button", { name: /次へ/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("空きポートの提案を初期値にし、その根拠も出す", async () => {
    mockFetch({ "/api/new-app/preflight": () => PREFLIGHT_OK });
    await advanceToPlacement();

    expect((screen.getByLabelText("本番ポート") as HTMLInputElement).value).toBe("3112");
    expect(screen.getByText("使用中: 3101・3111")).toBeTruthy();
  });

  it("vpsを読めなかったときは自動採番せず、手で決めるよう伝える", async () => {
    mockFetch({
      "/api/new-app/preflight": () => ({
        repository: { name: "kakei-report", taken: false },
        hostname: { value: "", taken: null },
        port: { suggested: null, note: null },
        localPortBand: { base: null, alreadyListed: false, note: "読めませんでした" },
        githubApp: { repositorySelection: "all", needsRepositoryAdd: false },
        vpsRead: false,
      }),
    });
    await advanceToPlacement();

    expect((screen.getByLabelText("本番ポート") as HTMLInputElement).value).toBe("");
    expect(
      screen.getByText(/guchi-apps\/vps を読めなかったため、空き番号を提案できません/),
    ).toBeTruthy();
  });

  it("確認ステップで9件と、自動・代行・手作業の内訳を出す", async () => {
    mockFetch({ "/api/new-app/preflight": () => PREFLIGHT_OK });
    await advanceToPlacement();

    fireEvent.click(screen.getByRole("button", { name: /次へ/ }));
    await waitFor(() => expect(screen.getByText("9件を作成します")).toBeTruthy());

    expect(screen.getAllByText("guchi-apps/kakei-report").length).toBeGreaterThan(0);
    // 払い出す予定のポート帯も押す前に読み取れる（#2225）
    expect(screen.getByText(/ローカルセッションのポート帯: ベース値 25000 を確保します/)).toBeTruthy();
    expect(screen.getByText(/ローカルセッションの開発サーバーのポート帯 25000 を確保する/)).toBeTruthy();
    // DNSが自動化できないことが、押す前に読み取れる
    expect(screen.getAllByText("あなたが実行").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("代行できる").length).toBeGreaterThanOrEqual(1);
  });

  it("体裁と運用は畳んだまま次へ進める（既定値が1行で読める。#2254）", async () => {
    mockFetch({ "/api/new-app/preflight": () => PREFLIGHT_OK });
    await advanceToPlacement();

    expect(screen.getByText("体裁と運用")).toBeTruthy();
    expect(screen.getByText("標準どおり")).toBeTruthy();
    expect(screen.getByText(/表示名「家計レポート」／.*PWA対応・オフラインなし／更新履歴あり/)).toBeTruthy();
    // 畳んだままでは入力欄を出さない
    expect(screen.queryByLabelText("表示名")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /次へ/ }));
    await waitFor(() => expect(screen.getByText("9件を作成します")).toBeTruthy());
    expect(screen.getByText(/体裁と運用: 表示名「家計レポート」/)).toBeTruthy();
  });

  it("開いて標準から外すと「標準どおり」が消え、要約もそれに追従する（#2254）", async () => {
    mockFetch({ "/api/new-app/preflight": () => PREFLIGHT_OK });
    await advanceToPlacement();

    fireEvent.click(screen.getByRole("button", { name: "変更する" }));
    fireEvent.change(screen.getByLabelText("表示名"), { target: { value: "家計" } });
    fireEvent.click(screen.getByLabelText(/更新履歴（changelog）を持つ/));

    expect(screen.queryByText("標準どおり")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.getByText(/表示名「家計」／.*更新履歴なし/)).toBeTruthy();
  });

  it("認証が無いアプリでは撮影バイパスの項目を出さない（#2254）", async () => {
    mockFetch({ "/api/new-app/preflight": () => PREFLIGHT_OK });
    await advanceToPlacement();

    // このウィザードの認証の既定は「なし」で、そのときは迂回するものが無い
    fireEvent.click(screen.getByRole("button", { name: "変更する" }));
    expect(screen.queryByLabelText(/CI撮影の認証バイパスを用意する/)).toBeNull();

    fireEvent.change(screen.getByLabelText("認証"), { target: { value: "supabase-google" } });
    expect(screen.getByLabelText(/CI撮影の認証バイパスを用意する/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("認証"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.getByText(/CI撮影の認証バイパスは不要（認証なし）/)).toBeTruthy();
  });

  it("vpsに同じ対象のIssueが開いていれば、押す前に知らせる", async () => {
    mockFetch({
      "/api/new-app/preflight": () => ({
        ...PREFLIGHT_OK,
        existingVpsIssue: {
          number: 121,
          title: "kakei-report.gucchii.com のVirtualHostを追加する",
          url: "https://github.com/guchi-apps/vps/issues/121",
          reference: "guchi-apps/vps#121",
          reason: "hostname",
        },
      }),
    });
    await advanceToPlacement();

    fireEvent.click(screen.getByRole("button", { name: /次へ/ }));
    await waitFor(() => expect(screen.getByText("9件を作成します")).toBeTruthy());

    expect(screen.getByText("guchi-apps/vps#121")).toBeTruthy();
    expect(screen.getByText(/新しく作らず、このIssueへ書き足します/)).toBeTruthy();
  });

  it("立ち上げが途中で失敗しても、作られたものをリンクとして出す", async () => {
    mockFetch({
      "/api/new-app/preflight": () => PREFLIGHT_OK,
      "/api/new-app": () => ({
        error: "launch_failed",
        message: "GitHub API request failed: 500",
        created: [
          {
            kind: "repository",
            title: "guchi-apps/kakei-report",
            reference: "guchi-apps/kakei-report",
            url: "https://github.com/guchi-apps/kakei-report",
          },
        ],
      }),
    });
    // 失敗を返させるため、ハンドラのok判定を上書きする
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : null;
        calls.push({ url, body });
        if (url === "/api/new-app/preflight") {
          return { ok: true, status: 200, json: async () => PREFLIGHT_OK } as Response;
        }
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: "launch_failed",
            message: "GitHub API request failed: 500",
            created: [
              {
                kind: "repository",
                title: "guchi-apps/kakei-report",
                reference: "guchi-apps/kakei-report",
                url: "https://github.com/guchi-apps/kakei-report",
              },
            ],
          }),
        } as Response;
      }),
    );

    await advanceToPlacement();
    fireEvent.click(screen.getByRole("button", { name: /次へ/ }));
    await waitFor(() => expect(screen.getByText("9件を作成します")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /立ち上げを開始/ }));

    await waitFor(() =>
      expect(screen.getByText("家計レポートの立ち上げは途中で止まりました")).toBeTruthy(),
    );
    const [link] = screen.getAllByRole("link", { name: /guchi-apps\/kakei-report/ });
    expect(link.getAttribute("href")).toBe("https://github.com/guchi-apps/kakei-report");
  });
});
