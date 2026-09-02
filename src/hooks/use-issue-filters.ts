"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import { useHistoryNavigation, type HistoryMode } from "@/hooks/use-history-navigation";
import {
  getNavViewDefaultState,
  isNavViewId,
  resolveStateOnViewChange,
} from "@/lib/nav-views";
import { DEFAULT_PULL_REQUEST_VIEW, isPullRequestViewId } from "@/lib/pull-request-views";
import type { NavViewId } from "@/types/issue";
import type { PullRequestViewId } from "@/types/pull-request";

export type IssueSort = "updated" | "created";
export type IssueStateFilter = "all" | "open" | "closed";

/**
 * ダッシュボード中央〜右カラムに何を表示しているか（#1058）。
 * Issue一覧とマージ待ちPR一覧は同じ画面内で切り替える別ペインで、Issue用の絞り込み条件とは
 * 直交する。ただしURLの持ち方を揃えたいのと、ビュー切り替えと同時に1回のURL更新で
 * 反映したい（別フックに分けると2回のrouter.replaceが競合する）ため、ここで一緒に扱う。
 *
 * `flow`はIssue・ブランチ・PRの関係を1画面で見る「ブランチ」画面（#1455）。
 * 一覧と詳細の2カラムを持たず、中央〜右を1カラムで使う。
 *
 * `preview`は確認環境（#2444）。developの最新をサブPCで動かして画面で確かめる。`flow`と同じく
 * 1カラムで、Issueの絞り込み条件とは無関係。
 *
 * `usage`はAI使用量（#2504）。サブPCのローカルセッションが使ったトークンを見る。これも1カラム。
 *
 * `releases`はリリース履歴（#2726）。全リポジトリのGitHub Releaseを時系列で見る。
 * `preview`と同じくホームのメニューからのドリルダウンだけで開き、ボトムナビのタブは持たない。
 */
export type DashboardPane = "issues" | "pull-requests" | "flow" | "preview" | "usage" | "releases";

function parsePane(value: string | null): DashboardPane {
  if (
    value === "pull-requests" ||
    value === "flow" ||
    value === "preview" ||
    value === "usage" ||
    value === "releases"
  ) {
    return value;
  }
  return "issues";
}

export type IssueFilters = {
  view: NavViewId;
  pane: DashboardPane;
  /**
   * PRペインで表示している状態別ビュー（#1312）。`pr`と同じくPC・スマホで同じクエリを使う。
   */
  prview: PullRequestViewId;
  /**
   * PRペインで詳細を開いているPRのid（`<owner>/<repo>#<番号>`）。未選択はnull。
   * PC・スマホで同じクエリを使う（スマホは選択中かどうかで一覧と詳細の画面を切り替える）。
   */
  pr: string | null;
  /**
   * 画面に重ねてPR詳細を開いているPRのid（#2149）。未選択はnull。
   *
   * `pr`（PRペイン・スマホのPR詳細画面の選択）とは**別のクエリにする**。重ね表示は下の画面を
   * 残したまま出るもので、`pr`はスマホのPR詳細画面（`mscreen=pull-requests`）が既に使って
   * いるため、同じクエリだと条件が重なる。ペインと違って一覧・詳細の2カラムを持たない。
   */
  prmodal: string | null;
  /**
   * PC版で詳細を開いているIssueのid（`String(githubIssueId)`。スマホの`missue`と同じ識別子）。
   * 未選択はnull。#688では初期表示用の読み取り専用クエリだったが、戻る操作で前の画面へ
   * 戻れるようにするため、PC版の選択中Issueもこのクエリを正とする（#1396）。
   */
  issue: string | null;
  q: string;
  repos: string[];
  state: IssueStateFilter;
  labels: string[];
  assignee: string | null;
  sort: IssueSort;
};

const DEFAULT_FILTERS: IssueFilters = {
  view: "all",
  pane: "issues",
  prview: DEFAULT_PULL_REQUEST_VIEW,
  pr: null,
  prmodal: null,
  issue: null,
  q: "",
  repos: [],
  state: "open",
  labels: [],
  assignee: null,
  sort: "created",
};

// ビューによってstateの既定値が変わる（「直近main反映済み」はcloseされたissueが対象のため
// all）ので、省略時の値はビューを踏まえて解決する。
function resolveDefaultFilters(view: NavViewId): IssueFilters {
  return { ...DEFAULT_FILTERS, state: getNavViewDefaultState(view) };
}

