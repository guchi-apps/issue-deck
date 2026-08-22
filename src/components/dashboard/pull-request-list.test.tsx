// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestList } from "@/components/dashboard/pull-request-list";
import type { PullRequestSummary, PullRequestViewId } from "@/types/pull-request";

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  const repositoryFullName = overrides.repositoryFullName ?? "guchi-apps/issue-deck";
  const number = overrides.number ?? 1;
  return {
    id: `${repositoryFullName}#${number}`,
    repositoryFullName,
    repositoryPrivate: false,
    number,
    title: "PRのタイトル",
    htmlUrl: `https://github.com/${repositoryFullName}/pull/${number}`,
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: `issue-${number}`,
    kind: "issue",
    linkedIssueNumber: number,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "unknown", step: null, runUrl: null },
    mergeable: null,
    repairWorkflowAvailability: {},
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

type RenderOverrides = Partial<{
  view: PullRequestViewId;
  isLoading: boolean;
  error: string | null;
  failedRepositories: string[];
  selectedPullRequestId: string | null;
  onSelectPullRequest: (pullRequest: PullRequestSummary) => void;
  onPullToRefresh: () => Promise<unknown> | void;
}>;

function renderList(pullRequests: PullRequestSummary[], overrides: RenderOverrides = {}) {
  return render(
    <PullRequestList
      view={overrides.view ?? "in-progress"}
      pullRequests={pullRequests}
      failedRepositories={overrides.failedRepositories ?? []}
      fetchedAt="2026-08-11T10:30:00Z"
      isLoading={overrides.isLoading ?? false}
      error={overrides.error ?? null}
      onPullToRefresh={overrides.onPullToRefresh}
      selectedPullRequestId={overrides.selectedPullRequestId ?? null}
      onSelectPullRequest={overrides.onSelectPullRequest}
    />,
  );
}

/**
 * jsdomには`TouchEvent`のコンストラクタが無いため、ハンドラが読む`touches`だけを持つ
 * イベントを組み立てる（`use-pull-to-refresh.test.tsx`と同じ作り）。
 */
function touchEvent(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: [{ clientX: x, clientY: y }] });
  return event;
}

