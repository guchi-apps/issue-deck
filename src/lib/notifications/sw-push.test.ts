import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * `public/sw.js`のpushハンドラのテスト（#2195）。
 *
 * Service Workerはバンドルされない素のJSで、importできない。**ファイルを読んで、偽の`self`を
 * 渡して動かす**ことで、通知を出す・出さないの分岐だけを確かめる。テスト通知が
 * 「押した画面が表示中だから」という理由で毎回握りつぶされていたのを取りこぼさないため。
 */

const SW_SOURCE = readFileSync(path.join(process.cwd(), "public/sw.js"), "utf8");

type ShowNotification = ReturnType<typeof vi.fn>;

/** 偽の`self`でsw.jsを読み込み、pushイベントを1回流す */
async function dispatchPush(options: {
  /** 通知の中身。`"unreadable"`のときは`json()`が投げる（読めない通知の再現） */
  payload: unknown | "unreadable";
  /** 表示中のウィンドウがあるか */
  visible: boolean;
}): Promise<ShowNotification> {
  const showNotification = vi.fn(async () => {});
  const listeners = new Map<string, (event: unknown) => void>();

  const fakeSelf = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, handler);
    },
    skipWaiting: () => {},
    location: { origin: "https://example.test" },
    registration: { showNotification },
    clients: {
      claim: async () => {},
      matchAll: async () => [
        { visibilityState: options.visible ? "visible" : "hidden", url: "https://example.test/" },
      ],
      openWindow: async () => {},
    },
  };

  // sw.jsは`self.`経由でしかグローバルを触らないので、引数で差し替えられる
  new Function("self", SW_SOURCE)(fakeSelf);

  const push = listeners.get("push");
  expect(push).toBeTypeOf("function");

  let waited: Promise<unknown> = Promise.resolve();
  push?.({
    data: {
      json: () => {
        if (options.payload === "unreadable") throw new Error("読めない中身");
        return options.payload;
      },
    },
    waitUntil: (promise: Promise<unknown>) => {
      waited = promise;
    },
  });
  await waited;

  return showNotification;
}

const CHECK_USER_PAYLOAD = {
  title: "確認待ちのIssueがあります",
  body: "#2195 テスト通知が届かない",
  url: "/dashboard?issue=2195",
  tag: "check-user:2195",
};

describe("public/sw.js のpushハンドラ", () => {
  it("表示中のウィンドウがあるとき、確認待ちの通知は出さない（トーストと二重になるため）", async () => {
    const showNotification = await dispatchPush({ payload: CHECK_USER_PAYLOAD, visible: true });
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("表示中のウィンドウが無ければ、確認待ちの通知を出す", async () => {
    const showNotification = await dispatchPush({ payload: CHECK_USER_PAYLOAD, visible: false });
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][0]).toBe("確認待ちのIssueがあります");
    expect(showNotification.mock.calls[0][1]).toMatchObject({
      tag: "check-user:2195",
      data: { url: "/dashboard?issue=2195" },
    });
  });

  it("`force`が付いた通知は、表示中でも出す（テスト通知は押した画面が必ず表示中になる）", async () => {
    const showNotification = await dispatchPush({
      payload: {
        title: "IssueDeckのテスト通知",
        body: "この通知が見えていれば、確認待ちになったときも届きます",
        url: "/dashboard",
        tag: "test",
        force: true,
      },
      visible: true,
    });
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][0]).toBe("IssueDeckのテスト通知");
    expect(showNotification.mock.calls[0][1]).toMatchObject({ tag: "test" });
  });

  it("中身を読めない通知でも、既定の文面で出す（無言で捨てない）", async () => {
    const showNotification = await dispatchPush({
      payload: "unreadable",
      visible: false,
    });
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][0]).toBe("確認待ちのIssueがあります");
  });
});
