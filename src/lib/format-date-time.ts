/**
 * 「いつの出来事か」を具体的な日時で出すためのフォーマッタ（#1468）。
 *
 * **相対表現（`formatRelativeDate`）と使い分ける。** 一覧の更新日時のように「新しいかどうか」だけ
 * 分かればよい場所は相対表現でよいが、サブPCのジョブのように後から「あのとき動かしたやつ」を
 * 突き合わせる相手がいる情報は、何時何分かが分からないと照合できない。
 *
 * 年は付けない（付けると1行に収まらず、突き合わせたい相手はたいてい直近のもの）。年まで含む
 * 完全な日時が要る場合は`formatDateTimeFull`をtitle属性などに添える。
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

/** ホバーで補うための完全な日時（年・秒まで）。 */
export function formatDateTimeFull(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ja-JP");
}
