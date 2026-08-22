import {
  Clock,
  GitMerge,
  Inbox,
  ListChecks,
  MessageCircleQuestionMark,
  PlayCircle,
  Rocket,
  Star,
  UserCheck,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { IssueStateFilter } from "@/hooks/use-issue-filters";
import { LABEL_FILTER_PRESETS } from "@/lib/github/approval-labels";
import type { ProgressStatusKey } from "@/lib/issue-progress";
import type { LabelNavViewId, NavViewId } from "@/types/issue";

export type NavView = {
  id: NavViewId;
  label: string;
  /**
   * ビュー選択時に暗黙で適用するラベル絞り込み（OR一致）。
   * 未指定のビューはラベルでは絞り込まない。
   */
  labels?: readonly string[];
  /**
   * ビュー選択時に暗黙で適用するラベル除外（このいずれかを持つIssueを除く）。
   * labelsとは逆にAND条件で、「未着手」のようにラベルの不在で定義するビュー向け。
   */
  excludeLabels?: readonly string[];
  /**
   * ビュー選択時に暗黙で適用する進捗Statusの絞り込み（OR一致）。
   * 判定は`resolveProgressStatus`（＝Project Status）を通す（#991 Phase 5）。
   */
  statuses?: readonly ProgressStatusKey[];
  /**
   * 質問Issue（`isAskRepoQuestionIssue`）だけに絞り込むビューかどうか（#1514）。
   * 質問であることはラベルにもStatusにも現れないため、専用の条件にしている。
   */
  questionOnly?: boolean;
  /** 質問Issueを除外するビューかどうか（#1514） */
  excludeQuestions?: boolean;
  /**
   * このビューが要求する状態フィルター。stateクエリ未指定時の既定値になるほか、
   * ビュー切り替え時には明示的に選ばれていたstateも上書きして自動で適用する（#475）。
   * `Done`（本番反映済）はマージ完了と同時にissueをcloseする運用（CLAUDE.md）のため、
   * 「直近main反映済み」ビューはopen絞り込みのままだと該当issueが出てこない。
   * お気に入りなど状態を要求しないビューは未指定にし、現在の絞り込み条件を保つ。
   */
  defaultState?: IssueStateFilter;
  /**
   * 最新リリース分だけに絞るビューかどうか。
   * `Done`は一度入ると戻らない状態のため、これがないと過去の全リリース分が
   * 累積してしまう（詳細はissue-statsのfilterLatestReleaseIssues）。
   */
  latestReleaseOnly?: boolean;
  /**
   * リポジトリごとのグルーピング表示（#849）の既定ON/OFF。未指定はOFFと同じ。
   * 「本番関連待ち」（release-pending・recently-merged）と実行中（in-progress）は
   * リポジトリごとに見通しが良いためデフォルトON。not-startedはリポジトリ横断で
   * まとめて一覧できる方が着手優先度を判断しやすいためデフォルトOFF（#876）。
   * check-userはリポジトリ横断の優先順位付け（確認が古い順）を崩したくないためOFFのまま。
   */
  groupByRepoDefault?: boolean;
  /**
   * ユーザーが指定した絞り込み条件（キーワード・リポジトリ・状態・ラベル・担当者）を
   * 適用しないビューかどうか（#1750）。
   *
   * このアプリは複数リポジトリを横断で見るためのもので、「人が動くまで進まないもの」と
   * 「質問」は**全体で取りこぼしが無いか**を確かめる場所になる。1リポジトリへ絞ったまま
   * 見ると、他のリポジトリで止まっているものが画面から消える。
   *
   * 無視するのはユーザーが指定した条件だけで、**ビューの定義そのもの**
   * （`labels`・`questionOnly`・`defaultState`）は従来どおり効く。
   */
  ignoresIssueFilters?: boolean;
  /**
   * 「人が手を動かすもの」を集めたビューかどうか（#2081）。スマホの一覧ヘッダーの
   * 見出しを「Issue」からビュー名へ差し替えるのに使う。
   *
   * 対象は「ユーザーの確認待ち」と「ユーザーの作業待ち」。**この2つはIssueだけの一覧では
   * ない**——確認待ちにはユーザーのマージを待っているPull Requestが混ざり（#1613）、
   * 作業待ちに並ぶのは開発のIssueではなく人が実行する手順（`71.manual-step`）。
   * 見出しに「Issue」と出ていると、並んでいるものと見出しが食い違う。
   */
  userActionList?: boolean;
};

const LABEL_NAV_VIEW_ICONS: Record<LabelNavViewId, LucideIcon> = {
  "check-user": UserCheck,
  "manual-step": Wrench,
  question: MessageCircleQuestionMark,
  // 「すべてのIssue」（ListChecks）と並ぶため、同じ線画に見えるListTodoは使わない（#1613）。
  // 受け皿の絵（Inbox）なら「まだ手を付けていないものが溜まっている場所」としても読める。
  "not-started": Inbox,
  "in-progress": PlayCircle,
  "release-pending": Rocket,
  "recently-merged": GitMerge,
};

export const baseNavViews: NavView[] = [
  { id: "all", label: "すべてのIssue" },
  { id: "favorites", label: "お気に入り" },
  { id: "recently-added", label: "最近追加した" },
];

/**
 * グルーピング表示（#849）をデフォルトONにするビュー。実行中（in-progress）と
 * 「本番関連待ち」（本番反映待ち・直近本番に反映した）が対象。not-startedは
 * リポジトリ横断でまとめて表示する方が着手優先度を判断しやすいため対象外（#876）。
 */
const GROUP_BY_REPO_DEFAULT_VIEWS: readonly LabelNavViewId[] = [
  "in-progress",
  "release-pending",
  "recently-merged",
];

/**
 * ユーザーの絞り込み条件を適用しないビュー（#1750）。左メニューの最上段（要対応の2つ）と
 * 「質問」で、どれも「全体で漏れが無いか」を見る場所。画面ではなくビューの性質として
 * ここに持つ——PC・スマホの各画面で条件を書くと、片方だけ直され続ける。
 *
 * 「ブランチ」（`pane=flow`）も同じ扱いにするが、ビューではないので画面側で行う。
 */
const IGNORE_FILTER_VIEWS: readonly LabelNavViewId[] = ["check-user", "manual-step", "question"];

/**
 * Issue以外のものが並ぶ「人が手を動かすもの」のビュー（#2081。`NavView.userActionList`）。
 * 「質問」を含めないのは、あちらに並ぶのがIssue（質問Issue）だけのため。
 */
const USER_ACTION_LIST_VIEWS: readonly LabelNavViewId[] = ["check-user", "manual-step"];

/** 定型の絞り込みを、他のビューと同じviewクエリで表現するためのビュー定義 */
export const labelNavViews: NavView[] = LABEL_FILTER_PRESETS.map((preset) => ({
  id: preset.key,
  label: preset.label,
  labels: preset.labels,
  excludeLabels: preset.excludeLabels,
  statuses: preset.statuses,
  questionOnly: preset.questionOnly,
  excludeQuestions: preset.excludeQuestions,
  defaultState: preset.state,
  latestReleaseOnly: preset.key === "recently-merged",
  groupByRepoDefault: GROUP_BY_REPO_DEFAULT_VIEWS.includes(preset.key),
  ignoresIssueFilters: IGNORE_FILTER_VIEWS.includes(preset.key),
  userActionList: USER_ACTION_LIST_VIEWS.includes(preset.key),
}));

/**
 * サイドメニュー「全体」やスマホのクイックビューで選べるビューの一覧。
 * ラベルベースのビューも含め、すべてviewクエリ1つで表現する。
 */
export const navViews: NavView[] = [...baseNavViews, ...labelNavViews];

/**
 * PC左メニューに出すIssueビューのグループ（#1613）。
 *
 * `navViews`は「viewクエリとして存在するビューの一覧」で、スマホのタブ・スワイプ順や件数の
 * 計算も同じ配列を見る。**左メニューに何をどの順で出すかはそれとは別の判断**なので、ここで
 * 別に持つ。ここから外したビュー（`recently-added`・`recently-merged`）も
 * viewクエリとしては生きており、スマホのタブや既存リンクからは今までどおり開ける。
 *
 * `attention`は「エージェントが止まっていて人が動くまで進まないもの」だけを置く枠で、
 * 見出しを付けず先頭に固定する。ここに他のビューを足すと、上から順に見て手を動かせば
 * 盤面が進む、という読み方が崩れる。
 */
export const sidebarAttentionNavViews: NavView[] = labelNavViews.filter((view) =>
  ["check-user", "manual-step"].includes(view.id),
);

/**
 * 要対応の枠とIssueの枠のあいだに置くビュー（#1613）。「質問」は人が読む先だが承認の待ちでは
 * ないため要対応には入れず、Issueの絞り込みとも性質が違うので独立させる。
 * 「ブランチ」（`pane=flow`）はビューではないので、ここではなく画面側で並べる。
 */
export const sidebarQuestionNavViews: NavView[] = labelNavViews.filter(
  (view) => view.id === "question",
);

/**
 * スマホのIssue一覧で選べるビュー（#1645）。「すべてのIssue」の次にユーザーの確認待ちを置き、
 * 対応が必要なIssueを最初に見つけられるようにする（#714）。
 *
 * 「お気に入り」「最近追加した」は出さない（#873）。「直近本番に反映した」も、左メニュー
 * （`sidebarIssueNavViews`）と揃えて外す（#1645）。viewクエリとしては生きており、既存リンクからは
 * 今までどおり開ける。
 *
 * **「本番反映待ち」は#1645でここから外していたが、#1743で戻した。** 左メニュー側へ足したので、
 * 「左メニューと揃える」という#1645の判断はここでも足す向きに働く。
 */
export const mobileListNavViews: NavView[] = [
  baseNavViews[0],
  ...labelNavViews.filter((view) => !["recently-merged"].includes(view.id)),
];

/**
 * スマホのIssue一覧に並べるビュー（#1645）。`mobileListNavViews`に無いビュー
 * （既存リンクやホーム画面から開いた「直近本番に反映した」など）で開かれたときだけ、
 * そのビューを末尾へ足す。
 *
 * 足さないと、選択中を示すものが画面から消えるうえ、スワイプの隣接判定
 * （`getAdjacentNavViewId`）が現在地を見つけられず左右どちらへも移動できなくなる。
 */
export function resolveMobileListNavViews(view: NavViewId): NavView[] {
  if (mobileListNavViews.some((navView) => navView.id === view)) return mobileListNavViews;
  return [...mobileListNavViews, getNavView(view)];
}

/**
 * 左メニュー「Issue」セクション。並びは広い順→絞った順（#1613）で、絞ったものどうしは
 * 進捗の順（未着手 → 実行中 → 本番反映待ち）に並べる。
 *
 * 「本番反映待ち」は#1613でここから外していたが、#1743で戻した。developまで来て本番へ
 * 出ていないIssueはリリース操作の起点として日常的に見るもので、PCではカードのような
 * 別の入口も無く、viewクエリを直接いじる以外に開く手段が無かった。**足す先はここで、
 * `sidebarAttentionNavViews`ではない**——本番反映待ちで止まっているのはエージェントではなく
 * リリースの実行なので、「人が動くまで進まないもの」の枠へ入れると上から順に手を動かせば
 * 盤面が進む、という読み方が崩れる。
 *
 * **この配列はスマホのホーム画面のメニューも使う**（#1690。`mobile-home-screen.tsx`）ので、
 * ここへ足すとPCとスマホの両方に出る。
 */
export const sidebarIssueNavViews: NavView[] = [
  "all",
  "favorites",
  "not-started",
  "in-progress",
  "release-pending",
]
  .map((id) => navViews.find((view) => view.id === id))
  .filter((view): view is NavView => view !== undefined);

export const navViewIcons: Record<NavViewId, LucideIcon> = {
  all: ListChecks,
  favorites: Star,
  "recently-added": Clock,
  ...LABEL_NAV_VIEW_ICONS,
};

export function isNavViewId(value: string | null | undefined): value is NavViewId {
  return value !== null && value !== undefined && navViews.some((view) => view.id === value);
}

export function getNavView(id: NavViewId): NavView {
  return navViews.find((view) => view.id === id) ?? baseNavViews[0];
}

export function getNavViewLabel(id: NavViewId): string {
  return getNavView(id).label;
}

/** ビューごとの、stateクエリ未指定時に適用する状態フィルター */
export function getNavViewDefaultState(id: NavViewId): IssueStateFilter {
  return getNavView(id).defaultState ?? "open";
}

/** ビューごとの、リポジトリごとのグルーピング表示（#849）の既定ON/OFF */
export function getNavViewDefaultGroupByRepo(id: NavViewId): boolean {
  return getNavView(id).groupByRepoDefault ?? false;
}

/**
 * ユーザーが指定した絞り込み条件を適用しないビューか（#1750）。
 * 一覧・件数・注記の出し分けはすべてこの1か所を通す。
 */
export function navViewIgnoresIssueFilters(id: NavViewId): boolean {
  return getNavView(id).ignoresIssueFilters ?? false;
}

/**
 * Issue以外のものも並ぶ「人が手を動かすもの」のビューか（#2081）。
 * スマホの一覧ヘッダーの見出しを「Issue」から差し替えるかの判定に使う。
 */
export function navViewIsUserActionList(id: NavViewId): boolean {
  return getNavView(id).userActionList ?? false;
}

/**
 * 指定した並び順（省略時はnavViews）上でidの1つ前・1つ後のビューIDを返す
 * （スマホ一覧のスワイプ切り替え用、#706）。先頭/末尾でそれ以上進められない場合や、
 * idがorderに存在しない場合はnullを返す（ループはしない）。
 *
 * orderを引数で受け取れるようにしているのは、スマホのタブ表示順（#714で
 * 「すべてのIssue」の右隣にユーザーの確認待ちを固定表示するようnavViewsとは
 * 異なる順序に変更済み）とスワイプの前後判定がズレていると、タブ上は隣り合って
 * 見えるビューにスワイプしても切り替わらず順番がおかしく感じられるため（#734）。
 */
export function getAdjacentNavViewId(
  id: NavViewId,
  direction: "prev" | "next",
  order: readonly NavView[] = navViews,
): NavViewId | null {
  const index = order.findIndex((view) => view.id === id);
  if (index === -1) return null;

  const adjacentIndex = direction === "next" ? index + 1 : index - 1;
  return order[adjacentIndex]?.id ?? null;
}

/**
 * ビュー切り替え後に適用すべき状態フィルターを解決する（#475）。
 *
 * - 切り替え先が状態を要求するビュー（「main反映済(直近)」）なら、その状態へ自動で
 *   切り替える。openのままではどう絞り込んでも0件になり、ビューとして成立しないため、
 *   ユーザーが明示的に選んでいた状態よりビューの要求を優先する。
 * - 状態を要求しないビュー（お気に入り等）は現在の絞り込み条件をそのまま引き継ぐ。
 *   ただし直前のビューの要求で決まっていただけの状態（＝明示的に選ばれていない）は、
 *   ユーザーの選択ではないので切り替え先の既定値に戻す。
 * - 同じビューを選び直しただけのときは、明示的な選択を上書きしない。
 *
 * @param isStateExplicit ユーザーが状態を明示的に選んでいるか（URLクエリに残っているか）
 */
export function resolveStateOnViewChange(
  nextView: NavViewId,
  currentView: NavViewId,
  currentState: IssueStateFilter,
  isStateExplicit: boolean,
): IssueStateFilter {
  if (nextView !== currentView) {
    const requiredState = getNavView(nextView).defaultState;
    if (requiredState) return requiredState;
  }
  return isStateExplicit ? currentState : getNavViewDefaultState(nextView);
}
