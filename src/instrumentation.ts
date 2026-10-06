/**
 * Next.jsのサーバー起動時に一度だけ呼ばれるフック。
 *
 * - GitHub API消費内訳（src/lib/github/api-usage.ts）とAI API消費内訳
 *   （src/lib/claude/api-usage.ts）をDBへ永続化する仕組みの初期化
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

  // AI側は呼び出しのたびに書く（`lib/claude/api-usage.ts`のコメントを参照）。
  const { onBucketUpdated, onCallRecorded } = await import("@/lib/claude/api-usage");
  const {
    hydrateClaudeApiUsageFromDb,
    flushBucketToDb: flushClaudeBucketToDb,
    addCumulativeInputTokens,
  } = await import(
    "@/lib/claude/api-usage-persistence"
  );

  await hydrateClaudeApiUsageFromDb();
  onBucketUpdated((bucket) => {
    void flushClaudeBucketToDb(bucket);
  });
  // 保持期間で消えない累計入力トークン（#3500）。バケットとは別に加算だけを書く。
  onCallRecorded(({ model, inputTokens }) => {
    void addCumulativeInputTokens(model, inputTokens);
  });

  // StatusHubの共通アクセス設定へ反映状況（appliedVersion）を伝える。判定APIは利用者の操作が無いと
  // 呼ばれないため、5分以内に1回は呼ぶ（管理画面の「反映済み」の判定に使われる）。
  const { sendAccessHeartbeat } = await import("@/lib/access/client");
  const heartbeat = () => void sendAccessHeartbeat();
  setTimeout(heartbeat, 10_000).unref();
  setInterval(heartbeat, 4 * 60_000).unref();
}
