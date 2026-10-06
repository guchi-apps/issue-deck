import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

/** poller起動失敗・プロセス消失でも、確認待ちへ戻す。通知失敗で状態報告は取り消さない。 */
export async function notifyReviewFixFailure(repositoryFullName: string, issueNumber: number, message: string) {
  try {
    const repository = await db.repository.findFirst({ where: { fullName: repositoryFullName }, include: { installation: true } });
    if (!repository) return;
    const token = await getInstallationToken(repository.installation.installationId);
    const base = `${GITHUB_API}/repos/${repositoryFullName}/issues/${issueNumber}`;
    await githubFetch(`${base}/comments`, token, { method: "POST", body: { body: `${message}\n\n<!-- issue-deck-source:claude-review-fix -->` } });
    await githubFetch(`${base}/labels`, token, { method: "POST", body: { labels: ["00.check-user", "01.check-blocked"] } });
  } catch (error) {
    console.error("[review-fix] 停止通知に失敗しました", error);
  }
}
