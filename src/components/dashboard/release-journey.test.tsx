// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReleaseJourneyInline, ReleaseJourneyNow } from "@/components/dashboard/release-journey";
import type { JourneyStepKey, ReleaseJourney } from "@/lib/release-journey";

afterEach(() => cleanup());

const KEYS: JourneyStepKey[] = ["create", "verify", "approve", "final", "merge", "deploy", "prod"];

function journey(key: JourneyStepKey, overrides: Partial<ReleaseJourney>): ReleaseJourney {
  return {
    candidateLabel: "RC-21",
    legacy: false,
    steps: KEYS.map((k) => ({ key: k, label: k, state: k === key ? "user" : "todo", status: null, title: null, at: null })),
    done: 0,
    total: 7,
    headline: { key, label: "", tone: "user", title: null },
    owner: "user",
    attention: null,
    next: null,
    others: [],
    checks: null,
    predecessor: null,
    updatedAt: null,
    stale: false,
    ...overrides,
  };
}

const approval = journey("approve", {
  headline: { key: "approve", label: "公開承認待ち", tone: "user", title: null },
  attention: "approval",
});
const decision = journey("verify", {
  headline: { key: "verify", label: "全体レビュー要確認", tone: "user", title: null },
  attention: "decision",
});

describe("工程の人の番の描き分け（#5099）", () => {
  it("担当チップに承認・判断を文言で添え、読み上げにも含める", () => {
    render(
      <>
        <ReleaseJourneyInline journey={approval} />
        <ReleaseJourneyInline journey={decision} />
      </>,
    );
    const [approvalChip, decisionChip] = screen.getAllByTestId("release-journey-owner");
    expect(approvalChip.textContent).toBe("担当: あなた・承認");
    expect(approvalChip.dataset.attention).toBe("approval");
    expect(decisionChip.textContent).toBe("担当: あなた・判断");
    expect(decisionChip.className).toContain("border-dashed");
    expect(approvalChip.className).not.toContain("border-dashed");
    expect(screen.getByRole("img", { name: /公開承認待ち（担当: あなた・承認）/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: /全体レビュー要確認（担当: あなた・判断）/ })).toBeTruthy();
  });

  it("自動で進む工程は承認・判断を添えない", () => {
    render(
      <ReleaseJourneyNow
        journey={journey("verify", { headline: { key: "verify", label: "修正Issue #1を対応中", tone: "fixing", title: null }, owner: "auto" })}
      />,
    );
    expect(screen.getByTestId("release-journey-owner").textContent).toBe("担当: 自動");
  });
});
