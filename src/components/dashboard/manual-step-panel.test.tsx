// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualStepPanel } from "@/components/dashboard/manual-step-panel";

describe("ManualStepPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("完了・実施せずのそれぞれのクローズを呼び分ける", () => {
    const onComplete = vi.fn();
    const onSkip = vi.fn();
    render(<ManualStepPanel isSubmitting={false} onComplete={onComplete} onSkip={onSkip} />);

    fireEvent.click(screen.getByRole("button", { name: "手作業を完了してクローズ" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "実施せずクローズ" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("送信中はどちらのボタンも押せない", () => {
    const onComplete = vi.fn();
    const onSkip = vi.fn();
    render(<ManualStepPanel isSubmitting onComplete={onComplete} onSkip={onSkip} />);

    for (const button of screen.getAllByRole<HTMLButtonElement>("button")) {
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(onComplete).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });
});
