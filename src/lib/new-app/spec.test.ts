import { describe, expect, it } from "vitest";

import {
  databaseNameFor,
  defaultsForKind,
  emptyNewAppSpec,
  hostnameFor,
  isValidRepositoryName,
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
