import { describe, expect, it } from "vitest";

import {
  buildRebuildEpisodes,
  decideAutoRebuildTrigger,
  excludedFromSelection,
  rebuildEventKey,
  unapprovedPrs,
  type RebuildEventView,
} from "./release-rebuild-history";

type Ev = RebuildEventView & { originPrNumber: number; originHeadSha: string };
let seq = 0;
function ev(partial: Partial<Ev> & Pick<Ev, "kind">): Ev {
  seq += 1;
  return {
    id: `e${seq}`,
    actorKind: "system",
    actorName: null,
    trigger: "sweep",
    reason: null,
    seriesId: null,
    payload: {},
    createdAt: `2026-10-11T02:0${seq % 10}:00.000Z`,
    originPrNumber: 4345,
    originHeadSha: "a".repeat(40),
    ...partial,
  };
}

describe("buildRebuildEpisodes", () => {
  it("手動承認→承認を契機にした自動作り直し→後継候補を、承認範囲・取り込み範囲つきで区別する", () => {
    seq = 0;
    const episodes = buildRebuildEpisodes([
      ev({ kind: "decision_waiting", payload: { pendingPrs: [4339, 4344] } }),
      ev({ kind: "approval", actorKind: "user", actorName: "guchi", trigger: "manual", payload: { approvedPrs: [{ number: 4339 }, { number: 4344 }] } }),
      ev({
        kind: "rebuild_started",
        trigger: "fix_series_after_approval",
        payload: { selectedPrs: [{ number: 4353, mergeSha: "b".repeat(40) }], excludedPrs: [4339], approvalEventId: "e2" },
      }),
      ev({ kind: "successor_created", payload: { successor: { number: 4360, headSha: "c".repeat(40), baseSha: null } } }),
    ]);
    expect(episodes).toHaveLength(1);
    const [episode] = episodes;
    expect(episode.phase).toBe("successor_created");
    expect(episode.pathUnknown).toBe(false);
    expect(episode.approvals).toHaveLength(1);
    expect(episode.approvals[0].actorName).toBe("guchi");
    expect(episode.selectedPrs.map((p) => p.number)).toEqual([4353]);
    expect(episode.excludedPrs).toEqual([4339]);
    expect(episode.successor?.number).toBe(4360);
  });

  it("後継候補の作成だけが記録され開始の記録が無ければ、操作経路不明にして承認を作らない", () => {
    seq = 0;
    const [episode] = buildRebuildEpisodes([
      ev({ kind: "successor_created", payload: { successor: { number: 9, headSha: null, baseSha: null } } }),
    ]);
    expect(episode.pathUnknown).toBe(true);
    expect(episode.approvals).toEqual([]);
  });

  it("記録の無い既存履歴（合成イベントのみ）は経路不明の現在地になる", () => {
    seq = 0;
    const [episode] = buildRebuildEpisodes([ev({ kind: "legacy_unknown", actorKind: "unknown", trigger: "unknown" })]);
    expect(episode.pathUnknown).toBe(true);
    expect(episode.phase).toBe("unknown");
  });

  it("失敗のあとで開始し直した経過は準備中になり、選択内容は直近の開始のものを保持する", () => {
    seq = 0;
    const [episode] = buildRebuildEpisodes([
      ev({ kind: "rebuild_started", payload: { selectedPrs: [{ number: 1 }] } }),
      ev({ kind: "rebuild_failed" }),
    ]);
    expect(episode.phase).toBe("failed");
    expect(episode.selectedPrs.map((p) => p.number)).toEqual([1]);
    seq = 0;
    const [retried] = buildRebuildEpisodes([
      ev({ kind: "rebuild_started", payload: { selectedPrs: [{ number: 1 }] } }),
      ev({ kind: "rebuild_failed" }),
      ev({ kind: "rebuild_started", trigger: "resume", payload: { selectedPrs: [{ number: 1 }] } }),
    ]);
    expect(retried.phase).toBe("preparing");
  });

  it("元候補ごとに経過を分け、新しい更新の経過を先頭にする", () => {
    seq = 0;
    const older = ev({ kind: "stopped", originPrNumber: 1, originHeadSha: "1".repeat(40), createdAt: "2026-10-10T00:00:00.000Z" });
    const newer = ev({ kind: "rebuild_started", originPrNumber: 2, originHeadSha: "2".repeat(40), createdAt: "2026-10-11T00:00:00.000Z" });
    expect(buildRebuildEpisodes([older, newer]).map((e) => e.originPrNumber)).toEqual([2, 1]);
  });
});

describe("範囲の判定", () => {
  it("元候補＋修正A、無関係B、承認後に追加されたC: 選んだAだけ含め、B・Cは含めず、Cは承認済みにならない", () => {
    expect(excludedFromSelection([10, 11, 12], [10])).toEqual([11, 12]);
    expect(unapprovedPrs([10, 11, 12], [10, 11])).toEqual([12]);
  });
  it("承認イベントが根拠にあれば承認を契機にした自動、無ければ関連修正のみ", () => {
    expect(decideAutoRebuildTrigger({ approvalEventId: "x" })).toBe("fix_series_after_approval");
    expect(decideAutoRebuildTrigger({ approvalEventId: null })).toBe("fix_series_related");
  });
});

describe("rebuildEventKey", () => {
  it("同じ依頼は順序が違っても同じ鍵になり、別の範囲は別の鍵になる", () => {
    const a = rebuildEventKey.approval("o/r", 1, "s", [2, 1], ["b", "a"]);
    expect(a).toBe(rebuildEventKey.approval("o/r", 1, "s", [1, 2], ["a", "b"]));
    expect(a).not.toBe(rebuildEventKey.approval("o/r", 1, "s", [1, 2, 3], ["a", "b"]));
    expect(rebuildEventKey.stop("s1", "stopped", "理由")).toBe(rebuildEventKey.stop("s1", "stopped", "理由"));
  });
});
