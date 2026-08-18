import type { ConnectedRepository } from "@/types/repository";

/**
 * リポジトリ一覧に「issue-deckで実装を回せないリポジトリ」の印（丸に斜め線）を出すかどうか（#1888）。
 *
 * 元は`hasClaudeWorkflow`（`claude-issue-dispatch.yml`の有無）だけで判定していたが、**実行経路は
 * GitHub Actionsの無人実行とサブPCのローカルセッションの2つある**。サブPC側は汎用ランチャー
 * （`scripts/generic-start-issue.sh`・#1224）で対象リポジトリに何も置かずに起動できるため、
 * `vps`・`subpc`・`docs`のように「無人実行は持たないがローカルセッションでは対応する」構成が
 * 普通に存在する（#1741）。片方の経路だけを見ていると、実際には対応しているリポジトリに
 * 「非対応」の印が出て、意味を取り違えさせる。
 *
 * そこで**どちらの経路でも起動できないときだけ**印を出す。
 *
 * 印を出す口は左メニュー（`sidebar-nav.tsx`）・スマホのリポジトリ画面
 * （`mobile-repos-screen.tsx`）・設定の「表示」区分（`repository-visibility-section.tsx`）の
 * 3か所あり、判定と文言をここへ寄せて画面ごとにずれないようにする。
 *
 * **Issue詳細の「実装を開始」の無効化（`startImplementationDisabledReason`）とは別物。**
 * あちらはダイアログの中のActionsの選択肢だけを落とすためのもので、軸がGitHub Actions単独に
 * 限られる（#1262）。こちらは一覧の印なので2経路の和を見る。
 */
export const REPOSITORY_AUTOMATION_UNSUPPORTED_TITLE =
  "無人実行（claude-issue-dispatch.yml）もサブPCのローカルセッションも対応していません（対応可否の近似判定です）";

/**
 * どちらの実行経路にも対応していないか。
 *
 * 判定材料は`ConnectedRepository`の2つだけで、**サブPC側は「いま応答しているか」を見ない**
 * （`dispatchRunnable`の定義を参照）。一覧の印はリポジトリの構成を表すもので、サブPCが
 * スリープしているあいだだけ印が付いたり消えたりすると、何を表しているのか読めなくなる。
 */
export function isRepositoryAutomationUnsupported(
  repository: Pick<ConnectedRepository, "hasClaudeWorkflow" | "dispatchRunnable">,
): boolean {
  return !repository.hasClaudeWorkflow && !repository.dispatchRunnable;
}
