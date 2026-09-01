import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDeployLaunchPushPayload } from "@/lib/github/deploy-launch-sweep-run";
import { GithubApiError } from "@/lib/github/github-api-error";

/**
 * 巡回そのものの確認。**判定（`deploy-launch.ts`）ではなく、判定の結果として実際に
 * 「起動し直したか」「PRへ書いたか」「行をどの状態で畳んだか」を見る。**
 * 起動という取り消しの効かない副作用を持つので、起動しない条件のほうを厚く確かめる。
 */

const dispatchDeployWorkflow = vi.fn();
const fetchRecentDeployWorkflowRuns = vi.fn();
const fetchCommitTreeSha = vi.fn();
const createComment = vi.fn();
const deployWorkflowExists = vi.fn();
const sendPushNotification = vi.fn();

/** DBの代わり。`deployLaunchWatch`の行を配列で持ち、更新は行へ書き戻す */
type WatchRow = {
  id: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  mergeCommitSha: string;
  mergedAt: Date;
  state: string;
  attempts: number;
  resolvedAt: Date | null;
  checkedAt: Date | null;
  runUrl: string | null;
};

let watches: WatchRow[] = [];
let repositoryRow: unknown = null;

vi.mock("@/lib/db", () => ({
  db: {
    deployLaunchWatch: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => watches.filter((row) => row.state === "pending")),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = watches.find((item) => item.id === where.id);
        if (!row) throw new Error("row not found");
        for (const [key, value] of Object.entries(data)) {
          if (key === "attempts" && typeof value === "object" && value !== null) {
            row.attempts += (value as { increment: number }).increment;
            continue;
          }
          (row as unknown as Record<string, unknown>)[key] = value;
        }
        return row;
      }),
    },
    repository: { findFirst: vi.fn(async () => repositoryRow) },
    pushSubscription: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "token") }));
vi.mock("@/lib/github/deploy-workflow-cache", () => ({
  deployWorkflowExists: (...args: unknown[]) => deployWorkflowExists(...args),
}));
vi.mock("@/lib/github/release-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchDeployWorkflow: (...args: unknown[]) => dispatchDeployWorkflow(...args),
  fetchRecentDeployWorkflowRuns: (...args: unknown[]) => fetchRecentDeployWorkflowRuns(...args),
  fetchCommitTreeSha: (...args: unknown[]) => fetchCommitTreeSha(...args),
}));
vi.mock("@/lib/github/issues-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createComment: (...args: unknown[]) => createComment(...args),
}));
vi.mock("@/lib/notifications/push", () => ({
  isPushConfigured: () => true,
  sendPushNotification: (...args: unknown[]) => sendPushNotification(...args),
}));

const { runDeployLaunchSweep } = await import("@/lib/github/deploy-launch-sweep-run");

const REPO = "guchi-apps/myroom";
const SHA = "db53cd2aa11223344556677889900aabbccddeef";

