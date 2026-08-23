// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { GithubActionsUsage } from "@/components/dashboard/github-actions-usage";
import type { ActionsUsageEntry } from "@/hooks/use-github-actions-usage";

const TODAY_STARTED_AT = new Date(2026, 7, 23, 0, 0, 0).getTime();

const DATA: ActionsUsageEntry[] = [
  {
    accountLogin: "guchi-apps",
    unsupported: false,
    errorStatus: null,
    usage: {
      year: 2026,
      month: 8,
      todayStartedAt: TODAY_STARTED_AT,
      today: {
        minutes: 1260,
        netAmount: 0,
        repositories: [{ name: "issue-deck", minutes: 1260, netAmount: 0 }],
        otherRepositoryCount: 0,
        otherMinutes: 0,
      },
      thisMonth: {
        minutes: 44028,
        netAmount: 0.036,
        repositories: [
          { name: "issue-deck", minutes: 22551, netAmount: 0 },
          { name: "vps", minutes: 330, netAmount: 0.018 },
        ],
        otherRepositoryCount: 13,
        otherMinutes: 10351,
      },
      storageGigabyteHours: 1486.75,
      storageNetAmount: 0,
      // JSTで8/23 10:55（画面はJST固定で出す）
      lastReportedAt: Date.parse("2026-08-23T01:55:00Z"),
    },
  },
];

describe("GithubActionsUsage", () => {
  afterEach(cleanup);

  it("既定は今月で、実行時間と課金額を並べる", () => {
    render(<GithubActionsUsage data={DATA} isLoading={false} error={null} />);

    expect(screen.getByText(/今月（8月）/)).toBeTruthy();
    expect(screen.getByText("44,028分")).toBeTruthy();
    expect(screen.getByText(/\$0\.04/)).toBeTruthy();
  });

  it("開くとリポジトリ別の内訳と、課金が出ているリポジトリの金額を出す", () => {
    render(<GithubActionsUsage data={DATA} isLoading={false} error={null} />);

    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(screen.getByText("issue-deck")).toBeTruthy();
    // 1セント未満でも切り上げて出す（発生していること自体が要点）
    expect(screen.getByText("$0.02")).toBeTruthy();
    expect(screen.getByText("ほか13リポジトリ")).toBeTruthy();
    expect(screen.getByText(/ストレージ 1,487 GB時/)).toBeTruthy();
  });

  it("どこまで反映されているかを常に出す（課金レポートは半日ほど遅れる）", () => {
    render(<GithubActionsUsage data={DATA} isLoading={false} error={null} />);

    expect(screen.getByText("8/23 10:55までの実行")).toBeTruthy();
  });

  it("まだ1件も反映されていない月は、0分ではなくその旨を出す", () => {
    const empty: ActionsUsageEntry[] = [
      {
        ...DATA[0],
        usage: { ...DATA[0].usage!, lastReportedAt: null },
      },
    ];

    render(<GithubActionsUsage data={empty} isLoading={false} error={null} />);

    expect(screen.getByText("まだ何も反映されていません")).toBeTruthy();
  });

  it("「今日」へ切り替えると、その日の分だけを出す", () => {
    render(<GithubActionsUsage data={DATA} isLoading={false} error={null} />);

    fireEvent.click(screen.getByRole("button", { name: "今日" }));

    expect(screen.getByText(/今日（8\/23）/)).toBeTruthy();
    expect(screen.getByText("1,260分")).toBeTruthy();
    // 選択中がどちらかは見た目にも出す（`aria-pressed`をbutton.tsxのoutlineが拾う）
    expect(screen.getByRole("button", { name: "今日" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "今月" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("個人アカウントのインストールは、消さずに理由を出す", () => {
    render(
      <GithubActionsUsage
        data={[{ accountLogin: "m-guchi", usage: null, errorStatus: null, unsupported: true }]}
        isLoading={false}
        error={null}
      />,
    );

    expect(screen.getByText(/個人アカウントのインストール（m-guchi）では表示できません/)).toBeTruthy();
  });

  it("取得に失敗したときはステータスを添えて理由を出す", () => {
    render(
      <GithubActionsUsage
        data={[{ accountLogin: "guchi-apps", usage: null, errorStatus: 403, unsupported: false }]}
        isLoading={false}
        error={null}
      />,
    );

    expect(screen.getByText(/消費量を取得できませんでした（403）/)).toBeTruthy();
  });
});
