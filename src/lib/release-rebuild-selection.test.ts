import { describe, expect, it } from "vitest";

import {
  checkRebuildPullRequest,
  defaultRebuildSelection,
  isRebuildRequestBlocking,
  orderSelection,
  parseRebuildSelection,
  serializeRebuildSelection,
  type RebuildPullRequestFacts,
} from "@/lib/release-rebuild-selection";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const facts = (over: Partial<NonNullable<RebuildPullRequestFacts["pr"]>> = {}, includedInOrigin = false): RebuildPullRequestFacts => ({
  number: 20,
  pr: { title: "修正A", mergedAt: "2026-10-10T10:00:00Z", mergeSha: SHA_A, baseRef: "develop", headRef: "issue-20", ...over },
  includedInOrigin,
});

describe("checkRebuildPullRequest", () => {
  it("developへマージ済みで元の候補に無いPRは選べる", () => {
    expect(checkRebuildPullRequest(facts())).toEqual({ ok: true, mergeSha: SHA_A, title: "修正A" });
  });
  it("未マージは選べない（developのレビュー・マージを省かない）", () => {
    expect(checkRebuildPullRequest(facts({ mergedAt: null, mergeSha: null }))).toEqual({ ok: false, problem: "not_merged" });
  });
  it("既に元の候補に含まれていれば選べない", () => {
    expect(checkRebuildPullRequest(facts({}, true))).toEqual({ ok: false, problem: "already_included" });
  });
  it("選んだ後にマージコミットが変わったら止める（PR番号だけを信じない）", () => {
    expect(checkRebuildPullRequest(facts(), SHA_B)).toEqual({ ok: false, problem: "sha_changed" });
  });
  it("develop向けでないPR・バンプPRは選べない", () => {
    expect(checkRebuildPullRequest(facts({ baseRef: "main" }))).toEqual({ ok: false, problem: "not_develop" });
    expect(checkRebuildPullRequest(facts({ headRef: "release/v8.50.1" }))).toEqual({ ok: false, problem: "release_branch" });
  });
  it("PRが無ければ選べない", () => {
    expect(checkRebuildPullRequest({ number: 1, pr: null, includedInOrigin: false })).toEqual({ ok: false, problem: "not_found" });
  });
});

describe("defaultRebuildSelection", () => {
  it("当該リリースの修正PRだけを既定にし、無関係なPRは選ばない", () => {
    expect(defaultRebuildSelection([20, 21, 22], [20, 99])).toEqual([20]);
    expect(defaultRebuildSelection([20, 21], [])).toEqual([]);
  });
});

describe("serialize/parseRebuildSelection", () => {
  it("往復でき、workflowへはnumberとmergeShaだけを渡す", () => {
    const selection = { origin: { pr: 99, headSha: SHA_B }, prs: [{ number: 20, mergeSha: SHA_A, title: "修正A" }] };
    const text = serializeRebuildSelection(selection);
    expect(JSON.parse(text)).toEqual({ origin: { pr: 99, headSha: SHA_B }, prs: [{ number: 20, mergeSha: SHA_A }] });
    expect(parseRebuildSelection(text)).toEqual({ ...selection, prs: [{ number: 20, mergeSha: SHA_A, title: "" }] });
  });
  it("形が崩れていればnull", () => {
    expect(parseRebuildSelection("")).toBeNull();
    expect(parseRebuildSelection("{")).toBeNull();
    expect(parseRebuildSelection(JSON.stringify({ origin: { pr: 1, headSha: "x" }, prs: [] }))).toBeNull();
    expect(parseRebuildSelection(JSON.stringify({ origin: { pr: 1, headSha: SHA_A }, prs: [{ number: 2, mergeSha: "short" }] }))).toBeNull();
  });
});

describe("isRebuildRequestBlocking", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  it("起動直後の依頼は二重起動を止め、期限切れ・失敗は止めない", () => {
    expect(isRebuildRequestBlocking({ status: "dispatched", createdAt: new Date("2026-10-10T11:30:00Z") }, now)).toBe(true);
    expect(isRebuildRequestBlocking({ status: "dispatched", createdAt: new Date("2026-10-10T09:00:00Z") }, now)).toBe(false);
    expect(isRebuildRequestBlocking({ status: "failed", createdAt: new Date("2026-10-10T11:59:00Z") }, now)).toBe(false);
  });
});

describe("orderSelection", () => {
  it("developへ入った順に並べる", () => {
    expect(
      orderSelection([
        { number: 22, mergedAt: "2026-10-10T12:00:00Z" },
        { number: 20, mergedAt: "2026-10-10T10:00:00Z" },
      ]).map((x) => x.number),
    ).toEqual([20, 22]);
  });
});
