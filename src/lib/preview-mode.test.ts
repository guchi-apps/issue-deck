import { afterEach, describe, expect, it } from "vitest";
import { isPreviewMode, previewModeGuard } from "@/lib/preview-mode";

const ORIGINAL_PREVIEW_MODE = process.env.PREVIEW_MODE;

afterEach(() => {
  if (ORIGINAL_PREVIEW_MODE === undefined) delete process.env.PREVIEW_MODE;
  else process.env.PREVIEW_MODE = ORIGINAL_PREVIEW_MODE;
});

describe("isPreviewMode", () => {
  it("PREVIEW_MODE=trueのときtrueを返す", () => {
    process.env.PREVIEW_MODE = "true";
    expect(isPreviewMode()).toBe(true);
  });

  it("PREVIEW_MODEが未設定のときfalseを返す", () => {
    delete process.env.PREVIEW_MODE;
    expect(isPreviewMode()).toBe(false);
  });

  it("PREVIEW_MODEが'true'以外の値のときfalseを返す", () => {
    process.env.PREVIEW_MODE = "false";
    expect(isPreviewMode()).toBe(false);
    process.env.PREVIEW_MODE = "1";
    expect(isPreviewMode()).toBe(false);
  });
});

describe("previewModeGuard", () => {
  it("プレビュー環境では403のNextResponseを返す", async () => {
    process.env.PREVIEW_MODE = "true";
    const response = previewModeGuard();
    expect(response).not.toBeNull();
    expect(response?.status).toBe(403);
    const body = await response?.json();
    expect(body).toEqual({ error: "preview_mode_forbidden" });
  });

  it("プレビュー環境でなければnullを返す", () => {
    delete process.env.PREVIEW_MODE;
    expect(previewModeGuard()).toBeNull();
  });
});
