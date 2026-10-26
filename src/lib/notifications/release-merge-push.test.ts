import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { MERGE_JUDGEMENT_UNKNOWN } from "@/lib/github/check-rollup";
import { fetchOpenPullRequestsForBase, fetchRefCheckState } from "@/lib/github/release-api";
import { releaseWorkflowExists } from "@/lib/github/release-workflow-cache";
import {
  buildReleaseMergePushPayload,
  releaseMergePushRenotifyHours,
  releaseMergePushSweepIntervalMinutes,
  resetReleaseMergePushSweepIntervalForTest,
  runReleaseMergePushSweep,
} from "@/lib/notifications/release-merge-push";
import { isPushConfigured, sendPushNotification } from "@/lib/notifications/push";
import { fetchReleaseChecks } from "@/lib/pull-request-release-checks";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/notifications/push", () => ({
  isPushConfigured: vi.fn(() => true),
  sendPushNotification: vi.fn(async () => ({ sent: 1, removed: 0 })),
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "token") }));
vi.mock("@/lib/github/release-workflow-cache", () => ({
  releaseWorkflowExists: vi.fn(async () => true),
}));
// 検証の記録は既定で両方合格（#4390）。検証中の挙動は個別のテストで差し替える
vi.mock("@/lib/pull-request-release-checks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pull-request-release-checks")>()),
  fetchReleaseChecks: vi.fn(async (targets: { repositoryFullName: string; number: number }[]) =>
    new Map(
      targets.map((t) => [
        `${t.repositoryFullName}#${t.number}`,
        { aiReview: "passed", integration: "passed", enforced: false },
      ]),
    ),
  ),
}));
vi.mock("@/lib/github/release-api", () => ({
  fetchOpenPullRequestsForBase: vi.fn(async () => []),
  fetchRefCheckState: vi.fn(async () => ({ ciState: "success", mergeJudgement: null })),
  DRAFT_PULL_REQUEST_CHECK_STATE: { ciState: "unknown", mergeJudgement: null },
}));

const NOW = new Date("2026-08-26T09:00:00.000Z");

const PENDING = {
  repositoryFullName: "guchi-apps/issue-deck",
  pullRequestNumber: 2381,
  pullRequestTitle: "Release v4.33.0",
  ciState: "success" as const,
};

/** 巡回が触るDBのメソッドだけをその場で生やす。戻り値は個々のテストで差し替える */
function stubDb(overrides: {
  subscriptionCount?: number;
  repositories?: unknown[];
  /** `create`が投げる＝既に鳴らした記録がある */
  noticeExists?: boolean;
  /** 鳴らし直しの`updateMany`が更新できた件数 */
  renotifyCount?: number;
  /** 宛先として返す購読（既定は1件） */
  targets?: unknown[];
}) {
  const deleteMany = vi.fn(async () => ({ count: 0 }));
  const create = vi.fn(async () => {
    if (overrides.noticeExists) throw new Error("Unique constraint failed");
    return {};
  });
  const updateMany = vi.fn(async () => ({ count: overrides.renotifyCount ?? 0 }));
  Object.assign(db, {
    pushSubscription: {
      count: vi.fn(async () => overrides.subscriptionCount ?? 1),
      findMany: vi.fn(
        async () => overrides.targets ?? [{ id: "s1", endpoint: "e", p256dh: "p", auth: "a" }],
      ),
    },
    repository: { findMany: vi.fn(async () => overrides.repositories ?? []) },
    releaseMergePushNotice: { create, updateMany, deleteMany },
  });
  return { create, updateMany, deleteMany };
}

const REPOSITORY = {
  id: "r1",
  fullName: "guchi-apps/issue-deck",
  ownerLogin: "guchi-apps",
  name: "issue-deck",
  installationId: "inst-cuid",
  installation: { installationId: 123 },
};

const RELEASE_PR = {
  number: 2381,
  title: "Release v4.33.0",
  head: { ref: "release-main/v4.33.0" },
};

beforeEach(() => {
  vi.clearAllMocks();
  resetReleaseMergePushSweepIntervalForTest();
  vi.mocked(isPushConfigured).mockReturnValue(true);
  vi.mocked(releaseWorkflowExists).mockResolvedValue(true);
  vi.mocked(fetchOpenPullRequestsForBase).mockResolvedValue([]);
  vi.mocked(fetchRefCheckState).mockResolvedValue({
    ciState: "success",
    mergeJudgement: MERGE_JUDGEMENT_UNKNOWN,
  });
});

