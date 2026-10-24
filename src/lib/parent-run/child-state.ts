import type { ChildPhase } from "@/lib/parent-run/decide";

/**
 * 親Issueの自動実行（#4536）の対象になっている子Issueの、一覧・詳細に出す印（#4953）。
 *
 * - `running`: 親の実行で起動済み（起動の受付中・ジョブ待ち・セッション実行中・PR作成後のマージ待ち）。
 *   進捗Statusが`Ready`のままでも「実行中」ビューへ出す
 * - `waiting`: 親の実行対象だが未起動（前提待ち・起動待ち）。「未着手」に残し、順番待ちの印を付ける
 *
 * Statusは書き換えず、画面の振り分けと印だけを変える（#1347と同じ方針）。
 */
export type ParentRunChildMark = {
  kind: "running" | "waiting";
  parentRepository: string;
  parentNumber: number;
  /** 待機先・理由（印のtitleと詳細に出す） */
  reason: string;
};

/**
 * 評価したphaseから印の種類を決める。`attention`・`blocked`・`done`・`skipped`は
 * 親の実行が進めている最中ではない（本人の対応待ち・停止・終了）ので印を付けない
 */
export function resolveParentRunChildKind(phase: ChildPhase): ParentRunChildMark["kind"] | null {
  switch (phase) {
    case "running":
    case "launching":
      return "running";
    case "ready":
    case "waiting":
      return "waiting";
    default:
      return null;
  }
}

/** 印の文言。親の番号を添える */
export function parentRunChildMarkText(mark: Pick<ParentRunChildMark, "kind" | "parentNumber">): string {
  return mark.kind === "running" ? `親 #${mark.parentNumber} の自動実行中` : `親 #${mark.parentNumber} の順番待ち`;
}

/** 再描画の判定用（`isIssueContentEqual`） */
export function isSameParentRunChildMark(a: ParentRunChildMark | null, b: ParentRunChildMark | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.parentRepository === b.parentRepository &&
    a.parentNumber === b.parentNumber &&
    a.reason === b.reason
  );
}
