import { describe, expect, it } from "vitest";

import {
  ACTIVE_DISPATCH_JOB_STATUSES,
  buildDispatchActiveKey,
  describeDispatchEnqueueRejection,
  DISPATCH_HOST_ONLINE_WINDOW_MS,
  isActiveDispatchJobStatus,
  isDispatchHostOnline,
  normalizeDispatchHostRepositories,
  parseDispatchHostName,
  parseDispatchHostRepositories,
  parseDispatchReportStatus,
  parseDispatchTarget,
  resolveDispatchConcurrency,
} from "@/lib/dispatch/dispatch-job";

describe("parseDispatchTarget", () => {
  it("owner/repoとIssue番号が妥当なら受け入れる", () => {
    expect(parseDispatchTarget("guchi-apps/issue-deck", 1179)).toEqual({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1179,
    });
  });

  it("パス参照・空白・スラッシュ過多を弾く（サブPC側でパスの一部になるため）", () => {
    expect(parseDispatchTarget("../etc", 1)).toBeNull();
    expect(parseDispatchTarget("guchi-apps/../issue-deck", 1)).toBeNull();
    expect(parseDispatchTarget("guchi apps/issue-deck", 1)).toBeNull();
    expect(parseDispatchTarget("issue-deck", 1)).toBeNull();
    expect(parseDispatchTarget("guchi-apps/issue-deck/extra", 1)).toBeNull();
  });

  it("Issue番号は正の整数のみ", () => {
    expect(parseDispatchTarget("guchi-apps/issue-deck", 0)).toBeNull();
    expect(parseDispatchTarget("guchi-apps/issue-deck", -1)).toBeNull();
    expect(parseDispatchTarget("guchi-apps/issue-deck", 1.5)).toBeNull();
    expect(parseDispatchTarget("guchi-apps/issue-deck", "1179")).toBeNull();
  });
});

describe("parseDispatchHostName", () => {
  it("英数字と.-_のみ通す", () => {
    expect(parseDispatchHostName("subpc")).toBe("subpc");
    expect(parseDispatchHostName(" subpc ")).toBe("subpc");
    expect(parseDispatchHostName("sub pc")).toBeNull();
    expect(parseDispatchHostName("sub/pc")).toBeNull();
    expect(parseDispatchHostName("..")).toBeNull();
    expect(parseDispatchHostName("")).toBeNull();
    expect(parseDispatchHostName(42)).toBeNull();
  });
});

describe("buildDispatchActiveKey", () => {
  it("リポジトリとIssue番号から一意キーを組み立てる", () => {
    expect(buildDispatchActiveKey("guchi-apps/issue-deck", 1179)).toBe(
      "guchi-apps/issue-deck#1179",
    );
  });

  it("別リポジトリの同じ番号は衝突しない", () => {
    expect(buildDispatchActiveKey("guchi-apps/dayspan", 1179)).not.toBe(
      buildDispatchActiveKey("guchi-apps/issue-deck", 1179),
    );
  });
});

describe("isActiveDispatchJobStatus", () => {
  it("未完了の3状態だけをactiveとして扱う", () => {
    expect(ACTIVE_DISPATCH_JOB_STATUSES).toEqual(["QUEUED", "CLAIMED", "RUNNING"]);
    expect(isActiveDispatchJobStatus("QUEUED")).toBe(true);
    expect(isActiveDispatchJobStatus("RUNNING")).toBe(true);
    expect(isActiveDispatchJobStatus("SUCCEEDED")).toBe(false);
    expect(isActiveDispatchJobStatus("TIMEOUT")).toBe(false);
    expect(isActiveDispatchJobStatus("CANCELED")).toBe(false);
  });
});

describe("isDispatchHostOnline", () => {
  const now = new Date("2026-08-14T12:00:00Z");

  it("猶予の内側なら生存", () => {
    expect(isDispatchHostOnline(new Date(now.getTime() - 60 * 1000), now)).toBe(true);
    expect(
      isDispatchHostOnline(new Date(now.getTime() - DISPATCH_HOST_ONLINE_WINDOW_MS), now),
    ).toBe(true);
  });

  it("猶予を超えたらoffline", () => {
    expect(
      isDispatchHostOnline(new Date(now.getTime() - DISPATCH_HOST_ONLINE_WINDOW_MS - 1), now),
    ).toBe(false);
  });
});

describe("parseDispatchHostRepositories", () => {
  it("JSON配列から妥当なリポジトリ名だけを取り出す", () => {
    expect(
      parseDispatchHostRepositories('["guchi-apps/issue-deck","guchi-apps/dayspan","bad name"]'),
    ).toEqual(["guchi-apps/issue-deck", "guchi-apps/dayspan"]);
  });

  it("壊れた申告は例外にせず空配列にする（画面を落とさない）", () => {
    expect(parseDispatchHostRepositories("not json")).toEqual([]);
    expect(parseDispatchHostRepositories('{"a":1}')).toEqual([]);
    expect(parseDispatchHostRepositories("")).toEqual([]);
  });
});

describe("normalizeDispatchHostRepositories", () => {
  it("重複を落とし、検証を通ったものだけを並べる", () => {
    expect(
      normalizeDispatchHostRepositories([
        "guchi-apps/issue-deck",
        "guchi-apps/issue-deck",
        "guchi-apps/dayspan",
        "../etc",
        123,
      ]),
    ).toEqual(["guchi-apps/dayspan", "guchi-apps/issue-deck"]);
  });

  it("配列でなければ空配列", () => {
    expect(normalizeDispatchHostRepositories("guchi-apps/issue-deck")).toEqual([]);
    expect(normalizeDispatchHostRepositories(undefined)).toEqual([]);
  });
});

describe("resolveDispatchConcurrency", () => {
  it("issue-deck側の設定とホストの申告の小さい方を採る", () => {
    expect(resolveDispatchConcurrency(4, 2)).toBe(2);
    expect(resolveDispatchConcurrency(2, 6)).toBe(2);
  });

  it("ホストが申告しない場合は設定値をそのまま使う", () => {
    expect(resolveDispatchConcurrency(3, null)).toBe(3);
    expect(resolveDispatchConcurrency(3, 0)).toBe(3);
  });
});

describe("parseDispatchReportStatus", () => {
  it("pollerが報告してよい状態だけを受け入れる", () => {
    expect(parseDispatchReportStatus("running")).toBe("running");
    expect(parseDispatchReportStatus("succeeded")).toBe("succeeded");
    expect(parseDispatchReportStatus("failed")).toBe("failed");
  });

  it("issue-deck側だけが付ける状態は受け付けない", () => {
    expect(parseDispatchReportStatus("timeout")).toBeNull();
    expect(parseDispatchReportStatus("canceled")).toBeNull();
    expect(parseDispatchReportStatus("QUEUED")).toBeNull();
  });
});

describe("describeDispatchEnqueueRejection", () => {
  it("理由ごとに、次に何を見ればよいかが分かる日本語を返す", () => {
    expect(describeDispatchEnqueueRejection("host_offline", { hostName: "subpc" })).toContain(
      "subpc",
    );
    expect(
      describeDispatchEnqueueRejection("repository_not_runnable", {
        hostName: "subpc",
        repositoryFullName: "guchi-apps/shopping-list",
      }),
    ).toContain("guchi-apps/shopping-list");
    expect(describeDispatchEnqueueRejection("already_queued", { hostName: "subpc" })).not.toBe("");
  });
});
