import { db } from "@/lib/db";

/**
 * ディスパッチ系のモジュールがGitHubへ書くときに使うインストールトークンの取得（#1119）。
 *
 * サブPCにGitHubの認証を持たせず、issue-deckがGitHub App名義で書く
 * （[docs/progress-status-architecture.md](../../../docs/progress-status-architecture.md)）。
 * 同じ取得手順が`session-escalation.ts`（異常終了の引き上げ）・`session-plan.ts`（計画の投稿）・
 * `session-start.ts`（受付コメント）・`session-wrapup.ts`（締めコメント）で4重になったので、
 * ここへ寄せた。
 *
 * **`app-auth`は動的importにする（#550と同じ理由）。** あちらはモジュール読み込みの時点で
 * `GITHUB_APP_ID`・`GITHUB_APP_PRIVATE_KEY_BASE64`を要求するため、静的importにすると
 * コメント本文の組み立てだけを見たいテストや、GitHub App認証を持たない環境で読み込み自体が
 * 失敗する。
 *
 * issue-deckが接続していないリポジトリでは書く手段が無いので`null`を返す。ホスト側では
 * 実行できてもこちらから書けない、という組み合わせは正常な状態として扱う。
 */
export async function resolveInstallationToken(
  repositoryFullName: string,
): Promise<string | null> {
  const repository = await db.repository.findFirst({
    where: { fullName: repositoryFullName },
    include: { installation: true },
  });
  if (!repository) return null;
  const { getInstallationToken } = await import("@/lib/github/app-auth");
  return getInstallationToken(repository.installation.installationId);
}
