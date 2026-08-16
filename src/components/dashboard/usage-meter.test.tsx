// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UsageMeter } from "@/components/dashboard/usage-meter";

function fillOf(container: HTMLElement): HTMLElement {
  const fill = container.querySelector<HTMLElement>('[data-slot="usage-meter-fill"]');
  if (!fill) throw new Error("塗りが描かれていない");
  return fill;
}

function tickOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-slot="usage-meter-tick"]');
}

describe("UsageMeter", () => {
  afterEach(() => {
    cleanup();
  });

  it("塗りの幅は残量ではなく使用率になる（左から右へ伸びる）", () => {
    const { container } = render(
      <UsageMeter label="週間" usedPercent={42} remainingPercent={58} elapsedPercent={82} />,
    );
    expect(fillOf(container).style.width).toBe("42%");
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("42");
  });

  it("目盛りは経過率の位置に立つ", () => {
    const { container } = render(
      <UsageMeter label="週間" usedPercent={42} remainingPercent={58} elapsedPercent={82} />,
    );
    expect(tickOf(container)?.style.left).toBe("82%");
  });

  it("経過率が取れなければ目盛りを出さない", () => {
    const { container } = render(
      <UsageMeter label="週間" usedPercent={42} remainingPercent={58} elapsedPercent={null} />,
    );
    expect(tickOf(container)).toBeNull();
    expect(screen.queryByText(/経過/)).toBeNull();
  });

  it("0-100の外へ出た値は端に丸める", () => {
    const { container } = render(
      <UsageMeter label="週間" usedPercent={140} remainingPercent={0} elapsedPercent={-20} />,
    );
    expect(fillOf(container).style.width).toBe("100%");
    expect(tickOf(container)?.style.left).toBe("0%");
  });

  it("残量・使用率・経過率とリセットまでの時間を文字でも出す", () => {
    render(
      <UsageMeter
        label="REST"
        labelMuted
        usedPercent={1}
        remainingPercent={99}
        remainingSuffix="(5,258 / 5,300)"
        elapsedPercent={15}
        resetSentence="あと51分でリセット"
        resetTitle="4:03 (あと51分)"
      />,
    );
    expect(screen.getByText("99%")).not.toBeNull();
    expect(screen.getByText("(5,258 / 5,300)", { exact: false })).not.toBeNull();
    expect(screen.getByText("使用 1%")).not.toBeNull();
    expect(screen.getByText("経過 15%")).not.toBeNull();
    // 絶対時刻は幅を食うので画面には出さず、ツールチップにだけ置く。
    expect(screen.getByText("あと51分でリセット").getAttribute("title")).toBe("4:03 (あと51分)");
  });

  it("残量が少なければ警告色にする", () => {
    const { container } = render(
      <UsageMeter label="週間" usedPercent={93} remainingPercent={7} elapsedPercent={76} />,
    );
    expect(fillOf(container).className).toContain("bg-destructive");
  });

  it("残量が十分でも停止中なら警告色にする", () => {
    const { container } = render(
      <UsageMeter
        label="5時間"
        usedPercent={40}
        remainingPercent={60}
        elapsedPercent={30}
        isBlocked
      />,
    );
    expect(fillOf(container).className).toContain("bg-destructive");
  });

  it("通常時は警告色にしない", () => {
    const { container } = render(
      <UsageMeter label="5時間" usedPercent={5} remainingPercent={95} elapsedPercent={8} />,
    );
    expect(fillOf(container).className).toContain("bg-primary");
    expect(fillOf(container).className).not.toContain("bg-destructive");
  });
});
