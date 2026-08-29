import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BROWSER_BLOCKED_PORTS,
  LOCAL_PORT_BAND_CONF_PATH,
  MAX_LOCAL_PORT_BASE,
  appendLocalPortBand,
  chooseNextLocalPortBase,
  findLocalPortBand,
  formatLocalPortBandLine,
  isBrowserBlockedPort,
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

  it("ブラウザがブロックするベース値は飛ばす（#2466）", () => {
    // 5000の次は6000だが、6000はX11用としてブラウザが拒否する（確認環境はベース値+0で開く）
    expect(chooseNextLocalPortBase([{ repository: "a", base: 5000 }])).toBe(7000);
  });
});

describe("isBrowserBlockedPort", () => {
  it("ブラウザがブロックするポートを見分ける", () => {
    expect(isBrowserBlockedPort(6000)).toBe(true);
    expect(isBrowserBlockedPort(10080)).toBe(true);
    expect(isBrowserBlockedPort(6001)).toBe(false);
    expect(isBrowserBlockedPort(4000)).toBe(false);
  });

  it("帯の範囲外（1000未満）は載せない", () => {
    expect(BROWSER_BLOCKED_PORTS.every((port) => port >= 1000)).toBe(true);
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

/**
 * **ブロック対象ポートの一覧は、TypeScriptとシェルで二重に持っている**（#2466）。帯を払い出すのは
 * 画面側（`chooseNextLocalPortBase`）、実際に確認環境を起こすのはシェル側
 * （`scripts/lib/dev-server.sh`の`dev_server_browser_safe_port`）で、片方だけ直すと
 * 「払い出せた帯なのに確認環境が開けない」という、画面からは見えない形でずれる。
 */
describe("シェル側の dev_server_browser_safe_port との突き合わせ", () => {
  function runDevServerLib(snippet: string): string {
    return execFileSync(
      "bash",
      ["-c", `source "$1" && ${snippet}`, "bash", join(process.cwd(), "scripts/lib/dev-server.sh")],
      { encoding: "utf8" },
    ).trim();
  }

  it("一覧が同じ", () => {
    const fromShell = runDevServerLib('printf "%s" "$DEV_SERVER_BROWSER_BLOCKED_PORTS"')
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10));
    expect(fromShell).toEqual([...BROWSER_BLOCKED_PORTS]);
  });

  it("ブロックされるポートは開けるものまで繰り上げる", () => {
    // 6000（X11）は6001へ。6665〜6669（IRC）は連続してブロックされるので6670まで進む
    expect(runDevServerLib("dev_server_browser_safe_port 6000")).toBe("6001");
    expect(runDevServerLib("dev_server_browser_safe_port 6665")).toBe("6670");
  });

  it("ブロックされないポートはそのまま", () => {
    expect(runDevServerLib("dev_server_browser_safe_port 4000")).toBe("4000");
    expect(runDevServerLib("dev_server_browser_safe_port 26000")).toBe("26000");
  });
});
