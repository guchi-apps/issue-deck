/**
 * リセット時刻までの残り時間を「あと2時間13分」形式にする。
 * 解釈できない値の場合はnullを返す。
 */
export function formatResetCountdown(resetsAt: string, now: number): string | null {
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) return null;

  const diffMs = target - now;
  if (diffMs <= 0) return "まもなくリセット";

  const totalMinutes = Math.ceil(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours === 0 ? `あと${days}日` : `あと${days}日${remainingHours}時間`;
  }
  if (hours === 0) return `あと${minutes}分`;
  if (minutes === 0) return `あと${hours}時間`;
  return `あと${hours}時間${minutes}分`;
}
