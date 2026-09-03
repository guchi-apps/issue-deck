import { parseClaudeLocalModel } from "@/lib/app-settings";
import { db } from "@/lib/db";
import { readDispatchAgent } from "@/lib/dispatch/dispatch-job";
import { enqueueDispatchJob } from "@/lib/dispatch/jobs";
import { addIssueLabels, fetchIssueLabelNames, fetchIssueState } from "@/lib/github/issues-api";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";
import {
  NIGHTLY_RUN_RESULT_RETENTION_DAYS,
  decideNightlyRunLaunch,
  describeNightlyRunWindowMissed,
  resolveNightlyRunWindow,
} from "@/lib/nightly-run";
import { readNightlyRunSettings } from "@/lib/nightly-run-db";

/**
 * 「今夜の夜間実行」に積んだIssueを、時刻が来たら起動ジョブへ変換する（#2772）。
 *
 * **進めるための常駐プロセスは置かない**（`expireStaleDispatchJobs`・巡回2本と同じ方針）。
 * 呼ぶのはサブPCのpollerが30秒ごとに叩く`POST /api/dispatch/claim`で、**ブラウザを開いて
 * いなくても回る唯一の定期経路**（確認待ちPushの巡回と同じ相乗り）。時刻の判定はサーバー側の
 * 純関数（`resolveNightlyRunWindow`）が持ち、pollerは何も知らない。
 *
 * **起動先はclaimしてきたホストの予定だけ。** 積むときにホストを決めてあるので、そのホストが
 * 取りに来た巡回で変換すれば、直後の払い出しでそのまま起動へ回る。他のホストの予定は触らない。
 *
 * 1件ずつの手順は「実装を開始」ダイアログ・「次にやること」（`enqueue-issue.ts`）と同じ順:
 * 実ラベルを読んで判定 → `enqueueDispatchJob` → 積めたときだけ`11.local`。オプションのラベルは
 * 積んだ時点で付けてある（`POST /api/nightly-run`）。
 *
 * GitHubへの読み書きは**積んだ人のトークン**で行う（`withUserGithubToken`）。ラベルの付与を
 * 人の操作として残すためで、インストールトークンにすると`issue-deck[bot]`が着手したように見える。
 * トークンが切れていれば見送りとして朝に出す（黙って起動しない）。
 */

export type NightlyRunLaunchAction = {
  entryId: string;
  repositoryFullName: string;
  issueNumber: number;
  result: "launched" | "skipped" | "deferred";
  detail: string | null;
};

export type NightlyRunLaunchResult = {
  enabled: boolean;
  isOpen: boolean;
  nightKey: string;
  actions: NightlyRunLaunchAction[];
};

/** 積めなかったが、次の巡回でやり直せば通りうる理由（ホストの都合・自分が先に積んだジョブ） */
const RETRYABLE_REJECTIONS: readonly string[] = ["host_unknown", "host_offline", "already_queued"];

