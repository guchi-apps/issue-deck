import { describe, expect, it } from "vitest";

import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import {
  buildPreviewRepositoryRows,
  describePreviewIdleStop,
  describePreviewJob,
  describePreviewRejection,
  isHostWidePreviewRejection,
  parseDispatchHostPreview,
  parsePreviewUrl,
  resolvePreviewRejection,
  selectHostWidePreviewRejection,
} from "@/lib/dispatch/preview-server";

const NOW = new Date("2026-08-29T12:00:00.000Z");

function host(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck", "guchi-apps/dayspan"],
    contractVersion: 2,
    online: true,
    lastSeenAt: NOW.toISOString(),
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: true,
    manualStepAbortCapable: true,
    manualStepValuesCapable: true,
    planReviewCapable: true,
    codeReviewCapable: true,
    codexCapable: null,
    selfUpdateCapable: true,
    previewCapable: true,
    rebootCapable: null,
    reboot: null,
    previewRepositories: ["guchi-apps/issue-deck", "guchi-apps/dayspan"],
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
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 0,
    issueTitle: null,
    issueId: null,
    targetHost: "subpc",
    agent: "claude",
    kind: "PREVIEW",
    status: "QUEUED",
    message: null,
    instruction: null,
    command: null,
    placeholderValues: null,
    resolvedCommand: null,
    manualStepLine: null,
    targetJobId: null,
    previewAction: "start",
    exitCode: null,
    commandOutput: null,
    tmuxSessionName: null,
    queuePriority: 0,
    createdAt: NOW.toISOString(),
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const RUNNING_STATE = {
  running: true,
  repository: "guchi-apps/issue-deck",
  port: 4000,
  branch: "develop",
  url: "http://subpc.tail5210f2.ts.net:4000",
  commit: "ea52e5c4",
  subject: "v4.48.0をリリースする。",
  startedAt: "2026-08-29T11:48:00.000Z",
  idleMinutes: 60,
};

describe("parseDispatchHostPreview（#2444）", () => {
  it("動いている申告をそのまま読む", () => {
    expect(parseDispatchHostPreview(RUNNING_STATE)).toEqual({
      repository: "guchi-apps/issue-deck",
      port: 4000,
      branch: "develop",
      url: "http://subpc.tail5210f2.ts.net:4000/",
      commit: "ea52e5c4",
      subject: "v4.48.0をリリースする。",
      startedAt: "2026-08-29T11:48:00.000Z",
      idleMinutes: 60,
    });
  });

  // 直前まで動いていた記録を残すと、止まっているものが画面では動いているように見える
  it("running:false は null（直前の記録を残さない）", () => {
    expect(parseDispatchHostPreview({ ...RUNNING_STATE, running: false })).toBeNull();
    expect(parseDispatchHostPreview(null)).toBeNull();
  });

  // `repository`と`port`は状態ファイルとプロセスさえ読めれば必ず分かる。欠けている申告は
  // どのリポジトリのことなのかが決まらないので、全体を落とす
  it("リポジトリ・ポートが欠けていれば全体を null にする", () => {
    expect(parseDispatchHostPreview({ ...RUNNING_STATE, repository: "issue-deck" })).toBeNull();
    expect(parseDispatchHostPreview({ ...RUNNING_STATE, port: 0 })).toBeNull();
  });

  // ブランチ・URL・コミットは取れないことがある（`--no-update`・tailscale serveが無いホスト）。
  // 1つ欠けても残りが誤読されないため、その項目だけを null にする
  it("取れなかった項目だけを null にする", () => {
    const parsed = parseDispatchHostPreview({
      running: true,
      repository: "guchi-apps/dayspan",
      port: 6000,
    });
    expect(parsed).toEqual({
      repository: "guchi-apps/dayspan",
      port: 6000,
      branch: null,
      url: null,
      commit: null,
      subject: null,
      startedAt: null,
      idleMinutes: null,
    });
  });
});

describe("parsePreviewUrl（#2444）", () => {
  it("http・httpsだけを受ける", () => {
    expect(parsePreviewUrl("http://subpc.tail5210f2.ts.net:4000")).toBe(
      "http://subpc.tail5210f2.ts.net:4000/",
    );
    expect(parsePreviewUrl("https://example.test/")).toBe("https://example.test/");
  });

  // 申告はそのまま`<a href>`に載る。認証済みの経路でも、画面へ出す値の検証を申告側に委ねない
  it("javascript: など他のスキームを弾く", () => {
    expect(parsePreviewUrl("javascript:alert(1)")).toBeNull();
    expect(parsePreviewUrl("subpc:4000")).toBeNull();
    expect(parsePreviewUrl("")).toBeNull();
    expect(parsePreviewUrl(42)).toBeNull();
  });
});

describe("resolvePreviewRejection（#2444）", () => {
  const base = {
    repositoryFullName: "guchi-apps/dayspan",
    action: "start" as const,
    hasQueuedJob: false,
  };

  it("申告のあるオンラインのホストなら押せる", () => {
    expect(resolvePreviewRejection({ ...base, host: host() })).toBeNull();
  });

  // 未申告（古いpoller）は「できない」側に倒す。配ると未知の種別として failed になる
  it("previewCapable が true でなければ押せない", () => {
    for (const previewCapable of [null, false]) {
      expect(resolvePreviewRejection({ ...base, host: host({ previewCapable }) })).toBe(
        "preview_unsupported",
      );
    }
  });

  it("オフライン・ホスト不明・順番待ちを見分ける", () => {
    expect(resolvePreviewRejection({ ...base, host: null })).toBe("host_unknown");
    expect(resolvePreviewRejection({ ...base, host: host({ online: false }) })).toBe("host_offline");
    expect(resolvePreviewRejection({ ...base, host: host(), hasQueuedJob: true })).toBe(
      "already_queued",
    );
  });

  // サブPCにチェックアウトが無いリポジトリ（申告そのものに載らない）
  it("そのホストが実行できないリポジトリは押せない", () => {
    expect(
      resolvePreviewRejection({ ...base, host: host(), repositoryFullName: "guchi-apps/vps" }),
    ).toBe("repository_unavailable");
  });

  // チェックアウトはあるが`package.json`が無いリポジトリ（vps・subpc・docs等）
  it("開発サーバーを持たないリポジトリは別の理由で押せない", () => {
    expect(
      resolvePreviewRejection({
        ...base,
        host: host({
          repositories: ["guchi-apps/vps"],
          previewRepositories: [],
        }),
        repositoryFullName: "guchi-apps/vps",
      }),
    ).toBe("no_dev_server");
  });

  // 動いていないものを止める・入れ替えるジョブが積まれても、押した先で理由が返るだけになる
  it("動いていないリポジトリの stop・refresh は押せない", () => {
    expect(resolvePreviewRejection({ ...base, host: host(), action: "stop" })).toBe("not_running");
    const running = host({ preview: parseDispatchHostPreview(RUNNING_STATE) });
    expect(
      resolvePreviewRejection({
        host: running,
        repositoryFullName: "guchi-apps/issue-deck",
        action: "refresh",
        hasQueuedJob: false,
      }),
    ).toBeNull();
  });
});

describe("describePreviewRejection（#2455）", () => {
  // ボタン名だけでは探す場所が分からない。「更新して再起動」は確認環境の画面には無く、
  // 実行キュー（スマホは「実行状況」）を開いた先のサブPCのカードにしか出ない
  it("pollerが古いときは、押すボタンの場所まで書く", () => {
    const message = describePreviewRejection("preview_unsupported");
    expect(message).toContain("実行キュー");
    expect(message).toContain("実行状況");
    expect(message).toContain("サブPCのカード");
    expect(message).toContain("「更新して再起動」");
  });
});

describe("isHostWidePreviewRejection・selectHostWidePreviewRejection（#2455）", () => {
  it("リポジトリを選び直しても変わらない理由だけをホスト全体として扱う", () => {
    expect(isHostWidePreviewRejection("host_unknown")).toBe(true);
    expect(isHostWidePreviewRejection("host_offline")).toBe(true);
    expect(isHostWidePreviewRejection("preview_unsupported")).toBe(true);
    expect(isHostWidePreviewRejection("no_dev_server")).toBe(false);
    expect(isHostWidePreviewRejection("repository_unavailable")).toBe(false);
    expect(isHostWidePreviewRejection("already_queued")).toBe(false);
    expect(isHostWidePreviewRejection("not_running")).toBe(false);
  });

  it("全部の行が同じホスト全体の理由なら、その理由を1つ返す", () => {
    const rows = buildPreviewRepositoryRows({
      host: host({ previewCapable: null }),
      hasQueuedJob: false,
    });
    expect(selectHostWidePreviewRejection(rows)).toBe("preview_unsupported");
  });

  // 行ごとに違う理由（開発サーバーの有無）は、まとめて見出しへ上げない
  it("行ごとに違う理由なら null", () => {
    const rows = buildPreviewRepositoryRows({
      host: host({
        repositories: ["guchi-apps/issue-deck", "guchi-apps/vps"],
        previewRepositories: ["guchi-apps/issue-deck"],
      }),
      hasQueuedJob: false,
    });
    expect(selectHostWidePreviewRejection(rows)).toBeNull();
  });

  it("押せる行がある・行が無い場合は null", () => {
    expect(
      selectHostWidePreviewRejection(
        buildPreviewRepositoryRows({ host: host(), hasQueuedJob: false }),
      ),
    ).toBeNull();
    expect(selectHostWidePreviewRejection([])).toBeNull();
  });
});

describe("buildPreviewRepositoryRows（#2444）", () => {
  it("動いているリポジトリを先頭に、あとは名前順で並べる", () => {
    const rows = buildPreviewRepositoryRows({
      host: host({
        repositories: ["guchi-apps/dayspan", "guchi-apps/car-care", "guchi-apps/issue-deck"],
        previewRepositories: [
          "guchi-apps/dayspan",
          "guchi-apps/car-care",
          "guchi-apps/issue-deck",
        ],
        preview: parseDispatchHostPreview(RUNNING_STATE),
      }),
      hasQueuedJob: false,
    });

    expect(rows.map((row) => row.name)).toEqual(["issue-deck", "car-care", "dayspan"]);
    expect(rows[0].running).toBe(true);
    expect(rows[1].running).toBe(false);
  });

  it("押せない理由を行ごとに持つ", () => {
    const rows = buildPreviewRepositoryRows({
      host: host({ previewCapable: null }),
      hasQueuedJob: false,
    });
    expect(rows.every((row) => row.rejection === "preview_unsupported")).toBe(true);
  });

  it("ホストが居なければ空", () => {
    expect(buildPreviewRepositoryRows({ host: null, hasQueuedJob: false })).toEqual([]);
  });

  // 開発サーバーを持たないリポジトリ（vps・docs等）は`previewRepositories`から外れている。
  // 母集団を`repositories`にすると、押しても必ず失敗する行が一覧に混ざる
  it("開発サーバーを持たないリポジトリは、行は出しつつ押せなくする", () => {
    const rows = buildPreviewRepositoryRows({
      host: host({
        repositories: ["guchi-apps/issue-deck", "guchi-apps/vps"],
        previewRepositories: ["guchi-apps/issue-deck"],
      }),
      hasQueuedJob: false,
    });
    expect(rows.map((row) => row.name)).toEqual(["issue-deck", "vps"]);
    expect(rows[0]).toMatchObject({ noDevServer: false, rejection: null });
    expect(rows[1]).toMatchObject({ noDevServer: true, rejection: "no_dev_server" });
  });

  // 申告していない古いpollerでは絞り込めない。押せなくすると、対応前は何も起こせなくなる
  it("previewRepositories が未申告なら、絞り込まずどれも押せるままにする", () => {
    const rows = buildPreviewRepositoryRows({
      host: host({
        repositories: ["guchi-apps/issue-deck", "guchi-apps/vps"],
        previewRepositories: null,
      }),
      hasQueuedJob: false,
    });
    expect(rows.map((row) => row.name)).toEqual(["issue-deck", "vps"]);
    expect(rows.every((row) => row.rejection === null)).toBe(true);
  });
});

describe("describePreviewJob（#2444）", () => {
  it("走っている間は回している旨を出す", () => {
    expect(describePreviewJob(job({ status: "RUNNING" }), NOW)).toEqual({
      tone: "running",
      text: "確認環境を操作しています...",
    });
  });

  it("終わった結果はメッセージをそのまま出す", () => {
    const finished = job({
      status: "SUCCEEDED",
      message: "起動しました（PID 123）。",
      finishedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    expect(describePreviewJob(finished, NOW)).toEqual({
      tone: "done",
      text: "起動しました（PID 123）。",
    });
  });

  // 押したことを忘れた頃に出ていると、いまの状態に見える
  it("終わってから時間が経った結果は出さない", () => {
    const old = job({
      status: "FAILED",
      message: "失敗しました。",
      finishedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    });
    expect(describePreviewJob(old, NOW)).toBeNull();
    expect(describePreviewJob(null, NOW)).toBeNull();
  });
});

describe("describePreviewIdleStop（#2444）", () => {
  it("申告があるときだけ自動停止の案内を出す", () => {
    const preview = parseDispatchHostPreview(RUNNING_STATE)!;
    expect(describePreviewIdleStop(preview)).toBe("60分アクセスが無いと自動で停止します。");
    expect(describePreviewIdleStop({ ...preview, idleMinutes: null })).toBeNull();
  });
});
