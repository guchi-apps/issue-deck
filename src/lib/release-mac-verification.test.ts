import { describe, expect, it } from "vitest";

import {
  describeReleaseMac,
  parseReleaseDisplayOnlyKind,
  parseReleaseMacReport,
  type ReleaseMacRow,
} from "@/lib/release-mac-verification";
import { RELEASE_VERIFICATION_KINDS, parseReleaseVerificationKind } from "@/lib/release-merge-gate";

const current = { baseSha: "b1", headSha: "h1" };
const row = (overrides: Partial<ReleaseMacRow> = {}): ReleaseMacRow => ({
  baseSha: "b1",
  headSha: "h1",
  state: "passed",
  summary: null,
  unverifiedScope: null,
  evidenceUrl: null,
  message: null,
  updatedAt: new Date("2026-10-10T00:00:00Z"),
  ...overrides,
});
const describeRows = (rows: ReleaseMacRow[], extra: { runningNow?: boolean; configured?: boolean } = {}) =>
  describeReleaseMac({ current, rows, runningNow: extra.runningNow ?? false, configured: extra.configured });

describe("Macをゲートの種別へ混ぜない（#4366）", () => {
  it("マージゲートの種別にmacは入らず、表示専用の種別としてだけ解釈する", () => {
    expect(RELEASE_VERIFICATION_KINDS).toEqual(["integration", "ai_review"]);
    expect(parseReleaseVerificationKind("mac")).toBeNull();
    expect(parseReleaseDisplayOnlyKind("mac")).toBe("mac");
    expect(parseReleaseDisplayOnlyKind("integration")).toBeNull();
  });
});

describe("parseReleaseMacReport", () => {
  it("形が違う・待機/未実施の状態はnull（旧版のランナーはmacを送らない）", () => {
    expect(parseReleaseMacReport(undefined)).toBeNull();
    expect(parseReleaseMacReport({ state: "waiting" })).toBeNull();
    expect(parseReleaseMacReport({ state: "unknown" })).toBeNull();
    expect(parseReleaseMacReport({ state: "passed", summary: "ok" })).toMatchObject({ state: "passed", summary: "ok" });
  });
});

describe("describeReleaseMac", () => {
  it("成功・失敗・対象外・実行中を独立して区別する", () => {
    expect(describeRows([row()]).state).toBe("passed");
    expect(describeRows([row({ state: "failed", message: "ビルド失敗" })])).toMatchObject({ state: "failed", reason: "ビルド失敗" });
    expect(describeRows([row({ state: "not_applicable", message: "ios/に差分なし" })])).toMatchObject({
      state: "not_applicable",
      reason: "ios/に差分なし",
    });
    expect(describeRows([], { runningNow: true }).state).toBe("running");
  });

  it("未接続（未確認範囲つき）は設定不足で、成功や対象外へ置き換えない", () => {
    expect(describeRows([row({ state: "needs_check", unverifiedScope: "Macへ接続できません" })])).toMatchObject({
      state: "needs_setup",
      reason: "Macへ接続できません",
    });
    expect(describeRows([row({ state: "passed", unverifiedScope: "未接続" })]).state).toBe("needs_setup");
  });

  it("記録が無ければ未実施（記録なし）で、設定の無いリポジトリだけ理由付きの対象外", () => {
    expect(describeRows([]).state).toBe("not_recorded");
    expect(describeRows([], { configured: false })).toMatchObject({ state: "not_applicable" });
  });

  it("対象のSHAが変わったら旧SHAの成功を使わず、古い結果にする", () => {
    expect(describeRows([row({ headSha: "old" })]).state).toBe("invalidated");
  });
});
