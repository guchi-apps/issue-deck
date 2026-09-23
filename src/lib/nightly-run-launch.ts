import { parseClaudeLocalModel, parseCodexLocalModel } from "@/lib/app-settings";
import { db } from "@/lib/db";
import { readDispatchAgent } from "@/lib/dispatch/dispatch-job";
import { enqueueDispatchJob } from "@/lib/dispatch/jobs";
import { addIssueLabels, fetchIssueLabelNames, fetchIssueState } from "@/lib/github/issues-api";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";
import {
  NIGHTLY_RUN_RESULT_RETENTION_DAYS,
  decideManualStartCancel,
  decideNightlyRunLaunch,
  type ScheduledRunKind,
} from "@/lib/nightly-run";
import { nightlyRunIssueKey } from "@/lib/nightly-run-db";

/**
 * 積んだ予定（`NightlyRunEntry`）を、時刻が来たら起動ジョブへ変換する（#2995）。
 *
 * **進めるための常駐プロセスは置かない**（`expireStaleDispatchJobs`・巡回2本と同じ方針）。
 * 呼ぶのはサブPCのpollerが30秒ごとに叩く`POST /api/dispatch/claim`で、**ブラウザを開いて
 * いなくても回る唯一の定期経路**（確認待ちPushの巡回と同じ相乗り）。時刻の判定はサーバー側の
 * 純関数（`resolveNextWindowRunWindow`）が持ち、pollerは何も知らない。
 *
 * **起動先はclaimしてきたホストの予定だけ。** 積むときにホストを決めてあるので、そのホストが
 * 取りに来た巡回で変換すれば、直後の払い出しでそのまま起動へ回る。他のホストの予定は触らない。
 *
 * 1件ずつの手順は「実装を開始」ダイアログと同じ順:
 * 実ラベルを読んで判定 → `enqueueDispatchJob` → 積めたときだけ`11.local`。オプションのラベルは
 * 積んだ時点で付けてある（`POST /api/nightly-run`）。**この1件ぶんの手順は
 * `launchScheduledRunEntry`に寄せてある**（かつては夜間実行とも共有していたが#3019で削除した。
 * `kind`引数は残っているが渡ってくるのは`NEXT_WINDOW`だけになった）。
 *
 * GitHubへの読み書きは**積んだ人のトークン**で行う（`withUserGithubToken`）。ラベルの付与を
 * 人の操作として残すためで、インストールトークンにすると`issue-deck[bot]`が着手したように見える。
 * 期限切れ（401）はリフレッシュトークンで延長して再試行し、延長にも失敗したときだけ見送りとして
 * 残す（黙って起動しない）。GitHub Appのユーザートークンは8時間で切れるので、延長できないと
 * 画面を触らない時間帯の起動が必ず見送りになる（#3148）。
 */

export type NightlyRunLaunchAction = {
  entryId: string;
  repositoryFullName: string;
  issueNumber: number;
  result: "launched" | "skipped" | "deferred";
  detail: string | null;
};

/**
 * 積めなかったが、次の巡回でやり直せば通りうる理由（ホストの都合・自分が先に積んだジョブ）。
 *
 * `agent_paused`（#2994）もここに含める。エージェントの一時停止は3時間の窓の中でトグルが
 * ONに戻る／枠が回復することがあり、`SKIPPED`（見送り）に確定させると窓の残り時間で
 * 再挑戦する機会を失う。
 */
const RETRYABLE_REJECTIONS: readonly string[] = [
  "host_unknown",
  "host_offline",
  "already_queued",
  "agent_paused",
];

/** 起動処理が1件ぶん読む列。Prismaの行をそのまま渡せる形にしてある */
export type ScheduledRunEntryRow = {
  id: string;
  repositoryFullName: string;
  issueNumber: number;
  agent: string;
  claudeModel: string | null;
  /** #3192。省略可なのは、この列を知らない呼び出し元・テストの値を壊さないため */
  codexModel?: string | null;
  requestedByUserId: string | null;
};

