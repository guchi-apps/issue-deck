"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

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

function applyFilterParam<K extends keyof IssueFilters>(
  params: URLSearchParams,
  key: K,
  value: IssueFilters[K],
) {
  if (
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    value === DEFAULT_FILTERS[key]
  ) {
    params.delete(key);
  } else if (Array.isArray(value)) {
    params.set(key, value.join(","));
  } else {
    params.set(key, String(value));
  }
}

function isNavViewId(value: string | null): value is NavViewId {
  return (
    value === "all" ||
    value === "assigned" ||
    value === "created" ||
    value === "favorites" ||
    value === "recent"
  );
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

    return {
      view: isNavViewId(viewParam) ? viewParam : DEFAULT_FILTERS.view,
      q: searchParams.get("q") ?? DEFAULT_FILTERS.q,
      repo: searchParams.get("repo"),
      state:
        stateParam === "open" || stateParam === "closed" || stateParam === "all"
          ? stateParam
          : DEFAULT_FILTERS.state,
      labels: labelsParam ? labelsParam.split(",").filter(Boolean) : [],
      assignee: searchParams.get("assignee"),
      sort: sortParam === "updated" ? "updated" : DEFAULT_FILTERS.sort,
    };
  }, [searchParams]);

  const setFilter = useCallback(
    <K extends keyof IssueFilters>(key: K, value: IssueFilters[K]) => {
      const params = new URLSearchParams(searchParams.toString());
      applyFilterParam(params, key, value);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  // 複数フィルターを1回のURL更新でまとめて反映する。setFilterを連続呼び出しすると
  // 各呼び出しが同じ古いsearchParamsを基点にrouter.replaceし合い、最後の呼び出し以外の
  // 変更が失われるため、一括更新が必要な場合はこちらを使う。
  const setFilters = useCallback(
    (updates: Partial<IssueFilters>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const key of Object.keys(updates) as (keyof IssueFilters)[]) {
        applyFilterParam(params, key, updates[key] as IssueFilters[typeof key]);
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
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
