import { describe, expect, it } from "vitest";

import {
  parseSharedTokenConsumer,
  parseSharedTokenInput,
  toSharedToken,
} from "@/lib/shared-tokens";

describe("parseSharedTokenInput", () => {
  it("トークン値を含む妥当な入力を受け付ける", () => {
    expect(
      parseSharedTokenInput({
        name: "EXAMPLE_TOKEN",
        value: "secret-value",
        description: "説明",
        sourceReference: "op://apps/example/token",
      }),
    ).toEqual({
      name: "EXAMPLE_TOKEN",
      value: "secret-value",
      description: "説明",
      sourceReference: "op://apps/example/token",
    });
  });

  it("画面が空欄として送るnullの任意項目を未入力として受け付ける", () => {
    expect(
      parseSharedTokenInput({ name: "TOKEN", value: "value", description: null, sourceReference: null }),
    ).toEqual({ name: "TOKEN", value: "value", description: null, sourceReference: null });
  });

  it("値の省略（キー無し・null）は自動生成を意味するnullとして受け付ける", () => {
    expect(parseSharedTokenInput({ name: "TOKEN" })?.value).toBeNull();
    expect(parseSharedTokenInput({ name: "TOKEN", value: null })?.value).toBeNull();
  });

  it("空の値や不正な任意項目を拒否する", () => {
    expect(parseSharedTokenInput({ name: "TOKEN", value: "" })).toBeNull();
    expect(parseSharedTokenInput({ name: "TOKEN", value: 1 })).toBeNull();
    expect(parseSharedTokenInput({ name: "TOKEN", value: "value", description: 1 })).toBeNull();
    expect(
      parseSharedTokenInput({ name: "TOKEN", value: "value", description: "x".repeat(1_001) }),
    ).toBeNull();
  });
});

describe("共有トークンの表示用変換", () => {
  it("暗号化済みの値を表示用データへ含めない", () => {
    const result = toSharedToken({
      id: "token-1",
      name: "EXAMPLE_TOKEN",
      encryptedValue: "encrypted-secret-value",
      description: null,
      sourceReference: null,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      updatedAt: new Date("2026-09-01T00:00:00Z"),
      usages: [
        {
          id: "usage-1",
          sharedTokenId: "token-1",
          consumer: "aide",
          action: "read",
          usedAt: new Date("2026-09-02T00:00:00Z"),
        },
      ],
    });

    expect(result).toEqual({
      id: "token-1",
      name: "EXAMPLE_TOKEN",
      description: null,
      sourceReference: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      lastUsedAt: "2026-09-02T00:00:00.000Z",
      consumers: ["aide"],
    });
    expect(JSON.stringify(result)).not.toContain("encrypted-secret-value");
  });

  it("利用元の入力を検証する", () => {
    expect(parseSharedTokenConsumer("  aide ")).toBe("aide");
    expect(parseSharedTokenConsumer(" ")).toBeNull();
  });
});
