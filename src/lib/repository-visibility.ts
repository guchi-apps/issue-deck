import type { ConnectedRepository } from "@/types/repository";

/**
 * 設定画面「表示」区分（#1552）でリポジトリの表示・非表示を扱うための純粋関数。
 *
 * 非表示の実体は`HiddenRepository`で、切り替える口は左メニュー（`sidebar-nav.tsx`）・
 * スマホのリポジトリ画面（`mobile-repos-screen.tsx`）・設定画面の3か所ある。件数の数え方と
 * 一括操作の対象の決め方をここへ寄せて、画面ごとに書かないようにする。
 */

export type RepositoryVisibilitySummary = {
  /** 連携しているリポジトリの総数 */
  total: number;
  /** 表示中（＝非表示にしていない）の件数 */
  visible: number;
  /** 非表示にしている件数 */
  hidden: number;
};

export function summarizeRepositoryVisibility(
  repositories: readonly ConnectedRepository[],
): RepositoryVisibilitySummary {
  const hidden = repositories.filter((repository) => repository.hidden).length;
  return { total: repositories.length, visible: repositories.length - hidden, hidden };
}

/**
 * 「すべて表示」「すべて非表示」で**実際に状態が変わる行だけ**を返す。
 *
 * 既にその状態のものまで送ると、押すたびに全リポジトリぶんの書き込みが飛ぶ（非表示が0件でも
 * 「すべて表示」で全件のDELETEが走る）。変わらないものを除いて0件になった場合は、呼び出し側で
 * リクエスト自体を省ける。
 */
export function selectRepositoriesToToggle(
  repositories: readonly ConnectedRepository[],
  hidden: boolean,
): ConnectedRepository[] {
  return repositories.filter((repository) => repository.hidden !== hidden);
}
