// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHECK_USER_TARGET_ATTR,
  checkUserTargetProps,
  focusCheckUserTarget,
} from "@/lib/check-user-focus";

describe("focusCheckUserTarget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function putTarget(target: "approval" | "pull-requests") {
    const element = document.createElement("div");
    element.setAttribute(CHECK_USER_TARGET_ATTR, target);
    // jsdomはscrollIntoViewを実装していない
    element.scrollIntoView = vi.fn();
    document.body.append(element);
    return element;
  }

  it("対象までスクロールし、一定時間だけハイライトする", () => {
    const element = putTarget("approval");

    expect(focusCheckUserTarget("approval")).toBe(true);
    expect(element.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(element.classList.contains("check-user-flash")).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(element.classList.contains("check-user-flash")).toBe(false);
  });

  it("対象が無ければ何もしない（対応PRが無いIssueなど）", () => {
    expect(focusCheckUserTarget("pull-requests")).toBe(false);
  });

  /** PC版とスマホ版が同時にDOMへ乗るため、目印は複数ある前提で選ぶ（#1663） */
  it("目印が複数あっても、表示されている方を選ぶ", () => {
    const hidden = putTarget("approval");
    const shown = putTarget("approval");
    // jsdomはレイアウトを持たないので、可視判定に使うoffsetParentを差し替える
    Object.defineProperty(hidden, "offsetParent", { value: null });
    Object.defineProperty(shown, "offsetParent", { value: document.body });

    expect(focusCheckUserTarget("approval")).toBe(true);
    expect(hidden.scrollIntoView).not.toHaveBeenCalled();
    expect(shown.scrollIntoView).toHaveBeenCalled();
  });

  it("目印のpropsはdata属性を返す（idにしない）", () => {
    expect(checkUserTargetProps("pull-requests")).toEqual({
      [CHECK_USER_TARGET_ATTR]: "pull-requests",
    });
  });
});
