import { describe, expect, it } from "vitest";

import { parseNewAppSpec } from "@/lib/new-app/parse";

const VALID = {
  displayName: "家計レポート",
  repositoryName: "kakei-report",
  visibility: "private",
  summary: "家計の月次推移",
  kind: "next-db",
  urlMode: "subdomain",
  subdomain: "kakei-report",
  basePath: "",
  port: 3112,
  databaseName: "app_kakei_report",
  auth: "supabase-google",
  multiAgent: true,
  appTitle: "",
  pwa: true,
  offline: false,
  iconPlan: "provisional",
  themeColor: "#0f172a",
  changelog: true,
  screenshotBypass: true,
};

describe("parseNewAppSpec", () => {
  it("そろっていればそのまま読む", () => {
    expect(parseNewAppSpec(VALID)).toEqual(VALID);
  });

  it("ポートとDB名はnullを許す（静的サイト）", () => {
    const spec = parseNewAppSpec({ ...VALID, kind: "static", port: null, databaseName: null });
    expect(spec?.port).toBeNull();
    expect(spec?.databaseName).toBeNull();
  });

  it("知らない値は既定へ倒さず、要求ごと弾く", () => {
    expect(parseNewAppSpec({ ...VALID, kind: "rails" })).toBeNull();
    expect(parseNewAppSpec({ ...VALID, auth: "saml" })).toBeNull();
    expect(parseNewAppSpec({ ...VALID, urlMode: "wildcard" })).toBeNull();
    expect(parseNewAppSpec({ ...VALID, visibility: "internal" })).toBeNull();
  });

  it("型が違うものを弾く", () => {
    expect(parseNewAppSpec({ ...VALID, port: "3112" })).toBeNull();
    expect(parseNewAppSpec({ ...VALID, port: 3112.5 })).toBeNull();
    expect(parseNewAppSpec({ ...VALID, multiAgent: "yes" })).toBeNull();
    expect(parseNewAppSpec(null)).toBeNull();
    expect(parseNewAppSpec("kakei-report")).toBeNull();
  });

  it("長すぎる文字列を弾く（切り詰めて作らない）", () => {
    expect(parseNewAppSpec({ ...VALID, repositoryName: "a".repeat(200) })).toBeNull();
    expect(parseNewAppSpec({ ...VALID, summary: "あ".repeat(500) })).toBeNull();
  });

  it("前後の空白は落とす", () => {
    expect(parseNewAppSpec({ ...VALID, displayName: "  家計レポート  " })?.displayName).toBe(
      "家計レポート",
    );
  });
});

describe("parseNewAppSpec の体裁と運用（#2254）", () => {
  it("知らないアイコンの決め方は不正な要求にする", () => {
    expect(parseNewAppSpec({ ...VALID, iconPlan: "later" })).toBeNull();
  });

  it("テーマカラーが `#rrggbb` でなければ不正な要求にする", () => {
    expect(parseNewAppSpec({ ...VALID, themeColor: "#0f1" })).toBeNull();
    expect(parseNewAppSpec({ ...VALID, themeColor: "teal" })).toBeNull();
  });

  it("体裁の項目が欠けていれば既定へ倒さず不正な要求にする", () => {
    const { pwa: _pwa, ...withoutPwa } = VALID;
    expect(parseNewAppSpec(withoutPwa)).toBeNull();
  });

  it("表示名は空文字を許す（アプリ名を使う）", () => {
    expect(parseNewAppSpec({ ...VALID, appTitle: "" })?.appTitle).toBe("");
    expect(parseNewAppSpec({ ...VALID, appTitle: "  秘書  " })?.appTitle).toBe("秘書");
  });
});
