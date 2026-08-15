import { describe, expect, it } from "vitest";

import { toPullRequestCiStatus } from "@/lib/github/pull-request-ci";

describe("toPullRequestCiStatus", () => {
  it("PR一覧と同じ集約結果を、対応PRカードの表記へ写す", () => {
    expect(toPullRequestCiStatus("pending")).toBe("in_progress");
    expect(toPullRequestCiStatus("success")).toBe("success");
    expect(toPullRequestCiStatus("failure")).toBe("failure");
  });

  it("unknownはバッジを出さないnoneにする（取得できないことを失敗として見せない）", () => {
    expect(toPullRequestCiStatus("unknown")).toBe("none");
  });
});
