/**
 * Next.jsのサーバー起動時に一度だけ呼ばれるフック。
 *
 * - GitHub API消費内訳（src/lib/github/api-usage.ts）をDBへ永続化する仕組みの初期化
 * - 本番プロセスのRSSの見張り（src/lib/process-memory-watch.ts。#2331）
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // **他の初期化より先に始める。** 起動直後の基準値が残らないと、あとで出たRSSが
  // 「どこから増えたのか」を読めない。見張り自体はDBもGitHubも触らないので先頭に置ける。
  const { startProcessMemoryWatch } = await import("@/lib/process-memory-watch");
  startProcessMemoryWatch();

  const { onBucketClosed } = await import("@/lib/github/api-usage");
  const { hydrateGithubApiUsageFromDb, flushBucketToDb } = await import("@/lib/github/api-usage-persistence");

  await hydrateGithubApiUsageFromDb();
  onBucketClosed((bucket) => {
    void flushBucketToDb(bucket);
  });
}
