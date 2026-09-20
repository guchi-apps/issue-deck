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
  const onToggleCheckedLine = vi.fn();
  const onToggleCheckTarget = vi.fn();
  render(
    <ReleaseHistoryPanel
      entries={[entry()]}
      isLoading={false}
      error={null}
      onRefresh={() => {}}
      checkTargets={[{ repoFullName: "guchi-apps/issue-deck", since: SINCE }]}
      checkRecords={[]}
      checkLineRecords={[]}
      checkRepositoryOptions={[
        { id: "repo-1", name: "issue-deck", fullName: "guchi-apps/issue-deck" },
        { id: "repo-2", name: "car-care", fullName: "guchi-apps/car-care" },
      ]}
      onToggleChecked={onToggleChecked}
      onToggleCheckedLine={onToggleCheckedLine}
      onToggleCheckTarget={onToggleCheckTarget}
      {...props}
    />,
  );
  return { onToggleChecked, onToggleCheckedLine, onToggleCheckTarget };
}

/** 初期表示は未確認だけなので、確認済み・対象外のカードを見るときは先にこのボタンを押す（#3170） */
function showAllReleases() {
  // 未確認が0件のときは案内の横にも同名の入口が出るので、ヘッダーのボタン（先頭）を押す
  fireEvent.click(screen.getAllByRole("button", { name: "確認済みも表示" })[0]);
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
    // 確認済みだけなので、初期表示では隠れている
    expect(screen.queryByText("確認済み")).toBeNull();
    showAllReleases();
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
    showAllReleases();
    expect(screen.getByText("v4.78.0")).toBeTruthy();
    expect(screen.queryByText("未確認")).toBeNull();
    expect(screen.queryByRole("button", { name: "確認済みにする" })).toBeNull();
  });

  it("対象を1つも選んでいなければ「対象外」の印も出さない", () => {
    renderPanel({ checkTargets: [] });
    showAllReleases();
    expect(screen.getByText("v4.78.0")).toBeTruthy();
    expect(screen.queryByText("対象外")).toBeNull();
    expect(screen.queryByText("未確認")).toBeNull();
  });

  it("対象を選んでいるとき、選んでいないリポジトリには「対象外」が出る", () => {
    renderPanel({
      entries: [entry(), entry({ repoFullName: "guchi-apps/car-care", tagName: "v1.12.0" })],
    });
    showAllReleases();
    expect(screen.getByText("対象外")).toBeTruthy();
  });
});

describe("ReleaseHistoryPanel の初期表示（#3170）", () => {
  const mixedEntries = [
    entry(),
    entry({ repoFullName: "guchi-apps/car-care", tagName: "v1.12.0" }),
    entry({ tagName: "v4.77.0", publishedAt: "2026-09-05T05:00:00.000Z" }),
  ];
  const checkedRecord = {
    repoFullName: "guchi-apps/issue-deck",
    tagName: "v4.77.0",
    checkedAt: "2026-09-07T12:00:00.000Z",
  };

  it("初期表示は未確認のカードだけで、確認済みと対象外は隠れる", () => {
    renderPanel({ entries: mixedEntries, checkRecords: [checkedRecord] });
    expect(screen.getByText("v4.78.0")).toBeTruthy();
    expect(screen.queryByText("v4.77.0")).toBeNull();
    expect(screen.queryByText("car-care")).toBeNull();
    expect(screen.getByText("未確認のリリースを新しい順に並べています")).toBeTruthy();
  });

  it("「確認済みも表示」を押すと全件に切り替わり、もう一度押すと未確認だけに戻る", () => {
    renderPanel({ entries: mixedEntries, checkRecords: [checkedRecord] });
    const toggle = screen.getByRole("button", { name: "確認済みも表示" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("v4.77.0")).toBeTruthy();
    expect(screen.getByText("car-care")).toBeTruthy();
    // 件数は絞り込みの前の母集団から数えるので動かない
    expect(screen.getByText("未確認 1件")).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.queryByText("v4.77.0")).toBeNull();
    expect(screen.queryByText("car-care")).toBeNull();
  });

  it("未確認が1件も無いときは専用の案内と、全件へ切り替える入口を出す", () => {
    renderPanel({ checkTargets: [] });
    expect(screen.getByText("未確認のリリースはありません。")).toBeTruthy();
    expect(screen.queryByText("v4.78.0")).toBeNull();

    // 案内の横の入口はヘッダーのボタンと同じ名前で、押すと全件が出る
    const [, entrance] = screen.getAllByRole("button", { name: "確認済みも表示" });
    fireEvent.click(entrance);
    expect(screen.getByText("v4.78.0")).toBeTruthy();
    expect(screen.queryByText("未確認のリリースはありません。")).toBeNull();
  });

  it("リリースがまだ無いときは、絞り込みの案内ではなく従来の案内を出す", () => {
    renderPanel({ entries: [] });
    expect(screen.getByText("リリースがまだありません。")).toBeTruthy();
    expect(screen.queryByText("未確認のリリースはありません。")).toBeNull();
  });
});

