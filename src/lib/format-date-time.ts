/**
 * 「いつの出来事か」を具体的な日時で出すためのフォーマッタ（#1468）。
 *
 * **画面に出す絶対時刻の整形はここだけが持つ**（#1977）。以前は画面ごとに
 * `toLocaleString("ja-JP")`や`getHours()`を直接呼んでおり、**実行環境のタイムゾーン任せ**
 * だった。本番のVPSもsubpcもCIもUTCで動いているため、サーバーで描いた分はUTC・ブラウザで
 * 描き直した分はJSTになり、同じ画面の中で9時間ずれた時刻が混ざる。ここでJSTへ固定すると、
 * どちらで描いても同じ文字列になるのでハイドレーションの食い違いも起きない。
 *
 * **相対表現（`formatRelativeDate`）と使い分ける。** 一覧の更新日時のように「新しいかどうか」だけ
 * 分かればよい場所は相対表現でよいが、サブPCのジョブのように後から「あのとき動かしたやつ」を
 * 突き合わせる相手がいる情報は、何時何分かが分からないと照合できない。相対表現は差分の計算
 * なのでタイムゾーンの影響を受けず、こちらの対象外。
 */

/**
 * 日本時間は+09:00固定で夏時間が無いため、`Intl`のタイムゾーン変換ではなく単純な加算で足りる。
 * 加算後の`Date`は**UTCの読み出し（`getUTC*`）でJSTの各部が取れるだけのもの**で、
 * 瞬間としては正しくない。この中でだけ使い、外へ返さない。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 日本時間で読むための各部。`weekday`は日曜=0 */
export type JstParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

/**
 * epoch msを日本時間の各部へ分解する。解釈できない値は`null`。
 *
 * 「同じ日か」「何曜日か」といった判定も、ローカルタイムの`getDate()`などではなくここを通す
 * （UTCで動いている環境では日付の境界が9時間ずれる）。
 */
export function toJstParts(value: number | string | Date): JstParts | null {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;

  const shifted = new Date(time + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

/** 日本時間で同じ日かどうか。日付の境界をまたぐ判定はこれを通す */
export function isSameJstDay(a: number | string | Date, b: number | string | Date): boolean {
  const left = toJstParts(a);
  const right = toJstParts(b);
  if (!left || !right) return false;
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

/** 日本時間の曜日ラベル（「月曜日」など）。解釈できない値は空文字 */
export function formatJstWeekday(value: number | string | Date): string {
  const parts = toJstParts(value);
  return parts === null ? "" : `${WEEKDAY_LABELS[parts.weekday]}曜日`;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/**
 * 月日と時分（例: `8月15日 09:05`）。
 *
 * 年は付けない（付けると1行に収まらず、突き合わせたい相手はたいてい直近のもの）。年まで含む
 * 完全な日時が要る場合は`formatDateTimeFull`をtitle属性などに添える。
 */
export function formatDateTime(iso: string): string {
  const parts = toJstParts(iso);
  if (parts === null) return "";
  return `${parts.month}月${parts.day}日 ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/**
 * ホバーで補うための完全な日時（年・秒まで）。
 *
 * **ここだけは「（日本時間）」を明記する。** 一覧に並ぶ時刻すべてに添えると読みにくいが、
 * 突き合わせのために正確な時刻を見に来た人には、どのタイムゾーンの値なのかが要る。
 */
export function formatDateTimeFull(iso: string): string {
  const parts = toJstParts(iso);
  if (parts === null) return "";
  return `${parts.year}/${parts.month}/${parts.day} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(
    parts.second,
  )}（日本時間）`;
}

/** 時分だけ（例: `09:05`）。同じ日の中の並びを見せる場所で使う */
export function formatTimeOfDay(value: number | string | Date): string {
  const parts = toJstParts(value);
  if (parts === null) return "";
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/** 月日だけ（例: `8/15`）。日付が変わったことだけを示す場所で使う */
export function formatMonthDay(value: number | string | Date): string {
  const parts = toJstParts(value);
  if (parts === null) return "";
  return `${parts.month}/${parts.day}`;
}

/** 年月日（例: `2026/8/15`）。期限のように時刻まで要らない場所で使う */
export function formatDateOnly(value: number | string | Date): string {
  const parts = toJstParts(value);
  if (parts === null) return "";
  return `${parts.year}/${parts.month}/${parts.day}`;
}

/**
 * 日本時間のその日の0:00をepoch msで返す（#2398）。`offsetDays`で前後の日へずらせる。
 *
 * 「明日まで伏せる」のような**日付の境界を跨ぐ時刻**を組み立てるためのもの。呼び出し側で
 * `getDate()`を使うと実行環境のタイムゾーン（本番・CIはUTC）で境界が9時間ずれるため、
 * ここを通す。解釈できない値は`null`。
 */
export function startOfJstDayMs(
  value: number | string | Date,
  offsetDays = 0,
): number | null {
  const parts = toJstParts(value);
  if (parts === null) return null;
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day + offsetDays, 0, 0, 0, 0) - JST_OFFSET_MS
  );
}
