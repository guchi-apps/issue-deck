import { describe, expect, it } from "vitest";

import { runExclusive } from "@/lib/keyed-mutex";

/** 解決を外から握れるPromise（実行が重なったかどうかを見るために使う）。 */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runExclusive", () => {
  it("同じキーの処理は重ならない（前が終わるまで次を始めない）", async () => {
    const first = deferred();
    const running: string[] = [];

    const a = runExclusive("issue:1", async () => {
      running.push("a:start");
      await first.promise;
      running.push("a:end");
    });
    const b = runExclusive("issue:1", async () => {
      running.push("b:start");
    });

    // aが止まっている間、bはまだ始まっていない
    await Promise.resolve();
    expect(running).toEqual(["a:start"]);

    first.resolve();
    await Promise.all([a, b]);
    expect(running).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("キーが違えば同時に走る（Issueをまたいで待たせない）", async () => {
    const first = deferred();
    const running: string[] = [];

    const a = runExclusive("issue:1", async () => {
      running.push("a:start");
      await first.promise;
    });
    const b = runExclusive("issue:2", async () => {
      running.push("b:start");
    });

    await b;
    expect(running).toEqual(["a:start", "b:start"]);

    first.resolve();
    await a;
  });

  it("前の処理が失敗しても後続は流れる（1件の失敗で以降の同期を止めない）", async () => {
    const failed = runExclusive("issue:1", async () => {
      throw new Error("同期に失敗");
    });
    const next = runExclusive("issue:1", async () => "ok");

    await expect(failed).rejects.toThrow("同期に失敗");
    await expect(next).resolves.toBe("ok");
  });

  it("戻り値は呼び出し側へそのまま返る", async () => {
    await expect(runExclusive("issue:1", async () => 42)).resolves.toBe(42);
  });
});