describe("PullRequestList", () => {
  afterEach(() => {
    cleanup();
  });

  it("PRが無いときはビューに応じた空状態を表示する", () => {
    renderList([]);
    expect(screen.getByText("実行中のPull Requestはありません。")).toBeTruthy();

    cleanup();
    renderList([], { view: "all" });
    expect(screen.getByText("開いているPull Requestはありません。")).toBeTruthy();
  });

  it("リポジトリごとにグループ化し、件数を表示する", () => {
    renderList([
      makePullRequest({ repositoryFullName: "guchi-apps/issue-deck", number: 1 }),
      makePullRequest({ repositoryFullName: "guchi-apps/dayspan", number: 2, createdAt: "2026-08-02T00:00:00Z" }),
      makePullRequest({ repositoryFullName: "guchi-apps/dayspan", number: 3, createdAt: "2026-08-03T00:00:00Z" }),
    ]);

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "guchi-apps/issue-deck1",
      "guchi-apps/dayspan2",
    ]);
    expect(screen.getByText("3件")).toBeTruthy();
  });

  it("CI通過済みのPRにはマージボタンを出す", () => {
    renderList([makePullRequest({ ciState: "success" })]);
    expect(screen.getByRole("button", { name: "マージする" })).toBeTruthy();
    expect(screen.getByText("CI通過")).toBeTruthy();
  });

  it("CI実行中・Auto-merge有効のPRにもマージボタンを出す（#1087）", () => {
    renderList([
      makePullRequest({ number: 1, ciState: "pending" }),
      makePullRequest({ number: 3, autoMergeEnabled: true }),
    ]);
    expect(screen.getAllByRole("button", { name: "マージする" })).toHaveLength(2);
    expect(screen.getByText("CI実行中")).toBeTruthy();
    expect(screen.getByText("Auto-merge有効")).toBeTruthy();
  });

  it("自動でマージされないPRには「ユーザーのマージが必要です」を出す（#1469）", () => {
    renderList([
      // 対応Issueに00.check-userが付いた実装PR
      makePullRequest({ number: 1, linkedIssueCheckUser: true }),
      // develop→mainのリリースPR（常に人がマージする）
      makePullRequest({
        number: 2,
        kind: "release",
        baseRef: "main",
        headRef: "develop",
        linkedIssueNumber: null,
      }),
    ]);
    expect(screen.getAllByText("ユーザーのマージが必要です")).toHaveLength(2);
  });

  it("判定が確定していないPRには出さない（#1469）", () => {
    renderList([makePullRequest({ linkedIssueCheckUser: false })]);
    expect(screen.queryByText("ユーザーのマージが必要です")).toBeNull();
  });

  // 一覧も`mergeable`を持つようになった（#1742）。CI通過だけを見て「入れられる」と読めてしまう
  // 状態を無くすのが目的なので、バッジと自動解消ボタンをここで確かめる。
  it("コンフリクトしているPRはその旨と自動解消ボタンを出し、マージボタンを出さない（#1742）", () => {
    renderList([makePullRequest({ ciState: "success", mergeable: false })]);
    expect(screen.getByText("CI通過")).toBeTruthy();
    expect(screen.getByText("コンフリクトあり")).toBeTruthy();
    expect(screen.getByRole("button", { name: "コンフリクトを自動解消" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
  });

  it("コンフリクトの判定が出ていないPRには何も出さない（#1742）", () => {
    renderList([makePullRequest({ mergeable: null })]);
    expect(screen.queryByText("コンフリクトあり")).toBeNull();
    expect(screen.queryByRole("button", { name: "コンフリクトを自動解消" })).toBeNull();
    expect(screen.getByRole("button", { name: "マージする" })).toBeTruthy();
  });

  it("CI失敗のPRには自動修正ボタンを出す（#1293）", () => {
    renderList([makePullRequest({ ciState: "failure" })]);
    expect(screen.getByRole("button", { name: "CI失敗を自動修正" })).toBeTruthy();
  });

  // 自動修復ワークフローが配られていないリポジトリでは、押しても404で起動しない（#1960）。
  // ボタンは消さず、押せなくしたうえで理由と配り先を添える。
  it("自動修復ワークフローが未配布なら修復ボタンを押せなくして理由を添える（#1960）", () => {
    renderList([
      makePullRequest({
        ciState: "failure",
        mergeable: false,
        repairWorkflowAvailability: { ci: "missing", conflict: "missing" },
      }),
    ]);

    const ciButton = screen.getByRole("button", { name: "CI失敗を自動修正" });
    const conflictButton = screen.getByRole("button", { name: "コンフリクトを自動解消" });
    expect(ciButton.hasAttribute("disabled")).toBe(true);
    expect(conflictButton.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText(
        "自動修復ワークフローが未配布です。設定 › フリート運用 から、このリポジトリへ配布できます。",
      ),
    ).toBeTruthy();
  });

  it("片方だけ未配布ならその種類だけ押せなくする（#1960）", () => {
    renderList([
      makePullRequest({
        ciState: "failure",
        mergeable: false,
        repairWorkflowAvailability: { ci: "available", conflict: "missing" },
      }),
    ]);

    expect(screen.getByRole("button", { name: "CI失敗を自動修正" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(
      screen.getByRole("button", { name: "コンフリクトを自動解消" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText(
        "コンフリクト解消のワークフローが未配布です。設定 › フリート運用 から、このリポジトリへ配布できます。",
      ),
    ).toBeTruthy();
  });

  it("配布状況を判定していないPRは従来どおり押せる（#1960）", () => {
    renderList([makePullRequest({ ciState: "failure", repairWorkflowAvailability: {} })]);

    expect(screen.getByRole("button", { name: "CI失敗を自動修正" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(screen.queryByText(/未配布/)).toBeNull();
  });

  it("draftのPRはGitHubがマージを受け付けないためボタンを出さない", () => {
    renderList([makePullRequest({ draft: true })]);
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
    expect(screen.getByText("ドラフト")).toBeTruthy();
  });

  it("自動マージ可否の判定中は「判定中」で押せなくする（#1968）", () => {
    // PR #1959の再現。CIは通っていても判定が終わるまではマージさせない。
    renderList([
      makePullRequest({
        ciState: "success",
        mergeJudgement: { state: "pending", step: null, runUrl: null },
      }),
    ]);
    const button = screen.getByRole("button", { name: "判定中" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
  });

  it("判定中は待っている段階をバッジで出し、実行ログへのリンクにする（#2059）", () => {
    // 「CI通過」なのにボタンが「判定中」で押せない理由は、`title`だけではスマホで読めない。
    renderList([
      makePullRequest({
        ciState: "success",
        mergeJudgement: {
          state: "pending",
          step: "claude-review",
          runUrl: "https://github.com/owner/repo/actions/runs/1/job/2",
        },
      }),
    ]);
    const badge = screen.getByText("Claudeがレビュー中").closest("a") as HTMLAnchorElement;
    expect(badge.href).toBe("https://github.com/owner/repo/actions/runs/1/job/2");
    expect(screen.getByText("CI通過")).toBeTruthy();
  });

  it("判定が終わっていれば判定中のバッジは出さない（#2059）", () => {
    renderList([
      makePullRequest({
        ciState: "success",
        mergeJudgement: { state: "settled", step: null, runUrl: null },
      }),
    ]);
    expect(screen.queryByText("マージ可否を判定中")).toBeNull();
    expect(screen.queryByText("Claudeがレビュー中")).toBeNull();
  });

  it("そのままマージしてよいか怪しいPRは確認ダイアログを挟む", () => {
    renderList([makePullRequest({ ciState: "failure" })]);
    fireEvent.click(screen.getByRole("button", { name: "マージする" }));
    expect(screen.getByText("このPRをマージしますか？")).toBeTruthy();
    expect(screen.getByText("CIが失敗しています。")).toBeTruthy();
  });

  it("種別・ブランチ・対応Issueへの導線を表示する", () => {
    renderList([
      makePullRequest({
        number: 7,
        kind: "release",
        baseRef: "main",
        headRef: "develop",
        linkedIssueNumber: null,
      }),
    ]);

    expect(screen.getByText("リリース（develop→main）")).toBeTruthy();
    expect(screen.getByText("develop")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.queryByText(/^Issue #/)).toBeNull();
  });

  it("対応Issueが特定できたPRにはIssueへのリンクを出す", () => {
    renderList([makePullRequest({ number: 9, linkedIssueNumber: 1058 })]);
    const link = screen.getByRole("link", { name: "Issue #1058" });
    expect(link.getAttribute("href")).toBe("https://github.com/guchi-apps/issue-deck/issues/1058");
  });

  it("取得に失敗したリポジトリがあることを画面に出す", () => {
    renderList([], { failedRepositories: ["guchi-apps/vps"] });
    expect(screen.getByText(/取得できなかったリポジトリがあります: guchi-apps\/vps/)).toBeTruthy();
  });

  it("エラー時はメッセージを表示し、空状態は出さない", () => {
    renderList([], { error: "リクエストに失敗しました (502)" });
    expect(screen.getByText("リクエストに失敗しました (502)")).toBeTruthy();
    expect(screen.queryByText("処理中のPull Requestはありません。")).toBeNull();
  });

  it("PR番号をタイトルの前に表示し、GitHubのPRへのリンクを併記する", () => {
    renderList([makePullRequest({ number: 42, title: "マージ待ちPR一覧を追加する" })]);
    // Issue一覧と同じ「#番号 タイトル」の並び
    const title = screen.getByRole("button", { name: /マージ待ちPR一覧を追加する/ });
    expect(title.textContent?.startsWith("#42 マージ待ちPR一覧を追加する")).toBe(true);
    const link = screen.getByRole("link", { name: "#42 をGitHubで開く" });
    expect(link.getAttribute("href")).toBe("https://github.com/guchi-apps/issue-deck/pull/42");
  });

  it("タイトルを押すと選択を親へ通知する（#1087）", () => {
    const onSelectPullRequest = vi.fn();
    renderList([makePullRequest({ number: 42, title: "PR詳細を追加する" })], {
      onSelectPullRequest,
    });

    fireEvent.click(screen.getByRole("button", { name: /#42 PR詳細を追加する/ }));
    expect(onSelectPullRequest).toHaveBeenCalledTimes(1);
    expect(onSelectPullRequest.mock.calls[0][0].number).toBe(42);
  });

  it("選択中のPRは一覧側でも見分けられるようにする", () => {
    renderList([makePullRequest({ number: 42 }), makePullRequest({ number: 43 })], {
      selectedPullRequestId: "guchi-apps/issue-deck#43",
    });

    const rows = screen.getAllByRole("listitem");
    expect(rows[0].className).not.toContain("border-l-primary");
    expect(rows[1].className).toContain("border-l-primary");
  });

  // 選択の正はURLクエリで、その反映はトランジション（低優先度）で入るため、親から
  // selectedPullRequestIdが返ってくるのは1テンポあと（#1597。Issue一覧と同じ）。
  it("押した行は、親から選択中PRが渡ってくる前にハイライトされる", () => {
    renderList([makePullRequest({ number: 42 }), makePullRequest({ number: 43 })], {
      onSelectPullRequest: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: /#43 PRのタイトル/ }));

    const rows = screen.getAllByRole("listitem");
    expect(rows[0].className).not.toContain("border-l-primary");
    expect(rows[1].className).toContain("border-l-primary");
  });
});

// #1891。1時間未満をまとめて「1時間以内」に丸めていたため、作ったばかりのPRが
// どれくらい前のものか読めなかった
describe("PullRequestList 経過時間", () => {
  it("1時間未満は「1時間以内」ではなく分で刻んで出す", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18, 12, 0, 0));
    try {
      renderList([
        makePullRequest({
          number: 50,
          createdAt: new Date(2026, 7, 18, 11, 43, 0).toISOString(),
        }),
      ]);

      expect(screen.getByText("17分前")).toBeTruthy();
      expect(screen.queryByText("1時間以内")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// #1947。ヘッダーの「更新」ボタンを外し、代わりに一覧を下へ引っ張って更新できるようにした。
// ジェスチャーの判定そのものは`use-pull-to-refresh.test.tsx`が実DOMで見る
describe("PullRequestList の更新（#1947）", () => {
  afterEach(() => {
    cleanup();
  });

  it("ヘッダーに「更新」ボタンを出さない", () => {
    renderList([makePullRequest()]);

    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
  });

  it("一覧を先頭から下へ引っ張ると更新が走る", async () => {
    const onPullToRefresh = vi.fn().mockResolvedValue(undefined);
    const { container } = renderList([makePullRequest()], { onPullToRefresh });

    // タッチを受けるのはスクロール領域を包む枠（0件でも残る側）
    const pullContainer = container.querySelector("div.relative");
    expect(pullContainer).toBeTruthy();

    await act(async () => {
      pullContainer!.dispatchEvent(touchEvent("touchstart", 100, 100));
      pullContainer!.dispatchEvent(touchEvent("touchmove", 100, 140));
      // しきい値（64px）を超えるまで引く。追従は移動量の半分（PULL_RESISTANCE）
      pullContainer!.dispatchEvent(touchEvent("touchmove", 100, 300));
      pullContainer!.dispatchEvent(new Event("touchend", { bubbles: true }));
    });

    expect(onPullToRefresh).toHaveBeenCalledTimes(1);
  });

  it("引っ張っている途中は「離すと更新」を出す", () => {
    const { container } = renderList([makePullRequest()], {
      onPullToRefresh: vi.fn().mockResolvedValue(undefined),
    });
    const pullContainer = container.querySelector("div.relative")!;

    act(() => {
      pullContainer.dispatchEvent(touchEvent("touchstart", 100, 100));
      pullContainer.dispatchEvent(touchEvent("touchmove", 100, 140));
    });
    expect(screen.getByText("引っ張って更新")).toBeTruthy();

    act(() => {
      pullContainer.dispatchEvent(touchEvent("touchmove", 100, 300));
    });
    expect(screen.getByText("離すと更新")).toBeTruthy();
  });
});
