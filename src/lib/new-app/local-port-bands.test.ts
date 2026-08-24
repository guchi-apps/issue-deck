import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LOCAL_PORT_BAND_CONF_PATH,
  MAX_LOCAL_PORT_BASE,
  appendLocalPortBand,
  chooseNextLocalPortBase,
  findLocalPortBand,
  formatLocalPortBandLine,
  parseLocalPortBands,
} from "@/lib/new-app/local-port-bands";

const SAMPLE = `# コメント
# guchi-apps/commented-out    1000

guchi-apps/issue-deck          4000
guchi-apps/dayspan             6000
guchi-apps/aide-bot           24000
`;

describe("parseLocalPortBands", () => {
  it("コメントと空行を捨てて対応表を読む", () => {
    expect(parseLocalPortBands(SAMPLE)).toEqual([
      { repository: "guchi-apps/issue-deck", base: 4000 },
      { repository: "guchi-apps/dayspan", base: 6000 },
      { repository: "guchi-apps/aide-bot", base: 24000 },
    ]);
  });

  it("書式に合わない行は捨てる（シェル側の正規表現と同じ判定）", () => {
    // 行末コメント付き・値が数字でない・列が多い、のいずれも `local_repo_port_base` は読まない
    expect(parseLocalPortBands("guchi-apps/foo 25000 # メモ\nguchi-apps/bar abc\n")).toEqual([]);
  });

  it("CRLFの行末でも読める", () => {
    expect(parseLocalPortBands("guchi-apps/foo 25000\r\n")).toEqual([
      { repository: "guchi-apps/foo", base: 25000 },
    ]);
  });
});

describe("findLocalPortBand", () => {
  it("載っていればその帯、載っていなければnull", () => {
    const bands = parseLocalPortBands(SAMPLE);
    expect(findLocalPortBand(bands, "guchi-apps/dayspan")).toBe(6000);
    expect(findLocalPortBand(bands, "guchi-apps/kakei-report")).toBeNull();
  });
});

describe("chooseNextLocalPortBase", () => {
  it("現状の最大 + 1000 を返す", () => {
    expect(chooseNextLocalPortBase(parseLocalPortBands(SAMPLE))).toBe(25000);
  });

  it("空きを詰め直さない（間が空いていても最大から進める）", () => {
    const bands = [
      { repository: "a", base: 4000 },
      { repository: "b", base: 24000 },
    ];
    expect(chooseNextLocalPortBase(bands)).toBe(25000);
  });

  it("対応表が空でも1000から始める", () => {
    expect(chooseNextLocalPortBase([])).toBe(1000);
  });

  it("上限を超えるならnull（人が帯を割り直す）", () => {
    expect(chooseNextLocalPortBase([{ repository: "a", base: MAX_LOCAL_PORT_BASE }])).toBeNull();
  });
});

describe("formatLocalPortBandLine", () => {
  it("実物の対応表と同じ桁で揃える", () => {
    const conf = readFileSync(join(process.cwd(), LOCAL_PORT_BAND_CONF_PATH), "utf8");
    for (const line of conf.split("\n")) {
      if (/^\s*(#|$)/.test(line)) continue;
      const match = /^\s*(\S+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      expect(formatLocalPortBandLine(match[1], Number.parseInt(match[2], 10))).toBe(line);
    }
  });
});

describe("appendLocalPortBand", () => {
  it("由来のコメントを上の行に置いて末尾へ足す", () => {
    const updated = appendLocalPortBand(SAMPLE, {
      repository: "guchi-apps/kakei-report",
      base: 25000,
      comment: "家計レポート（guchi-apps/issue-deck#2301）。",
    });
    expect(updated).toMatch(
      /# 家計レポート（guchi-apps\/issue-deck#2301）。\nguchi-apps\/kakei-report {7}25000\n$/,
    );
  });

  it("足した行はシェルと同じ判定で読み直せる", () => {
    const updated = appendLocalPortBand(SAMPLE, {
      repository: "guchi-apps/kakei-report",
      base: 25000,
      comment: "家計レポート。",
    });
    expect(findLocalPortBand(parseLocalPortBands(updated), "guchi-apps/kakei-report")).toBe(25000);
  });

  it("末尾に空行が残っていても行を詰めて足す", () => {
    const updated = appendLocalPortBand(`${SAMPLE}\n\n`, {
      repository: "guchi-apps/kakei-report",
      base: 25000,
      comment: "家計レポート。",
    });
    expect(updated).toContain("guchi-apps/aide-bot           24000\n# 家計レポート。\n");
    expect(updated.endsWith("25000\n")).toBe(true);
  });
});

/**
 * **生成した行を実際にシェルへ読ませる。** 書式の正は
 * `scripts/lib/local-repo-resolve.sh`の`local_repo_port_base`で、TypeScript側はそれを
 * 写しているだけ。片方だけ直すと、対応表に載っているのに帯が引けない（＝既定の
 * 3000 + Issue番号に落ちる）という、画面からは見えない形で壊れる。
 */
describe("シェル側の local_repo_port_base との突き合わせ", () => {
  function portBaseFromShell(conf: string, repository: string): string {
    const dir = mkdtempSync(join(tmpdir(), "local-port-bands-"));
    const file = join(dir, "local-repo-ports.conf");
    writeFileSync(file, conf, "utf8");
    return execFileSync(
      "bash",
      [
        "-c",
        `source "$1" && ISSUE_DECK_LOCAL_REPO_PORTS_CONFIG="$2" local_repo_port_base "$3"`,
        "bash",
        join(process.cwd(), "scripts/lib/local-repo-resolve.sh"),
        file,
        repository,
      ],
      { encoding: "utf8" },
    ).trim();
  }

  it("追記した行をシェルが同じ値で読む", () => {
    const updated = appendLocalPortBand(SAMPLE, {
      repository: "guchi-apps/kakei-report",
      base: 25000,
      comment: "家計レポート（guchi-apps/issue-deck#2301）。",
    });
    expect(portBaseFromShell(updated, "guchi-apps/kakei-report")).toBe("25000");
    expect(portBaseFromShell(updated, "guchi-apps/issue-deck")).toBe("4000");
  });

  it("実物の対応表もTypeScript側と同じ結果になる", () => {
    const conf = readFileSync(join(process.cwd(), LOCAL_PORT_BAND_CONF_PATH), "utf8");
    for (const band of parseLocalPortBands(conf)) {
      expect(portBaseFromShell(conf, band.repository)).toBe(String(band.base));
    }
  });
});
