import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import {
  buildCheckUserPushPayload,
  CHECK_USER_MERGE_PUSH_DELAY_MS,
  CHECK_USER_PUSH_DELAY_MS,
  CHECK_USER_PUSH_MAX_AGE_MS,
  decideCheckUserPush,
  sweepCheckUserPushNotifications,
} from "@/lib/notifications/check-user-push";
import { isPushConfigured, sendPushNotification } from "@/lib/notifications/push";

// 判定だけを見るテスト。DBとweb-pushはこのモジュールの読み込みで引きずられるだけなので潰す
// （宛先の絞り込みを見るテストだけ、必要なメソッドをその場で生やす）
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/notifications/push", () => ({
  isPushConfigured: vi.fn(() => false),
  sendPushNotification: vi.fn(),
}));
// 夜間実行の保留（#2772）はDBを読むので、ここでは「止めるものは無い」に固定する
vi.mock("@/lib/nightly-run-db", () => ({
  selectNightlyRunPushHold: vi.fn(async () => null),
  nightlyRunIssueKey: (repositoryFullName: string, issueNumber: number) =>
    `${repositoryFullName}#${issueNumber}`,
}));

const NOW = new Date("2026-08-22T12:00:00.000Z");

function at(msBefore: number): Date {
  return new Date(NOW.getTime() - msBefore);
}

const CHECK_USER = { name: "00.check-user" };

describe("decideCheckUserPush", () => {
  it("付いた直後は送らない（理由ラベルが揃うのを待つ）", () => {
    expect(
      decideCheckUserPush({ labels: [CHECK_USER], checkUserLabeledAt: at(5_000), now: NOW }),
    ).toBe("wait");
  });

  it("夜間実行の保留（holdUntil）が未来なら、待ちが生きていても送らない（#2772）", () => {
    const input = {
      labels: [CHECK_USER, { name: "01.check-plan" }],
      checkUserLabeledAt: at(CHECK_USER_PUSH_DELAY_MS),
      hasPendingSessionRequest: true,
      now: NOW,
    };
    expect(decideCheckUserPush({ ...input, holdUntil: new Date(NOW.getTime() + 60_000) })).toBe(
      "wait",
    );
    // 保留が明けていれば従来どおり（待ちがあるので待たずに送る）
    expect(decideCheckUserPush({ ...input, holdUntil: at(1) })).toBe("send");
    expect(decideCheckUserPush({ ...input, holdUntil: null })).toBe("send");
  });

  it("計画レビューの自動反映待ち（holdForPlanReview）は、待ちが生きていても送らない（#3616）", () => {
    const input = {
      labels: [CHECK_USER, { name: "01.check-plan" }],
      checkUserLabeledAt: at(CHECK_USER_PUSH_DELAY_MS),
      hasPendingSessionRequest: true,
      now: NOW,
    };
    expect(decideCheckUserPush({ ...input, holdForPlanReview: true })).toBe("wait");
    expect(decideCheckUserPush({ ...input, holdForPlanReview: false })).toBe("send");
  });

  it("既定の待ち時間を過ぎたら送る", () => {
    expect(
      decideCheckUserPush({
        labels: [CHECK_USER, { name: "01.check-plan" }],
        checkUserLabeledAt: at(CHECK_USER_PUSH_DELAY_MS),
        now: NOW,
      }),
    ).toBe("send");
  });

  it("01.check-mergeは既定の待ち時間では送らない（#1709。CIの完了と自動マージを待つ）", () => {
    expect(
      decideCheckUserPush({
        labels: [CHECK_USER, { name: "01.check-merge" }],
        checkUserLabeledAt: at(CHECK_USER_PUSH_DELAY_MS),
        now: NOW,
      }),
    ).toBe("wait");
  });

  it("01.check-mergeでも、長い待ち時間を過ぎて残っていれば送る", () => {
    expect(
      decideCheckUserPush({
        labels: [CHECK_USER, { name: "01.check-merge" }],
        checkUserLabeledAt: at(CHECK_USER_MERGE_PUSH_DELAY_MS),
        now: NOW,
      }),
    ).toBe("send");
  });

  it("理由ラベルが無いリポジトリは既定の待ち時間で送る（判断できないものは出す側へ倒す）", () => {
    expect(
      decideCheckUserPush({
        labels: [CHECK_USER],
        checkUserLabeledAt: at(CHECK_USER_PUSH_DELAY_MS),
        now: NOW,
      }),
    ).toBe("send");
  });

  it("計画・質問の待ちが生きていれば、待ち時間を過ぎていなくても送る（#2238）", () => {
    expect(
      decideCheckUserPush({
        labels: [CHECK_USER, { name: "01.check-input" }],
        checkUserLabeledAt: at(5_000),
        hasPendingSessionRequest: true,
        now: NOW,
      }),
    ).toBe("send");
  });

  it("01.check-mergeでも、待ちが生きていれば長い待ち時間を待たない（#2238）", () => {
    expect(
      decideCheckUserPush({
        labels: [CHECK_USER, { name: "01.check-merge" }],
        checkUserLabeledAt: at(CHECK_USER_PUSH_DELAY_MS),
        hasPendingSessionRequest: true,
        now: NOW,
      }),
    ).toBe("send");
  });

  it("待ちが無ければ従来どおり待ち時間で決める（#2238）", () => {
    expect(
      decideCheckUserPush({
        labels: [CHECK_USER, { name: "01.check-input" }],
        checkUserLabeledAt: at(5_000),
        hasPendingSessionRequest: false,
        now: NOW,
      }),
    ).toBe("wait");
  });

  it("古すぎる確認待ちは送らずに送信済みとして畳む", () => {
    expect(
      decideCheckUserPush({
        labels: [CHECK_USER],
        checkUserLabeledAt: at(CHECK_USER_PUSH_MAX_AGE_MS),
        now: NOW,
      }),
    ).toBe("skip");
  });
});