describe("releaseMergePushSweepIntervalMinutes", () => {
  it("未設定・不正な値は既定の10分", () => {
    expect(releaseMergePushSweepIntervalMinutes(undefined)).toBe(10);
    expect(releaseMergePushSweepIntervalMinutes("")).toBe(10);
    expect(releaseMergePushSweepIntervalMinutes("あ")).toBe(10);
    expect(releaseMergePushSweepIntervalMinutes("-1")).toBe(10);
  });

  it("0は「巡回しない」として通す", () => {
    expect(releaseMergePushSweepIntervalMinutes("0")).toBe(0);
  });
});

describe("releaseMergePushRenotifyHours", () => {
  it("未設定は既定の6時間、0は「鳴らし直さない」", () => {
    expect(releaseMergePushRenotifyHours(undefined)).toBe(6);
    expect(releaseMergePushRenotifyHours("0")).toBe(0);
    expect(releaseMergePushRenotifyHours("12")).toBe(12);
  });
});

describe("buildReleaseMergePushPayload", () => {
  it("画面と同じ語彙で、PR詳細を開くURLを載せる", () => {
    const payload = buildReleaseMergePushPayload(PENDING);
    expect(payload.title).toBe("issue-deck ・ mainへマージ待ち");
    expect(payload.body).toBe("#2381 Release v4.33.0");
    // `useReferenceNavigation.openPullRequest`と同じ形（PCの`pane`・`pr`とスマホの`mscreen`）
    expect(payload.url).toBe(
      "/dashboard?pane=pull-requests&pr=guchi-apps%2Fissue-deck%232381&mscreen=pull-requests",
    );
    expect(payload.tag).toBe("release-merge:guchi-apps/issue-deck#2381");
  });

  it("CIが落ちているときは「マージ待ち」と言わない（#1059）", () => {
    const payload = buildReleaseMergePushPayload({ ...PENDING, ciState: "failure" });
    expect(payload.title).toBe("issue-deck ・ チェック失敗");
  });
});

