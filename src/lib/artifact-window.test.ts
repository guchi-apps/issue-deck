import { describe, expect, it } from "vitest";

import {
  artifactWindowName,
  artifactWindowPath,
  buildArtifactWindowFeatures,
} from "@/lib/artifact-window";

describe("artifactWindowPath", () => {
  it("単独ページのURLを返す", () => {
    expect(artifactWindowPath("cmf3k9x0a0001")).toBe("/artifacts/cmf3k9x0a0001");
  });

  it("URLに使えない文字は escape する（IDはDB由来だが、そのまま連結しない）", () => {
    expect(artifactWindowPath("a/b?c")).toBe("/artifacts/a%2Fb%3Fc");
  });
});

describe("artifactWindowName", () => {
  it("アーティファクトごとに別のウィンドウにする（2つの見た目案を並べて見比べられる）", () => {
    expect(artifactWindowName("art_1")).not.toBe(artifactWindowName("art_2"));
  });

  it("同じアーティファクトは同じウィンドウ（押すたびに増えない）", () => {
    expect(artifactWindowName("art_1")).toBe(artifactWindowName("art_1"));
  });
});

describe("buildArtifactWindowFeatures", () => {
  it("画面中央に、既定の大きさで開く", () => {
    expect(buildArtifactWindowFeatures({ availWidth: 2560, availHeight: 1440 })).toBe(
      "popup=yes,width=1180,height=900,left=690,top=270",
    );
  });

  it("画面が狭ければはみ出さない大きさに収める", () => {
    expect(buildArtifactWindowFeatures({ availWidth: 1000, availHeight: 700 })).toBe(
      "popup=yes,width=960,height=660,left=20,top=20",
    );
  });

  it("マルチディスプレイでは、その画面の原点を足した位置に開く", () => {
    expect(
      buildArtifactWindowFeatures({
        availWidth: 2560,
        availHeight: 1440,
        availLeft: 2560,
        availTop: 0,
      }),
    ).toBe("popup=yes,width=1180,height=900,left=3250,top=270");
  });
});
