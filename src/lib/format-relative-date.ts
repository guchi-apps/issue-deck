/**
 * 「どれくらい前か」を相対表現で出すためのフォーマッタ。
 *
 * **画面ごとに粗い実装を作らず、相対表現はここに集約する**（#1891）。以前はIssue一覧が日単位
 * （当日はすべて「今日」）、Pull Request一覧が時間単位（1時間未満はすべて「1時間以内」）の
 * 独自実装を持っており、同じ画面の中でも「いつ動いたのか」の細かさが揃っていなかった。
 *
 * 具体的な日時（何月何日の何時何分か）が要る場所は`formatDateTime`を使う。
 */
export function formatRelativeDate(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  if (diffMinutes <= 0) return "たった今";
  if (diffMinutes < 60) return `${diffMinutes}分前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}時間前`;
  return `${Math.floor(diffHours / 24)}日前`;
}
