// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReleasePublishAction } from "@/components/dashboard/release-publish-action";
import type { RcPublishDecision } from "@/lib/release-rc-action";
import type { PullRequestSummary } from "@/types/pull-request";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

const pullRequest = { headRef: "release-rc/5", number: 596 } as PullRequestSummary;
const verify: RcPublishDecision = { ok: false, error: "rc_not_prepared", next: "verify", message: "公開準備がまだです" };
const preparing: RcPublishDecision = { ok: false, error: "rc_preparing", next: "wait", message: "公開準備中です" };

describe("ReleasePublishAction の hideVerifyHint（#4938）", () => {
  afterEach(cleanup);

  it("検証の合格待ちの理由文だけを出さない", () => {
    const { container } = render(<ReleasePublishAction pullRequest={pullRequest} decision={verify} onMerged={() => {}} hideVerifyHint />);
    expect(container.innerHTML).toBe("");
  });

  it("公開準備中など他の理由文は残す", () => {
    render(<ReleasePublishAction pullRequest={pullRequest} decision={preparing} onMerged={() => {}} hideVerifyHint />);
    expect(screen.getByText("公開準備中です")).toBeTruthy();
  });

  it("指定しなければ検証待ちの理由文も出す（PR詳細）", () => {
    render(<ReleasePublishAction pullRequest={pullRequest} decision={verify} onMerged={() => {}} />);
    expect(screen.getByText("公開準備がまだです")).toBeTruthy();
  });
});
