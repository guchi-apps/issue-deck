import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BROWSER_BLOCKED_PORTS,
  LOCAL_PORT_BAND_CONF_PATH,
  LOCAL_PORT_BAND_STEP,
  MAX_LOCAL_PORT_BASE,
  appendLocalPortBand,
  chooseNextLocalPortBase,
  findLocalPortBand,
  findOverlappingLocalPortBands,
  formatLocalPortBandLine,
  isBrowserBlockedPort,
  localPortBandEnd,
  parseLocalPortBands,
} from "@/lib/new-app/local-port-bands";

const SAMPLE = `# コメント
# guchi-apps/commented-out    1000

guchi-apps/issue-deck          4000  2000
guchi-apps/dayspan             6000
guchi-apps/aide-bot           24000
`;

describe("parseLocalPortBands", () => {
  it("コメントと空行を捨てて対応表を読む", () => {
    expect(parseLocalPortBands(SAMPLE)).toEqual([
      { repository: "guchi-apps/issue-deck", base: 4000, width: 2000 },
      { repository: "guchi-apps/dayspan", base: 6000, width: LOCAL_PORT_BAND_STEP },
      { repository: "guchi-apps/aide-bot", base: 24000, width: LOCAL_PORT_BAND_STEP },
    ]);
  });

  it("書式に合わない行は捨てる（シェル側の正規表現と同じ判定）", () => {
    // 行末コメント付き・値が数字でない・列が多すぎる、のいずれも `local_repo_port_base` は読まない
    expect(
      parseLocalPortBands(
        "guchi-apps/foo 25000 # メモ\nguchi-apps/bar abc\nguchi-apps/baz 25000 1000 1000\n",
      ),
    ).toEqual([]);
  });

  it("CRLFの行末でも読める", () => {
    expect(parseLocalPortBands("guchi-apps/foo 25000\r\n")).toEqual([
      { repository: "guchi-apps/foo", base: 25000, width: LOCAL_PORT_BAND_STEP },
    ]);
  });

  it("3列目を帯の幅として読む（#2478）", () => {
    expect(parseLocalPortBands("guchi-apps/foo 25000 3000\n")).toEqual([
      { repository: "guchi-apps/foo", base: 25000, width: 3000 },
    ]);
    expect(localPortBandEnd({ repository: "guchi-apps/foo", base: 25000, width: 3000 })).toBe(27999);
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
      { repository: "a", base: 4000, width: LOCAL_PORT_BAND_STEP },
      { repository: "b", base: 24000, width: LOCAL_PORT_BAND_STEP },
    ];
    expect(chooseNextLocalPortBase(bands)).toBe(25000);
  });

  it("幅の広い帯の途中を払い出さない（#2478）", () => {
    // 4000〜7999を占める帯の次は8000。ベース値の最大（4000）だけを見ると5000を配ってしまう
    expect(chooseNextLocalPortBase([{ repository: "a", base: 4000, width: 4000 }])).toBe(8000);
  });

  it("対応表が空でも1000から始める", () => {
    expect(chooseNextLocalPortBase([])).toBe(1000);
  });

  it("上限を超えるならnull（人が帯を割り直す）", () => {
    expect(
      chooseNextLocalPortBase([
        { repository: "a", base: MAX_LOCAL_PORT_BASE, width: LOCAL_PORT_BAND_STEP },
      ]),
    ).toBeNull();
  });

  it("ブラウザがブロックするベース値は飛ばす（#2466）", () => {
    // 5000の次は6000だが、6000はX11用としてブラウザが拒否する（確認環境はベース値+0で開く）
    expect(chooseNextLocalPortBase([{ repository: "a", base: 5000, width: LOCAL_PORT_BAND_STEP }])).toBe(
      7000,
    );
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
      const match = /^\s*(\S+)\s+(\d+)(?:\s+(\d+))?\s*$/.exec(line);
      if (!match) continue;
      expect(
        formatLocalPortBandLine(
          match[1],
          Number.parseInt(match[2], 10),
          match[3] ? Number.parseInt(match[3], 10) : undefined,
        ),
      ).toBe(line);
    }
  });

  it("原則の幅（1000）は3列目を書かない（#2478）", () => {
    expect(formatLocalPortBandLine("guchi-apps/kakei-report", 25000)).toBe(
      formatLocalPortBandLine("guchi-apps/kakei-report", 25000, LOCAL_PORT_BAND_STEP),
    );
    expect(formatLocalPortBandLine("guchi-apps/kakei-report", 25000)).not.toContain("1000");
  });
});

