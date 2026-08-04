const WEEKDAY_LABELS = [
  "日曜日",
  "月曜日",
  "火曜日",
  "水曜日",
  "木曜日",
  "金曜日",
  "土曜日",
] as const;

/**
 * リセット時刻(epoch秒)までの残り時間を「あと2時間13分」形式にする。
 * 解釈できない値の場合はnullを返す。
 */
export function formatResetCountdown(resetsAtSeconds: number, nowMs: number): string | null {
  if (!Number.isFinite(resetsAtSeconds)) return null;

  const diffMs = resetsAtSeconds * 1000 - nowMs;
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

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * リセット時刻を「13:00 (あと2時間14分)」形式にする。
 * 日をまたぐ場合は「月曜日 4:00 (あと3日4時間)」のように曜日を添える。
 *
 * 曜日の有無は「週次枠かどうか」ではなく日付が変わるかどうかで判定するため、
 * 5時間枠が深夜をまたぐ場合にも曜日が付く。
 */
export function formatResetAt(resetsAtSeconds: number, nowMs: number): string | null {
  if (!Number.isFinite(resetsAtSeconds)) return null;

  const resetDate = new Date(resetsAtSeconds * 1000);
  if (Number.isNaN(resetDate.getTime())) return null;

  const time = `${resetDate.getHours()}:${String(resetDate.getMinutes()).padStart(2, "0")}`;
  const weekday = isSameLocalDay(resetDate, new Date(nowMs))
    ? ""
    : `${WEEKDAY_LABELS[resetDate.getDay()]} `;

  const countdown = formatResetCountdown(resetsAtSeconds, nowMs);
  return countdown === null ? `${weekday}${time}` : `${weekday}${time} (${countdown})`;
}
