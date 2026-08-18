import { describe, expect, it } from "vitest";

import {
  SLOW_LOADING_THRESHOLD_MS,
  loadingScreenMessage,
} from "@/lib/loading-screen-message";

describe("loadingScreenMessage", () => {
  it("しきい値までは「読み込み中」だけを出し、操作を足さない", () => {
    for (const elapsed of [0, 1_000, SLOW_LOADING_THRESHOLD_MS - 1]) {
      const message = loadingScreenMessage(elapsed);
      expect(message.status).toBe("読み込み中");
      expect(message.hint).toBeNull();
      expect(message.showReload).toBe(false);
    }
  });

  it("しきい値を過ぎたら文言を強め、読み込み直す手段を添える", () => {
    for (const elapsed of [SLOW_LOADING_THRESHOLD_MS, 30_000]) {
      const message = loadingScreenMessage(elapsed);
      expect(message.status).toBe("時間がかかっています");
      expect(message.hint).not.toBeNull();
      expect(message.showReload).toBe(true);
    }
  });
});
