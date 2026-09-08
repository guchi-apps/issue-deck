import { describe, expect, it } from "vitest";

import type { ReleaseHistoryItem } from "@/lib/github/release-api";
import {
  applyReleaseCheckToggle,
  buildReleaseCheckIndex,
  countUncheckedReleases,
  resolveReleaseCheckStatus,
  selectUncheckedReleases,
} from "@/lib/release-check";

function makeEntry(overrides: Partial<ReleaseHistoryItem> = {}): ReleaseHistoryItem {
  return {
    repoFullName: "guchi-apps/issue-deck",
    tagName: "v1.0.0",
    name: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/releases/tag/v1.0.0",
    publishedAt: "2026-09-02T05:00:00Z",
    body: null,
    ...overrides,
  };
}

const SINCE = "2026-09-01T00:00:00Z";

describe("resolveReleaseCheckStatus", () => {
  it("対象に選んでいないリポジトリは対象外になる", () => {
    const index = buildReleaseCheckIndex([], []);
    expect(resolveReleaseCheckStatus(makeEntry(), index)).toEqual({ kind: "out_of_scope" });
  });

  it("対象に加えた時刻より後のリリースは、記録が無ければ未確認になる", () => {
    const index = buildReleaseCheckIndex(
      [{ repoFullName: "guchi-apps/issue-deck", since: SINCE }],
      [],
    );
    expect(resolveReleaseCheckStatus(makeEntry(), index)).toEqual({ kind: "unchecked" });
  });

  it("対象に加えた時刻より前のリリースは対象外のまま（過去分を一斉に未確認にしない）", () => {
    const index = buildReleaseCheckIndex(
      [{ repoFullName: "guchi-apps/issue-deck", since: SINCE }],
      [],
    );
    const past = makeEntry({ publishedAt: "2026-08-20T00:00:00Z" });
    expect(resolveReleaseCheckStatus(past, index)).toEqual({ kind: "out_of_scope" });
  });

  it("記録があれば確認済みになり、確認した時刻を返す", () => {
    const index = buildReleaseCheckIndex(
      [{ repoFullName: "guchi-apps/issue-deck", since: SINCE }],
      [
        {
          repoFullName: "guchi-apps/issue-deck",
          tagName: "v1.0.0",
          checkedAt: "2026-09-03T10:00:00Z",
        },
      ],
    );
    expect(resolveReleaseCheckStatus(makeEntry(), index)).toEqual({
      kind: "checked",
      checkedAt: "2026-09-03T10:00:00Z",
    });
  });

  it("記録は同じリポジトリの別タグへ波及しない", () => {
    const index = buildReleaseCheckIndex(
      [{ repoFullName: "guchi-apps/issue-deck", since: SINCE }],
      [
        {
          repoFullName: "guchi-apps/issue-deck",
          tagName: "v1.0.0",
          checkedAt: "2026-09-03T10:00:00Z",
        },
      ],
    );
    expect(resolveReleaseCheckStatus(makeEntry({ tagName: "v1.1.0" }), index)).toEqual({
      kind: "unchecked",
    });
  });

  it("対象から外したリポジトリは、記録が残っていても対象外になる", () => {
    const index = buildReleaseCheckIndex(
      [],
      [
        {
          repoFullName: "guchi-apps/issue-deck",
          tagName: "v1.0.0",
          checkedAt: "2026-09-03T10:00:00Z",
        },
      ],
    );
    expect(resolveReleaseCheckStatus(makeEntry(), index)).toEqual({ kind: "out_of_scope" });
  });

  it("公開時刻が無いリリースは対象外にする", () => {
    const index = buildReleaseCheckIndex(
      [{ repoFullName: "guchi-apps/issue-deck", since: SINCE }],
      [],
    );
    expect(resolveReleaseCheckStatus(makeEntry({ publishedAt: null }), index)).toEqual({
      kind: "out_of_scope",
    });
  });

  it("日付として読めないsinceの行は対象に数えない", () => {
    const index = buildReleaseCheckIndex(
      [{ repoFullName: "guchi-apps/issue-deck", since: "not-a-date" }],
      [],
    );
    expect(resolveReleaseCheckStatus(makeEntry(), index)).toEqual({ kind: "out_of_scope" });
  });
});

describe("selectUncheckedReleases / countUncheckedReleases", () => {
  const entries = [
    makeEntry({ tagName: "v1.2.0" }),
    makeEntry({ tagName: "v1.1.0" }),
    makeEntry({ repoFullName: "guchi-apps/car-care", tagName: "v9.0.0" }),
  ];
  const index = buildReleaseCheckIndex(
    [{ repoFullName: "guchi-apps/issue-deck", since: SINCE }],
    [
      {
        repoFullName: "guchi-apps/issue-deck",
        tagName: "v1.1.0",
        checkedAt: "2026-09-03T10:00:00Z",
      },
    ],
  );

  it("未確認だけを残す（確認済みと対象外は落とす）", () => {
    expect(selectUncheckedReleases(entries, index).map((entry) => entry.tagName)).toEqual([
      "v1.2.0",
    ]);
  });

  it("件数は未確認の数と一致する", () => {
    expect(countUncheckedReleases(entries, index)).toBe(1);
  });
});

describe("applyReleaseCheckToggle", () => {
  const target = { repoFullName: "guchi-apps/issue-deck", tagName: "v1.0.0" };
  const now = new Date("2026-09-06T12:00:00Z");

  it("確認済みにすると記録が1件増える", () => {
    expect(applyReleaseCheckToggle([], target, true, now)).toEqual([
      { ...target, checkedAt: "2026-09-06T12:00:00.000Z" },
    ]);
  });

  it("未確認に戻すと記録が消える", () => {
    const records = [{ ...target, checkedAt: "2026-09-03T10:00:00Z" }];
    expect(applyReleaseCheckToggle(records, target, false, now)).toEqual([]);
  });

  it("同じリリースを二重に確認済みにしても記録は1件のまま", () => {
    const records = [{ ...target, checkedAt: "2026-09-03T10:00:00Z" }];
    expect(applyReleaseCheckToggle(records, target, true, now)).toEqual([
      { ...target, checkedAt: "2026-09-06T12:00:00.000Z" },
    ]);
  });

  it("他のリリースの記録は残す", () => {
    const other = {
      repoFullName: "guchi-apps/car-care",
      tagName: "v9.0.0",
      checkedAt: "2026-09-01T10:00:00Z",
    };
    expect(applyReleaseCheckToggle([other], target, true, now)).toEqual([
      other,
      { ...target, checkedAt: "2026-09-06T12:00:00.000Z" },
    ]);
  });
});
