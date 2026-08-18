import { formatJstWeekday, isSameJstDay, toJstParts } from "@/lib/format-date-time";

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

/**
 * リセットまでの残り時間を「あと2時間13分でリセット」形式の一文にする。
 * 使用量メーターの下段は幅が狭く、絶対時刻まで置くと折り返すため、
 * 画面にはこの一文だけを出し、絶対時刻（`formatResetAt`）はツールチップへ回す。
 * 期限を過ぎている場合は「まもなくリセット」をそのまま返す（「でリセット」を重ねない）。
 */
export function formatResetSentence(resetsAtSeconds: number, nowMs: number): string | null {
  const countdown = formatResetCountdown(resetsAtSeconds, nowMs);
  if (countdown === null) return null;
  return countdown.startsWith("あと") ? `${countdown}でリセット` : countdown;
}

/**
 * リセット時刻を「13:00 (あと2時間14分)」形式にする。
 * 日をまたぐ場合は「月曜日 4:00 (あと3日4時間)」のように曜日を添える。
 *
 * 曜日の有無は「週次枠かどうか」ではなく日付が変わるかどうかで判定するため、
 * 5時間枠が深夜をまたぐ場合にも曜日が付く。
 *
 * **時刻・曜日・同じ日かの判定はすべて日本時間**（#1977）。実行環境のタイムゾーンで読むと、
 * UTCで動くサーバー側とブラウザ側で9時間ずれた時刻が出る。
 */
export function formatResetAt(resetsAtSeconds: number, nowMs: number): string | null {
  if (!Number.isFinite(resetsAtSeconds)) return null;

  const resetDate = new Date(resetsAtSeconds * 1000);
  const parts = toJstParts(resetDate);
  if (parts === null) return null;

  // 時は揃えず分だけ2桁にする（「13:00」「4:00」）。狭い枠に置く1行なので、
  // 先頭の0を落としたぶんだけ短くなる
  const time = `${parts.hour}:${String(parts.minute).padStart(2, "0")}`;
  const weekday = isSameJstDay(resetDate, nowMs) ? "" : `${formatJstWeekday(resetDate)} `;

  const countdown = formatResetCountdown(resetsAtSeconds, nowMs);
  return countdown === null ? `${weekday}${time}` : `${weekday}${time} (${countdown})`;
}

/**
 * リセット時刻(epoch秒)・固定ウィンドウ長(ミリ秒)・現在時刻(epoch ms)から、
 * ウィンドウ開始時点を100%・リセット時点を0%とする残り時間の割合(0-100)を返す。
 * 解釈できない値の場合はnullを返す。
 */
export function calcRemainingTimePercent(
  resetsAtSeconds: number,
  durationMs: number,
  nowMs: number,
): number | null {
  if (!Number.isFinite(resetsAtSeconds) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }

  const remainingMs = resetsAtSeconds * 1000 - nowMs;
  const percent = (remainingMs / durationMs) * 100;
  return Math.min(100, Math.max(0, percent));
}

/**
 * `calcRemainingTimePercent`の裏返しで、ウィンドウ開始時点を0%・リセット時点を100%とする
 * 経過時間の割合(0-100)を返す。使用量メーターの目盛りの位置に使う。
 */
export function calcElapsedTimePercent(
  resetsAtSeconds: number,
  durationMs: number,
  nowMs: number,
): number | null {
  const remaining = calcRemainingTimePercent(resetsAtSeconds, durationMs, nowMs);
  return remaining === null ? null : 100 - remaining;
}
