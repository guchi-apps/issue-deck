// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReleaseRcNextStep } from "@/components/dashboard/release-rc-next-step";
import type { RcCandidateView } from "@/lib/release-rc-run";

const candidate = (status: string, attention: string | null = null): RcCandidateView =>
  ({ label: "RC-2", currentRevision: 3, phase: "review", status: { status, label: "ラベル", reason: "理由", attention } }) as never;

describe("ReleaseRcNextStep（#4635）", () => {
  afterEach(cleanup);
  const text = () => screen.getByTestId("release-rc-next-step-action").textContent ?? "";

  it("検証中は自動で進む", () => {
    render(<ReleaseRcNextStep candidate={candidate("verifying")} />);
    expect(text()).toContain("自動で進みます");
  });
  it("失敗・要修正は「自動で進む」と言わず再実行・修正へ案内する", () => {
    render(<ReleaseRcNextStep candidate={candidate("needs_fix")} />);
    expect(text()).not.toContain("自動で進みます");
    expect(text()).toContain("再実行");
  });
  it("合格後は公開準備へ", () => {
    render(<ReleaseRcNextStep candidate={candidate("ready_to_prepare")} />);
    expect(text()).toContain("本番公開へ進む（公開承認）");
  });
  it("記録との食い違いがあるときは自動で進むと言わない", () => {
    render(<ReleaseRcNextStep candidate={candidate("awaiting_verification", "候補のPRを取得できませんでした")} />);
    expect(text()).not.toContain("自動で進みます");
  });
});
