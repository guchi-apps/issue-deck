import { describe, expect, it } from "vitest";

import { buildWeakEtag, matchesIfNoneMatch } from "./response-etag";

describe("buildWeakEtag", () => {
  it("同じ内容なら同じETagになる", () => {
    expect(buildWeakEtag([{ id: 1, body: "a" }])).toBe(buildWeakEtag([{ id: 1, body: "a" }]));
  });

  it("内容が変わればETagも変わる", () => {
    expect(buildWeakEtag([{ id: 1, body: "a" }])).not.toBe(buildWeakEtag([{ id: 1, body: "b" }]));
  });

  it("弱いETagの形で返す", () => {
    expect(buildWeakEtag({})).toMatch(/^W\/"[\w-]+"$/);
  });
});

describe("matchesIfNoneMatch", () => {
  const etag = 'W/"abc"';

  it("ヘッダーが無ければ一致しない", () => {
    expect(matchesIfNoneMatch(null, etag)).toBe(false);
  });

  it("同じETagなら一致する", () => {
    expect(matchesIfNoneMatch('W/"abc"', etag)).toBe(true);
  });

  it("W/の有無は無視して比べる（プロキシが強弱を付け替えても通す）", () => {
    expect(matchesIfNoneMatch('"abc"', etag)).toBe(true);
  });

  it("並んだ候補のどれかに一致すればよい", () => {
    expect(matchesIfNoneMatch('W/"x", W/"abc"', etag)).toBe(true);
  });

  it("*は常に一致する", () => {
    expect(matchesIfNoneMatch("*", etag)).toBe(true);
  });

  it("違うETagなら一致しない", () => {
    expect(matchesIfNoneMatch('W/"xyz"', etag)).toBe(false);
  });
});
