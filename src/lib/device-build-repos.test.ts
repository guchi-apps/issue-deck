import { describe, expect, it } from "vitest";

import { getDeviceBuildRepository } from "@/lib/device-build-repos";

describe("getDeviceBuildRepository", () => {
  it("aide-iosはXcodeで実機へ反映するリポジトリとして返す", () => {
    expect(getDeviceBuildRepository("guchi-apps/aide-ios")).toEqual({
      pendingLabel: "Xcode未反映",
      reflectedLabel: "実機反映（Xcode）",
      command: "cd ~/Projects/AIDEios && scripts/xcode-release.sh",
    });
  });

  it("表に無いリポジトリはnull", () => {
    expect(getDeviceBuildRepository("guchi-apps/issue-deck")).toBeNull();
    expect(getDeviceBuildRepository("guchi-apps/aide")).toBeNull();
  });
});
