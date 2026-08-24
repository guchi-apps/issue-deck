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

/**
 * 一覧に出すIssueの母集団から、非表示にしたリポジトリのものを除く（#2279）。
 *
 * **明示的に選択中のリポジトリは、非表示でも除かない。** 左メニューは選択中のリポジトリを
 * 非表示でも行として出し（#1480）、「すべて表示する」で隠れている行も出せるため、そこから
 * 選べるのに一覧が必ず空になる、という状態を作らないための逃げ道。横断ビュー（確認待ち・
 * 作業待ち・質問）は`resolveFiltersForView`でリポジトリの選択を捨てるので、逃げ道は効かず
 * 常に除かれる。
 *
 * サーバー側（`getIssuesForUser`）ではなくここで除くのは、この逃げ道が画面の絞り込み条件に
 * 依存するため。**非表示リポジトリの母集団はクライアントまで届いている**ので、件数・ラベル
 * 集計などの派生値もすべてこの関数を通した集合から作ること。
 */
export function selectVisibleIssues<T extends { repositoryFullName: string }>(
  issues: readonly T[],
  repositories: readonly ConnectedRepository[],
  selectedRepoFullNames: readonly string[] = [],
): T[] {
  const excluded = new Set(
    repositories
      .filter(
        (repository) =>
          repository.hidden && !selectedRepoFullNames.includes(repository.fullName),
      )
      .map((repository) => repository.fullName),
  );
  if (excluded.size === 0) return [...issues];
  return issues.filter((issue) => !excluded.has(issue.repositoryFullName));
}
