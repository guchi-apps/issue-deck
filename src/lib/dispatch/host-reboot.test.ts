import { describe, expect, it } from "vitest";

import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import {
  describeDispatchHostReboot,
  describeDispatchHostRebootJob,
  parseDispatchHostReboot,
  resolveRebootRejection,
} from "@/lib/dispatch/host-reboot";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function host(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: new Date(NOW.getTime() - 20_000).toISOString(),
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: null,
    manualStepAbortCapable: null,
    manualStepValuesCapable: null,
    planReviewCapable: null,
    codeReviewCapable: null,
    codexCapable: null,
    selfUpdateCapable: null,
    previewCapable: null,
    rebootCapable: true,
    reboot: {
      required: true,
      requiredSince: "2026-08-20T06:12:00.000Z",
      bootedAt: "2026-08-17T12:00:00.000Z",
    },
    previewRepositories: null,
    preview: null,
    maxSessions: 12,
    liveSessions: 0,
    metrics: null,
    launchHold: null,
    checkout: null,
    ...overrides,
  };
}

function job(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 0,
    issueTitle: null,
    targetHost: "subpc",
    agent: "claude",
    kind: "REBOOT",
    status: "QUEUED",
    message: null,
    tmuxSessionName: null,
    instruction: null,
    command: null,
    resolvedCommand: null,
    manualStepLine: null,
    targetJobId: null,
    previewAction: null,
    createdAt: NOW.toISOString(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  } as DispatchJobView;
}

describe("parseDispatchHostReboot（#2496）", () => {
  it("pollerが送る形をそのまま読む", () => {
    expect(
      parseDispatchHostReboot({
        required: true,
        requiredSince: "2026-08-20T06:12:00Z",
        bootedAt: "2026-08-17T12:00:00Z",
      }),
    ).toEqual({
      required: true,
      requiredSince: "2026-08-20T06:12:00.000Z",
      bootedAt: "2026-08-17T12:00:00.000Z",
    });
  });

  it("requiredが無ければ全体をnullにする（申告していない古いpoller）", () => {
    expect(parseDispatchHostReboot({ bootedAt: "2026-08-17T12:00:00Z" })).toBeNull();
    expect(parseDispatchHostReboot(null)).toBeNull();
    expect(parseDispatchHostReboot("true")).toBeNull();
  });

  it("時刻だけが壊れていても全体は落とさず、その項目だけnullにする", () => {
    expect(parseDispatchHostReboot({ required: false, requiredSince: "壊れた値" })).toEqual({
      required: false,
      requiredSince: null,
      bootedAt: null,
    });
  });
});

describe("resolveRebootRejection（#2496）", () => {
  it("セッションが0本で対応していれば押せる", () => {
    expect(resolveRebootRejection({ host: host(), hasQueuedJob: false })).toBeNull();
  });

  it("セッションが走っていれば押せない", () => {
    expect(resolveRebootRejection({ host: host({ liveSessions: 3 }), hasQueuedJob: false })).toBe(
      "sessions_running",
    );
  });

  it("本数を申告していないホストでは押させない（安全側は「押させない」）", () => {
    expect(
      resolveRebootRejection({ host: host({ liveSessions: null }), hasQueuedJob: false }),
    ).toBe("sessions_unknown");
  });

  it("pollerが対応していなければ押せない", () => {
    expect(
      resolveRebootRejection({ host: host({ rebootCapable: null }), hasQueuedJob: false }),
    ).toBe("not_capable");
    expect(
      resolveRebootRejection({ host: host({ rebootCapable: false }), hasQueuedJob: false }),
    ).toBe("not_capable");
  });

  it("応答していなければ押せない", () => {
    expect(resolveRebootRejection({ host: host({ online: false }), hasQueuedJob: false })).toBe(
      "offline",
    );
  });

  it("ホストがいなければ押せない", () => {
    expect(resolveRebootRejection({ host: null, hasQueuedJob: false })).toBe("host_not_found");
  });

  it("未処理の再起動があれば押せない", () => {
    expect(resolveRebootRejection({ host: host(), hasQueuedJob: true })).toBe("already_queued");
  });
});

describe("describeDispatchHostReboot（#2496）", () => {
  it("適用待ちがあれば、いつからかを添えて橙で出す", () => {
    expect(describeDispatchHostReboot(host(), NOW)).toMatchObject({
      uptime: "稼働 13日",
      status: "更新の適用待ち",
      tone: "warn",
    });
    expect(describeDispatchHostReboot(host(), NOW)?.detail).toContain("から");
  });

  it("適用待ちが無ければ、落とす理由が無いことが分かる顔にする", () => {
    const row = describeDispatchHostReboot(
      host({
        reboot: {
          required: false,
          requiredSince: null,
          bootedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        },
      }),
      NOW,
    );
    expect(row).toEqual({
      uptime: "稼働 2時間",
      status: "適用待ちなし",
      detail: null,
      tone: "normal",
    });
  });

  it("申告が無い巡・応答していないホストでは行ごと出さない", () => {
    expect(describeDispatchHostReboot(host({ reboot: null }), NOW)).toBeNull();
    expect(describeDispatchHostReboot(host({ online: false }), NOW)).toBeNull();
  });

  it("起動時刻が取れなくても、適用待ちであることは出す", () => {
    expect(
      describeDispatchHostReboot(
        host({ reboot: { required: true, requiredSince: null, bootedAt: null } }),
        NOW,
      ),
    ).toEqual({ uptime: "稼働時間不明", status: "更新の適用待ち", detail: null, tone: "warn" });
  });
});

describe("describeDispatchHostRebootJob（#2496）", () => {
  it("積んだ直後は、届くのを待っていることと起動を止めていることを出す", () => {
    const row = describeDispatchHostRebootJob(job(), NOW);
    expect(row?.pending).toBe(true);
    expect(row?.label).toContain("起動を止めています");
  });

  it("成功しても押せる顔に戻さない（落ちている最中に2回目を押させない）", () => {
    const row = describeDispatchHostRebootJob(
      job({
        status: "SUCCEEDED",
        message: "再起動を開始しました（セッション0本）。",
        finishedAt: NOW.toISOString(),
      }),
      NOW,
    );
    expect(row).toMatchObject({ pending: true, label: "再起動を開始しました（セッション0本）。" });
  });

  it("失敗はpollerが返した理由をそのまま出す", () => {
    const row = describeDispatchHostRebootJob(
      job({
        status: "FAILED",
        message: "セッションが2本走っています。",
        finishedAt: NOW.toISOString(),
      }),
      NOW,
    );
    expect(row).toMatchObject({ tone: "critical", pending: false });
    expect(row?.label).toContain("セッションが2本走っています。");
  });

  it("終わってから時間が経った結果は出さない（翌日まで残さない）", () => {
    expect(
      describeDispatchHostRebootJob(
        job({
          status: "SUCCEEDED",
          finishedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it("積んでいなければ何も出さない", () => {
    expect(describeDispatchHostRebootJob(null, NOW)).toBeNull();
  });
});