describe("runReleaseMergePushSweep", () => {
  it("マージ待ちのリリースPRを見つけたら鳴らす", async () => {
    const { create } = stubDb({ repositories: [REPOSITORY] });
    vi.mocked(fetchOpenPullRequestsForBase).mockResolvedValue([RELEASE_PR] as never);

    const result = await runReleaseMergePushSweep({ now: NOW });

    expect(result.pending).toHaveLength(1);
    expect(result.notified).toHaveLength(1);
    // **送る前に席を取る**（#2300と同じ理由）
    expect(create).toHaveBeenCalled();
    expect(sendPushNotification).toHaveBeenCalledOnce();
  });

  it("draftの候補はチェックを読まず、ブランチ画面と同じく「mainへマージ待ち」で鳴らす（#4916）", async () => {
    stubDb({ repositories: [REPOSITORY] });
    vi.mocked(fetchOpenPullRequestsForBase).mockResolvedValue([
      { number: 1308, title: "リリース候補 RC-11", head: { ref: "release-rc/11" }, draft: true },
    ] as never);
    // 正式バンプ前の候補では`version-tag-check`が落ちている。読めば「チェック失敗」になる
    vi.mocked(fetchRefCheckState).mockResolvedValue({
      ciState: "failure",
      mergeJudgement: MERGE_JUDGEMENT_UNKNOWN,
    });

    // 検証に合格した新方式の候補は、工程（#5076）で公開承認があなたの番になる
    vi.mocked(fetchReleaseChecks).mockResolvedValueOnce(
      new Map([
        [
          "guchi-apps/issue-deck#1308",
          {
            aiReview: "passed",
            integration: "passed",
            enforced: false,
            rc: {
              sequence: 11,
              phase: "review",
              pendingRevision: null,
              approval: null,
              finalization: null,
              productionStopLabel: null,
              predecessor: null,
              updatedAt: "2026-10-26T12:00:00.000Z",
            },
          },
        ],
      ]),
    );

    const result = await runReleaseMergePushSweep({ now: NOW });

    expect(fetchRefCheckState).not.toHaveBeenCalled();
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]?.ciState).toBe("unknown");
    expect(result.pending[0]?.actionLabel).toBe("公開承認待ち");
  });

  it("新方式の候補の記録が無い・読めないときは、推測で鳴らさない（#5076）", async () => {
    stubDb({ repositories: [REPOSITORY] });
    vi.mocked(fetchOpenPullRequestsForBase).mockResolvedValue([
      { number: 1308, title: "リリース候補 RC-11", head: { ref: "release-rc/11" }, draft: true },
    ] as never);

    const result = await runReleaseMergePushSweep({ now: NOW });

    expect(result.pending).toHaveLength(0);
  });

  it("自動マージ可否の判定中は鳴らさない（#2326。画面が我慢している最中に鳴らさない）", async () => {
    stubDb({ repositories: [REPOSITORY] });
    vi.mocked(fetchOpenPullRequestsForBase).mockResolvedValue([RELEASE_PR] as never);
    vi.mocked(fetchRefCheckState).mockResolvedValue({
      ciState: "success",
      mergeJudgement: { ...MERGE_JUDGEMENT_UNKNOWN, state: "pending" },
    } as never);

    const result = await runReleaseMergePushSweep({ now: NOW });

    expect(result.pending).toHaveLength(0);
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("統合検証・全体レビューの実行中は鳴らさない（#4390）", async () => {
    stubDb({ repositories: [REPOSITORY] });
    vi.mocked(fetchOpenPullRequestsForBase).mockResolvedValue([RELEASE_PR] as never);
    vi.mocked(fetchReleaseChecks).mockResolvedValueOnce(
      new Map([
        [
          "guchi-apps/issue-deck#2381",
          {
            aiReview: "running",
            integration: "passed",
            enforced: false,
            started: { aiReview: true, integration: false, mac: false },
          },
        ],
      ]),
    );

    const result = await runReleaseMergePushSweep({ now: NOW });

    expect(result.pending).toHaveLength(0);
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("CIが実行中も鳴らさない（#1433）", async () => {
    stubDb({ repositories: [REPOSITORY] });
    vi.mocked(fetchOpenPullRequestsForBase).mockResolvedValue([RELEASE_PR] as never);
    vi.mocked(fetchRefCheckState).mockResolvedValue({
      ciState: "pending",
      mergeJudgement: MERGE_JUDGEMENT_UNKNOWN,
    } as never);

    expect((await runReleaseMergePushSweep({ now: NOW })).notified).toHaveLength(0);
  });

  it("`develop`をheadにした古い形のリリースPRも拾う（#2117以前の配布）", async () => {
    stubDb({ repositories: [REPOSITORY] });
    vi.mocked(fetchOpenPullRequestsForBase).mockResolvedValue([
      { number: 12, title: "Release", head: { ref: "develop" } },
    ] as never);

    expect((await runReleaseMergePushSweep({ now: NOW })).notified).toHaveLength(1);
  });

  it("宛先がOFFのせいで全員消えたときは席を取らない（ONに戻したらすぐ鳴らせる。#4159）", async () => {
    const { create } = stubDb({ repositories: [REPOSITORY], targets: [] });
    vi.mocked(fetchOpenPullRequestsForBase).mockResolvedValue([RELEASE_PR] as never);

    const result = await runReleaseMergePushSweep({ now: NOW });

    expect(result.notified).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("一度鳴らしたPRは、鳴らし直しの間隔に達するまで鳴らさない", async () => {
    const { updateMany } = stubDb({
      repositories: [REPOSITORY],
      noticeExists: true,
      renotifyCount: 0,
    });
    vi.mocked(fetchOpenPullRequestsForBase).mockResolvedValue([RELEASE_PR] as never);

    const result = await runReleaseMergePushSweep({ now: NOW });

    expect(result.pending).toHaveLength(1);
    expect(result.notified).toHaveLength(0);
    expect(updateMany).toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("間隔に達するまで巡回しない（GitHubを叩かない）", async () => {
    stubDb({ repositories: [REPOSITORY] });
    await runReleaseMergePushSweep({ now: NOW });
    vi.clearAllMocks();

    const again = await runReleaseMergePushSweep({ now: new Date(NOW.getTime() + 60_000) });

    expect(again.swept).toBe(false);
    expect(fetchOpenPullRequestsForBase).not.toHaveBeenCalled();
  });

  it("購読が1件も無ければGitHubを叩かない", async () => {
    stubDb({ subscriptionCount: 0, repositories: [REPOSITORY] });

    const result = await runReleaseMergePushSweep({ now: NOW });

    expect(result.swept).toBe(true);
    expect(fetchOpenPullRequestsForBase).not.toHaveBeenCalled();
  });

  it("1リポジトリの取得失敗で他リポジトリの通知を止めない", async () => {
    stubDb({
      repositories: [{ ...REPOSITORY, fullName: "guchi-apps/other", name: "other" }, REPOSITORY],
    });
    vi.mocked(fetchOpenPullRequestsForBase)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([RELEASE_PR] as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runReleaseMergePushSweep({ now: NOW });

    expect(result.failedRepositories).toEqual(["guchi-apps/other"]);
    expect(result.notified).toHaveLength(1);
    errorSpy.mockRestore();
  });
});
