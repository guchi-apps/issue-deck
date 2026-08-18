import { describe, expect, it } from "vitest";

import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import {
  describeDispatchHostCheckout,
  parseDispatchHostCheckout,
  type DispatchHostCheckout,
} from "@/lib/dispatch/host-checkout";

const NOW = new Date("2026-08-16T12:00:00.000Z");

const CHECKOUT: DispatchHostCheckout = {
  commit: "fbb809d",
  branch: "develop",
  committedAt: "2026-08-16T09:00:00.000Z",
  behindCount: 0,
  fetchedAt: "2026-08-16T11:00:00.000Z",
};

function host(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: NOW.toISOString(),
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: null,
    planReviewCapable: null,
    selfUpdateCapable: null,
    maxSessions: 12,
    liveSessions: 2,
    metrics: null,
    checkout: CHECKOUT,
    ...overrides,
  };
}

describe("parseDispatchHostCheckout（#1612）", () => {
  it("pollerが送る形をそのまま読む", () => {
    expect(
      parseDispatchHostCheckout({
        commit: "fbb809d",
        branch: "develop",
        committedAt: "2026-08-16T09:00:00Z",
        behindCount: 97,
        fetchedAt: "2026-08-16T11:00:00Z",
      }),
    ).toEqual({
      commit: "fbb809d",
      branch: "develop",
      committedAt: "2026-08-16T09:00:00.000Z",
      behindCount: 97,
      fetchedAt: "2026-08-16T11:00:00.000Z",
    });
  });

  // 版が特定できない申告に意味が無いため、ここだけは全体を落とす
  it("commitが無い・SHAの形でなければ申告そのものを落とす", () => {
    expect(parseDispatchHostCheckout({ branch: "develop", behindCount: 0 })).toBeNull();
    expect(parseDispatchHostCheckout({ commit: "not-a-sha" })).toBeNull();
    expect(parseDispatchHostCheckout({ commit: "fbb80" })).toBeNull();
    expect(parseDispatchHostCheckout(null)).toBeNull();
    expect(parseDispatchHostCheckout("fbb809d")).toBeNull();
  });

  /**
   * 使用率（`parseDispatchHostMetrics`）が1つでも壊れていれば全体を落とすのとは向きが違う。
   * あちらは割合として並ぶ5つで、欠けた項目が0＝空きに見えてしまうのに対し、こちらは
   * 独立した事実の集まりで、1つ欠けても残りが誤読されない。
   */
  it("commit以外は欠けていても全体を落とさず、その項目だけnullにする", () => {
    expect(parseDispatchHostCheckout({ commit: "FBB809D" })).toEqual({
      commit: "fbb809d",
      branch: null,
      committedAt: null,
      behindCount: null,
      fetchedAt: null,
    });
    expect(
      parseDispatchHostCheckout({
        commit: "fbb809d",
        branch: "de velop",
        committedAt: "壊れた日付",
        behindCount: -1,
        fetchedAt: 12345,
      }),
    ).toEqual({
      commit: "fbb809d",
      branch: null,
      committedAt: null,
      behindCount: null,
      fetchedAt: null,
    });
  });
});

describe("describeDispatchHostCheckout（#1612）", () => {
  it("追い付いていれば控えめに出す", () => {
    expect(describeDispatchHostCheckout(host(), NOW)).toEqual({
      version: "develop fbb809d",
      status: "最新",
      detail: "3時間前",
      tone: "normal",
    });
  });

  // マージ直後は必ずここを通るため、数コミットの遅れは橙にとどめる
  it("少し遅れていれば橙", () => {
    expect(describeDispatchHostCheckout(host({ checkout: { ...CHECKOUT, behindCount: 3 } }), NOW))
      .toMatchObject({ status: "3コミット遅れ", tone: "warn" });
  });

  // #1600のときは97コミット遅れており、マージ済みの修正が2件とも効いていなかった
  it("日をまたいで放置された遅れは赤", () => {
    expect(describeDispatchHostCheckout(host({ checkout: { ...CHECKOUT, behindCount: 97 } }), NOW))
      .toMatchObject({ status: "97コミット遅れ", tone: "critical" });
  });

  // fetchできていないだけで「遅れていない」とは言えない。遅れ0と同じ顔にしない
  it("数えられなかった場合は遅れ不明として出す", () => {
    expect(
      describeDispatchHostCheckout(host({ checkout: { ...CHECKOUT, behindCount: null } }), NOW),
    ).toMatchObject({ status: "遅れ不明", tone: "warn" });
  });

  // 毎巡fetchしないため、0が「いつ時点の0か」が分からないと意味が定まらない
  it("数字の元になったfetchが古ければ、いつ時点かを添える", () => {
    expect(
      describeDispatchHostCheckout(
        host({ checkout: { ...CHECKOUT, fetchedAt: "2026-08-15T00:00:00.000Z" } }),
        NOW,
      ),
    ).toMatchObject({ status: "最新", detail: "3時間前・1日前時点" });
  });

  it("detached HEADはブランチ名の代わりにその事実を出す", () => {
    expect(
      describeDispatchHostCheckout(host({ checkout: { ...CHECKOUT, branch: null } }), NOW),
    ).toMatchObject({ version: "fbb809d（detached）" });
  });

  // 古い申告を今の姿として見せない（使用率と同じ扱い）
  it("申告が無い・応答していないホストでは行ごと出さない", () => {
    expect(describeDispatchHostCheckout(host({ checkout: null }), NOW)).toBeNull();
    expect(describeDispatchHostCheckout(host({ online: false }), NOW)).toBeNull();
  });
});
