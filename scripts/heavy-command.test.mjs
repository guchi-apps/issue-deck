// `scripts/heavy-command.sh`のセマフォを、一時ディレクトリを枠の置き場にして実行する（#2076）。
//
// この仕組みは**サブPCのメモリを守る最後の砦**で、緩むと12本のセッションが同時に
// `pnpm test:unit`（1本でピーク3.2GiB）を始められる状態へ戻る。実物のセッションを立てずに
// 確かめられるのは、枠の上限・素通りの条件・待機の見え方までなので、その境界をここで固定する。

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "heavy-command.sh");

let lockDir;

beforeEach(() => {
  lockDir = mkdtempSync(path.join(tmpdir(), "heavy-command-"));
});

afterEach(() => {
  rmSync(lockDir, { recursive: true, force: true });
});

/**
 * 検証用の既定の環境変数。
 *
 * **`HEAVY_COMMAND_HELD`を必ず空へ戻す。** このテスト自体が`pnpm test:unit`
 * （＝`scripts/heavy-command.sh`経由）から走るため、そのまま継ぐと入れ子とみなされ、
 * 枠を見ずに素通りする側の挙動しか確かめられない。
 */
function baseEnv() {
  return { HEAVY_COMMAND_LOCK_DIR: lockDir, HEAVY_COMMAND_HELD: "" };
}

/** 同期で1本実行する。`env`は既定へ足す形で渡す。 */
function run(args, env = {}) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...baseEnv(), ...env },
  });
}

/** 枠を掴んだまま`seconds`秒待つプロセスを立てる。呼び出し側が`kill()`で片付ける。 */
function holdSlot(seconds, env = {}) {
  return spawn("bash", [script, "sleep", String(seconds)], {
    stdio: "ignore",
    env: { ...process.env, ...baseEnv(), ...env },
  });
}

/** 枠を掴んだプロセスが実際にロックを握るまで待つ（立ち上がりの数十msを吸収する）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("scripts/heavy-command.sh", () => {
  it("コマンドの終了コードをそのまま返す", () => {
    expect(run(["bash", "-c", "exit 7"]).status).toBe(7);
    expect(run(["echo", "ok"]).stdout.trim()).toBe("ok");
  });

  it("枠が空いていればすぐ実行する", () => {
    const started = Date.now();
    const result = run(["echo", "ok"], { HEAVY_COMMAND_SLOTS: "1" });
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("枠が埋まっている間は待ち、空いてから実行する", { timeout: 20000 }, async () => {
      const holder = holdSlot(3, { HEAVY_COMMAND_SLOTS: "1" });
      try {
        await sleep(500);
        const started = Date.now();
        const result = run(["echo", "waited"], { HEAVY_COMMAND_SLOTS: "1" });
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe("waited");
        expect(Date.now() - started).toBeGreaterThan(1000);
        // **待機中であることが標準エラー出力に出ること。** 出ないと固まったように見え、
        // エージェントが待ちを異常とみなして中断する。`exec`のリダイレクトを
        // `2>/dev/null`で囲うと、ここが丸ごと消える（実際に一度そうなった）
        expect(result.stderr).toContain("待機");
      } finally {
        holder.kill();
      }
  });

  it("待ちの上限を超えたら、枠を取らずにそのまま実行する", { timeout: 20000 }, async () => {
      const holder = holdSlot(10, { HEAVY_COMMAND_SLOTS: "1" });
      try {
        await sleep(500);
        const result = run(["echo", "forced"], {
          HEAVY_COMMAND_SLOTS: "1",
          HEAVY_COMMAND_TIMEOUT_SECONDS: "1",
        });
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe("forced");
        expect(result.stderr).toContain("制限なしで実行");
      } finally {
        holder.kill();
      }
  });

  it("HEAVY_COMMAND_SLOTS=0 なら枠を見ずに実行する", { timeout: 20000 }, async () => {
      const holder = holdSlot(10, { HEAVY_COMMAND_SLOTS: "1" });
      try {
        await sleep(500);
        const started = Date.now();
        const result = run(["echo", "disabled"], { HEAVY_COMMAND_SLOTS: "0" });
        expect(result.status).toBe(0);
        expect(Date.now() - started).toBeLessThan(2000);
      } finally {
        holder.kill();
      }
  });

  it("入れ子（HEAVY_COMMAND_HELD）では待たない", { timeout: 20000 }, async () => {
      const holder = holdSlot(10, { HEAVY_COMMAND_SLOTS: "1" });
      try {
        await sleep(500);
        const started = Date.now();
        const result = run(["echo", "nested"], {
          HEAVY_COMMAND_SLOTS: "1",
          HEAVY_COMMAND_HELD: "1",
        });
        expect(result.status).toBe(0);
        expect(Date.now() - started).toBeLessThan(2000);
      } finally {
        holder.kill();
      }
  });

  it("実行するコマンドへ HEAVY_COMMAND_HELD を渡す", () => {
    const result = run(["bash", "-c", "echo \"held=${HEAVY_COMMAND_HELD:-}\""], {
      HEAVY_COMMAND_SLOTS: "1",
    });
    expect(result.stdout.trim()).toBe("held=1");
  });
});
