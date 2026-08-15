// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DispatchQueueButton } from "@/components/dashboard/dispatch-queue-button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const NOW = new Date("2026-08-15T12:00:00.000Z");

const dismiss = vi.fn();
const cancel = vi.fn();
const prioritize = vi.fn();

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: NOW.toISOString(),
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    maxSessions: 12,
    liveSessions: 0,
    metrics: null,
    ...overrides,
  };
}

function makeJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1479,
    issueTitle: null,
    targetHost: "subpc",
    kind: "LAUNCH",
    status: "FAILED",
    message: "tmuxの起動に失敗しました。",
    instruction: null,
    tmuxSessionName: null,
    queuePriority: 0,
    createdAt: NOW.toISOString(),
    claimedAt: null,
    startedAt: null,
    finishedAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeDispatch(jobs: DispatchJobView[]): DispatchStateHandle {
  return {
    hosts: [makeHost()],
    jobs,
    sessions: [],
    concurrency: 2,
    error: null,
    setError: vi.fn(),
    isSubmitting: false,
    enqueue: vi.fn(),
    sendSessionControl: vi.fn(),
    cancel,
    dismiss,
    prioritize,
  } as unknown as DispatchStateHandle;
}

async function openQueue(jobs: DispatchJobView[]) {
  render(<DispatchQueueButton dispatch={makeDispatch(jobs)} />);
  fireEvent.click(screen.getByLabelText("実行キュー"));
  await waitFor(() => expect(screen.getByText("直近の失敗")).toBeDefined());
}

