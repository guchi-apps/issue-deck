import { describe, expect, it } from "vitest";

import {
  POST_CREATE_DESTINATION_DEFAULT,
  normalizePostCreateDestinationSetting,
  resolvePostCreateDestination,
  shouldAskPostCreateDestination,
} from "@/lib/post-create-destination";

describe("normalizePostCreateDestinationSetting", () => {
  it("設定として妥当な値はそのまま返す", () => {
    expect(normalizePostCreateDestinationSetting("ask")).toBe("ask");
    expect(normalizePostCreateDestinationSetting("detail")).toBe("detail");
    expect(normalizePostCreateDestinationSetting("stay")).toBe("stay");
  });

  it("端末に残った未知の値・壊れた値は既定へ落とす", () => {
    expect(normalizePostCreateDestinationSetting("issue")).toBe(POST_CREATE_DESTINATION_DEFAULT);
    expect(normalizePostCreateDestinationSetting(null)).toBe(POST_CREATE_DESTINATION_DEFAULT);
    expect(normalizePostCreateDestinationSetting(undefined)).toBe(POST_CREATE_DESTINATION_DEFAULT);
    expect(normalizePostCreateDestinationSetting(1)).toBe(POST_CREATE_DESTINATION_DEFAULT);
  });
});

describe("shouldAskPostCreateDestination", () => {
  it("既定（毎回選ぶ）では選択画面を出す", () => {
    expect(shouldAskPostCreateDestination(POST_CREATE_DESTINATION_DEFAULT)).toBe(true);
  });

  it("行き先を記憶していれば選択画面を出さない", () => {
    expect(shouldAskPostCreateDestination("detail")).toBe(false);
    expect(shouldAskPostCreateDestination("stay")).toBe(false);
  });
});

describe("resolvePostCreateDestination", () => {
  it("記憶した行き先をそのまま返す", () => {
    expect(resolvePostCreateDestination("detail")).toBe("detail");
    expect(resolvePostCreateDestination("stay")).toBe("stay");
  });

  it("毎回選ぶ設定のまま呼ばれた場合は従来の挙動（詳細へ移動）へ落とす", () => {
    expect(resolvePostCreateDestination("ask")).toBe("detail");
  });
});
