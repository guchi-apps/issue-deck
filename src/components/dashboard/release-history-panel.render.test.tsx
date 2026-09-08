// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReleaseHistoryPanel } from "@/components/dashboard/release-history-panel";
import type { ReleaseHistoryItem } from "@/lib/github/release-api";

function entry(overrides: Partial<ReleaseHistoryItem> = {}): ReleaseHistoryItem {
  return {
    repoFullName: "guchi-apps/issue-deck",
    tagName: "v4.78.0",
    name: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/releases/tag/v4.78.0",
    publishedAt: "2026-09-06T05:00:00.000Z",
    body: "## What's Changed\n* 修正を依頼する導線を足す by @m-guchi in guchi-apps/issue-deck#2919\n",
    ...overrides,
  };
}

const SINCE = "2026-09-01T00:00:00.000Z";

function renderPanel(props: Partial<Parameters<typeof ReleaseHistoryPanel>[0]> = {}) {
  const onToggleChecked = vi.fn();
  const onToggleCheckTarget = vi.fn();
  render(
    <ReleaseHistoryPanel
      entries={[entry()]}
      isLoading={false}
      error={null}
      onRefresh={() => {}}
      checkTargets={[{ repoFullName: "guchi-apps/issue-deck", since: SINCE }]}
      checkRecords={[]}
      checkRepositoryOptions={[
        { id: "repo-1", name: "issue-deck", fullName: "guchi-apps/issue-deck" },
        { id: "repo-2", name: "car-care", fullName: "guchi-apps/car-care" },
      ]}
      onToggleChecked={onToggleChecked}
      onToggleCheckTarget={onToggleCheckTarget}
      {...props}
    />,
  );
  return { onToggleChecked, onToggleCheckTarget };
}

afterEach(() => {
  cleanup();
});

describe("ReleaseHistoryPanel の動作確認フラグ（#2930）", () => {
  it("対象リポジトリの新しいリリースには未確認のバッジと件数が出る", () => {
    renderPanel();
    expect(screen.getByText("未確認")).toBeTruthy();
    expect(screen.getByText("未確認 1件")).toBeTruthy();
    expect(screen.getByRole("button", { name: "確認済みにする" })).toBeTruthy();
  });

  it("「確認済みにする」を押すとリポジトリとタグを渡して呼ばれる", () => {
    const { onToggleChecked } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "確認済みにする" }));
    expect(onToggleChecked).toHaveBeenCalledWith(
      { repoFullName: "guchi-apps/issue-deck", tagName: "v4.78.0" },
      true,
    );
  });

  it("確認済みの記録があるリリースは、確認済みの表示と戻す導線になる", () => {
    const { onToggleChecked } = renderPanel({
      checkRecords: [
        {
          repoFullName: "guchi-apps/issue-deck",
          tagName: "v4.78.0",
          checkedAt: "2026-09-07T12:00:00.000Z",
        },
      ],
    });
    expect(screen.getByText("確認済み")).toBeTruthy();
    expect(screen.queryByText("未確認 1件")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "未確認に戻す" }));
    expect(onToggleChecked).toHaveBeenCalledWith(
      { repoFullName: "guchi-apps/issue-deck", tagName: "v4.78.0" },
      false,
    );
  });

  it("対象に加える前のリリースにはフラグが付かない", () => {
    renderPanel({ entries: [entry({ publishedAt: "2026-08-20T00:00:00.000Z" })] });
    expect(screen.queryByText("未確認")).toBeNull();
    expect(screen.queryByRole("button", { name: "確認済みにする" })).toBeNull();
  });

  it("対象を1つも選んでいなければ「対象外」の印も出さない", () => {
    renderPanel({ checkTargets: [] });
    expect(screen.queryByText("対象外")).toBeNull();
    expect(screen.queryByText("未確認")).toBeNull();
  });

  it("対象を選んでいるとき、選んでいないリポジトリには「対象外」が出る", () => {
    renderPanel({
      entries: [entry(), entry({ repoFullName: "guchi-apps/car-care", tagName: "v1.12.0" })],
    });
    expect(screen.getByText("対象外")).toBeTruthy();
  });

  it("「未確認だけ」で確認済みと対象外のカードが隠れる", () => {
    renderPanel({
      entries: [entry(), entry({ repoFullName: "guchi-apps/car-care", tagName: "v1.12.0" })],
    });
    expect(screen.getByText("car-care")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "未確認だけ" }));
    expect(screen.queryByText("car-care")).toBeNull();
    expect(screen.getByText("issue-deck")).toBeTruthy();
    // 件数は絞り込みの前の母集団から数えるので動かない
    expect(screen.getByText("未確認 1件")).toBeTruthy();
  });

  it("未確認が1件も無い状態で「未確認だけ」を押すと、専用の案内を出す", () => {
    renderPanel({ checkTargets: [] });
    fireEvent.click(screen.getByRole("button", { name: "未確認だけ" }));
    expect(screen.getByText("未確認のリリースはありません。")).toBeTruthy();
  });
});