describe("ReleaseHistoryPanel の箇条書き行ごとの確認チェック（#2982）", () => {
  it("箇条書き行にチェックボックスが出て、押すとリポジトリ・タグ・行番号を渡して呼ばれる", () => {
    const { onToggleCheckedLine } = renderPanel();
    const checkbox = screen.getByRole("checkbox", {
      name: "「修正を依頼する導線を足す」を確認済みにする（参考）",
    });
    expect(checkbox).toBeTruthy();

    fireEvent.click(checkbox);
    expect(onToggleCheckedLine).toHaveBeenCalledWith(
      { repoFullName: "guchi-apps/issue-deck", tagName: "v4.78.0", lineKey: "guchi-apps/issue-deck#2919" },
      true,
    );
  });

  it("記録済みの行はチェック済みで表示され、外すとfalseで呼ばれる", () => {
    const { onToggleCheckedLine } = renderPanel({
      checkLineRecords: [
        {
          repoFullName: "guchi-apps/issue-deck",
          tagName: "v4.78.0",
          lineKey: "guchi-apps/issue-deck#2919",
          checkedAt: "2026-09-07T12:00:00.000Z",
        },
      ],
    });
    const checkbox = screen.getByRole("checkbox", {
      name: "「修正を依頼する導線を足す」を確認済みにする（参考）",
    });
    expect(checkbox.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(checkbox);
    expect(onToggleCheckedLine).toHaveBeenCalledWith(
      { repoFullName: "guchi-apps/issue-deck", tagName: "v4.78.0", lineKey: "guchi-apps/issue-deck#2919" },
      false,
    );
  });

  it("対象外のリリースでも参考チェックは表示される", () => {
    renderPanel({
      entries: [entry({ repoFullName: "guchi-apps/car-care", tagName: "v1.12.0" })],
    });
    showAllReleases();
    expect(
      screen.getByRole("checkbox", { name: "「修正を依頼する導線を足す」を確認済みにする（参考）" }),
    ).toBeTruthy();
  });
});

describe("ReleaseHistoryPanel のPR詳細への導線（#3128）", () => {
  const URL_BODY =
    "## What's Changed\n* 修正を依頼する導線を足す by @m-guchi in https://github.com/guchi-apps/issue-deck/pull/3114\n";

  it("箇条書きのタイトルを押すとPR idを渡して呼ばれる（自動生成本文のURL形式）", () => {
    const onOpenPullRequest = vi.fn();
    renderPanel({ entries: [entry({ body: URL_BODY })], onOpenPullRequest });
    fireEvent.click(screen.getByRole("button", { name: "修正を依頼する導線を足す" }));
    expect(onOpenPullRequest).toHaveBeenCalledWith("guchi-apps/issue-deck#3114");
  });

  it("owner/repo#N形式の行も押せる", () => {
    const onOpenPullRequest = vi.fn();
    renderPanel({ onOpenPullRequest });
    fireEvent.click(screen.getByRole("button", { name: "修正を依頼する導線を足す" }));
    expect(onOpenPullRequest).toHaveBeenCalledWith("guchi-apps/issue-deck#2919");
  });

  it("PR参照を持たない手書きの行は押せない", () => {
    renderPanel({
      entries: [entry({ body: "* 手書きのメモ書き\n" })],
      onOpenPullRequest: vi.fn(),
    });
    expect(screen.getByText("手書きのメモ書き")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "手書きのメモ書き" })).toBeNull();
  });

  it("onOpenPullRequestを渡さなければ押せないテキストのまま", () => {
    renderPanel({ entries: [entry({ body: URL_BODY })] });
    expect(screen.queryByRole("button", { name: "修正を依頼する導線を足す" })).toBeNull();
  });

  it("確認チェックボックスを押してもPR詳細は開かず、行の確認記録だけが呼ばれる", () => {
    const onOpenPullRequest = vi.fn();
    const { onToggleCheckedLine } = renderPanel({ entries: [entry({ body: URL_BODY })], onOpenPullRequest });
    fireEvent.click(screen.getByRole("checkbox", { name: /を確認済みにする（参考）/ }));
    expect(onToggleCheckedLine).toHaveBeenCalledTimes(1);
    expect(onOpenPullRequest).not.toHaveBeenCalled();
  });
});