async function pruneOldEntries(now: Date): Promise<void> {
  const before = new Date(now.getTime() - NIGHTLY_RUN_RESULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await db.nightlyRunEntry.deleteMany({
    where: { status: { in: ["LAUNCHED", "SKIPPED", "CANCELED"] }, resolvedAt: { lt: before } },
  });
}

async function markSkipped(entryId: string, nightKey: string, reason: string, now: Date): Promise<void> {
  await db.nightlyRunEntry.update({
    where: { id: entryId },
    data: { status: "SKIPPED", nightKey, skipReason: reason, activeKey: null, resolvedAt: now },
  });
}

export async function launchNightlyRunEntries(params: {
  hostName: string;
  now?: Date;
}): Promise<NightlyRunLaunchResult> {
  const now = params.now ?? new Date();
  const settings = await readNightlyRunSettings();
  const window = resolveNightlyRunWindow(now, settings.startHour);
  const result: NightlyRunLaunchResult = {
    enabled: settings.enabled,
    isOpen: window.isOpen,
    nightKey: window.nightKey,
    actions: [],
  };

  await pruneOldEntries(now);
  // OFFのあいだは予定を残したまま何もしない（窓を過ぎた見送りも付けない。ONにした夜に走る）
  if (!settings.enabled) return result;

  const entries = await db.nightlyRunEntry.findMany({
    where: { status: "QUEUED", targetHost: params.hostName },
    orderBy: { createdAt: "asc" },
  });
  if (entries.length === 0) return result;

  if (!window.isOpen) {
    // 直近の窓が閉じた後。**窓が閉じる前から積んであった予定**は起動できなかったものとして
    // 見送る（サブPCが応答していなかった等）。窓が閉じた後に積んだものは今夜の予定なので残す
    for (const entry of entries) {
      if (entry.createdAt.getTime() >= window.endsAt.getTime()) continue;
      await markSkipped(entry.id, window.nightKey, describeNightlyRunWindowMissed(settings.startHour), now);
      result.actions.push({
        entryId: entry.id,
        repositoryFullName: entry.repositoryFullName,
        issueNumber: entry.issueNumber,
        result: "skipped",
        detail: describeNightlyRunWindowMissed(settings.startHour),
      });
    }
    return result;
  }

  for (const entry of entries) {
    // **席を取る**（`reserveCheckUserPush`と同じ）。claimは同時に何本も来うるので、
    // `nightKey`を入れられた1本だけが処理する
    const reserved = await db.nightlyRunEntry.updateMany({
      where: { id: entry.id, status: "QUEUED", nightKey: null },
      data: { nightKey: window.nightKey },
    });
    if (reserved.count === 0) continue;

    const action: NightlyRunLaunchAction = {
      entryId: entry.id,
      repositoryFullName: entry.repositoryFullName,
      issueNumber: entry.issueNumber,
      result: "skipped",
      detail: null,
    };
    result.actions.push(action);

    const user = entry.requestedByUserId
      ? await db.user.findUnique({
          where: { id: entry.requestedByUserId },
          select: { id: true, githubAccessToken: true, githubRefreshToken: true },
        })
      : null;
    if (!user) {
      action.detail = "積んだユーザーの情報が見つかりません";
      await markSkipped(entry.id, window.nightKey, action.detail, now);
      continue;
    }

    const [owner, repo] = entry.repositoryFullName.split("/");
    const fetched = await withUserGithubToken(user, "[nightly-run]", async (token) => {
      const state = await fetchIssueState(owner, repo, entry.issueNumber, token);
      const labels = state === null ? [] : await fetchIssueLabelNames(owner, repo, entry.issueNumber, token);
      return { state, labels };
    });
    const decision = decideNightlyRunLaunch({
      issueState: "value" in fetched ? fetched.value.state : null,
      labels: "value" in fetched ? fetched.value.labels.map((name) => ({ name })) : [],
    });
    if (decision.action === "skip") {
      action.detail = decision.reason;
      await markSkipped(entry.id, window.nightKey, decision.reason, now);
      continue;
    }

    const enqueued = await enqueueDispatchJob({
      repositoryFullName: entry.repositoryFullName,
      issueNumber: entry.issueNumber,
      hostName: params.hostName,
      agent: readDispatchAgent(entry.agent),
      claudeModel: parseClaudeLocalModel(entry.claudeModel),
      requestedByUserId: entry.requestedByUserId,
      now,
    });
    if (!enqueued.ok) {
      if (RETRYABLE_REJECTIONS.includes(enqueued.rejection)) {
        // 次の巡回でやり直す。席を戻し、窓が閉じるまで残す（閉じたら上の分岐で見送りになる）
        await db.nightlyRunEntry.updateMany({
          where: { id: entry.id, status: "QUEUED" },
          data: { nightKey: null },
        });
        action.result = "deferred";
        action.detail = enqueued.message;
        // ホストの都合なら残りも同じ理由で通らない。次の巡回へ回す
        if (enqueued.rejection !== "already_queued") break;
        continue;
      }
      action.detail = enqueued.message;
      await markSkipped(entry.id, window.nightKey, enqueued.message, now);
      continue;
    }

    // `11.local`は**積めたときだけ**付ける（`enqueue-issue.ts`と同じ）。付与に失敗しても
    // 起動自体は妨げない（起動できないより、ラベルが遅れる方が軽い）
    const labeled = await withUserGithubToken(user, "[nightly-run]", (token) =>
      addIssueLabels(owner, repo, entry.issueNumber, token, [LOCAL_LABEL_NAME]),
    );
    if (!("value" in labeled)) {
      console.error(
        `[nightly-run] ${entry.repositoryFullName}#${entry.issueNumber}: ${LOCAL_LABEL_NAME}を付けられませんでした`,
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
  }

  return result;
}
