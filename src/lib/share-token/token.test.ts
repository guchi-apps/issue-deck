import { describe, expect, it } from "vitest";

import {
  extractShareToken,
  hashShareToken,
  issueShareTokenValue,
  parseDeviceId,
  provisionalTitle,
} from "./token";

describe("共有トークン", () => {
  it("発行した値はBearerから取り出せ、ハッシュが一致する", () => {
    const { value, hash } = issueShareTokenValue();
    expect(extractShareToken(`Bearer ${value}`)).toBe(value);
    expect(hashShareToken(value)).toBe(hash);
  });

  it("他の形式のBearerは共有トークンとして扱わない", () => {
    expect(extractShareToken("Bearer secret")).toBeNull();
    expect(extractShareToken(null)).toBeNull();
    expect(extractShareToken("Bearer idsh_short")).toBeNull();
  });

  it("端末IDは形式を検査する", () => {
    expect(parseDeviceId("A".repeat(16))).toBe("A".repeat(16));
    expect(parseDeviceId("short")).toBeNull();
    expect(parseDeviceId(123)).toBeNull();
  });
});

describe("仮タイトル", () => {
  it("先頭行を使い、長ければ切る", () => {
    expect(provisionalTitle("バグです\n詳細")).toBe("バグです");
    expect(provisionalTitle("a".repeat(100))).toHaveLength(80);
  });
  it("URLだけならホスト名、画像だけなら既定", () => {
    expect(provisionalTitle("https://example.com/a/b")).toBe("共有: example.com");
    expect(provisionalTitle("![image](x)")).toBe("共有された内容");
    expect(provisionalTitle("")).toBe("共有された内容");
  });
});
