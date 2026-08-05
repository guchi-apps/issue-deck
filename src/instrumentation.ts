/**
 * Next.jsのサーバー起動時に一度だけ呼ばれるフック。
 * GitHub API消費内訳（src/lib/github/api-usage.ts）をDBへ永続化する仕組みの初期化を行う。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { onBucketClosed } = await import("@/lib/github/api-usage");
  const { hydrateGithubApiUsageFromDb, flushBucketToDb } = await import("@/lib/github/api-usage-persistence");

  await hydrateGithubApiUsageFromDb();
  onBucketClosed((bucket) => {
    void flushBucketToDb(bucket);
  });
}