function applyFilterParam<K extends keyof IssueFilters>(
  params: URLSearchParams,
  key: K,
  value: IssueFilters[K],
  defaults: IssueFilters,
) {
  if (
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    value === defaults[key]
  ) {
    params.delete(key);
  } else if (Array.isArray(value)) {
    params.set(key, value.join(","));
  } else {
    params.set(key, String(value));
  }
}

/**
 * 変えると現在地が変わる（＝履歴を積む）キー。残りは絞り込み条件で、変えても見ている場所は
 * 同じなので履歴を積まない（#1396）。
 */
const NAVIGATION_KEYS: ReadonlySet<keyof IssueFilters> = new Set([
  "view",
  "pane",
  "prview",
  "pr",
  "prmodal",
  "issue",
]);

function resolveHistoryMode(keys: (keyof IssueFilters)[]): HistoryMode {
  return keys.some((key) => NAVIGATION_KEYS.has(key)) ? "push" : "replace";
}

export function useIssueFilters() {
  const searchParams = useSearchParams();
  const { navigateParams } = useHistoryNavigation();

  // 状態がユーザーの明示的な選択かどうか。既定値と同じ状態はクエリに残さない運用のため、
  // クエリの有無がそのまま「明示的に選ばれているか」になる（ビュー切り替え時の判断に使う）。
  const isStateExplicit = ["all", "open", "closed"].includes(searchParams.get("state") ?? "");

  const filters = useMemo<IssueFilters>(() => {
    const viewParam = searchParams.get("view");
    const prViewParam = searchParams.get("prview");
    const stateParam = searchParams.get("state");
    const labelsParam = searchParams.get("labels");
    const reposParam = searchParams.get("repos");
    const sortParam = searchParams.get("sort");

    const view = isNavViewId(viewParam) ? viewParam : DEFAULT_FILTERS.view;

    return {
      view,
      pane: parsePane(searchParams.get("pane")),
      prview: isPullRequestViewId(prViewParam) ? prViewParam : DEFAULT_FILTERS.prview,
      pr: searchParams.get("pr"),
      prmodal: searchParams.get("prmodal"),
      issue: searchParams.get("issue"),
      q: searchParams.get("q") ?? DEFAULT_FILTERS.q,
      repos: reposParam ? reposParam.split(",").filter(Boolean) : [],
      state:
        stateParam === "open" || stateParam === "closed" || stateParam === "all"
          ? stateParam
          : getNavViewDefaultState(view),
      labels: labelsParam ? labelsParam.split(",").filter(Boolean) : [],
      assignee: searchParams.get("assignee"),
      sort: sortParam === "updated" ? "updated" : DEFAULT_FILTERS.sort,
    };
  }, [searchParams]);

  // historyを明示しない場合は、変更するキーが現在地を変えるものかどうかで決まる。
  const setFilter = useCallback(
    <K extends keyof IssueFilters>(
      key: K,
      value: IssueFilters[K],
      options?: { history?: HistoryMode },
    ) => {
      const nextView = key === "view" ? (value as NavViewId) : filters.view;
      navigateParams(
        (params) => applyFilterParam(params, key, value, resolveDefaultFilters(nextView)),
        { history: options?.history ?? resolveHistoryMode([key]) },
      );
    },
    [navigateParams, filters.view],
  );

  // 複数フィールドを1回のURL更新でまとめて反映する（ビュー切り替えなど、
  // setFilterの連続呼び出しだと互いの変更を上書きしてしまうケース向け）。
  const setFilters = useCallback(
    (patch: Partial<IssueFilters>, options?: { history?: HistoryMode }) => {
      const keys = Object.keys(patch) as (keyof IssueFilters)[];
      const defaults = resolveDefaultFilters(patch.view ?? filters.view);
      navigateParams(
        (params) => {
          for (const key of keys) {
            applyFilterParam(params, key, patch[key] as IssueFilters[typeof key], defaults);
          }
        },
        { history: options?.history ?? resolveHistoryMode(keys) },
      );
    },
    [navigateParams, filters.view],
  );

  // サイドメニュー等でのビュー切り替え。切り替え先ビューが状態を要求する場合は状態も
  // 併せて自動で切り替える（「main反映済(直近)」をopen絞り込みのまま開くと0件になるため）。
  const selectView = useCallback(
    (view: NavViewId) => {
      setFilters({
        view,
        state: resolveStateOnViewChange(view, filters.view, filters.state, isStateExplicit),
        // Issueのビューを選んだらIssueペインへ戻す。PRペインを開いたままビューだけ変わると
        // 左メニューの選択と表示内容が食い違って見えるため。
        pane: "issues",
        pr: null,
        // 重ねて開いていたPR詳細も畳む（#2149）。下の画面が変わったのに重ね表示だけ残ると、
        // 閉じた先が押したときの一覧ではなくなる。
        prmodal: null,
        // ビューを切り替えたら選択中Issueも畳む。別のビューの一覧に、そこに並んでいない
        // Issueの詳細が残るのを避ける（1回のURL更新にまとめないと互いの変更を落とす）。
        issue: null,
      });
    },
    [setFilters, filters.view, filters.state, isStateExplicit],
  );

  // 左メニューのPull Requestセクションからの遷移（#1312）。ペインとビューを1回のURL更新で
  // まとめて反映する（setFilterを2回呼ぶと後の1回が前の1回の変更を落とす）。
  const selectPullRequestView = useCallback(
    (prview: PullRequestViewId) => {
      // ビューを切り替えるときは選択中PRを畳む。PRは開きっぱなしにする対象ではなく
      // （マージすれば一覧から消える）、戻ってきたときに存在しないPRの詳細が残るのを避ける。
      setFilters({ pane: "pull-requests", prview, pr: null, prmodal: null });
    },
    [setFilters],
  );

  // 左メニューの「ブランチ」画面への遷移（#1455）。この画面はPRの選択状態を持たない
  // ので、開くときに選択中PRを畳んでおく（戻ってきたときに前のPRが残らないようにする）。
  const selectFlowPane = useCallback(() => {
    setFilters({ pane: "flow", pr: null, prmodal: null });
  }, [setFilters]);

  // 左メニューの「確認環境」画面への遷移（#2444）。「ブランチ」と同じくPRの選択状態を持たない。
  const selectPreviewPane = useCallback(() => {
    setFilters({ pane: "preview", pr: null, prmodal: null });
  }, [setFilters]);

  // 左メニューの「AI使用量」画面への遷移（#2504）。上の2つと同じくPRの選択状態を持たない。
  const selectUsagePane = useCallback(() => {
    setFilters({ pane: "usage", pr: null, prmodal: null });
  }, [setFilters]);

  // 左メニューの「リリース履歴」画面への遷移（#2726）。上と同じくPRの選択状態を持たない。
  const selectReleaseHistoryPane = useCallback(() => {
    setFilters({ pane: "releases", pr: null, prmodal: null });
  }, [setFilters]);

  // PRを開くのは現在地が進む操作なので履歴を積む。閉じる側（null）は戻る操作・マージ後の
  // 後始末で呼ばれるため積まない（積むと戻る操作が往復を増やすだけになる。#1396）。
  const selectPullRequest = useCallback(
    (pullRequestId: string | null) => {
      setFilter("pr", pullRequestId, { history: pullRequestId ? "push" : "replace" });
    },
    [setFilter],
  );

  // 画面に重ねてPR詳細を開く・閉じる（#2149）。履歴の積み方は`selectPullRequest`と同じで、
  // 開くときだけ積む——戻る操作（スマホのスワイプを含む）で閉じられるようにするため。
  const selectPullRequestModal = useCallback(
    (pullRequestId: string | null) => {
      setFilter("prmodal", pullRequestId, { history: pullRequestId ? "push" : "replace" });
    },
    [setFilter],
  );

  const toggleLabel = useCallback(
    (name: string) => {
      const next = filters.labels.includes(name)
        ? filters.labels.filter((label) => label !== name)
        : [...filters.labels, name];
      setFilter("labels", next);
    },
    [filters.labels, setFilter],
  );

  // リポジトリは複数選択できる。選択済みのリポジトリをもう一度選ぶと選択解除される（#775）。
  const toggleRepo = useCallback(
    (fullName: string) => {
      const next = filters.repos.includes(fullName)
        ? filters.repos.filter((repo) => repo !== fullName)
        : [...filters.repos, fullName];
      setFilter("repos", next);
    },
    [filters.repos, setFilter],
  );

  return {
    filters,
    setFilter,
    setFilters,
    selectView,
    selectPullRequestView,
    selectFlowPane,
    selectPreviewPane,
    selectUsagePane,
    selectReleaseHistoryPane,
    selectPullRequest,
    selectPullRequestModal,
    toggleLabel,
    toggleRepo,
  };
}
