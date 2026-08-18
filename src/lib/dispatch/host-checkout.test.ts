import { describe, expect, it } from "vitest";

import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import {
  describeDispatchHostCheckout,
  describeDispatchHostSelfUpdate,
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
    manualStepAbortCapable: null,
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

/**
 * #1927。押した「更新して再起動」の結果は、ここが返す1行にしか出ない
 * （`SELF_UPDATE`は実行キューの一覧に載らない）。
 */
describe("describeDispatchHostSelfUpdate（#1927）", () => {
  function selfUpdateJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
    return {
      id: "job-1",
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 0,
      issueTitle: null,
      issueId: null,
      targetHost: "subpc",
      kind: "SELF_UPDATE",
      status: "QUEUED",
      message: null,
      instruction: null,
      command: null,
      manualStepLine: null,
      targetJobId: null,
      exitCode: null,
      commandOutput: null,
      tmuxSessionName: null,
      queuePriority: 0,
      createdAt: NOW.toISOString(),
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
      ...overrides,
    };
  }

  it("積んだ直後は届くまでの目安を出し、押し直させない", () => {
    expect(describeDispatchHostSelfUpdate(selfUpdateJob(), NOW)).toEqual({
      label: "更新を積みました（届くまで最大30秒）",
      tone: "normal",
      pending: true,
    });
    expect(describeDispatchHostSelfUpdate(selfUpdateJob({ status: "RUNNING" }), NOW)).toEqual({
      label: "更新しています",
      tone: "normal",
      pending: true,
    });
  });

  // pollerが返した理由（「作業ツリーに未コミットの変更があります」等）は、ここに出さないと
  // 画面のどこにも出ないまま24時間で消える
  it("失敗はpollerが返した理由をそのまま添えて赤で出す", () => {
    expect(
      describeDispatchHostSelfUpdate(
        selfUpdateJob({
          status: "FAILED",
          message: "作業ツリーに未コミットの変更があります。手元で確認してください。",
          finishedAt: NOW.toISOString(),
        }),
        NOW,
      ),
    ).toEqual({
      label: "更新できませんでした: 作業ツリーに未コミットの変更があります。手元で確認してください。",
      tone: "critical",
      pending: false,
    });
  });

  it("成功はpollerの文言をそのまま出す（journaldの文言と揃える）", () => {
    expect(
      describeDispatchHostSelfUpdate(
        selfUpdateJob({
          status: "SUCCEEDED",
          message: "7b71764 → fbb809d へ更新しました。再起動します。",
          finishedAt: NOW.toISOString(),
        }),
        NOW,
      ),
    ).toMatchObject({ label: "7b71764 → fbb809d へ更新しました。再起動します。", pending: false });
  });

  // 終了したジョブは24時間ぶん画面へ返る。翌日まで「更新しました」が残らないようにする
  it("終わってから時間が経った更新は出さない", () => {
    expect(
      describeDispatchHostSelfUpdate(
        selfUpdateJob({
          status: "SUCCEEDED",
          finishedAt: new Date(NOW.getTime() - 11 * 60 * 1000).toISOString(),
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it("積んだ更新が無ければ何も出さない", () => {
    expect(describeDispatchHostSelfUpdate(null, NOW)).toBeNull();
  });
});
