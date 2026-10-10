import { describe, expect, it } from "vitest";

import {
  LEGACY_RELEASE_FAILURE_NOTICE_TEXT,
  extractErrorExcerpt,
  findFailedStep,
  releaseFailureDerivedLabels,
  type IssueCommentSummary,
  type IssueLabelEvent,
} from "@/lib/release-preparation";

const NOTICE: IssueCommentSummary = {
  body: `⚠️ ${LEGACY_RELEASE_FAILURE_NOTICE_TEXT}。\n\n実行ログ: https://github.com/o/r/actions/runs/1\n\n<!-- issue-deck-fallback-notice -->`,
  authorLogin: "github-actions[bot]",
  createdAt: "2026-10-10T15:48:00Z",
};

function labeled(label: string, at: string, actor = "github-actions[bot]"): IssueLabelEvent {
  return { event: "labeled", label, actorLogin: actor, createdAt: at };
}

describe("releaseFailureDerivedLabels", () => {
  it("旧notify-failureが付けた00.check-userと01.check-blockedを外す", () => {
    expect(
      releaseFailureDerivedLabels({
        labels: ["00.check-user", "01.check-blocked", "30.bug"],
        events: [labeled("00.check-user", "2026-10-10T15:48:02Z"), labeled("01.check-blocked", "2026-10-10T15:48:02Z")],
        comments: [NOTICE],
      }),
    ).toEqual(["00.check-user", "01.check-blocked"]);
  });

  it("失敗の後に別の理由で付け直されていれば外さない", () => {
    expect(
      releaseFailureDerivedLabels({
        labels: ["00.check-user", "01.check-blocked"],
        events: [
          labeled("00.check-user", "2026-10-10T15:48:02Z"),
          { event: "unlabeled", label: "00.check-user", actorLogin: "m-guchi", createdAt: "2026-10-10T16:00:00Z" },
          labeled("00.check-user", "2026-10-10T17:00:00Z"),
          labeled("01.check-blocked", "2026-10-10T15:48:02Z"),
        ],
        comments: [NOTICE],
      }),
    ).toEqual([]);
  });

  it("他の理由ラベル（質問・計画）が付いていれば外さない", () => {
    expect(
      releaseFailureDerivedLabels({
        labels: ["00.check-user", "01.check-input"],
        events: [labeled("00.check-user", "2026-10-10T15:48:02Z")],
        comments: [NOTICE],
      }),
    ).toEqual([]);
  });

  it("失敗の前から付いていた（付与イベントが通知と対にならない）ものは外さない", () => {
    expect(
      releaseFailureDerivedLabels({
        labels: ["00.check-user", "01.check-blocked"],
        events: [labeled("00.check-user", "2026-10-09T10:00:00Z", "m-guchi"), labeled("01.check-blocked", "2026-10-10T15:48:02Z")],
        comments: [NOTICE],
      }),
    ).toEqual([]);
  });

  it("通知コメントが無い（由来不明）なら外さない", () => {
    expect(
      releaseFailureDerivedLabels({
        labels: ["00.check-user", "01.check-blocked"],
        events: [labeled("00.check-user", "2026-10-10T15:48:02Z"), labeled("01.check-blocked", "2026-10-10T15:48:02Z")],
        comments: [{ ...NOTICE, body: "別のフォールバック通知 <!-- issue-deck-fallback-notice -->" }],
      }),
    ).toEqual([]);
  });

  it("人が書いた同じ文言のコメントとは対にしない", () => {
    expect(
      releaseFailureDerivedLabels({
        labels: ["00.check-user"],
        events: [labeled("00.check-user", "2026-10-10T15:48:02Z")],
        comments: [{ ...NOTICE, authorLogin: "m-guchi" }],
      }),
    ).toEqual([]);
  });

  it("理由ラベルの無い00.check-userだけなら00.check-userだけを外す", () => {
    expect(
      releaseFailureDerivedLabels({
        labels: ["00.check-user"],
        events: [labeled("00.check-user", "2026-10-10T15:48:02Z")],
        comments: [NOTICE],
      }),
    ).toEqual(["00.check-user"]);
  });
});

describe("findFailedStep", () => {
  it("呼び出し側から見たジョブ名（release / release）の失敗工程を返す", () => {
    expect(
      findFailedStep([
        { name: "release / release", conclusion: "failure", steps: [
          { name: "リリース状態を判定する", conclusion: "success" },
          { name: "バージョンをbumpしてdevelop向けPRを作成する", conclusion: "failure" },
        ] },
        { name: "release / notify-failure", conclusion: "success", steps: [] },
      ]),
    ).toEqual({ jobName: "release / release", stepName: "バージョンをbumpしてdevelop向けPRを作成する" });
  });

  it("失敗したジョブが無ければnull", () => {
    expect(findFailedStep([{ name: "release", conclusion: "success" }])).toEqual({ jobName: null, stepName: null });
  });
});

describe("extractErrorExcerpt", () => {
  it("##[error]の行だけを抜き出し、終了コードだけの行は落とす", () => {
    const log = [
      "2026-10-10T15:47:33.1547037Z 判定どおりの v8.50.0 は作り直す v8.50.1 以下のため、v8.50.2 にします",
      "2026-10-10T15:47:33.2591823Z ##[error]バンプを取り消した後の版（8.50.0）がmain（8.49.0）と一致しません。",
      "2026-10-10T15:47:33.2594612Z ##[error]Process completed with exit code 1.",
    ].join("\n");
    expect(extractErrorExcerpt(log)).toBe("バンプを取り消した後の版（8.50.0）がmain（8.49.0）と一致しません。");
  });

  it("エラー行が無ければnull", () => {
    expect(extractErrorExcerpt("ok\nfine")).toBeNull();
  });

  it("トークンらしき文字列は伏せる", () => {
    expect(extractErrorExcerpt("##[error]token ghp_abcdefghijklmnopqrstuvwxyz0123456789 failed")).not.toContain("ghp_abcdefghij");
  });
});
