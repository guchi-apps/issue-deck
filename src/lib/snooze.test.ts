import { describe, expect, it } from "vitest";

import {
  buildSnoozeKey,
  buildSnoozeMap,
  buildSnoozePresets,
  defaultSnoozeUntilDateValue,
  describeSnoozeResume,
  describeSnoozeUntil,
  findActiveIssueSnooze,
  findActiveSnooze,
  isSnoozeActive,
  parseSnoozeUntilDate,
  selectSnoozedIssueIds,
  type SnoozeEntry,
} from "@/lib/snooze";
import type { Issue } from "@/types/issue";

const REPO = "guchi-apps/issue-deck";
/** 2026年8月27日 21:00（日本時間）。日付の境界をまたぐ判定を確かめるため、JSTの夜に置く */
const NOW = Date.parse("2026-08-27T12:00:00.000Z");

function entry(overrides: Partial<SnoozeEntry> = {}): SnoozeEntry {
  return { kind: "issue", repositoryFullName: REPO, number: 1, until: null, ...overrides };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: `issue-${overrides.number ?? 1}`,
    number: 1,
    title: "サンプル",
    repositoryFullName: REPO,
    ...overrides,
  } as Issue;
}

describe("buildSnoozeKey", () => {
  it("種別が違えば別の対象として扱う（同じリポジトリのIssue #12 とPR #12 は別物）", () => {
    expect(buildSnoozeKey({ kind: "issue", repositoryFullName: REPO, number: 12 })).not.toBe(
      buildSnoozeKey({ kind: "pull-request", repositoryFullName: REPO, number: 12 }),
    );
  });
});

describe("isSnoozeActive", () => {
  it("untilがnullなら手動で解除するまで効き続ける", () => {
    expect(isSnoozeActive(entry({ until: null }), NOW)).toBe(true);
  });

  it("untilが未来なら効いている", () => {
    expect(isSnoozeActive(entry({ until: "2026-09-01T00:00:00.000Z" }), NOW)).toBe(true);
  });

  it("untilを過ぎていれば効いていない（行が残っていても件数と通知へ戻る）", () => {
    expect(isSnoozeActive(entry({ until: "2026-08-27T11:59:59.000Z" }), NOW)).toBe(false);
  });

  it("読めない時刻は効いていない側へ倒す（要対応の項目が永久に消えないように）", () => {
    expect(isSnoozeActive(entry({ until: "９月" }), NOW)).toBe(false);
  });

  it("現在時刻が未取得（マウント前）のあいだは効いていない扱いにする", () => {
    expect(isSnoozeActive(entry({ until: null }), null)).toBe(false);
  });
});

describe("findActiveSnooze", () => {
  const snoozes = buildSnoozeMap([
    entry({ number: 1, until: "2026-09-01T00:00:00.000Z" }),
    entry({ number: 2, until: "2026-08-01T00:00:00.000Z" }),
    entry({ kind: "pull-request", number: 3, until: null }),
  ]);

  it("効いている保留を返す", () => {
    expect(
      findActiveSnooze(snoozes, { kind: "issue", repositoryFullName: REPO, number: 1 }, NOW),
    ).not.toBeNull();
  });

  it("期限切れはnull", () => {
    expect(
      findActiveSnooze(snoozes, { kind: "issue", repositoryFullName: REPO, number: 2 }, NOW),
    ).toBeNull();
  });

  it("Pull Requestも同じ表から引ける", () => {
    expect(
      findActiveSnooze(
        snoozes,
        { kind: "pull-request", repositoryFullName: REPO, number: 3 },
        NOW,
      ),
    ).not.toBeNull();
  });

  it("同じ番号でも種別が違えば引き当てない", () => {
    expect(
      findActiveSnooze(snoozes, { kind: "issue", repositoryFullName: REPO, number: 3 }, NOW),
    ).toBeNull();
  });
});

describe("selectSnoozedIssueIds", () => {
  it("効いている保留を持つIssueのidだけを返す", () => {
    const snoozes = buildSnoozeMap([
      entry({ number: 1, until: "2026-09-01T00:00:00.000Z" }),
      entry({ number: 2, until: "2026-08-01T00:00:00.000Z" }),
    ]);
    const ids = selectSnoozedIssueIds(
      [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 })],
      snoozes,
      NOW,
    );
    expect([...ids]).toEqual(["issue-1"]);
  });

  it("保留が1件も無ければ空（一覧・件数は今までどおり）", () => {
    expect(selectSnoozedIssueIds([issue()], buildSnoozeMap([]), NOW).size).toBe(0);
  });
});