beforeEach(() => {
  vi.clearAllMocks();
  dismiss.mockResolvedValue(true);
  cancel.mockResolvedValue(true);
  prioritize.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

/**
 * #1479。終了したジョブは24時間出続けるため、対処が済んだ失敗を畳めないと新しい失敗が
 * 古いものに埋もれる。
 */
describe("DispatchQueueButton の失敗の表示を消す", () => {
  it("失敗の行の×はdismissを呼ぶ", async () => {
    await openQueue([makeJob()]);

    fireEvent.click(screen.getByLabelText("#1479の失敗の表示を消す"));

    expect(dismiss).toHaveBeenCalledWith("job-1");
    // 取り消し（走る前のジョブを止める操作）とは別物。取り違えると実行中のものを消せてしまう
    expect(cancel).not.toHaveBeenCalled();
  });

  // 実行中・順番待ちの×は従来どおり取り消しのまま
  it("順番待ちの×はcancelを呼ぶ", async () => {
    await openQueue([
      makeJob(),
      makeJob({ id: "job-2", issueNumber: 1480, status: "QUEUED", finishedAt: null }),
    ]);

    fireEvent.click(screen.getByLabelText("#1480のジョブを取り消す"));

    expect(cancel).toHaveBeenCalledWith("job-2");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("失敗が1件だけならまとめて消すボタンは出さない（行の×で足りる）", async () => {
    await openQueue([makeJob()]);

    expect(screen.queryByText(/失敗の表示をすべて消す/)).toBeNull();
  });

  it("失敗が2件以上ならまとめて消せる", async () => {
    await openQueue([makeJob(), makeJob({ id: "job-2", issueNumber: 1480 })]);

    fireEvent.click(screen.getByText(/失敗の表示をすべて消す（2件）/));

    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(2));
    expect(dismiss).toHaveBeenCalledWith("job-1");
    expect(dismiss).toHaveBeenCalledWith("job-2");
  });
});

/**
 * #1541。夜にまとめて積んだあと「これを次に流したい」が出てくるが、キューは積んだ順で
 * 固定されていて、取り消して積み直すと最後尾へ回るだけだった。
 */
describe("DispatchQueueButton の先頭へ上げる", () => {
  function queued(id: string, issueNumber: number, overrides: Partial<DispatchJobView> = {}) {
    return makeJob({ id, issueNumber, status: "QUEUED", finishedAt: null, ...overrides });
  }

  // 共通の`openQueue`は「直近の失敗」の描画を待つが、順番待ちだけのキューにはその節が出ない
  async function openQueued(jobs: DispatchJobView[]) {
    render(<DispatchQueueButton dispatch={makeDispatch(jobs)} />);
    fireEvent.click(screen.getByLabelText("実行キュー"));
    await waitFor(() => expect(screen.getByText("順番待ち")).toBeDefined());
  }

  it("2行目以降の↑はprioritizeを呼ぶ", async () => {
    await openQueued([
      queued("job-1", 1601, { createdAt: "2026-08-15T01:00:00.000Z" }),
      queued("job-2", 1602, { createdAt: "2026-08-15T02:00:00.000Z" }),
    ]);

    fireEvent.click(screen.getByLabelText("#1602のジョブを先頭へ上げる"));

    expect(prioritize).toHaveBeenCalledWith("job-2");
    // 取り消し・表示消しとは別の操作。同じ行に並ぶので取り違えないことを確かめる
    expect(cancel).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  // 押しても何も変わらない
  it("先頭の行には↑を出さない", async () => {
    await openQueued([
      queued("job-1", 1601, { createdAt: "2026-08-15T01:00:00.000Z" }),
      queued("job-2", 1602, { createdAt: "2026-08-15T02:00:00.000Z" }),
    ]);

    expect(screen.queryByLabelText("#1601のジョブを先頭へ上げる")).toBeNull();
  });

  // 画面の並びは払い出し（claimDispatchJob）と同じでなければならない
  it("先頭へ上げたジョブが1番に出て、その行には↑が出ない", async () => {
    await openQueued([
      queued("job-1", 1601, { createdAt: "2026-08-15T01:00:00.000Z" }),
      queued("job-2", 1602, { createdAt: "2026-08-15T02:00:00.000Z", queuePriority: 1 }),
    ]);

    expect(screen.queryByLabelText("#1602のジョブを先頭へ上げる")).toBeNull();
    expect(screen.getByLabelText("#1601のジョブを先頭へ上げる")).toBeDefined();
  });

  // 終わったジョブの順番を入れ替えても意味が無い
  it("実行中・直近の失敗には↑を出さない", async () => {
    await openQueue([
      makeJob({ id: "job-1", issueNumber: 1603, status: "RUNNING", finishedAt: null }),
      makeJob({ id: "job-2", issueNumber: 1604 }),
    ]);

    expect(screen.queryByLabelText("#1603のジョブを先頭へ上げる")).toBeNull();
    expect(screen.queryByLabelText("#1604のジョブを先頭へ上げる")).toBeNull();
  });
});

/**
 * #1519。従来は`issue-deck #1519`と番号しか出ておらず、何のジョブが積まれているのかが
 * GitHubを開くまで分からなかった。
 */
describe("DispatchQueueButton の行の内容", () => {
  async function openWith(jobs: DispatchJobView[], sectionTitle: string) {
    render(<DispatchQueueButton dispatch={makeDispatch(jobs)} />);
    fireEvent.click(screen.getByLabelText("実行キュー"));
    await waitFor(() => expect(screen.getByText(sectionTitle)).toBeDefined());
  }

  it("Issueのタイトルを番号と一緒に出す", async () => {
    await openWith(
      [
        makeJob({
          status: "QUEUED",
          finishedAt: null,
          issueNumber: 1519,
          issueTitle: "実行キューの状態を可視化する",
        }),
      ],
      "順番待ち",
    );

    expect(screen.getByText("#1519 実行キューの状態を可視化する")).toBeDefined();
  });

  // 同期前のIssueやGitHub Appを外したリポジトリでは引けない。従来と同じ見た目に戻す
  it("タイトルが引けなければ番号だけを出す（穴埋めの文言を出さない）", async () => {
    await openWith(
      [makeJob({ status: "QUEUED", finishedAt: null, issueNumber: 1519, issueTitle: null })],
      "順番待ち",
    );

    expect(screen.getByText("#1519")).toBeDefined();
  });

  // QUEUEDのときは状態ラベルがどちらも「順番待ち」になり、状態だけでは見分けられない
  it("種別チップで起動と横断質問を見分けられる", async () => {
    await openWith(
      [
        makeJob({ id: "job-1", status: "QUEUED", finishedAt: null, issueNumber: 1601 }),
        makeJob({
          id: "job-2",
          status: "QUEUED",
          finishedAt: null,
          issueNumber: 1602,
          kind: "CROSS_REPO_QUESTION",
          createdAt: "2026-08-15T13:00:00.000Z",
        }),
      ],
      "順番待ち",
    );

    expect(screen.getByText("実装")).toBeDefined();
    expect(screen.getByText("横断質問")).toBeDefined();
  });
});

/**
 * #1519。制御ジョブは届くまでpull型ぶん最大30秒かかるのに、キューのどこにも出ていなかった
 * （#1544で枠の数え方から外したのは正しいが、表示まで消える必要は無い）。
 */
describe("DispatchQueueButton の送信中の操作", () => {
  async function openControls(jobs: DispatchJobView[]) {
    render(<DispatchQueueButton dispatch={makeDispatch(jobs)} />);
    fireEvent.click(screen.getByLabelText("実行キュー"));
    await waitFor(() => expect(screen.getByText("送信中の操作")).toBeDefined());
  }

  it("未処理の停止を別の節に出す", async () => {
    await openControls([
      makeJob({
        id: "job-1",
        kind: "INTERRUPT",
        status: "QUEUED",
        message: null,
        finishedAt: null,
        issueNumber: 1332,
        issueTitle: "走っているセッションを止める",
      }),
    ]);

    expect(screen.getByText("停止")).toBeDefined();
    expect(screen.getByText("#1332 走っているセッションを止める")).toBeDefined();
    // 枠を使わないことの注記が無いと「実行中 0/2」との辻褄が合わないように見える
    expect(screen.getByText("同時実行数の枠は使わず、先に届きます。")).toBeDefined();
    // 積まれていないと言い切らない
    expect(screen.queryByText(/積まれているジョブはありません/)).toBeNull();
  });

  // 届くまで最大1分あるため、何を送ったのか見えないと送り直してよいか判断できない（#1012）
  it("追加指示は本文も出す", async () => {
    await openControls([
      makeJob({
        id: "job-1",
        kind: "INSTRUCTION",
        status: "QUEUED",
        message: null,
        instruction: "Issueのコメントを読んでから続けて",
        finishedAt: null,
      }),
    ]);

    expect(screen.getByText("「Issueのコメントを読んでから続けて」")).toBeDefined();
  });

  // 実行中はworktreeの作成途中で、制御ジョブはそもそも取り消しの対象外
  it("取り消し・先頭へ上げるは出さない", async () => {
    await openControls([
      makeJob({
        id: "job-1",
        kind: "KILL",
        status: "QUEUED",
        message: null,
        finishedAt: null,
        issueNumber: 1332,
      }),
    ]);

    expect(screen.queryByLabelText("#1332のジョブを取り消す")).toBeNull();
    expect(screen.queryByLabelText("#1332のジョブを先頭へ上げる")).toBeNull();
    expect(screen.queryByText(/まとめて取り消す/)).toBeNull();
  });
});

/**
 * #1567。ポップオーバーがキューだけでなく「サブPCが今どうなっているか」も映すようになった。
 * 従来はセッションの本数しか出ておらず、その中身とホストの余力は別のアプリでしか見られなかった。
 */
describe("DispatchQueueButton のホスト表示", () => {
  function makeSession(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
    return {
      host: "subpc",
      tmuxSessionName: "issue-deck-issue-1567",
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1567,
      issueTitle: "サブPC上のセッション表示",
      state: "ALIVE",
      exitStatus: null,
      firstSeenAt: NOW.toISOString(),
      lastReportedAt: NOW.toISOString(),
      activity: null,
      activityAt: null,
      remoteControlUrl: null,
      previewUrl: null,
      ...overrides,
    };
  }

  function openWithHost(host: DispatchHostView, sessions: DispatchSessionView[]) {
    const dispatch = { ...makeDispatch([]), hosts: [host], sessions } as DispatchStateHandle;
    render(<DispatchQueueButton dispatch={dispatch} />);
    fireEvent.click(screen.getByLabelText("実行キュー"));
  }

  it("使用率と動いているセッションをキューと同じ場所に出す", () => {
    openWithHost(
      makeHost({
        liveSessions: 1,
        metrics: {
          cpuPercent: 34,
          memoryUsedMb: 12_698,
          memoryTotalMb: 32_650,
          diskUsedGb: 219.4,
          diskTotalGb: 468.2,
          swapUsedMb: 1_024,
          swapTotalMb: 8_192,
        },
      }),
      [makeSession()],
    );

    expect(screen.getByText("サブPC")).toBeTruthy();
    expect(screen.getByText("セッション 1/12")).toBeTruthy();
    expect(screen.getByText("34%")).toBeTruthy();
    expect(screen.getByText("#1567 サブPC上のセッション表示")).toBeTruthy();
  });

  // 同じ「実行」でも経路が別で、出ていないことを止まっていると読まれないようにする
  it("GitHub Actionsの無人実行はここに出ないことを但し書きで出す", () => {
    openWithHost(makeHost(), []);

    expect(screen.getByText(/GitHub Actionsでの無人実行はここには出ません/)).toBeTruthy();
  });
});
