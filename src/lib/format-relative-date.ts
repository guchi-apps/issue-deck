export function formatRelativeDate(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  if (diffMinutes <= 0) return "たった今";
  if (diffMinutes < 60) return `${diffMinutes}分前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}時間前`;
  return `${Math.floor(diffHours / 24)}日前`;
}
