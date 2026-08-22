// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualStepRunBadge } from "@/components/dashboard/manual-step-run-badge";
import type { ManualStepRunView } from "@/lib/manual-step-run-view";

function run(overrides: Partial<ManualStepRunView> = {}): ManualStepRunView {
  return {
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 2101,
    issueTitle: "[手作業] サブPC: pollerを再起動する",
    issueId: "issue-2101",
    targetHost: "subpc",
    status: "RUNNING",
    pausedReason: null,
    done: 2,
    total: 5,
    currentLine: 12,
    currentLabel: "pnpm install",
    currentJobId: null,
    message: null,
    diagnoseConsent: false,
    startedAt: "2026-08-22T00:00:00Z",
    finishedAt: null,
    ...overrides,
  };
}

afterEach(cleanup);

/** バッジ本体（ポップオーバーを開く前） */
function badge(): HTMLElement {
  return screen.getByRole("button", { name: /自動実行/ });
}

describe("自動実行バッジ（#2119）", () => {
  it("走っている実行が無ければ何も出さない", () => {
    const { container } = render(<ManualStepRunBadge runs={[]} onOpenRun={vi.fn()} />);

    expect(container.innerHTML).toBe("");
  });

  // 押せるようになっただけの変更で、見慣れた文言まで変えない
  it("1件だけなら今までどおり進み具合だけを出す", () => {
    render(<ManualStepRunBadge runs={[run()]} onOpenRun={vi.fn()} />);

    expect(badge().textContent).toContain("自動実行 2 / 5");
    expect(badge().textContent).not.toContain("件");
  });

  it("複数走っていれば件数と合計の進み具合を出す", () => {
    render(
      <ManualStepRunBadge
        runs={[run(), run({ issueNumber: 48, done: 1, total: 4 })]}
        onOpenRun={vi.fn()}
      />,
    );

    expect(badge().textContent).toContain("自動実行 2件 3 / 9");
  });

  // 走っていることに気づかないのがいちばん困る状態なので、失敗はバッジごと色を変える
  it("失敗して止まっている実行があればバッジを赤へ寄せる", () => {
    render(
      <ManualStepRunBadge
        runs={[run({ status: "PAUSED", pausedReason: "FAILED" })]}
        onOpenRun={vi.fn()}
      />,
    );

    expect(badge().className).toContain("text-destructive");
  });

  it("押すと走っている実行が全部並ぶ", () => {
    render(
      <ManualStepRunBadge
        runs={[
          run(),
          run({
            repositoryFullName: "guchi-apps/vps",
            issueNumber: 48,
            issueTitle: "[手作業] VPS: Apacheのvhostを反映する",
            targetHost: "vps",
            status: "PAUSED",
            pausedReason: "USER",
            done: 1,
            total: 4,
          }),
        ]}
        onOpenRun={vi.fn()}
      />,
    );

    fireEvent.click(badge());

    expect(screen.getByText("実行中の自動実行")).toBeTruthy();
    expect(screen.getByText("[手作業] サブPC: pollerを再起動する")).toBeTruthy();
    expect(screen.getByText("[手作業] VPS: Apacheのvhostを反映する")).toBeTruthy();
    // 止まっているものは、止まっている理由まで出す
    expect(screen.getByText("あなたが実行する手順で止まっています")).toBeTruthy();
  });

  it("行を押すとその実行を渡し、ポップオーバーを閉じる", () => {
    const onOpenRun = vi.fn();
    const target = run({ issueNumber: 48, issueTitle: "[手作業] VPS: Apacheのvhostを反映する" });
    render(<ManualStepRunBadge runs={[run(), target]} onOpenRun={onOpenRun} />);

    fireEvent.click(badge());
    fireEvent.click(screen.getByText("[手作業] VPS: Apacheのvhostを反映する"));

    expect(onOpenRun).toHaveBeenCalledWith(target);
    expect(screen.queryByText("実行中の自動実行")).toBeNull();
  });

  // タイトルを引けなかった実行でも、どのIssueなのかは押す前に分かる必要がある
  it("タイトルを引けない実行はIssue番号を出す", () => {
    render(<ManualStepRunBadge runs={[run({ issueTitle: null })]} onOpenRun={vi.fn()} />);

    fireEvent.click(badge());

    expect(screen.getByText("#2101")).toBeTruthy();
  });
});
