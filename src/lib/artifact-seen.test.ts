import { describe, expect, it } from "vitest";

import {
  ARTIFACT_SEEN_LIMIT,
  isArtifactUpdated,
  withBaseline,
  withSeen,
} from "@/lib/artifact-seen";

const a = (id: string, publishedAt = "t1") => ({ id, publishedAt });

describe("isArtifactUpdated", () => {
  it("記録が無い（初めて見る）ものは更新扱いにしない", () => {
    expect(isArtifactUpdated({}, a("x"))).toBe(false);
  });
  it("記録と同じ版は更新なし、違う版は更新あり", () => {
    expect(isArtifactUpdated({ x: "t1" }, a("x", "t1"))).toBe(false);
    expect(isArtifactUpdated({ x: "t1" }, a("x", "t2"))).toBe(true);
  });
});

describe("withBaseline", () => {
  it("記録の無いものだけ足し、既にあるIDは上書きしない", () => {
    const next = withBaseline({ x: "t1" }, [a("x", "t2"), a("y", "t2")]);
    expect(next).toEqual({ x: "t1", y: "t2" });
  });
  it("変化が無ければ同じオブジェクトを返す", () => {
    const seen = { x: "t1" };
    expect(withBaseline(seen, [a("x", "t2")])).toBe(seen);
  });
});

describe("withSeen", () => {
  it("見た版へ更新して強調を外す", () => {
    const next = withSeen({ x: "t1" }, a("x", "t2"));
    expect(isArtifactUpdated(next, a("x", "t2"))).toBe(false);
  });
  it("上限を超えたら古いものから消す", () => {
    let seen = {};
    for (let i = 0; i < ARTIFACT_SEEN_LIMIT + 5; i++) seen = withSeen(seen, a(`id${i}`));
    expect(Object.keys(seen)).toHaveLength(ARTIFACT_SEEN_LIMIT);
    expect(seen).not.toHaveProperty("id0");
    expect(seen).toHaveProperty(`id${ARTIFACT_SEEN_LIMIT + 4}`);
  });
});
