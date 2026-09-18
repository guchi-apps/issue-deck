import { describe, expect, it } from "vitest";

import { shouldReadNextWindowSnapshot } from "@/lib/nightly-run-state";

/**
 * #3005: `shouldReadNextWindowSnapshot`が`||`のままだと、次枠実行をONにしただけで予定が
 * 0件でも、またはOFFのままでも予定が1件あれば、枠の取得（Anthropic APIへの推論リクエスト）が
 * 呼ばれ続けてしまう。呼んでよいのは**ONで、かつ予定が1件以上あるとき**だけ（AND）。
 */
describe("shouldReadNextWindowSnapshot", () => {
  it("ONで予定が1件以上あるときだけ true", () => {
    expect(shouldReadNextWindowSnapshot({ enabled: true }, 1)).toBe(true);
  });

  it("ONでも予定が0件なら false", () => {
    expect(shouldReadNextWindowSnapshot({ enabled: true }, 0)).toBe(false);
  });

  it("OFFなら予定が1件以上あっても false", () => {
    expect(shouldReadNextWindowSnapshot({ enabled: false }, 1)).toBe(false);
  });

  it("OFFで予定も0件なら false", () => {
    expect(shouldReadNextWindowSnapshot({ enabled: false }, 0)).toBe(false);
  });
});
