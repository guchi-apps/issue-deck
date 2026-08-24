import { describe, expect, it, vi } from "vitest";

import {
  buildCheckUserPushPayload,
  CHECK_USER_MERGE_PUSH_DELAY_MS,
  CHECK_USER_PUSH_DELAY_MS,
  CHECK_USER_PUSH_MAX_AGE_MS,
  decideCheckUserPush,
} from "@/lib/notifications/check-user-push";

// 判定だけを見るテスト。DBとweb-pushはこのモジュールの読み込みで引きずられるだけなので潰す
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/notifications/push", () => ({
  isPushConfigured: () => false,
  sendPushNotification: vi.fn(),
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
