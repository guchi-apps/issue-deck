/**
 * Next.jsのサーバー起動時に一度だけ呼ばれるフック。
 * GitHub API消費内訳（src/lib/github/api-usage.ts）とAI API消費内訳
 * （src/lib/claude/api-usage.ts）をDBへ永続化する仕組みの初期化を行う。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { onBucketClosed } = await import("@/lib/github/api-usage");
  const { hydrateGithubApiUsageFromDb, flushBucketToDb } = await import("@/lib/github/api-usage-persistence");

  await hydrateGithubApiUsageFromDb();
  onBucketClosed((bucket) => {
    void flushBucketToDb(bucket);
  });

  // AI側は呼び出しのたびに書く（`lib/claude/api-usage.ts`のコメントを参照）。
  const { onBucketUpdated } = await import("@/lib/claude/api-usage");
  const { hydrateClaudeApiUsageFromDb, flushBucketToDb: flushClaudeBucketToDb } = await import(
    "@/lib/claude/api-usage-persistence"
  );

  await hydrateClaudeApiUsageFromDb();
  onBucketUpdated((bucket) => {
    void flushClaudeBucketToDb(bucket);
  });
}
