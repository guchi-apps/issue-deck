import { describe, expect, it } from "vitest";

import { checkConsistency } from "../../../ios/scripts/check-consistency.mjs";

describe("iOSアプリとサーバーの整合", () => {
  it("戻り先スキーム・横取りするパス・同一オリジン判定・エフェメラルがSwiftとTSで揃っている", () => {
    expect(checkConsistency()).toEqual([]);
  });
});
