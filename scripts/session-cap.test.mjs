// `scripts/lib/session-cap.sh`の判定を、metricsのJSONを渡して実行する（#3780）。
//
// 空きメモリに応じて本数の上限を絞る入口で、壊れると「余力が無いのに足し続ける」か
// 「余力があるのに永久に起動しない」のどちらかになる。実物のホストは要らないので境界を固定する。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** サブPCの平常時に近い形（総量13873MB・使用5200MB → 空き約8.5GiB） */
const BASE = { memoryUsedMb: 5200, memoryTotalMb: 13873, swapUsedMb: 100, swapTotalMb: 11032 };

/** 判定を1回実行して`{effective, reported}`を返す。`metrics`に`null`を渡すと取れなかった巡 */
function resolve(metrics, { live = 6, max = 12, perSession = 1024, reserve = 2048 } = {}) {
  const payload = metrics === null ? "" : JSON.stringify(metrics);
  const script = [
    `source ${JSON.stringify(path.join(repoRoot, "scripts/lib/session-cap.sh"))}`,
    `resolve_session_cap ${live} ${max} ${JSON.stringify(payload)} ${perSession} ${reserve}`,
    `printf '%s\\n%s\\n' "$SESSION_CAP_EFFECTIVE" "$SESSION_CAP_REPORTED"`,
  ].join("\n");
  const [effective, reported] = execFileSync("bash", ["-c", script], { encoding: "utf8" })
    .split("\n")
    .map(Number);
  return { effective, reported };
}

describe("resolve_session_cap（#3780）", () => {
  it("見積りが0（既定）なら絞らず、静的な上限のまま", () => {
    expect(resolve(BASE, { perSession: 0 })).toEqual({ effective: 12, reported: 12 });
  });

  it("空きに余裕があれば静的な上限が天井になる", () => {
    // 空き8673MB - 余白2048 = 6625MB ÷ 1024 = 6本 → 6 + 6 = 12
    expect(resolve(BASE)).toEqual({ effective: 12, reported: 12 });
    expect(resolve(BASE, { max: 8 })).toEqual({ effective: 8, reported: 8 });
  });

  it("空きが減ると、足せる本数ぶんだけ絞る", () => {
    // 空き4673MB - 余白2048 = 2625MB ÷ 1024 = 2本 → 6 + 2 = 8
    expect(resolve({ ...BASE, memoryUsedMb: 9200 })).toEqual({ effective: 8, reported: 8 });
  });

  it("空きが余白を下回っても実効上限は生きている本数を下回らない", () => {
    expect(resolve({ ...BASE, memoryUsedMb: 12500 })).toEqual({ effective: 6, reported: 6 });
  });

  it("生きている本数が0で空きが無いと、実効上限は0だが申告は1以上にそろえる", () => {
    expect(resolve({ ...BASE, memoryUsedMb: 12500 }, { live: 0 })).toEqual({
      effective: 0,
      reported: 1,
    });
  });

  it("生きている本数が静的な上限を超えていても、上限は静的な値のまま", () => {
    expect(resolve(BASE, { live: 14 })).toEqual({ effective: 12, reported: 12 });
  });

  it("metricsが取れなかった巡・総量が分からない巡は絞らない", () => {
    expect(resolve(null)).toEqual({ effective: 12, reported: 12 });
    expect(resolve({ ...BASE, memoryTotalMb: 0 })).toEqual({ effective: 12, reported: 12 });
  });
});
