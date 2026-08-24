import { describe, expect, it } from "vitest";

import {
  appTitleFor,
  appearanceSummary,
  databaseNameFor,
  defaultsForKind,
  emptyNewAppSpec,
  hostnameFor,
  isAppearanceDefault,
  isValidRepositoryName,
  isValidThemeColor,
  offlineEnabled,
  screenshotBypassEnabled,
  isValidSubdomain,
  publicUrlFor,
  slugifyRepositoryName,
  validateNewAppSpec,
  vpsAppListLocation,
  type NewAppSpec,
} from "@/lib/new-app/spec";

function spec(overrides: Partial<NewAppSpec> = {}): NewAppSpec {
  return {
    ...emptyNewAppSpec(),
    displayName: "家計レポート",
    repositoryName: "kakei-report",
    summary: "家計の月次推移",
    subdomain: "kakei-report",
    port: 3112,
    databaseName: "app_kakei_report",
    ...overrides,
  };
}

describe("slugifyRepositoryName", () => {
  it("英字の表示名はケバブケースへ落とす", () => {
    expect(slugifyRepositoryName("Kakei Report")).toBe("kakei-report");
    expect(slugifyRepositoryName("  My  App!! ")).toBe("my-app");
  });

  it("ASCIIに落ちない名前では空文字を返す（誤った綴りを既定値にしない）", () => {
    expect(slugifyRepositoryName("家計レポート")).toBe("");
  });
});

describe("isValidRepositoryName", () => {
  it("英小文字・数字・ハイフンのみを通す", () => {
    expect(isValidRepositoryName("kakei-report")).toBe(true);
    expect(isValidRepositoryName("app2")).toBe(true);
  });

  it("先頭・末尾のハイフンと大文字・記号は弾く", () => {
    expect(isValidRepositoryName("-app")).toBe(false);
    expect(isValidRepositoryName("app-")).toBe(false);
    expect(isValidRepositoryName("App")).toBe(false);
    expect(isValidRepositoryName("my_app")).toBe(false);
    expect(isValidRepositoryName("")).toBe(false);
  });
});

describe("isValidSubdomain", () => {
  it("多段のサブドメインを許す（klondike.game のような実例がある）", () => {
    expect(isValidSubdomain("klondike.game")).toBe(true);
  });

  it("空・不正なラベルは弾く", () => {
    expect(isValidSubdomain("")).toBe(false);
    expect(isValidSubdomain("a..b")).toBe(false);
    expect(isValidSubdomain("-a")).toBe(false);
  });
});

describe("databaseNameFor", () => {
  it("ハイフンをアンダースコアにする（MySQLの識別子に使えないため）", () => {
    expect(databaseNameFor("kakei-report")).toBe("app_kakei_report");
    expect(databaseNameFor("myroom")).toBe("app_myroom");
  });
});

describe("hostnameFor / publicUrlFor / vpsAppListLocation", () => {
  it("サブドメイン直下", () => {
    const s = spec();
    expect(hostnameFor(s)).toBe("kakei-report.gucchii.com");
    expect(publicUrlFor(s)).toBe("https://kakei-report.gucchii.com/");
    expect(vpsAppListLocation(s)).toBe("kakei-report.gucchii.com / 3112");
  });

  it("既存サイト配下のパス", () => {
    const s = spec({ urlMode: "path", basePath: "kakei-report" });
    expect(hostnameFor(s)).toBe("gucchii.com");
    expect(publicUrlFor(s)).toBe("https://gucchii.com/kakei-report");
    expect(vpsAppListLocation(s)).toBe("gucchii.com/kakei-report / 3112");
  });

  it("ポートを持たない静的サイトでは「/ ポート」を付けない", () => {
    const s = spec({ kind: "static", port: null });
    expect(vpsAppListLocation(s)).toBe("kakei-report.gucchii.com");
  });
});

describe("defaultsForKind", () => {
  it("DBを使う種別だけDB名を決める", () => {
    expect(defaultsForKind("next-db", "kakei-report").databaseName).toBe("app_kakei_report");
    expect(defaultsForKind("next", "kakei-report").databaseName).toBeNull();
    expect(defaultsForKind("static", "kakei-report").databaseName).toBeNull();
  });

  it("ポートは実物を見ないと決まらないので既定ではnull", () => {
    expect(defaultsForKind("next-db", "kakei-report").port).toBeNull();
  });
});

