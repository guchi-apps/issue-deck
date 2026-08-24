import { describe, expect, it } from "vitest";

import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";
import {
  countReleaseActivity,
  describeReleaseActivity,
  selectVisibleReleaseStatuses,
} from "@/lib/release-activity";

function makeReleaseStatus(
  repoFullName: string,
  status: RepositoryReleaseStatus["status"],
): RepositoryReleaseStatus {
  return {
    repoFullName,
    status,
    failedWorkflow: status === "error" ? "deploy" : null,
    pendingMerge:
      status === "action_required"
        ? {
            mergeTarget: "main",
            pullRequestNumber: 500,
            pullRequestUrl: `https://github.com/${repoFullName}/pull/500`,
            pullRequestTitle: "リリース v4.19.0",
            ciState: "success",
          }
        : null,
  };
}

describe("countReleaseActivity（#2167）", () => {
  it("未取得（null）のうちは件数を出さない（0件と区別する）", () => {
    expect(countReleaseActivity(null)).toBeNull();
  });

  it("片付いていないリポジトリが無ければ0件を返す", () => {
    expect(countReleaseActivity([])).toEqual({
      total: 0,
      progressing: 0,
      mergePending: 0,
      failed: 0,
      actionRequired: 0,
    });
  });

  it("返ってきたリポジトリ数がそのまま「未完了」の件数になる", () => {
    const counts = countReleaseActivity([
      makeReleaseStatus("guchi-apps/issue-deck", "progressing"),
      makeReleaseStatus("guchi-apps/myroom", "progressing"),
    ]);

    expect(counts).toMatchObject({ total: 2, progressing: 2, actionRequired: 0 });
  });

  it("マージ待ちと失敗を内訳として別々に持ち、合わせて操作待ちに数える", () => {
    const counts = countReleaseActivity([
      makeReleaseStatus("guchi-apps/issue-deck", "action_required"),
      makeReleaseStatus("guchi-apps/myroom", "error"),
      makeReleaseStatus("guchi-apps/vps", "progressing"),
    ]);

    expect(counts).toEqual({
      total: 3,
      progressing: 1,
      mergePending: 1,
      failed: 1,
      actionRequired: 2,
    });
  });

  it("未取得のうちはnullを返す（0件と区別する）", () => {
    expect(countReleaseActivity(null)).toBeNull();
  });
});

// 押して開くブランチ画面は非表示リポジトリを出さないため、揃えないと
// 「1件と出ているのに開いた先に無い」が起こる（#2167のレビュー指摘）。#2279で通知ベルの
// 項目・マージ待ちの本数も同じ集合から作るようになり、絞り込みをここへ寄せた。
describe("selectVisibleReleaseStatuses（#2279）", () => {
  it("左メニューで非表示にしたリポジトリを取り除く", () => {
    const visible = selectVisibleReleaseStatuses(
      [
        makeReleaseStatus("guchi-apps/issue-deck", "action_required"),
        makeReleaseStatus("guchi-apps/myroom", "progressing"),
      ],
      [
        { fullName: "guchi-apps/issue-deck", hidden: false },
        { fullName: "guchi-apps/myroom", hidden: true },
      ],
    );

    expect(visible?.map((status) => status.repoFullName)).toEqual(["guchi-apps/issue-deck"]);
  });

  it("非表示が無ければ受け取ったものをそのまま返す", () => {
    const releaseStatuses = [makeReleaseStatus("guchi-apps/myroom", "progressing")];

    expect(selectVisibleReleaseStatuses(releaseStatuses, [])).toBe(releaseStatuses);
  });

  it("未取得（null）はnullのまま返す", () => {
    expect(selectVisibleReleaseStatuses(null, [])).toBeNull();
  });
});

describe("describeReleaseActivity（#2167）", () => {
  const NONE = { total: 0, progressing: 0, mergePending: 0, failed: 0, actionRequired: 0 };

  it("未取得・0件では片付いていないものが無いことを添える", () => {
    expect(describeReleaseActivity(null)).toContain("未完了のリリース・デプロイはありません");
    expect(describeReleaseActivity(NONE)).toContain("未完了のリリース・デプロイはありません");
  });

  it("0件の内訳は出さない（実行中だけなら実行中だけを書く）", () => {
    const title = describeReleaseActivity({
      total: 2,
      progressing: 2,
      mergePending: 0,
      failed: 0,
      actionRequired: 0,
    });

    expect(title).toContain("リリース・デプロイが未完了のプロジェクト2件: 実行中2件");
    expect(title).not.toContain("マージ待ち");
    expect(title).not.toContain("失敗");
  });

  // 失敗は動いていないので、まとめて「実行中」と書くと数字の意味が崩れる（レビュー指摘）。
  it("実行中と失敗を書き分ける", () => {
    const title = describeReleaseActivity({
      total: 3,
      progressing: 1,
      mergePending: 1,
      failed: 1,
      actionRequired: 2,
    });

    expect(title).toContain(
      "リリース・デプロイが未完了のプロジェクト3件: 実行中1件・マージ待ち1件・失敗1件",
    );
  });
});
