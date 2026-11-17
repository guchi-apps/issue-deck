import { describe, expect, it } from "vitest";

import {
  ARTIFACT_SEEN_LIMIT,
  artifactFreshness,
  withSeen,
} from "@/lib/artifact-seen";

const a = (id: string, publishedAt = "t1") => ({ id, publishedAt });

describe("artifactFreshness", () => {
  it("記録が無い（初めて提示された）ものは新規として強調する", () => {
    expect(artifactFreshness({}, a("x"))).toBe("new");
  });
  it("記録と同じ版は見た、違う版は更新あり", () => {
    expect(artifactFreshness({ x: "t1" }, a("x", "t1"))).toBe("seen");
    expect(artifactFreshness({ x: "t1" }, a("x", "t2"))).toBe("updated");
  });
});

describe("withSeen", () => {
  it("見た版へ更新して強調を外す", () => {
    const next = withSeen({ x: "t1" }, a("x", "t2"));
    expect(artifactFreshness(next, a("x", "t2"))).toBe("seen");
  });
  it("上限を超えたら古いものから消す", () => {
    let seen = {};
    for (let i = 0; i < ARTIFACT_SEEN_LIMIT + 5; i++) seen = withSeen(seen, a(`id${i}`));
    expect(Object.keys(seen)).toHaveLength(ARTIFACT_SEEN_LIMIT);
    expect(seen).not.toHaveProperty("id0");
    expect(seen).toHaveProperty(`id${ARTIFACT_SEEN_LIMIT + 4}`);
  });
});