describe("buildCheckUserPushPayload", () => {
  const issue = {
    githubIssueId: BigInt(987654321),
    number: 838,
    title: "画面を閉じているとき（PWA）のユーザー確認待ちPush通知を追加",
    repositoryFullName: "guchi-apps/issue-deck",
  };

  it("1行目にIssue、2行目にリポジトリと理由を出す", () => {
    const payload = buildCheckUserPushPayload({
      ...issue,
      labels: [CHECK_USER, { name: "01.check-plan" }],
    });

    expect(payload.title).toBe(`#838 ${issue.title}`);
    expect(payload.body).toBe("issue-deck ・ 計画の承認");
  });

  it("理由ラベルが無ければ「確認待ち」とだけ出す", () => {
    const payload = buildCheckUserPushPayload({ ...issue, labels: [CHECK_USER] });
    expect(payload.body).toBe("issue-deck ・ 確認待ち");
  });

  it("PC・スマホの両方の現在地を載せたURLを開く", () => {
    const payload = buildCheckUserPushPayload({ ...issue, labels: [CHECK_USER] });
    expect(payload.url).toBe(
      "/dashboard?issue=987654321&mscreen=issue-detail&missue=987654321",
    );
  });

  it("同じIssueの通知はまとまるよう、Issueごとのtagを付ける", () => {
    const payload = buildCheckUserPushPayload({ ...issue, labels: [CHECK_USER] });
    expect(payload.tag).toBe("check-user:987654321");
  });
});

