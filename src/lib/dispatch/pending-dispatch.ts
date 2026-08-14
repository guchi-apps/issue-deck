import { db } from "@/lib/db";

/**
 * 「そのIssueにサブPCの未完了ジョブがあるか」だけを引く（#1347）。
 *
 * **`jobs.ts`ではなく独立したモジュールに置く。** `jobs.ts`はセッション（`sessions.ts`→
 * `session-escalation.ts`）経由でGitHub Appの認証（`github/app-auth.ts`）を読み込み、
 * そこはモジュール読み込みの時点で`GITHUB_APP_ID`・`GITHUB_APP_PRIVATE_KEY_BASE64`を要求する。
 * Issue一覧（`issues-for-user.ts`・ダッシュボードのサーバーコンポーネント）は本来この
 * 資格情報を必要としないため、順番待ちを出すためだけに要求を増やさない。
 */

/**
 * 未完了のジョブを積んでいるIssueを「`owner/repo#番号` → 積んだ日時」で返す。
 *
 * **`activeKey`だけを条件にする。** 未完了（QUEUED・CLAIMED・RUNNING）の間だけ
 * `owner/repo#番号`が入り、終了時にnullへ戻るunique列（`prisma/schema.prisma`）なので、
 * 状態の配列で引くのと同じ結果になり索引も効く。
 *
 * ここでは期限切れジョブの掃除（`expireStaleDispatchJobs`）を呼ばない。Issue一覧は10秒ごとに
 * 読まれるため、掃除を兼ねると読み取りのたびに書き込みが走る。掃除は`GET /api/dispatch`
 * （画面を開いていれば60秒以内に来る）に任せる。
 */
export async function getPendingDispatchAtByIssue(): Promise<Map<string, Date>> {
  const jobs = await db.dispatchJob.findMany({
    where: { activeKey: { not: null } },
    select: { activeKey: true, createdAt: true },
  });

  const map = new Map<string, Date>();
  for (const job of jobs) {
    if (job.activeKey) map.set(job.activeKey, job.createdAt);
  }
  return map;
}

/** 1件ぶんの取得。単票を返す経路（作成・編集・転送）で使う */
export async function getPendingDispatchAt(activeKey: string): Promise<Date | null> {
  const job = await db.dispatchJob.findUnique({
    where: { activeKey },
    select: { createdAt: true },
  });
  return job?.createdAt ?? null;
}
