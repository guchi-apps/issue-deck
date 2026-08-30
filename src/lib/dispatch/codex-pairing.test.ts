import { describe, expect, it } from "vitest";

import {
  buildCodexPairingActiveKey,
  describeCodexPairingJob,
  describeCodexPairingRejection,
  formatCodexPairingCountdown,
  isCodexPairingExpired,
  normalizeCodexPairingExpiry,
  parseCodexPairingCode,
  resolveCodexPairingRejection,
} from "@/lib/dispatch/codex-pairing";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";

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
    codexCapable: true,
    codexRemoteControlCapable: true,
    selfUpdateCapable: null,
    previewCapable: null,
    rebootCapable: null,
    reboot: null,
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
    kind: "CODEX_PAIRING",
    status: "QUEUED",
    message: null,
    tmuxSessionName: null,
    instruction: null,
    command: null,
    resolvedCommand: null,
    manualStepLine: null,
    targetJobId: null,
    previewAction: null,
    codexPairingCode: null,
    codexPairingExpiresAt: null,
    createdAt: NOW.toISOString(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  } as DispatchJobView;
}

describe("parseCodexPairingCode（#2524）", () => {
  it("`XXXX-XXXX`の形だけを通し、大文字へ揃える", () => {
    expect(parseCodexPairingCode("A1B2-C3D4")).toBe("A1B2-C3D4");
    expect(parseCodexPairingCode(" a1b2-c3d4 ")).toBe("A1B2-C3D4");
  });

  it("形が違うものは通さない（CLIの版が変われば別のものが返りうる）", () => {
    expect(parseCodexPairingCode("A1B2C3D4")).toBeNull();
    expect(parseCodexPairingCode("A1B2-C3D45")).toBeNull();
    expect(parseCodexPairingCode("")).toBeNull();
    expect(parseCodexPairingCode(null)).toBeNull();
    // `pair`が返すもう一方の`pairingCode`（数字の長い列）は画面に出すものではない
    expect(parseCodexPairingCode("123456789012")).toBeNull();
  });
});

describe("normalizeCodexPairingExpiry（#2524）", () => {
  it("Codexが返すepoch秒を読む", () => {
    const at = normalizeCodexPairingExpiry(NOW.getTime() / 1000 + 600, NOW);
    expect(at?.toISOString()).toBe("2026-08-30T12:10:00.000Z");
  });

  it("ミリ秒で来ても読める", () => {
    const at = normalizeCodexPairingExpiry(NOW.getTime() + 600_000, NOW);
    expect(at?.toISOString()).toBe("2026-08-30T12:10:00.000Z");
  });

  it("過去だけ`null`（既に切れているものを有効だと言い直さない）", () => {
    expect(normalizeCodexPairingExpiry(NOW.getTime() / 1000 - 1, NOW)).toBeNull();
  });

  // 捨てるとコード（`manualPairingCode`のほう）まで失われ、押した人は何も受け取れない
  it("読めない・届かない場合は10分後を当てる", () => {
    expect(normalizeCodexPairingExpiry("あした", NOW)?.toISOString()).toBe(
      "2026-08-30T12:10:00.000Z",
    );
    expect(normalizeCodexPairingExpiry(null, NOW)?.toISOString()).toBe("2026-08-30T12:10:00.000Z");
    expect(normalizeCodexPairingExpiry("", NOW)?.toISOString()).toBe("2026-08-30T12:10:00.000Z");
  });

  it("遠すぎる未来は10分後へ丸める（消えないコードを作らない）", () => {
    const at = normalizeCodexPairingExpiry(NOW.getTime() / 1000 + 86_400, NOW);
    expect(at?.toISOString()).toBe("2026-08-30T12:10:00.000Z");
  });
});

describe("isCodexPairingExpired（#2524）", () => {
  it("期限が入っていなければ切れている扱い（出さない側へ倒す）", () => {
    expect(isCodexPairingExpired(null, NOW)).toBe(true);
    expect(isCodexPairingExpired("こわれた値", NOW)).toBe(true);
  });

  it("期限そのものは切れている", () => {
    expect(isCodexPairingExpired(NOW.toISOString(), NOW)).toBe(true);
    expect(isCodexPairingExpired(new Date(NOW.getTime() + 1000).toISOString(), NOW)).toBe(false);
  });
});

