import { describe, expect, it } from "vitest";

import { runSerialized } from "./keyed-serial";

describe("runSerialized", () => {
  it("同じキーの処理は重ならず、呼んだ順に実行される", async () => {
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end:${name}`);
    };
    await Promise.all([runSerialized("k", task("a", 20)), runSerialized("k", task("b", 1))]);
    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("先の処理が失敗しても次の処理は走る", async () => {
    const failed = runSerialized("e", async () => {
      throw new Error("boom");
    });
    const next = runSerialized("e", async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("違うキーは並行して動く", async () => {
    const log: string[] = [];
    await Promise.all([
      runSerialized("x", async () => {
        await new Promise((r) => setTimeout(r, 20));
        log.push("x");
      }),
      runSerialized("y", async () => {
        log.push("y");
      }),
    ]);
    expect(log).toEqual(["y", "x"]);
  });
});
