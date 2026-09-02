// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PreviewPanel } from "@/components/dashboard/preview-panel";
import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";

const NOW = new Date("2026-08-29T12:00:00.000Z");

function host(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck", "guchi-apps/dayspan", "guchi-apps/car-care"],
    contractVersion: 2,
    online: true,
    lastSeenAt: NOW.toISOString(),
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: true,
    manualStepAbortCapable: true,
    manualStepValuesCapable: true,
    planReviewCapable: true,
    codeReviewCapable: true,
    codexCapable: null,
    codexRemoteControlCapable: null,
    manualStepSessionCapable: null,
    selfUpdateCapable: true,
    previewCapable: true,
    rebootCapable: null,
    reboot: null,
    previewRepositories: [
      "guchi-apps/issue-deck",
      "guchi-apps/dayspan",
      "guchi-apps/car-care",
    ],
    preview: null,
    maxSessions: 12,
    liveSessions: 0,
    metrics: null,
    launchHold: null,
    checkout: null,
    ...overrides,
  };
}

/**
 * #2455。理由が出る画面（確認環境）と押すボタンのある画面（実行キュー）が別なので、
 * 文言には置き場所まで書く。行ごとに繰り返すと、申告しているリポジトリの数だけ同じ長文が並ぶ。
 */
describe("PreviewPanel の押せない理由（#2455）", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("pollerが古いときは、押すボタンの場所を含む理由を1回だけ出す", () => {
    render(<PreviewPanel hosts={[host({ previewCapable: null })]} jobs={[]} isLoaded />);

    const notices = screen.getAllByText(/pollerが確認環境に対応していません/);
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toContain("実行キュー");
    expect(notices[0].textContent).toContain("実行状況");
    expect(notices[0].textContent).toContain("サブPCのカード");
    expect(notices[0].textContent).toContain("「更新して再起動」");
    // 行そのものは消さない（どのリポジトリを起こせるはずなのかは見えたままにする）
    expect(screen.getByText("issue-deck")).not.toBeNull();
  });

  // 行の`title`はタッチでは読めない。縮めた版でも理由そのものは出す
  it("スマホ（compact）でも理由を出す", () => {
    render(
      <PreviewPanel hosts={[host({ previewCapable: false })]} jobs={[]} isLoaded compact />,
    );
    expect(screen.getAllByText(/pollerが確認環境に対応していません/)).toHaveLength(1);
  });

  it("応答していないホストも、理由をまとめて1回だけ出す", () => {
    render(<PreviewPanel hosts={[host({ online: false })]} jobs={[]} isLoaded />);
    expect(screen.getAllByText(/サブPCが応答していません/)).toHaveLength(1);
  });

  // 行ごとに違う理由（開発サーバーの有無）は従来どおり行に出す
  it("行ごとに違う理由は、まとめずその行に出す", () => {
    render(
      <PreviewPanel
        hosts={[
          host({
            repositories: ["guchi-apps/issue-deck", "guchi-apps/vps"],
            previewRepositories: ["guchi-apps/issue-deck"],
          }),
        ]}
        jobs={[]}
        isLoaded
      />,
    );
    expect(screen.getByText("開発サーバーがありません")).not.toBeNull();
    expect(screen.queryByText(/pollerが確認環境に対応していません/)).toBeNull();
  });
});