describe("resolveCodexPairingRejection（#2524）", () => {
  it("申告のあるオンラインのホストなら押せる", () => {
    expect(resolveCodexPairingRejection({ host: host(), hasQueuedJob: false })).toBeNull();
  });

  it("standalone installを申告していないホストでは押せない（#2521）", () => {
    expect(
      resolveCodexPairingRejection({
        host: host({ codexRemoteControlCapable: null }),
        hasQueuedJob: false,
      }),
    ).toBe("not_capable");
    // `codexCapable`（`codex`コマンドがある）だけでは足りない
    expect(
      resolveCodexPairingRejection({
        host: host({ codexCapable: true, codexRemoteControlCapable: false }),
        hasQueuedJob: false,
      }),
    ).toBe("not_capable");
  });

  it("応答していない・申告が無い・発行中は押せない", () => {
    expect(resolveCodexPairingRejection({ host: host({ online: false }), hasQueuedJob: false })).toBe(
      "offline",
    );
    expect(resolveCodexPairingRejection({ host: null, hasQueuedJob: false })).toBe("host_not_found");
    expect(resolveCodexPairingRejection({ host: host(), hasQueuedJob: true })).toBe("already_queued");
  });

  it("理由はそのまま画面に出せる文になる", () => {
    expect(describeCodexPairingRejection("not_capable", "subpc")).toContain("standalone install");
  });
});

describe("describeCodexPairingJob（#2524）", () => {
  it("届くまでは押し直させない", () => {
    expect(describeCodexPairingJob(job(), NOW)?.pending).toBe(true);
    expect(describeCodexPairingJob(job({ status: "RUNNING" }), NOW)?.pending).toBe(true);
  });

  it("成功したらコードと残り時間を返す（`label`には入れない）", () => {
    const row = describeCodexPairingJob(
      job({
        status: "SUCCEEDED",
        finishedAt: NOW.toISOString(),
        codexPairingCode: "A1B2-C3D4",
        codexPairingExpiresAt: new Date(NOW.getTime() + 500_000).toISOString(),
      }),
      NOW,
    );
    expect(row?.code).toBe("A1B2-C3D4");
    expect(row?.expiresInSeconds).toBe(500);
    expect(row?.pending).toBe(false);
    // コードは押した人がコピーするもので、文の中に埋めない
    expect(row?.label).not.toContain("A1B2-C3D4");
  });

  it("コードが切れたら行ごと消える（効かないコードを打たせない）", () => {
    const expired = job({
      status: "SUCCEEDED",
      finishedAt: NOW.toISOString(),
      codexPairingCode: "A1B2-C3D4",
      codexPairingExpiresAt: new Date(NOW.getTime() - 1000).toISOString(),
    });
    expect(describeCodexPairingJob(expired, NOW)).toBeNull();
  });

  it("形の違う値が入っていたら出さない", () => {
    const broken = job({
      status: "SUCCEEDED",
      finishedAt: NOW.toISOString(),
      codexPairingCode: "こわれた値",
      codexPairingExpiresAt: new Date(NOW.getTime() + 500_000).toISOString(),
    });
    expect(describeCodexPairingJob(broken, NOW)).toBeNull();
  });

  it("失敗は理由を10分だけ出す", () => {
    const failed = job({
      status: "FAILED",
      finishedAt: NOW.toISOString(),
      message: "Codexのデーモンを起動できませんでした（終了コード 1）。",
    });
    expect(describeCodexPairingJob(failed, NOW)?.tone).toBe("critical");
    expect(describeCodexPairingJob(failed, new Date(NOW.getTime() + 11 * 60_000))).toBeNull();
  });

  it("ジョブが無ければ何も出さない", () => {
    expect(describeCodexPairingJob(null, NOW)).toBeNull();
  });
});

describe("formatCodexPairingCountdown（#2524）", () => {
  it("分と秒で出す", () => {
    expect(formatCodexPairingCountdown(500)).toBe("あと 8分20秒");
    expect(formatCodexPairingCountdown(45)).toBe("あと 45秒");
  });

  it("切れていれば出さない", () => {
    expect(formatCodexPairingCountdown(0)).toBeNull();
    expect(formatCodexPairingCountdown(null)).toBeNull();
  });
});

describe("buildCodexPairingActiveKey（#2524）", () => {
  it("ホストごとに1件へ絞る（連打しても増えるのは短命のコードだけ）", () => {
    expect(buildCodexPairingActiveKey("subpc")).toBe("codex_pairing:host:subpc");
    expect(buildCodexPairingActiveKey("subpc")).not.toBe(buildCodexPairingActiveKey("other"));
  });
});
