"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import {
  getNavViewDefaultState,
  isNavViewId,
  resolveStateOnViewChange,
} from "@/lib/nav-views";
import type { NavViewId } from "@/types/issue";

export type IssueSort = "updated" | "created";
export type IssueStateFilter = "all" | "open" | "closed";

/**
 * ダッシュボード中央〜右カラムに何を表示しているか（#1058）。
 * Issue一覧とマージ待ちPR一覧は同じ画面内で切り替える別ペインで、Issue用の絞り込み条件とは
 * 直交する。ただしURLの持ち方を揃えたいのと、ビュー切り替えと同時に1回のURL更新で
 * 反映したい（別フックに分けると2回のrouter.replaceが競合する）ため、ここで一緒に扱う。
 */
export type DashboardPane = "issues" | "pull-requests";

export type IssueFilters = {
  view: NavViewId;
  pane: DashboardPane;
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

export function useIssueFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // 状態がユーザーの明示的な選択かどうか。既定値と同じ状態はクエリに残さない運用のため、
  // クエリの有無がそのまま「明示的に選ばれているか」になる（ビュー切り替え時の判断に使う）。
  const isStateExplicit = ["all", "open", "closed"].includes(searchParams.get("state") ?? "");

  const filters = useMemo<IssueFilters>(() => {
    const viewParam = searchParams.get("view");
    const stateParam = searchParams.get("state");
    const labelsParam = searchParams.get("labels");
    const reposParam = searchParams.get("repos");
    const sortParam = searchParams.get("sort");

    const view = isNavViewId(viewParam) ? viewParam : DEFAULT_FILTERS.view;

    return {
      view,
      pane: searchParams.get("pane") === "pull-requests" ? "pull-requests" : "issues",
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

  const setFilter = useCallback(
    <K extends keyof IssueFilters>(key: K, value: IssueFilters[K]) => {
      const params = new URLSearchParams(searchParams.toString());
      const nextView = key === "view" ? (value as NavViewId) : filters.view;
      applyFilterParam(params, key, value, resolveDefaultFilters(nextView));
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams, filters.view],
  );

  // 複数フィールドを1回のURL更新でまとめて反映する（よく使うフィルター適用など、
  // setFilterの連続呼び出しだと互いの変更を上書きしてしまうケース向け）。
  const setFilters = useCallback(
    (patch: Partial<IssueFilters>) => {
      const params = new URLSearchParams(searchParams.toString());
      const defaults = resolveDefaultFilters(patch.view ?? filters.view);
      for (const key of Object.keys(patch) as (keyof IssueFilters)[]) {
        applyFilterParam(params, key, patch[key] as IssueFilters[typeof key], defaults);
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams, filters.view],
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
      });
    },
    [setFilters, filters.view, filters.state, isStateExplicit],
  );

  const selectPane = useCallback(
    (pane: DashboardPane) => {
      setFilter("pane", pane);
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

  return { filters, setFilter, setFilters, selectView, selectPane, toggleLabel, toggleRepo };
}