/**
 * **対応表そのものに重なりが無いこと**（#2478）。採番は帯の中で折り返すため、帯が重なって
 * いなければ別リポジトリのIssueと同じポートになることはない。逆に言えば、ここが唯一の砦。
 */
describe("findOverlappingLocalPortBands", () => {
  it("実物の対応表の帯は重なっていない", () => {
    const conf = readFileSync(join(process.cwd(), LOCAL_PORT_BAND_CONF_PATH), "utf8");
    const overlaps = findOverlappingLocalPortBands(parseLocalPortBands(conf));
    expect(
      overlaps.map(
        ({ a, b }) =>
          `${a.repository}(${a.base}〜${localPortBandEnd(a)}) と ${b.repository}(${b.base}〜${localPortBandEnd(b)})`,
      ),
    ).toEqual([]);
  });

  it("重なっていれば挙げる", () => {
    // #2478で実際に起きていた形（issue-deckが4000から2000ぶんを占めるのに、dayspanが5000にいる）
    const overlaps = findOverlappingLocalPortBands([
      { repository: "guchi-apps/issue-deck", base: 4000, width: 2000 },
      { repository: "guchi-apps/dayspan", base: 5000, width: LOCAL_PORT_BAND_STEP },
    ]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].b.repository).toBe("guchi-apps/dayspan");
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
  function portFieldFromShell(
    conf: string,
    repository: string,
    fn: "local_repo_port_base" | "local_repo_port_width" = "local_repo_port_base",
  ): string {
    const dir = mkdtempSync(join(tmpdir(), "local-port-bands-"));
    const file = join(dir, "local-repo-ports.conf");
    writeFileSync(file, conf, "utf8");
    return execFileSync(
      "bash",
      [
        "-c",
        `source "$1" && ISSUE_DECK_LOCAL_REPO_PORTS_CONFIG="$2" ${fn} "$3" || true`,
        "bash",
        join(process.cwd(), "scripts/lib/local-repo-resolve.sh"),
        file,
        repository,
      ],
      { encoding: "utf8" },
    ).trim();
  }

  function portBaseFromShell(conf: string, repository: string): string {
    return portFieldFromShell(conf, repository);
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

  it("3列目の帯の幅もシェルが同じ値で読む（#2478）", () => {
    const conf = readFileSync(join(process.cwd(), LOCAL_PORT_BAND_CONF_PATH), "utf8");
    for (const band of parseLocalPortBands(conf)) {
      // 省略された行では何も返さない（原則の幅は採番側の既定に任せる）
      const expected = band.width === LOCAL_PORT_BAND_STEP ? "" : String(band.width);
      expect(portFieldFromShell(conf, band.repository, "local_repo_port_width")).toBe(expected);
    }
  });

  it("3列目を足してもベース値の読み取りは変わらない", () => {
    expect(portBaseFromShell("guchi-apps/foo 25000 3000\n", "guchi-apps/foo")).toBe("25000");
    expect(
      portFieldFromShell("guchi-apps/foo 25000 3000\n", "guchi-apps/foo", "local_repo_port_width"),
    ).toBe("3000");
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

/**
 * **Issueごとのセッションのポートも繰り上げる**（#2470）。「ベース値 + Issue番号」も
 * `6566`（dayspan #566）・`10080`（clip-hive #80）・`6665`〜`6669`（IRC）のようにブロック対象へ
 * 当たりうる。
 *
 * **さらに帯の幅を超えたら帯の中で折り返す**（#2478）。Issue番号は単調増加するので、素朴に足すと
 * 必ずいつか隣の帯へ食い込む（issue-deckの`4000 + 2470 = 6470`がdayspanの6000帯に入っていた）。
 *
 * 繰り上げ・折り返しを入れる以上、**採番する側と止める側が同じ計算をしていること**が前提になる。
 * 片側だけに入れると、止める側が動く前のポートを探しに行って起こしたセッションを止められなく
 * なるため、計算は`dev_server_port_for_issue`だけに置く。ここではその1か所の振る舞いと、
 * 呼び出し側が自前で足し算へ戻っていないことを固定する。
 */
describe("シェル側の dev_server_port_for_issue との突き合わせ", () => {
  function runDevServerLib(snippet: string): string {
    return execFileSync(
      "bash",
      ["-c", `source "$1" && ${snippet}`, "bash", join(process.cwd(), "scripts/lib/dev-server.sh")],
      { encoding: "utf8" },
    ).trim();
  }

  it("帯の幅に収まるIssue番号は「ベース値 + Issue番号」のまま", () => {
    expect(runDevServerLib("dev_server_port_for_issue 1999 4000 2000")).toBe("5999");
    expect(runDevServerLib("dev_server_port_for_issue 464 6000 1000")).toBe("6464");
  });

  it("ブロック対象に当たるIssue番号は繰り上げる", () => {
    // dayspan（6000帯）の #566 → 6566（X11以外のブロック対象）、#665〜#669 → IRCの6665〜6669
    expect(runDevServerLib("dev_server_port_for_issue 566 6000 1000")).toBe("6567");
    expect(runDevServerLib("dev_server_port_for_issue 665 6000 1000")).toBe("6670");
    expect(runDevServerLib("dev_server_port_for_issue 669 6000 1000")).toBe("6670");
    // clip-hive（10000帯）の #80 → 10080
    expect(runDevServerLib("dev_server_port_for_issue 80 10000 1000")).toBe("10081");
  });

  it("帯の幅を超えたIssue番号は帯の中で折り返す（#2478）", () => {
    // issue-deck（4000から2000ぶん）。オフセットは 1〜1999 を巡回する
    expect(runDevServerLib("dev_server_port_for_issue 2470 4000 2000")).toBe("4471");
    expect(runDevServerLib("dev_server_port_for_issue 2000 4000 2000")).toBe("4001");
    // dayspan（6000から1000ぶん）が #1000 に達しても、7000（shopping-listの予約）へは出ない
    expect(runDevServerLib("dev_server_port_for_issue 1000 6000 1000")).toBe("6001");
  });

  it("ベース値 + 0（確認環境のポート）は使わない", () => {
    // 折り返しのオフセットが0になると、そのリポジトリの確認環境（start-preview-dev.sh）と重なる
    for (const issueNumber of [1999, 2000, 2001, 3998, 3999]) {
      expect(runDevServerLib(`dev_server_port_for_issue ${issueNumber} 4000 2000`)).not.toBe("4000");
    }
  });

  it("ベース値・帯の幅は 引数 → 環境変数 → issue-deckの帯（4000・2000）の順で決まる", () => {
    expect(
      runDevServerLib(
        "ISSUE_DECK_DEV_PORT_BASE=6000 ISSUE_DECK_DEV_PORT_WIDTH=1000 dev_server_port_for_issue 566",
      ),
    ).toBe("6567");
    expect(runDevServerLib("dev_server_port_for_issue 566")).toBe("4566");
    expect(runDevServerLib("dev_server_port_for_issue 2478")).toBe("4479");
  });

  it("採番する側が自前で「ベース値 + Issue番号」を計算しない", () => {
    for (const name of ["start-issue.sh", "generic-start-issue.sh"]) {
      const source = readFileSync(join(process.cwd(), "scripts", name), "utf8")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      expect(source).toMatch(/DEV_PORT="\$\(dev_server_port_for_issue /);
      // 折り返し・繰り上げを通さない代入に戻っていないこと。
      expect(source).not.toMatch(/^\s*DEV_PORT=\$\(\(/m);
    }
  });
});

/**
 * **どのIssue番号でも自分の帯から出ない**（#2478）。帯が重なっていないことと合わせて、
 * 「別リポジトリのIssueと同じポートになる」形の衝突が起こらないことを担保する。
 *
 * シェルを1回だけ起こして番号を回す（1番号ごとにbashを起こすと実物の対応表ぶんで数千回になる）。
 */
describe("ポートは帯からはみ出さない（#2478）", () => {
  function portsFromShell(base: number, width: number, issueNumbers: number[]): number[] {
    const output = execFileSync(
      "bash",
      [
        "-c",
        `source "$1" && for n in $3; do dev_server_port_for_issue "$n" "$2" "$4"; echo; done`,
        "bash",
        join(process.cwd(), "scripts/lib/dev-server.sh"),
        String(base),
        issueNumbers.join(" "),
        String(width),
      ],
      { encoding: "utf8" },
    );
    return output
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => Number.parseInt(line, 10));
  }

  it("実物の対応表のどの帯でも、Issue番号を回してもその帯の中に収まる", () => {
    const conf = readFileSync(join(process.cwd(), LOCAL_PORT_BAND_CONF_PATH), "utf8");
    const issueNumbers = [1, 2, 45, 80, 566, 665, 999, 1000, 1999, 2000, 2478, 5000, 12345];
    for (const band of parseLocalPortBands(conf)) {
      for (const port of portsFromShell(band.base, band.width, issueNumbers)) {
        // ベース値 + 0 は確認環境が使うため、Issueごとのセッションには配らない
        expect(port).toBeGreaterThan(band.base);
        expect(port).toBeLessThanOrEqual(localPortBandEnd(band));
      }
    }
  });
});