function seed(mergedAtOffsetMs: number, overrides: Partial<WatchRow> = {}): WatchRow {
  const row: WatchRow = {
    id: "watch-1",
    repositoryFullName: REPO,
    pullRequestNumber: 312,
    pullRequestTitle: "v4.8.0をリリースする。",
    mergeCommitSha: SHA,
    mergedAt: new Date(Date.now() - mergedAtOffsetMs),
    state: "pending",
    attempts: 0,
    resolvedAt: null,
    checkedAt: null,
    runUrl: null,
    ...overrides,
  };
  watches = [row];
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  watches = [];
  repositoryRow = {
    id: "repo-1",
    ownerLogin: "guchi-apps",
    name: "myroom",
    installationId: "inst-1",
    installation: { installationId: 900000001 },
  };
  // **`clearAllMocks`は呼び出し履歴しか消さない。** 実装（`mockRejectedValue`）は残るので、
  // 失敗を仕込むモックは毎回`mockReset`してから既定へ戻す。
  dispatchDeployWorkflow.mockReset();
  dispatchDeployWorkflow.mockResolvedValue(undefined);
  createComment.mockReset();
  createComment.mockResolvedValue({});
  sendPushNotification.mockReset();
  sendPushNotification.mockResolvedValue({ sent: 0, removed: 0, failed: 0 });
  deployWorkflowExists.mockResolvedValue(true);
  fetchCommitTreeSha.mockResolvedValue(null);
  fetchRecentDeployWorkflowRuns.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runDeployLaunchSweep", () => {
  it("見張っている行が無ければGitHubを1回も叩かない", async () => {
    const result = await runDeployLaunchSweep();

    expect(result).toMatchObject({ swept: true, watching: 0, actions: [] });
    expect(deployWorkflowExists).not.toHaveBeenCalled();
    expect(fetchRecentDeployWorkflowRuns).not.toHaveBeenCalled();
  });

  it("猶予（0秒）で無効にしていれば何もしない", async () => {
    vi.stubEnv("DEPLOY_LAUNCH_GRACE_SECONDS", "0");
    seed(300_000);

    const result = await runDeployLaunchSweep();

    expect(result).toMatchObject({ swept: false, disabled: true });
    expect(fetchRecentDeployWorkflowRuns).not.toHaveBeenCalled();
  });

  it("猶予の中は起動せず、pendingのまま次の巡回へ残す", async () => {
    const row = seed(10_000);

    const result = await runDeployLaunchSweep();

    expect(dispatchDeployWorkflow).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
    expect(row.state).toBe("pending");
    expect(row.checkedAt).not.toBeNull();
  });

  it("マージコミットの実行が見つかれば、起動せずcoveredで畳む", async () => {
    const row = seed(300_000);
    fetchRecentDeployWorkflowRuns.mockResolvedValue([
      {
        id: 1,
        htmlUrl: "https://github.com/guchi-apps/myroom/actions/runs/1",
        createdAt: new Date().toISOString(),
        event: "push",
        headSha: SHA,
        headBranch: "main",
        headTreeSha: "t1",
      },
    ]);

    const result = await runDeployLaunchSweep();

    expect(dispatchDeployWorkflow).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(result.actions[0]).toMatchObject({ kind: "covered" });
    expect(row.state).toBe("covered");
    expect(row.runUrl).toBe("https://github.com/guchi-apps/myroom/actions/runs/1");
  });

  it("猶予を過ぎて実行が無ければ、mainから起動し直してPRへ残す（myroom#315の状況）", async () => {
    const row = seed(300_000);

    const result = await runDeployLaunchSweep();

    // `dispatchDeployWorkflow`は`ref: "main"`固定。リリースブランチのrefから起動すると
    // `tag`ジョブが`v<version>`をmain上に無いコミットへ付けてしまうため（myroom#315）。
    expect(dispatchDeployWorkflow).toHaveBeenCalledWith("guchi-apps", "myroom", "token");
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment.mock.calls[0]?.[4]?.body).toContain("起動し直しました");
    expect(sendPushNotification).not.toHaveBeenCalled(); // 宛先が0件なら送らない
    expect(result.actions[0]).toMatchObject({ kind: "dispatched" });
    expect(row.state).toBe("dispatched");
    // **起動する前に試行を数える**（この後で落ちても無限に起動し直さない）
    expect(row.attempts).toBe(1);
  });

  it("treeが一致すれば、猶予を過ぎていても起動しない", async () => {
    const row = seed(300_000);
    fetchRecentDeployWorkflowRuns.mockResolvedValue([
      {
        id: 2,
        htmlUrl: "https://github.com/guchi-apps/myroom/actions/runs/2",
        createdAt: new Date(Date.now() - 900_000).toISOString(),
        event: "workflow_dispatch",
        headSha: "0000000000000000000000000000000000000000",
        headBranch: "release-main/v4.8.0",
        headTreeSha: "same-tree",
      },
    ]);
    fetchCommitTreeSha.mockResolvedValue("same-tree");

    const result = await runDeployLaunchSweep();

    expect(dispatchDeployWorkflow).not.toHaveBeenCalled();
    expect(result.actions[0]).toMatchObject({ kind: "covered" });
    expect(row.state).toBe("covered");
  });

  it("deploy.ymlを持たないリポジトリは、GitHubを叩かずunsupportedで畳む", async () => {
    const row = seed(300_000);
    deployWorkflowExists.mockResolvedValue(false);

    const result = await runDeployLaunchSweep();

    expect(fetchRecentDeployWorkflowRuns).not.toHaveBeenCalled();
    expect(result.actions[0]).toMatchObject({ kind: "unsupported" });
    expect(row.state).toBe("unsupported");
  });

  it("workflow_dispatchに未対応（422）なら、鳴らさずunsupportedで畳む", async () => {
    const row = seed(300_000);
    dispatchDeployWorkflow.mockRejectedValue(new GithubApiError(422, "Unexpected inputs provided"));

    const result = await runDeployLaunchSweep();

    expect(createComment).not.toHaveBeenCalled();
    expect(result.actions[0]).toMatchObject({ kind: "unsupported" });
    expect(row.state).toBe("unsupported");
  });

  it("起動に失敗したら、押す場所を書いたコメントを残してfailedで畳む", async () => {
    const row = seed(300_000);
    dispatchDeployWorkflow.mockRejectedValue(new GithubApiError(403, "Forbidden"));

    const result = await runDeployLaunchSweep();

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment.mock.calls[0]?.[4]?.body).toContain("--ref main");
    expect(result.actions[0]).toMatchObject({ kind: "failed" });
    expect(row.state).toBe("failed");
  });

  it("試行回数を使い切ったら、起動を試さずfailedで畳む", async () => {
    const row = seed(300_000, { attempts: 3 });

    const result = await runDeployLaunchSweep();

    expect(dispatchDeployWorkflow).not.toHaveBeenCalled();
    expect(result.actions[0]).toMatchObject({ kind: "failed" });
    expect(row.state).toBe("failed");
  });

  it("連携が外れたリポジトリの見張りは、トークンを取りに行かずに畳む", async () => {
    const row = seed(300_000);
    repositoryRow = null;

    const result = await runDeployLaunchSweep();

    expect(deployWorkflowExists).not.toHaveBeenCalled();
    expect(result.actions[0]).toMatchObject({ kind: "unsupported" });
    expect(row.state).toBe("unsupported");
  });

  it("コメント投稿が落ちても、起動し直した事実は残す", async () => {
    const row = seed(300_000);
    createComment.mockRejectedValue(new Error("403"));

    const result = await runDeployLaunchSweep();

    expect(result.actions[0]).toMatchObject({ kind: "dispatched" });
    expect(row.state).toBe("dispatched");
  });
});

describe("buildDeployLaunchPushPayload", () => {
  it("1行目でリポジトリと何をしたか、2行目でどのPRかが分かる", () => {
    const payload = buildDeployLaunchPushPayload({
      repositoryFullName: REPO,
      pullRequestNumber: 312,
      pullRequestTitle: "v4.8.0をリリースする。",
      kind: "dispatched",
    });

    expect(payload.title).toBe("myroom ・ デプロイを起動し直しました");
    expect(payload.body).toBe("#312 v4.8.0をリリースする。");
    expect(payload.url).toContain("pane=pull-requests");
    expect(payload.tag).toBe("deploy-launch:guchi-apps/myroom#312");
  });

  it("起動できなかったときは文言を変える", () => {
    const payload = buildDeployLaunchPushPayload({
      repositoryFullName: REPO,
      pullRequestNumber: 312,
      pullRequestTitle: "v4.8.0をリリースする。",
      kind: "failed",
    });

    expect(payload.title).toBe("myroom ・ デプロイを起動できません");
  });
});