describe("validateNewAppSpec", () => {
  it("埋まっていれば誤りなし", () => {
    expect(validateNewAppSpec(spec())).toEqual([]);
  });

  it("空の初期値では必須項目が並ぶ", () => {
    const errors = validateNewAppSpec(emptyNewAppSpec());
    expect(errors).toContain("display_name_required");
    expect(errors).toContain("repository_name_required");
    expect(errors).toContain("subdomain_required");
    expect(errors).toContain("port_required");
    expect(errors).toContain("database_name_required");
  });

  it("ポートが種別の割り当て範囲から外れていれば指摘する", () => {
    expect(validateNewAppSpec(spec({ port: 3000 }))).toContain("port_out_of_range");
    expect(validateNewAppSpec(spec({ kind: "fastapi", port: 3112 }))).toContain("port_out_of_range");
    expect(validateNewAppSpec(spec({ kind: "fastapi", port: 8003 }))).toEqual([]);
  });

  it("静的サイトではポートもDBも要求しない", () => {
    expect(validateNewAppSpec(spec({ kind: "static", port: null, databaseName: null }))).toEqual([]);
  });

  it("パス配置ではサブドメインではなくパスを要求する", () => {
    const s = spec({ urlMode: "path", subdomain: "", basePath: "" });
    const errors = validateNewAppSpec(s);
    expect(errors).toContain("base_path_required");
    expect(errors).not.toContain("subdomain_required");
  });
});

describe("体裁と運用（#2254）", () => {
  it("既定は「PWA対応・オフラインなし・アイコン暫定・更新履歴あり・撮影バイパスあり」", () => {
    const base = emptyNewAppSpec();
    expect(base.pwa).toBe(true);
    expect(base.offline).toBe(false);
    expect(base.iconPlan).toBe("provisional");
    expect(base.changelog).toBe(true);
    expect(base.screenshotBypass).toBe(true);
    expect(isAppearanceDefault(base)).toBe(true);
  });

  it("表示名が空ならアプリ名を使う", () => {
    expect(appTitleFor(spec())).toBe("家計レポート");
    expect(appTitleFor(spec({ appTitle: "  家計  " }))).toBe("家計");
  });

  it("PWA対応しないならオフライン対応も成立しない", () => {
    expect(offlineEnabled(spec({ pwa: false, offline: true }))).toBe(false);
    expect(offlineEnabled(spec({ pwa: true, offline: true }))).toBe(true);
  });

  it("認証が無いアプリでは撮影バイパスを不要にする", () => {
    expect(screenshotBypassEnabled(spec({ auth: "none", screenshotBypass: true }))).toBe(false);
    expect(screenshotBypassEnabled(spec({ auth: "supabase-google" }))).toBe(true);
  });

  it("標準から外すと「標準どおり」ではなくなる（表示名は判定に含めない）", () => {
    expect(isAppearanceDefault(spec({ appTitle: "家計" }))).toBe(true);
    expect(isAppearanceDefault(spec({ changelog: false }))).toBe(false);
    expect(isAppearanceDefault(spec({ themeColor: "#0f766e" }))).toBe(false);
  });

  it("要約は決めた値をそのまま並べる", () => {
    const summary = appearanceSummary(spec({ auth: "supabase-google" }));
    expect(summary).toContain("表示名「家計レポート」");
    expect(summary).toContain("PWA対応・オフラインなし");
    expect(summary).toContain("更新履歴あり");
    expect(summary).toContain("CI撮影の認証バイパスあり");
    expect(appearanceSummary(spec({ auth: "none" }))).toContain("不要（認証なし）");
  });

  it("テーマカラーは `#rrggbb` だけを認め、PWA対応時に検証する", () => {
    expect(isValidThemeColor("#0F172A")).toBe(true);
    expect(isValidThemeColor("#0f1")).toBe(false);
    expect(validateNewAppSpec(spec({ themeColor: "teal" }))).toContain("theme_color_invalid");
    expect(validateNewAppSpec(spec({ pwa: false, themeColor: "teal" }))).not.toContain(
      "theme_color_invalid",
    );
  });
});
