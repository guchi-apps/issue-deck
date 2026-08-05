"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import { getNavViewDefaultState, isNavViewId } from "@/lib/nav-views";
import type { NavViewId } from "@/types/issue";

export type IssueSort = "updated" | "created";
export type IssueStateFilter = "all" | "open" | "closed";

export type IssueFilters = {
  view: NavViewId;
  q: string;
  repo: string | null;
  state: IssueStateFilter;
  labels: string[];
  assignee: string | null;
  sort: IssueSort;
};

const DEFAULT_FILTERS: IssueFilters = {
  view: "all",
  q: "",
  repo: null,
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

  const filters = useMemo<IssueFilters>(() => {
    const viewParam = searchParams.get("view");
    const stateParam = searchParams.get("state");
    const labelsParam = searchParams.get("labels");
    const sortParam = searchParams.get("sort");

    const view = isNavViewId(viewParam) ? viewParam : DEFAULT_FILTERS.view;

    return {
      view,
      q: searchParams.get("q") ?? DEFAULT_FILTERS.q,
      repo: searchParams.get("repo"),
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

  const toggleLabel = useCallback(
    (name: string) => {
      const next = filters.labels.includes(name)
        ? filters.labels.filter((label) => label !== name)
        : [...filters.labels, name];
      setFilter("labels", next);
    },
    [filters.labels, setFilter],
  );

  return { filters, setFilter, setFilters, toggleLabel };
}
