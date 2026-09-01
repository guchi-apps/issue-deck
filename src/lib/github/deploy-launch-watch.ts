import { MAIN_BRANCH } from "@/lib/branch-flow";
import { db } from "@/lib/db";
import { deployLaunchGraceSeconds } from "@/lib/deploy-launch";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";

/**
 * mainへのマージを見張り対象として記録する（#2703）。
 *
 * 呼ぶのは`POST /api/issues/pull-request-merge`のマージ成功直後だけ。**ここでポーリングは
 * しない。** リクエストの中で60〜120秒待つと、その間ブラウザが握られたままになり、
 * 本番の再起動（PM2の`max_memory_restart`・#2331）でその待ちごと消える。行を1つ置いて、
 * 実際に見張るのはpollerが叩く巡回（`deploy-launch-sweep-run.ts`）に任せる。
 *
 * 判定に要るのは「baseがmainか」だけなので、**マージした後にPRを1回引く**。
 * マージの前に引かないのは、この取得が失敗してもマージを止めたくないため
 * （見張りが立たないだけで、マージそのものは成功している）。
 */
export async function recordDeployLaunchWatch({
  owner,
  repo,
  pullRequestNumber,
  mergeCommitSha,
  token,
  now = new Date(),
}: {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  mergeCommitSha: string | null;
  token: string;
  now?: Date;
}): Promise<boolean> {
  // 猶予0は「見張りごと無効」。行も作らない（作ると巡回が決着させられずに残る）。
  if (deployLaunchGraceSeconds() === 0) return false;
  // マージコミットのSHAが読めなければ照合の鍵が無い。**推測で別のSHAを入れない**——
  // 一致しない鍵で見張ると、正常に起動していても起動し直してしまう。
  if (!mergeCommitSha) return false;

  const pullRequest = await fetchPullRequest(owner, repo, pullRequestNumber, token);
  if (pullRequest.base.ref !== MAIN_BRANCH) return false;

  const repositoryFullName = `${owner}/${repo}`;
  // 同じPRを二度マージすることは無いが、`upsert`にしておくと再送・二度押しでも行が増えない。
  await db.deployLaunchWatch.upsert({
    where: { repositoryFullName_pullRequestNumber: { repositoryFullName, pullRequestNumber } },
    create: {
      repositoryFullName,
      pullRequestNumber,
      pullRequestTitle: pullRequest.title,
      mergeCommitSha,
      mergedAt: now,
      state: "pending",
    },
    update: {},
  });
  return true;
}
