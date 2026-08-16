import { describe, expect, it } from "vitest";

import {
  describeDispatchQueueRefresh,
  describeDispatchQueueRefreshHint,
} from "@/lib/dispatch/queue-refresh";

/**
 * #1773。実行キューの更新インジケーターの文言と配色。
 *
 * 実行キューは開いている間ずっと自動で取り直しているが、その形跡が画面に無かった。
 * 取得の失敗は握り潰す作りなので、古いまま固まっていても正常時と見分けが付かない。
 */
const NOW = new Date("2026-08-16T12:00:00.000Z").getTime();
const IDLE_INTERVAL_MS = 20_000;
const ACTIVE_INTERVAL_MS = 5_000;

describe("describeDispatchQueueRefresh", () => {
  it("取得中は経過ではなく「更新中…」を出す", () => {
    expect(
      describeDispatchQueueRefresh({
        fetchedAt: NOW - 12_000,
        nowMs: NOW,
        isFetching: true,
        pollIntervalMs: IDLE_INTERVAL_MS,
      }),
    ).toEqual({ label: "更新中…", tone: "normal" });
  });

  /**
   * まだ一度も取れていないときに「0秒前に更新」を出すと、取れていないのに取れたように読める
   */
  it("まだ一度も取得できていなければ「更新中…」を出す", () => {
    expect(
      describeDispatchQueueRefresh({
        fetchedAt: null,
        nowMs: NOW,
        isFetching: false,
        pollIntervalMs: IDLE_INTERVAL_MS,
      }).label,
    ).toBe("更新中…");
  });

  /** `useNow`はマウント前に`null`を返す（サーバー描画で`Date.now()`を呼ばないため） */
  it("現在時刻が確定していなければ「更新中…」を出す", () => {
    expect(
      describeDispatchQueueRefresh({
        fetchedAt: NOW - 12_000,
        nowMs: null,
        isFetching: false,
        pollIntervalMs: IDLE_INTERVAL_MS,
      }).label,
    ).toBe("更新中…");
  });

  it("1秒未満は「たった今更新」を出す", () => {
    expect(
      describeDispatchQueueRefresh({
        fetchedAt: NOW - 300,
        nowMs: NOW,
        isFetching: false,
        pollIntervalMs: IDLE_INTERVAL_MS,
      }),
    ).toEqual({ label: "たった今更新・20秒ごと", tone: "normal" });
  });

  it("1分未満は秒で出す", () => {
    expect(
      describeDispatchQueueRefresh({
        fetchedAt: NOW - 12_000,
        nowMs: NOW,
        isFetching: false,
        pollIntervalMs: IDLE_INTERVAL_MS,
      }).label,
    ).toBe("12秒前に更新・20秒ごと");
  });

  it("1分以上は分で出す", () => {
    expect(
      describeDispatchQueueRefresh({
        fetchedAt: NOW - 125_000,
        nowMs: NOW,
        isFetching: false,
        pollIntervalMs: IDLE_INTERVAL_MS,
      }).label,
    ).toBe("2分前に更新・20秒ごと");
  });

  it("1時間以上は時間で出す", () => {
    expect(
      describeDispatchQueueRefresh({
        fetchedAt: NOW - 3 * 60 * 60 * 1000,
        nowMs: NOW,
        isFetching: false,
        pollIntervalMs: IDLE_INTERVAL_MS,
      }).label,
    ).toBe("3時間前に更新・20秒ごと");
  });

  /** 動いているジョブがある間は5秒間隔へ切り替わる。表示もその値に追従する */
  it("間隔はフックが実際に使っている値を出す", () => {
    expect(
      describeDispatchQueueRefresh({
        fetchedAt: NOW - 3_000,
        nowMs: NOW,
        isFetching: false,
        pollIntervalMs: ACTIVE_INTERVAL_MS,
      }).label,
    ).toBe("3秒前に更新・5秒ごと");
  });

  /** 1回や2回の取りこぼしは自動で追い付くので、3周ぶん落ちて初めて色を変える */
  it("間隔の3倍までは通常色のままにする", () => {
    expect(
      describeDispatchQueueRefresh({
        fetchedAt: NOW - IDLE_INTERVAL_MS * 3,
        nowMs: NOW,
        isFetching: false,
        pollIntervalMs: IDLE_INTERVAL_MS,
      }).tone,
    ).toBe("normal");
  });

  it("間隔の3倍を超えたら注意色にする", () => {
    expect(
      describeDispatchQueueRefresh({
        fetchedAt: NOW - IDLE_INTERVAL_MS * 3 - 1,
        nowMs: NOW,
        isFetching: false,
        pollIntervalMs: IDLE_INTERVAL_MS,
      }),
    ).toEqual({ label: "1分前に更新・20秒ごと", tone: "warn" });
  });

  /** 端末の時刻がずれて未来になっても「-3秒前」を出さない */
  it("取得時刻が未来でも負の経過を出さない", () => {
    expect(
      describeDispatchQueueRefresh({
        fetchedAt: NOW + 5_000,
        nowMs: NOW,
        isFetching: false,
        pollIntervalMs: IDLE_INTERVAL_MS,
      }),
    ).toEqual({ label: "たった今更新・20秒ごと", tone: "normal" });
  });
});

describe("describeDispatchQueueRefreshHint", () => {
  it("押すと何が起きるかと、放っておいても更新されることの両方を出す", () => {
    expect(describeDispatchQueueRefreshHint(IDLE_INTERVAL_MS)).toBe(
      "今すぐ更新（20秒ごとに自動更新）",
    );
    expect(describeDispatchQueueRefreshHint(ACTIVE_INTERVAL_MS)).toBe(
      "今すぐ更新（5秒ごとに自動更新）",
    );
  });
});