describe("findActiveIssueSnooze", () => {
  it("リポジトリが違えば引き当てない", () => {
    const snoozes = buildSnoozeMap([entry({ number: 1, until: null })]);
    expect(
      findActiveIssueSnooze(
        snoozes,
        { repositoryFullName: "guchi-apps/vps", number: 1 },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("describeSnoozeUntil", () => {
  it("手動解除はその旨を出す", () => {
    expect(describeSnoozeUntil(null, NOW)).toBe("手動で解除するまで");
  });

  it("当日中に戻るものは時刻まで出す（すでに戻っているように読めないように）", () => {
    expect(describeSnoozeUntil("2026-08-27T14:30:00.000Z", NOW)).toBe("今日 23:30まで");
  });

  it("年内は月日だけ", () => {
    expect(describeSnoozeUntil("2026-08-31T15:00:00.000Z", NOW)).toBe("9月1日まで");
  });

  it("年をまたぐものは年を添える", () => {
    expect(describeSnoozeUntil("2027-01-04T15:00:00.000Z", NOW)).toBe("2027年1月5日まで");
  });
});

describe("describeSnoozeResume", () => {
  it("いちばん早く戻るものを出す", () => {
    expect(
      describeSnoozeResume(
        [
          entry({ number: 1, until: "2026-09-10T15:00:00.000Z" }),
          entry({ number: 2, until: "2026-08-31T15:00:00.000Z" }),
        ],
        NOW,
      ),
    ).toBe("最短で9月1日に戻ります");
  });

  it("手動解除が混ざっているときは「早いもので」と書く（全部は戻らないため）", () => {
    expect(
      describeSnoozeResume(
        [entry({ number: 1, until: null }), entry({ number: 2, until: "2026-08-31T15:00:00.000Z" })],
        NOW,
      ),
    ).toBe("早いもので9月1日に戻ります");
  });

  it("全部が手動解除待ちなら日付を出さない", () => {
    expect(describeSnoozeResume([entry({ until: null })], NOW)).toBe(
      "手動で解除するまで戻りません",
    );
  });

  it("期限切れの保留は数えない", () => {
    expect(
      describeSnoozeResume(
        [
          entry({ number: 1, until: "2026-08-01T00:00:00.000Z" }),
          entry({ number: 2, until: "2026-08-31T15:00:00.000Z" }),
        ],
        NOW,
      ),
    ).toBe("最短で9月1日に戻ります");
  });
});

describe("buildSnoozePresets", () => {
  it("戻る時刻は日本時間のその日の0:00に揃える（押した時刻でばらつかない）", () => {
    const presets = buildSnoozePresets(NOW);
    expect(presets.map((preset) => preset.label)).toEqual([
      "明日まで",
      "3日後まで",
      "1週間後まで",
      "手動で解除するまで",
    ]);
    expect(presets[0]?.until).toBe("2026-08-27T15:00:00.000Z");
    expect(presets[0]?.hint).toBe("8/28");
    expect(presets[2]?.hint).toBe("9/3");
  });

  it("手動解除の選択肢はuntilを持たない", () => {
    expect(buildSnoozePresets(NOW).at(-1)).toMatchObject({ until: null, hint: null });
  });
});

describe("parseSnoozeUntilDate", () => {
  it("日付入力を日本時間のその日の0:00として読む（UTCの端末でも9時間ずれない）", () => {
    expect(parseSnoozeUntilDate("2026-09-01")).toBe("2026-08-31T15:00:00.000Z");
  });

  it("空欄・読めない値はnull", () => {
    expect(parseSnoozeUntilDate("")).toBeNull();
    expect(parseSnoozeUntilDate("9月1日")).toBeNull();
  });
});

describe("defaultSnoozeUntilDateValue", () => {
  it("既定は1週間後（入力欄がそのまま押せる値になっている）", () => {
    expect(defaultSnoozeUntilDateValue(NOW)).toBe("2026-09-03");
  });
});