describe("sweepCheckUserPushNotifications", () => {
  /**
   * 巡回1回ぶんのDBを差し替える。`reservedCount`は「送信済みの席を取れたか」で、
   * 0は別の巡回に先を越された状態（#2300）。
   */
  function mockDb(options?: {
    reservedCount?: number;
    labels?: { name: string }[];
    /** 宛先として返す購読（既定は空＝誰も購読していない） */
    subscriptions?: unknown[];
    /** そのIssueを保留にしているユーザーの購読数（#2398。既定は0） */
    snoozedSubscriberCount?: number;
    /** 期限内のWAITINGの計画待ち（既定は無し） */
    waitingPlans?: unknown[];
    /** 計画レビューのジョブ（新しい順） */
    planReviewJobs?: unknown[];
    /** 自動反映の決定直後の計画待ち（decidedByUserId=nullのREVISION_REQUESTED） */
    reflectedPlans?: unknown[];
  }) {
    const findSubscriptions = vi.fn().mockResolvedValue(options?.subscriptions ?? []);
    const updateMany = vi.fn().mockResolvedValue({ count: options?.reservedCount ?? 1 });
    Object.assign(db, {
      issue: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "issue-1",
            githubIssueId: 987654321,
            number: 12,
            title: "確認してほしい",
            checkUserLabeledAt: at(CHECK_USER_PUSH_DELAY_MS),
            labels: options?.labels ?? [CHECK_USER, { name: "01.check-plan" }],
            repository: {
              id: "repo-1",
              fullName: "guchi-apps/issue-deck",
              installationId: "install-1",
            },
          },
        ]),
        updateMany,
      },
      sessionPlanRequest: {
        findMany: vi.fn().mockImplementation(async (args: { where: { status: string } }) =>
          args.where.status === "REVISION_REQUESTED"
            ? (options?.reflectedPlans ?? [])
            : (options?.waitingPlans ?? []),
        ),
      },
      dispatchJob: { findMany: vi.fn().mockResolvedValue(options?.planReviewJobs ?? []) },
      sessionQuestionRequest: { findMany: vi.fn().mockResolvedValue([]) },
      // 保留（#2398）で宛先が全員消えたかを見るための件数。既定は0（誰も伏せていない）
      pushSubscription: {
        findMany: findSubscriptions,
        count: vi.fn().mockResolvedValue(options?.snoozedSubscriberCount ?? 0),
      },
    });
    return { findSubscriptions, updateMany };
  }

  beforeEach(() => {
    vi.mocked(isPushConfigured).mockReturnValue(true);
    vi.mocked(sendPushNotification).mockReset();
    vi.mocked(sendPushNotification).mockResolvedValue({ sent: 1, removed: 0, failed: 0 });
  });

  describe("計画レビューの採否が決まるまで待つ保留（#3616・#3648）", () => {
    const sub = [{ id: "s", endpoint: "e", p256dh: "p", auth: "a" }];
    const plan = {
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 12,
      createdAt: at(60_000),
    };
    const runningJob = {
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 12,
      agent: "claude",
      status: "RUNNING",
      createdAt: at(50_000),
      finishedAt: null,
      planReviewDecidedAt: null,
    };

    it("計画待ちがあり、レビューが作成中なら送らない", async () => {
      mockDb({ waitingPlans: [plan], planReviewJobs: [runningJob] });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });

    it("理由ラベルがまだ付いていなくても、レビューが作成中なら送らない（#3726）", async () => {
      mockDb({ labels: [CHECK_USER], waitingPlans: [plan], planReviewJobs: [runningJob], subscriptions: sub });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });

    it("成功から10分を過ぎていれば保留しない", async () => {
      mockDb({
        waitingPlans: [plan],
        planReviewJobs: [{ ...runningJob, status: "SUCCEEDED", finishedAt: at(11 * 60_000) }],
        subscriptions: sub,
      });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).toHaveBeenCalled();
    });

    it("指摘が届いても、採否が決まるまで（Jevの判定中）は送らない", async () => {
      mockDb({
        waitingPlans: [plan],
        planReviewJobs: [{ ...runningJob, status: "SUCCEEDED", finishedAt: at(10_000) }],
        subscriptions: sub,
      });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });

    it("採否が決まっていれば保留しない", async () => {
      mockDb({
        waitingPlans: [plan],
        planReviewJobs: [
          { ...runningJob, status: "SUCCEEDED", finishedAt: at(10_000), planReviewDecidedAt: at(5_000) },
        ],
        subscriptions: sub,
      });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).toHaveBeenCalled();
    });

    it("自動反映済みの計画を出し直したときも（2回目以降）保留する", async () => {
      // 出し直した計画のあとに積まれたジョブが作成中
      mockDb({ waitingPlans: [plan], planReviewJobs: [runningJob], subscriptions: sub });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });

    it("今の計画より前に積まれたジョブしか無ければ（今回のレビューが積まれていない）保留しない", async () => {
      mockDb({
        waitingPlans: [plan],
        planReviewJobs: [{ ...runningJob, createdAt: at(10 * 60_000) }],
        subscriptions: sub,
      });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).toHaveBeenCalled();
    });

    it("計画待ちの作成直後でジョブが未積みなら、理由ラベルが無くても保留する（#3709）", async () => {
      mockDb({
        labels: [CHECK_USER],
        waitingPlans: [{ ...plan, createdAt: at(10_000) }],
        subscriptions: sub,
      });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });

    it("前の周のジョブが残っていても、出し直した計画の直後は保留する（#3709）", async () => {
      mockDb({
        labels: [CHECK_USER],
        waitingPlans: [{ ...plan, createdAt: at(10_000) }],
        planReviewJobs: [
          { ...runningJob, status: "SUCCEEDED", createdAt: at(8 * 60_000), finishedAt: at(7 * 60_000), planReviewDecidedAt: at(6 * 60_000) },
        ],
        subscriptions: sub,
      });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });

    it("ジョブが積まれないまま60秒を過ぎたら保留しない（#3709）", async () => {
      mockDb({ waitingPlans: [{ ...plan, createdAt: at(90_000) }], subscriptions: sub });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).toHaveBeenCalled();
    });

    it("自動反映の決定直後は、ラベルがDBに残っていても保留する（#3709）", async () => {
      mockDb({
        reflectedPlans: [{ ...plan, decidedAt: at(5_000) }],
        subscriptions: sub,
      });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).not.toHaveBeenCalled();
    });

    it("自動反映のあとに新しい計画待ちが出ていれば、その計画の判定に任せる（#3709）", async () => {
      mockDb({
        reflectedPlans: [{ ...plan, decidedAt: at(100_000) }],
        waitingPlans: [{ ...plan, createdAt: at(90_000) }],
        subscriptions: sub,
      });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).toHaveBeenCalled();
    });

    it("Codexのレビュー・計画待ちが無い場合は保留しない", async () => {
      mockDb({
        waitingPlans: [plan],
        planReviewJobs: [{ ...runningJob, agent: "codex" }],
        subscriptions: sub,
      });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).toHaveBeenCalledTimes(1);

      vi.mocked(sendPushNotification).mockClear();
      mockDb({ planReviewJobs: [runningJob], subscriptions: sub });
      await sweepCheckUserPushNotifications(NOW);
      expect(sendPushNotification).toHaveBeenCalledTimes(1);
    });
  });

  it("そのリポジトリを非表示にしているユーザーの購読は宛先から外す（#2279）", async () => {
    const { findSubscriptions } = mockDb();

    await sweepCheckUserPushNotifications(NOW);

    expect(findSubscriptions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          user: expect.objectContaining({
            userInstallations: { some: { installationId: "install-1" } },
            hiddenRepositories: { none: { repositoryId: "repo-1" } },
          }),
        },
      }),
    );
  });

  it("「いまは実施しない」として伏せているユーザーの購読も宛先から外す（#2398）", async () => {
    const { findSubscriptions } = mockDb();

    await sweepCheckUserPushNotifications(NOW);

    expect(findSubscriptions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          user: expect.objectContaining({
            NOT: {
              snoozedItems: {
                some: {
                  repositoryId: "repo-1",
                  kind: "ISSUE",
                  number: 12,
                  OR: [{ until: null }, { until: { gt: NOW } }],
                },
              },
            },
          }),
        },
      }),
    );
  });

  it("宛先が保留で全員消えたときは送信済みにせず、次の巡回へ回す（#2398）", async () => {
    const { updateMany } = mockDb({ subscriptions: [], snoozedSubscriberCount: 1 });

    await sweepCheckUserPushNotifications(NOW);

    // 送らないだけでなく、**席も取らない**。取ると保留を解除しても二度と鳴らない
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("送る前に「送信済み」を立てて席を取る（#2300）", async () => {
    const { updateMany } = mockDb();

    await sweepCheckUserPushNotifications(NOW);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "issue-1", checkUserPushSentAt: null },
      data: { checkUserPushSentAt: NOW },
    });
    expect(sendPushNotification).toHaveBeenCalledTimes(1);
    // 席を取る更新は1回だけ。送った後に記録を付け直さない
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("席を取れなかったら送らない（同時に走った巡回で同じ通知を2件送らない。#2300）", async () => {
    mockDb({ reservedCount: 0 });

    await sweepCheckUserPushNotifications(NOW);

    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("同時に走った2本の巡回でも、送るのは1件だけ（#2300）", async () => {
    // 1行ぶんのDBを模す。`updateMany`はMySQLの行ロックと同じく、
    // 条件（まだ未送信）に合う行が残っていたときだけ更新される
    let checkUserPushSentAt: Date | null = null;
    const row = {
      id: "issue-1",
      githubIssueId: 987654321,
      number: 12,
      title: "確認してほしい",
      checkUserLabeledAt: at(CHECK_USER_PUSH_DELAY_MS),
      labels: [CHECK_USER, { name: "01.check-plan" }],
      repository: { id: "repo-1", fullName: "guchi-apps/issue-deck", installationId: "install-1" },
    };
    Object.assign(db, {
      issue: {
        findMany: vi.fn(async () => (checkUserPushSentAt === null ? [row] : [])),
        updateMany: vi.fn(async ({ data }: { data: { checkUserPushSentAt: Date } }) => {
          if (checkUserPushSentAt !== null) return { count: 0 };
          checkUserPushSentAt = data.checkUserPushSentAt;
          return { count: 1 };
        }),
      },
      sessionPlanRequest: { findMany: vi.fn().mockResolvedValue([]) },
      sessionQuestionRequest: { findMany: vi.fn().mockResolvedValue([]) },
      pushSubscription: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    });
    // 送信には時間がかかる（Pushサービスへの往復）。**その間にもう1本が走る**のが
    // 実際に起きていた並びなので、送信を待たせて重ねる
    vi.mocked(sendPushNotification).mockImplementation(
      async () =>
        await new Promise((resolve) =>
          setTimeout(() => resolve({ sent: 1, removed: 0, failed: 0 }), 10),
        ),
    );

    await Promise.all([
      sweepCheckUserPushNotifications(NOW),
      sweepCheckUserPushNotifications(NOW),
    ]);

    expect(sendPushNotification).toHaveBeenCalledTimes(1);
  });

  it("古すぎる確認待ちは送らずに記録だけ付ける", async () => {
    const { updateMany } = mockDb();
    (db.issue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "issue-1",
        githubIssueId: 987654321,
        number: 12,
        title: "確認してほしい",
        checkUserLabeledAt: at(CHECK_USER_PUSH_MAX_AGE_MS),
        labels: [CHECK_USER],
        repository: { id: "repo-1", fullName: "guchi-apps/issue-deck", installationId: "install-1" },
      },
    ]);

    await sweepCheckUserPushNotifications(NOW);

    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
