import { describe, expect, it } from "vitest";

import {
  addDismissal,
  parseDismissals,
  pruneDismissals,
  removeDismissal,
  splitDismissedNotifications,
} from "@/lib/notification-dismissals";
import type { NotificationItem } from "@/lib/notifications";

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: "release:guchi-apps/car-care:270",
    group: "release",
    tone: "error",
    title: "#270 リリース候補 RC-2",
    badgeLabel: "チェック失敗",
    repositoryFullName: "guchi-apps/car-care",
    since: null,
    target: { kind: "flow" },
    ...overrides,
  };
}

const NOW = Date.parse("2026-10-19T12:00:00.000Z");

describe("splitDismissedNotifications", () => {
  it("伏せた通知を一覧から外し、伏せた側へ回す", () => {
    const failing = item();
    const other = item({ id: "manual-step:a", group: "manual-step", tone: "info", badgeLabel: "手作業" });
    const dismissals = addDismissal([], failing, NOW);

    const { visible, dismissed } = splitDismissedNotifications([failing, other], dismissals);

    expect(visible).toEqual([other]);
    expect(dismissed).toEqual([failing]);
  });

  it("状態（バッジの文言）が変わった通知は再び出す", () => {
    const dismissals = addDismissal([], item(), NOW);

    const { visible } = splitDismissedNotifications(
      [item({ tone: "action", badgeLabel: "mainへマージ待ち" })],
      dismissals,
    );

    expect(visible).toHaveLength(1);
  });

  it("確認待ちが付け直された（版が変わった）通知は再び出す", () => {
    const checkUser = item({
      id: "check-user:issue-1",
      group: "check-user",
      tone: "action",
      badgeLabel: "計画の承認",
      revision: "2026-10-18T00:00:00.000Z",
    });
    const dismissals = addDismissal([], checkUser, NOW);

    expect(splitDismissedNotifications([checkUser], dismissals).visible).toHaveLength(0);
    expect(
      splitDismissedNotifications(
        [{ ...checkUser, revision: "2026-10-19T00:00:00.000Z" }],
        dismissals,
      ).visible,
    ).toHaveLength(1);
  });

  it("待ち時間の基準（since）が動いただけでは伏せたままにする", () => {
    const dismissals = addDismissal([], item({ since: "2026-10-18T00:00:00.000Z" }), NOW);

    const { visible } = splitDismissedNotifications(
      [item({ since: "2026-10-19T00:00:00.000Z" })],
      dismissals,
    );

    expect(visible).toHaveLength(0);
  });
});

describe("removeDismissal", () => {
  it("戻した通知は再び出る", () => {
    const dismissals = removeDismissal(addDismissal([], item(), NOW), item().id);

    expect(splitDismissedNotifications([item()], dismissals).visible).toHaveLength(1);
  });
});

describe("pruneDismissals", () => {
  it("指紋が変わった記録は取り直しの前でも消す（失敗→成功→失敗で伏せ直さない）", () => {
    const dismissals = addDismissal([], item(), NOW);

    expect(
      pruneDismissals(dismissals, [item({ tone: "action", badgeLabel: "mainへマージ待ち" })], false),
    ).toEqual([]);
  });

  it("対象が一覧から消えた記録は、取り直しが済むまで残す", () => {
    const dismissals = addDismissal([], item(), NOW);

    expect(pruneDismissals(dismissals, [], false)).toBe(dismissals);
    expect(pruneDismissals(dismissals, [], true)).toEqual([]);
  });

  it("まだ効いている記録だけなら入力をそのまま返す（保存し直さない）", () => {
    const dismissals = addDismissal([], item(), NOW);

    expect(pruneDismissals(dismissals, [item()], true)).toBe(dismissals);
  });
});

describe("parseDismissals", () => {
  it("形の合わない値は捨てる", () => {
    expect(parseDismissals(null)).toEqual([]);
    expect(parseDismissals("x")).toEqual([]);
    expect(
      parseDismissals([
        { id: "a", fingerprint: "f", dismissedAt: "2026-10-19T00:00:00.000Z" },
        { id: 1 },
        null,
      ]),
    ).toEqual([{ id: "a", fingerprint: "f", dismissedAt: "2026-10-19T00:00:00.000Z" }]);
  });
});
