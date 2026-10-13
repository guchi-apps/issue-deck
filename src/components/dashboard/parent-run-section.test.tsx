// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ParentRunSection } from "@/components/dashboard/parent-run-section";
import type { ChildDisplay } from "@/lib/parent-run/decide";
import type { ParentRunView } from "@/lib/parent-run/run";

const R = "guchi-apps/issue-deck";
const display = (phase: ChildDisplay["phase"], label: string, reason: string, action: ChildDisplay["action"] = null): ChildDisplay => ({
  phase,
  label,
  reason,
  dependencies: [],
  prNumber: null,
  action,
});
const child = (number: number, d: ChildDisplay) => ({
  repository: R,
  number,
  title: `子${number}`,
  launchState: "LAUNCHED" as const,
  attempt: 1,
  verified: false,
  display: d,
});

const run: ParentRunView = {
  id: "r1",
  parent: { repository: R, number: 100 },
  status: "RUNNING",
  planVersion: 3,
  hostName: "subpc",
  agent: "claude",
  maxParallel: 2,
  startedAt: new Date().toISOString(),
  notice: null,
  verified: false,
  summary: {
    counts: { done: 2, running: 1, waiting: 2, attention: 1, total: 6 },
    next: `${R}#4542`,
    evidence: [
      { label: "子のdevelopマージ", ok: false, detail: "2/6" },
      { label: "本番確認", ok: false, detail: "未確認（人が記録します）" },
    ],
    complete: false,
  },
  children: [
    child(1, display("done", "完了", "PR #10がdevelopへマージ済み")),
    child(2, display("running", "実行中", "セッションが実行中です")),
    child(3, display("attention", "起動失敗", "起動ジョブがFAILEDで終わりました", "retry")),
    child(4, display("blocked", "停止（前提の問題）", "#3の対応が済むまで進めません")),
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ParentRunSection", () => {
  it("件数・子ごとの状態・待機理由・対応先・完了条件の証拠を出し、主操作は新規起動の一時停止", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ run, plan: null }) })));
    render(<ParentRunSection repositoryFullName={R} issueNumber={100} hosts={[]} />);
    await waitFor(() => expect(screen.getByTestId("parent-run-section")).toBeTruthy());
    expect(screen.getByTestId("parent-run-summary").textContent).toContain("完了2件／実行中1件／待機2件");
    expect(screen.getByTestId("parent-run-attention").textContent).toContain("起動ジョブがFAILEDで終わりました");
    expect(screen.getByText("#3の対応が済むまで進めません")).toBeTruthy();
    expect(screen.getByRole("button", { name: "新規起動を一時停止" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "再試行" })).toBeTruthy();
    expect(screen.getByTestId("parent-run-evidence").textContent).toContain("本番確認: 未確認");
  });

  it("計画も実行も無い親（本文のみのEpic）には何も出さない", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ run: null, plan: null }) })));
    const { container } = render(<ParentRunSection repositoryFullName={R} issueNumber={100} hosts={[]} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
