import type { NotificationItem } from "@/lib/notifications";

/**
 * 通知ベルの行を×で伏せる判定（#4857）。
 *
 * ベルには、実際には片付いているのに行が残ることがある。手作業Issueは完了確認コマンドが
 * 通るまでopenのまま残る（#4315）し、リリース状況は取り直すまで前の結果を出している。
 * 原因が複数にまたがり機械的には消し切れないため、**人が「これはもう見た」と伏せられる**
 * ようにした。
 *
 * **伏せるのは押した時点の状態だけ。** 記録は通知のid（対象）と指紋（`notificationFingerprint`。
 * バッジの文言・トーン・`revision`）の組で、同じ対象でも状態が変われば指紋が合わずに再び出る。
 * 伏せたせいで新しい警告を見逃すことを避けるため、迷う場合は**出す側へ倒す**
 * （`lib/snooze.ts`の「読めない値は効いていない側へ倒す」と同じ考え方）。
 *
 * 既存の保留（#2398。`lib/snooze.ts`）とは別物。あちらはIssue一覧・左メニューの件数からも
 * 消す重い操作で、対象もIssue・PRに限られる。こちらはベルの表示だけを変え、リリースの行も
 * 伏せられる。
 */

/** 伏せた記録1件。ブラウザのlocalStorageへそのまま保存する */
export type NotificationDismissal = {
  /** `NotificationItem.id` */
  id: string;
  /** 伏せた時点の`notificationFingerprint` */
  fingerprint: string;
  /** 伏せた時刻（ISO8601）。対象が消えた記録を片付ける目安に使う */
  dismissedAt: string;
};

/**
 * 通知の状態を表す指紋。**同じ対象で、人が改めて見るべき変化があれば値が変わる**ものだけを入れる。
 *
 * - `badgeLabel`・`tone`: 「チェック失敗」→「mainへマージ待ち」、確認待ちの理由の変化など
 * - `revision`: 区分ごとの版（確認待ちは`00.check-user`が付いた時刻。付け直されたら別物）
 *
 * 待ち時間の基準（`since`）は入れない。確認待ちの`since`は付与時刻が取れないと`updatedAt`へ
 * 落ち、コメントが付くたびに変わって伏せた意味が無くなるため。
 */
export function notificationFingerprint(item: NotificationItem): string {
  return [item.badgeLabel, item.tone, item.revision ?? ""].join("\u0000");
}

/** 通知が伏せられているか。id・指紋の両方が一致したときだけ真 */
function isDismissed(
  item: NotificationItem,
  dismissals: ReadonlyMap<string, NotificationDismissal>,
): boolean {
  const dismissal = dismissals.get(item.id);
  return dismissal !== undefined && dismissal.fingerprint === notificationFingerprint(item);
}

/** 通知を、表示するものと伏せたものに分ける。並びは入力のまま保つ */
export function splitDismissedNotifications(
  items: NotificationItem[],
  dismissals: readonly NotificationDismissal[],
): { visible: NotificationItem[]; dismissed: NotificationItem[] } {
  if (dismissals.length === 0) return { visible: items, dismissed: [] };
  const byId = new Map(dismissals.map((dismissal) => [dismissal.id, dismissal] as const));
  const visible: NotificationItem[] = [];
  const dismissed: NotificationItem[] = [];
  items.forEach((item) => (isDismissed(item, byId) ? dismissed : visible).push(item));
  return { visible, dismissed };
}

/** 伏せる。同じidの古い記録は置き換える */
export function addDismissal(
  dismissals: readonly NotificationDismissal[],
  item: NotificationItem,
  now: number,
): NotificationDismissal[] {
  return [
    ...dismissals.filter((dismissal) => dismissal.id !== item.id),
    {
      id: item.id,
      fingerprint: notificationFingerprint(item),
      dismissedAt: new Date(now).toISOString(),
    },
  ];
}

/** 伏せた記録を外す（「元に戻す」「戻す」） */
export function removeDismissal(
  dismissals: readonly NotificationDismissal[],
  id: string,
): NotificationDismissal[] {
  return dismissals.filter((dismissal) => dismissal.id !== id);
}

/**
 * もう効かない記録を片付ける。
 *
 * - **指紋が変わった記録はいつでも消す。** 状態が変わって再表示された時点で役目を終えている。
 *   残すと、状態が元へ戻った（失敗→成功→失敗）ときに古い記録が再び効いて伏せてしまう
 * - **対象が一覧から消えた記録は`settled`のときだけ消す。** 解消して消えた対象が後で同じ
 *   状態で戻ってきたら（同じPRのチェックが再び失敗した等）、改めて出すため。取得が済む前は
 *   材料が空のことがあり、そこで消すと伏せた行がまとめて戻ってしまうので、呼び出し側が
 *   取り直しの完了を確かめてから`settled`を渡す
 *
 * 何も変わらなければ入力をそのまま返す（状態の更新・localStorageへの書き込みを起こさない）。
 */
export function pruneDismissals(
  dismissals: readonly NotificationDismissal[],
  items: NotificationItem[],
  settled: boolean,
): readonly NotificationDismissal[] {
  if (dismissals.length === 0) return dismissals;
  const fingerprints = new Map(
    items.map((item) => [item.id, notificationFingerprint(item)] as const),
  );
  const kept = dismissals.filter((dismissal) => {
    const fingerprint = fingerprints.get(dismissal.id);
    if (fingerprint === undefined) return !settled;
    return fingerprint === dismissal.fingerprint;
  });
  return kept.length === dismissals.length ? dismissals : kept;
}

/** localStorageから読んだ値を検める。形の合わない要素は捨てる（壊れた値で例外にしない） */
export function parseDismissals(value: unknown): NotificationDismissal[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is NotificationDismissal =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.id === "string" &&
      typeof entry.fingerprint === "string" &&
      typeof entry.dismissedAt === "string",
  );
}
