// `scripts/lib/launch-hold.sh`の判定を、metricsのJSONを渡して実行する（#2095）。
//
// ここは**新しいセッションを起こしてよいかを決める唯一の入口**で、外すと「逼迫しても足し続ける」
// （このIssueが直したかったこと）か「余力があるのに永久に起動しない」のどちらかになる。
// どちらも実機で気づくまで時間がかかるため、境界を固定しておく。
// 判定に使うのはpollerが1巡の入口で集める`metrics`だけなので、実物のホストは要らない。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** サブPCの平常時に近い形。ここから1項目だけ動かして境界を見る */
const BASE = {
  cpuPercent: 12.5,
  memoryUsedMb: 5200,
  memoryTotalMb: 13873,
  swapUsedMb: 800,
  swapTotalMb: 4095,
  diskUsedGb: 120.4,
  diskTotalGb: 400.0,
};

/**
 * 判定を1回実行し、`{json, message}`を返す。見送っていなければどちらも空文字。
 * `metrics`に`null`を渡すと「取れなかった巡」（pollerは空文字を渡す）になる。
 */
function resolve(metrics, { memory = 85, swap = 50 } = {}) {
  const payload = metrics === null ? "" : JSON.stringify(metrics);
  const script = [
    `source ${JSON.stringify(path.join(repoRoot, "scripts/lib/launch-hold.sh"))}`,
    `resolve_launch_hold ${JSON.stringify(payload)} ${memory} ${swap}`,
    `printf '%s\\n%s\\n' "$LAUNCH_HOLD_JSON" "$LAUNCH_HOLD_MESSAGE"`,
  ].join("\n");
  const stdout = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  const [json, message] = stdout.split("\n");
  return { json: json ?? "", message: message ?? "" };
}

describe("resolve_launch_hold（#2095）", () => {
  it("余力があるうちは見送らない", () => {
    expect(resolve(BASE)).toEqual({ json: "", message: "" });
  });

  it("メモリが閾値を超えたら見送り、理由と使用率を申告する", () => {
    const { json, message } = resolve({ ...BASE, memoryUsedMb: 12800 });
    expect(JSON.parse(json)).toMatchObject({ reason: "MEMORY", thresholdPercent: 85 });
    expect(JSON.parse(json).percent).toBeCloseTo(92.3, 1);
    expect(message).toContain("メモリ 92%・上限 85%");
  });

  it("閾値ちょうどでも見送る（上限に達した時点で止める）", () => {
    // 13873の85%は11792.05MB。ちょうど超えた値で境界を固定する
    expect(resolve({ ...BASE, memoryUsedMb: 11793 }).json).toContain('"reason":"MEMORY"');
    expect(resolve({ ...BASE, memoryUsedMb: 11700 }).json).toBe("");
  });

  it("メモリに余裕があってもSWAPが閾値を超えたら見送る", () => {
    const { json, message } = resolve({ ...BASE, swapUsedMb: 3000 });
    expect(JSON.parse(json)).toMatchObject({ reason: "SWAP", thresholdPercent: 50 });
    expect(message).toContain("SWAP 73%・上限 50%");
  });

  it("どちらも超えていたら理由はメモリ（SWAPは結果なので原因の側を出す）", () => {
    const { json } = resolve({ ...BASE, memoryUsedMb: 13000, swapUsedMb: 3000 });
    expect(JSON.parse(json).reason).toBe("MEMORY");
  });

  it("SWAPを持たないホスト（総量0）ではSWAPを見ない", () => {
    expect(resolve({ ...BASE, swapUsedMb: 0, swapTotalMb: 0 })).toEqual({ json: "", message: "" });
  });

  it("SWAPを申告しないpoller（null）でもメモリの判定は効く", () => {
    const noSwap = { ...BASE, swapUsedMb: null, swapTotalMb: null };
    expect(resolve(noSwap).json).toBe("");
    expect(resolve({ ...noSwap, memoryUsedMb: 13000 }).json).toContain('"reason":"MEMORY"');
  });

  it("閾値0はその項目を無効にする", () => {
    const tight = { ...BASE, memoryUsedMb: 13000, swapUsedMb: 3000 };
    expect(resolve(tight, { memory: 0 }).json).toContain('"reason":"SWAP"');
    expect(resolve(tight, { memory: 0, swap: 0 })).toEqual({ json: "", message: "" });
  });

  it("使用率が取れなかった巡は見送らない（壊れたときに倒れる向きを起動する側へ置く）", () => {
    expect(resolve(null)).toEqual({ json: "", message: "" });
    // 壊れたJSONでも同じ（jqが失敗しても呼び出し側を止めない）
    const script = [
      `source ${JSON.stringify(path.join(repoRoot, "scripts/lib/launch-hold.sh"))}`,
      `set -euo pipefail`,
      `resolve_launch_hold '{壊れている' 85 50`,
      `printf '%s' "$LAUNCH_HOLD_JSON"`,
    ].join("\n");
    expect(execFileSync("bash", ["-c", script], { encoding: "utf8" })).toBe("");
  });
});
