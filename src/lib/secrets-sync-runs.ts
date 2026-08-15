import type { SecretSyncRun } from "@prisma/client";

import { db } from "@/lib/db";
import { SECRETS_SYNC_TIMEOUT_MS, type SecretSyncRunView } from "@/lib/secrets-sync";

/**
 * シークレット同期の実行履歴（`SecretSyncRun`）に触る処理（#1309）。
 *
 * 判断そのもの（起動してよいか・画面に何と出すか）は`src/lib/secrets-sync.ts`の純粋関数が持つ。
 * こちらはDBとの往復だけを引き受ける。
 */

export function toSecretSyncRunView(run: SecretSyncRun): SecretSyncRunView {
  return {
    id: run.id,
    repositoryFullName: run.repositoryFullName,
    only: run.only,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    syncedCount: run.syncedCount,
    skippedCount: run.skippedCount,
    failedCount: run.failedCount,
    // 空文字を`split`すると`[""]`になり、画面に空の項目名が並ぶ
    failedKeys: run.failedKeys === "" ? [] : run.failedKeys.split(","),
    runUrl: run.runUrl,
    message: run.message,
  };
}

/**
 * 報告が来ないまま放置された実行をTIMEOUTへ倒す。
 *
 * **定期実行は持たない。** 一覧取得・起動のたびに呼ぶ遅延評価で、`expireStaleDispatchJobs`と
 * 同じ形にしている（常駐プロセスを増やさないため）。倒さないと、報告が届かなかった1回で
 * そのリポジトリが「実行中」のまま固まり、二度と押せなくなる。
 */
export async function expireStaleSecretSyncRuns(now: Date = new Date()): Promise<void> {
  await db.secretSyncRun.updateMany({
    where: { status: "QUEUED", startedAt: { lt: new Date(now.getTime() - SECRETS_SYNC_TIMEOUT_MS) } },
    data: {
      status: "TIMEOUT",
      finishedAt: now,
      message:
        "GitHub Actionsからの結果報告がありませんでした。Actionsの実行ログを確認してください。",
    },
  });
}

/** リポジトリごとの最新の実行。画面の一覧とクールダウン判定が同じものを見る */
export async function findLatestSecretSyncRuns(
  repositoryFullNames: string[],
): Promise<Record<string, SecretSyncRunView>> {
  if (repositoryFullNames.length === 0) return {};

  const runs = await db.secretSyncRun.findMany({
    where: { repositoryFullName: { in: repositoryFullNames } },
    orderBy: { startedAt: "desc" },
    // リポジトリごとに1件へ絞るのはSQLでは書きにくいため、十分な件数を取ってから畳む。
    // 対象は最大でもリポジトリ数（現在16件）なので、その数倍で足りる
    take: repositoryFullNames.length * 5,
  });

  const latest: Record<string, SecretSyncRunView> = {};
  for (const run of runs) {
    if (latest[run.repositoryFullName]) continue;
    latest[run.repositoryFullName] = toSecretSyncRunView(run);
  }
  return latest;
}

export async function findLatestSecretSyncRun(
  repositoryFullName: string,
): Promise<SecretSyncRunView | null> {
  const run = await db.secretSyncRun.findFirst({
    where: { repositoryFullName },
    orderBy: { startedAt: "desc" },
  });
  return run ? toSecretSyncRunView(run) : null;
}

export async function createQueuedSecretSyncRun(params: {
  repositoryFullName: string;
  only: string;
  requestedByUserId: string;
}): Promise<SecretSyncRunView> {
  const run = await db.secretSyncRun.create({
    data: {
      repositoryFullName: params.repositoryFullName,
      only: params.only,
      requestedByUserId: params.requestedByUserId,
      failedKeys: "",
    },
  });
  return toSecretSyncRunView(run);
}

/** 起動そのものに失敗した場合（ワークフローが未配布など）。押した側に理由を残す */
export async function failSecretSyncRun(id: string, message: string): Promise<void> {
  await db.secretSyncRun.update({
    where: { id },
    data: { status: "FAILED", finishedAt: new Date(), message },
  });
}

export type SecretsSyncReport = {
  repositoryFullName: string;
  runUrl: string | null;
  only: string;
  succeeded: boolean;
  synced: number;
  skipped: number;
  failed: number;
  /** 失敗した項目の**名前だけ**。値・値の長さは受け取らない */
  failedKeys: string[];
  /** 件数だけでは何が起きたか分からない場合の補足（同期処理が始まる前に落ちた場合など） */
  message: string | null;
};

/**
 * 対象リポジトリのActionsからの結果報告を書き込む。
 *
 * **突き合わせは「そのリポジトリの未完了の実行」で行い、照合用のnonceは使わない。**
 * `workflow_dispatch`の入力はActionsのUIに出るため、issue-deck（PUBLICリポジトリ）では
 * 誰でも読める。認証は共有シークレット（`PROGRESS_REPORT_SECRET`）が担っており、
 * nonceを足しても守れるものが増えない。
 *
 * 未完了の実行が無ければ新しい行として残す。GitHubのActionsタブから直接起動した実行も
 * 画面に出るようにするため。
 */
export async function recordSecretsSyncReport(report: SecretsSyncReport): Promise<void> {
  const status = report.succeeded ? "SUCCEEDED" : "FAILED";
  const data = {
    status,
    finishedAt: new Date(),
    syncedCount: report.synced,
    skippedCount: report.skipped,
    failedCount: report.failed,
    failedKeys: report.failedKeys.join(","),
    runUrl: report.runUrl,
    message: report.message,
  } as const;

  const queued = await db.secretSyncRun.findFirst({
    where: { repositoryFullName: report.repositoryFullName, status: "QUEUED" },
    orderBy: { startedAt: "desc" },
  });

  if (queued) {
    await db.secretSyncRun.update({ where: { id: queued.id }, data });
    return;
  }

  await db.secretSyncRun.create({
    data: {
      repositoryFullName: report.repositoryFullName,
      only: report.only,
      ...data,
    },
  });
}