export async function pruneOldScheduledRunEntries(now: Date): Promise<void> {
  const before = new Date(now.getTime() - NIGHTLY_RUN_RESULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await db.nightlyRunEntry.deleteMany({
    where: { status: { in: ["LAUNCHED", "SKIPPED", "CANCELED"] }, resolvedAt: { lt: before } },
  });
}

/**
 * 積んだ後に手動で実装開始されたIssueの予定を取り消す（#3274）。
 *
 * 予約実行の画面は`QUEUED`・`LAUNCHED`・`SKIPPED`しか描かないので、`CANCELED`にすれば画面から
 * 消える（行は理由付きで残り、`pruneOldScheduledRunEntries`が30日で掃除する）。判定は
 * `decideManualStartCancel`。GitHubへは問い合わせず、**DBに同期済みのラベルと起動ジョブ**だけを
 * 読む（次枠実行がOFFでも回すため、積んだ人のトークンに依存させない）。
 *
 * **`nightKey`が入っている予定は触らない。** 起動処理が席を取った後（自分で作るジョブ・
 * `11.local`を手動着手と取り違える）で、`updateMany`の条件にも同じ`nightKey: null`を置いて、
 * 判定と書き込みのあいだに席を取られた場合も取り消さない。
 *
 * **積む口（`POST /api/nightly-run`）は`11.local`付きのIssueを409で断る**（#3366）ので、
 * ここで見る`11.local`は積んだ後に付いたものだけのはず。積む前から付いていたケースが紛れ込むのは
 * 積む口の判定が漏れたときだけで、この関数はその場合の保険にはならない（積む前から付いていたのか
 * 積んだ後に付いたのかを区別する情報を持たないため）。
 *
 * @returns 取り消した予定の件数
 */
export async function cancelManuallyStartedScheduledRuns(now: Date): Promise<number> {
  const entries = await db.nightlyRunEntry.findMany({
    where: { status: "QUEUED", nightKey: null },
    select: { id: true, repositoryFullName: true, issueNumber: true, createdAt: true },
  });
  if (entries.length === 0) return 0;

  const targets = entries.map((entry) => ({
    repositoryFullName: entry.repositoryFullName,
    issueNumber: entry.issueNumber,
  }));
  // ジョブの絞り込みは最も古い予定より後で足りる（Issueごとの厳密な比較は下でメモリ上で行う）
  const oldestQueuedAt = new Date(Math.min(...entries.map((entry) => entry.createdAt.getTime())));
  const [issues, jobs] = await Promise.all([
    db.issue.findMany({
      where: {
        OR: targets.map((target) => ({
          number: target.issueNumber,
          repository: { fullName: target.repositoryFullName },
        })),
      },
      select: {
        number: true,
        labels: { select: { name: true } },
        repository: { select: { fullName: true } },
      },
    }),
    db.dispatchJob.findMany({
      where: {
        kind: "LAUNCH",
        // 失敗・タイムアウト・取り消しで終わったものは、実際には着手されていない
        status: { in: ["QUEUED", "CLAIMED", "RUNNING", "SUCCEEDED"] },
        createdAt: { gt: oldestQueuedAt },
        OR: targets.map((target) => ({
          repositoryFullName: target.repositoryFullName,
          issueNumber: target.issueNumber,
        })),
      },
      select: { repositoryFullName: true, issueNumber: true, createdAt: true },
    }),
  ]);

  const labelsByIssue = new Map(
    issues.map((issue) => [nightlyRunIssueKey(issue.repository.fullName, issue.number), issue.labels]),
  );

  let canceled = 0;
  for (const entry of entries) {
    const key = nightlyRunIssueKey(entry.repositoryFullName, entry.issueNumber);
    const reason = decideManualStartCancel({
      labels: labelsByIssue.get(key) ?? [],
      hasLaunchJobSinceQueued: jobs.some(
        (job) =>
          nightlyRunIssueKey(job.repositoryFullName, job.issueNumber) === key &&
          job.createdAt > entry.createdAt,
      ),
    });
    if (reason === null) continue;
    const result = await db.nightlyRunEntry.updateMany({
      where: { id: entry.id, status: "QUEUED", nightKey: null },
      data: { status: "CANCELED", skipReason: reason, activeKey: null, resolvedAt: now },
    });
    canceled += result.count;
  }
  return canceled;
}

export async function markScheduledRunSkipped(
  entryId: string,
  runKey: string,
  reason: string,
  now: Date,
): Promise<void> {
  await db.nightlyRunEntry.update({
    where: { id: entryId },
    data: { status: "SKIPPED", nightKey: runKey, skipReason: reason, activeKey: null, resolvedAt: now },
  });
}

/**
 * 予定1件を起動ジョブへ変換する。**窓が開いているかの判定は呼び出し側**（種類ごとに違う）で、
 * ここは「開いている前提で1件を処理する」だけを持つ。
 *
 * 返り値の`stop`が`true`のときは、そのホストの残りの予定も同じ理由で通らないので、この巡回では
 * 打ち切る（`already_queued`＝自分が先に積んだジョブのときだけは次の予定へ進む）。
 * `reserved`が`false`のときは、同時に走った別の巡回が先に掴んだので何もしていない。
 */
export async function launchScheduledRunEntry(params: {
  entry: ScheduledRunEntryRow;
  kind: ScheduledRunKind;
  runKey: string;
  hostName: string;
  now: Date;
}): Promise<{ reserved: boolean; action: NightlyRunLaunchAction | null; stop: boolean }> {
  const { entry, kind, runKey, hostName, now } = params;

  // **席を取る**（`reserveCheckUserPush`と同じ）。claimは同時に何本も来うるので、
  // `nightKey`を入れられた1本だけが処理する
  const reserved = await db.nightlyRunEntry.updateMany({
    where: { id: entry.id, status: "QUEUED", nightKey: null },
    data: { nightKey: runKey },
  });
  if (reserved.count === 0) return { reserved: false, action: null, stop: false };

  const action: NightlyRunLaunchAction = {
    entryId: entry.id,
    repositoryFullName: entry.repositoryFullName,
    issueNumber: entry.issueNumber,
    result: "skipped",
    detail: null,
  };
  const logTag = kind === "NEXT_WINDOW" ? "[next-window-run]" : "[nightly-run]";

  const user = entry.requestedByUserId
    ? await db.user.findUnique({
        where: { id: entry.requestedByUserId },
        select: { id: true, githubAccessToken: true, githubRefreshToken: true },
      })
    : null;
  if (!user) {
    action.detail = "積んだユーザーの情報が見つかりません";
    await markScheduledRunSkipped(entry.id, runKey, action.detail, now);
    return { reserved: true, action, stop: false };
  }

  const [owner, repo] = entry.repositoryFullName.split("/");
  const fetched = await withUserGithubToken(user, logTag, async (token) => {
    const state = await fetchIssueState(owner, repo, entry.issueNumber, token);
    const labels = state === null ? [] : await fetchIssueLabelNames(owner, repo, entry.issueNumber, token);
    return { state, labels };
  });
  const decision = decideNightlyRunLaunch({
    issueState: "value" in fetched ? fetched.value.state : null,
    labels: "value" in fetched ? fetched.value.labels.map((name) => ({ name })) : [],
    kind,
    // 失敗の中身は`withUserGithubToken`が返すステータスで見分ける（409＝延長にも失敗・
    // トークンはクリア済み／502＝それ以外のAPIエラー）
    fetchFailure:
      "value" in fetched ? null : fetched.errorResponse.status === 409 ? "reauth_required" : "api_error",
  });
  if (decision.action === "skip") {
    action.detail = decision.reason;
    await markScheduledRunSkipped(entry.id, runKey, decision.reason, now);
    return { reserved: true, action, stop: false };
  }

  const enqueued = await enqueueDispatchJob({
    repositoryFullName: entry.repositoryFullName,
    issueNumber: entry.issueNumber,
    hostName,
    agent: readDispatchAgent(entry.agent),
    claudeModel: parseClaudeLocalModel(entry.claudeModel),
    codexModel: parseCodexLocalModel(entry.codexModel),
    requestedByUserId: entry.requestedByUserId,
    now,
  });
  if (!enqueued.ok) {
    if (RETRYABLE_REJECTIONS.includes(enqueued.rejection)) {
      // 次の巡回でやり直す。席を戻し、窓が閉じるまで残す（閉じたら呼び出し側が見送りにする）
      await db.nightlyRunEntry.updateMany({
        where: { id: entry.id, status: "QUEUED" },
        data: { nightKey: null },
      });
      action.result = "deferred";
      action.detail = enqueued.message;
      // ホストの都合なら残りも同じ理由で通らない。次の巡回へ回す
      return { reserved: true, action, stop: enqueued.rejection !== "already_queued" };
    }
    action.detail = enqueued.message;
    await markScheduledRunSkipped(entry.id, runKey, enqueued.message, now);
    return { reserved: true, action, stop: false };
  }

  // `11.local`は**積めたときだけ**付ける（「実装を開始」ダイアログと同じ）。付与に失敗しても
  // 起動自体は妨げない（起動できないより、ラベルが遅れる方が軽い）。
  // **トークンは読み直す**（#3148）。上の取得で延長していれば`user`の値は古く、そのまま渡すと
  // 401→ローテーション済みのリフレッシュトークンでの延長失敗→DB再読込、と毎回遠回りする
  const latestUser =
    (await db.user.findUnique({
      where: { id: user.id },
      select: { id: true, githubAccessToken: true, githubRefreshToken: true },
    })) ?? user;
  const labeled = await withUserGithubToken(latestUser, logTag, (token) =>
    addIssueLabels(owner, repo, entry.issueNumber, token, [LOCAL_LABEL_NAME]),
  );
  if (!("value" in labeled)) {
    console.error(
      `${logTag} ${entry.repositoryFullName}#${entry.issueNumber}: ${LOCAL_LABEL_NAME}を付けられませんでした`,
    );
  }

  await db.nightlyRunEntry.update({
    where: { id: entry.id },
    data: {
      status: "LAUNCHED",
      dispatchJobId: enqueued.job.id,
      activeKey: null,
      resolvedAt: now,
    },
  });
  action.result = "launched";
  action.detail = `ジョブ ${enqueued.job.id}`;
  return { reserved: true, action, stop: false };
}

