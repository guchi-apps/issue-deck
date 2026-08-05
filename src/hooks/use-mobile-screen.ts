"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useTransition } from "react";

import type { MobileBottomNavTab } from "@/components/dashboard/mobile-bottom-nav";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";
import {
  getNavViewDefaultState,
  isNavViewId,
  resolveStateOnViewChange,
} from "@/lib/nav-views";
import type { Issue, NavViewId } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";
import type { QuickFilter } from "@/types/quick-filter";

export type MobileScreen =
  | { kind: "home" }
  | {
      kind: "issues";
      view: NavViewId;
      labels: string[];
      state: IssueStateFilter;
      assignee: string | null;
      sort: IssueSort;
      returnToIssueId: string | null;
    }
  | { kind: "repos" }
  | { kind: "settings" }
  | {
      kind: "repo-detail";
      repository: ConnectedRepository;
      view: NavViewId;
      labels: string[];
      state: IssueStateFilter;
      assignee: string | null;
      sort: IssueSort;
      returnToIssueId: string | null;
      back: MobileScreen;
    }
  | { kind: "issue-detail"; issue: Issue; back: MobileScreen };

// スマホ画面の現在地をURLクエリ（mscreen/mrepo/missue/mview/mlabels/mstate/massignee/msort）に保持する。
// ステートのみで管理するとページ更新時に必ずホーム画面へ戻ってしまい、Issue詳細から一覧へ
// 戻ったときにも絞り込み条件（状態・担当者・並び順・ラベル）がリセットされてしまうため（#318）。
export function useMobileScreen(issues: Issue[], repositories: ConnectedRepository[]) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const screenParam = searchParams.get("mscreen");
  const repoParam = searchParams.get("mrepo");
  const issueParam = searchParams.get("missue");
  const viewParam = searchParams.get("mview");
  const labelsParam = searchParams.get("mlabels");
  const stateParam = searchParams.get("mstate");
  const assigneeParam = searchParams.get("massignee");
  const sortParam = searchParams.get("msort");
  const labels = useMemo(
    () => (labelsParam ? labelsParam.split(",").filter(Boolean) : []),
    [labelsParam],
  );
  const view: NavViewId = isNavViewId(viewParam) ? viewParam : "all";
  // stateクエリ未指定時の既定値はビューによって変わる（「直近main反映済み」はclose済み
  // issueが対象のためall）。明示的に選ばれているかどうかは、ビュー切り替え時に
  // 状態を引き継ぐべきかの判断にも使う。
  const isStateExplicit =
    stateParam === "all" || stateParam === "closed" || stateParam === "open";
  const state: IssueStateFilter = isStateExplicit
    ? (stateParam as IssueStateFilter)
    : getNavViewDefaultState(view);
  const assignee = assigneeParam ?? null;
  const sort: IssueSort = sortParam === "updated" ? "updated" : "created";

  const mobileScreen = useMemo<MobileScreen>(() => {
    if (screenParam === "issue-detail") {
      const issue = issues.find((item) => item.id === issueParam);
      if (!issue) return { kind: "home" };

      const repository = repoParam
        ? repositories.find((repo) => repo.fullName === repoParam)
        : undefined;
      const back: MobileScreen = repository
        ? {
            kind: "repo-detail",
            repository,
            view,
            labels,
            state,
            assignee,
            sort,
            returnToIssueId: null,
            back: { kind: "repos" },
          }
        : {
            kind: "issues",
            view,
            labels,
            state,
            assignee,
            sort,
            returnToIssueId: null,
          };

      return { kind: "issue-detail", issue, back };
    }

    if (screenParam === "repo-detail") {
      const repository = repositories.find((repo) => repo.fullName === repoParam);
      if (!repository) return { kind: "home" };
      return {
        kind: "repo-detail",
        repository,
        view,
        labels,
        state,
        assignee,
        sort,
        returnToIssueId: issueParam,
        back: { kind: "repos" },
      };
    }

    if (screenParam === "issues") {
      return {
        kind: "issues",
        view,
        labels,
        state,
        assignee,
        sort,
        returnToIssueId: issueParam,
      };
    }

    if (screenParam === "repos" || screenParam === "settings") {
      return { kind: screenParam };
    }

    return { kind: "home" };
  }, [screenParam, repoParam, issueParam, view, labels, state, assignee, sort, issues, repositories]);

  const navigate = useCallback(
    (
      next: {
        screen: MobileBottomNavTab | "issue-detail" | "repo-detail";
        repo?: string | null;
        issue?: string | null;
        view?: NavViewId | null;
        labels?: string[] | null;
        state?: IssueStateFilter | null;
        assignee?: string | null;
        sort?: IssueSort | null;
      },
      options?: { silent?: boolean },
    ) => {
      const params = new URLSearchParams(searchParams.toString());

      if (next.screen === "home") {
        params.delete("mscreen");
      } else {
        params.set("mscreen", next.screen);
      }

      if (next.repo) {
        params.set("mrepo", next.repo);
      } else {
        params.delete("mrepo");
      }

      if (next.issue) {
        params.set("missue", next.issue);
      } else {
        params.delete("missue");
      }

      if (next.view) {
        params.set("mview", next.view);
      } else {
        params.delete("mview");
      }

      if (next.labels && next.labels.length > 0) {
        params.set("mlabels", next.labels.join(","));
      } else {
        params.delete("mlabels");
      }

      // 既定値と同じstateはクエリに残さない。既定値はビューによって変わる。
      if (next.state && next.state !== getNavViewDefaultState(next.view ?? "all")) {
        params.set("mstate", next.state);
      } else {
        params.delete("mstate");
      }

      if (next.assignee) {
        params.set("massignee", next.assignee);
      } else {
        params.delete("massignee");
      }

      if (next.sort && next.sort !== "created") {
        params.set("msort", next.sort);
      } else {
        params.delete("msort");
      }

      const url = `${pathname}?${params.toString()}`;

      // 画面遷移用のクエリ変更はページ全体のデータ再取得を伴うため、遷移完了までに間が
      // 生じうる。startTransitionでラップしisPendingを公開し、その間はスケルトンを表示する（#221）。
      // ただし絞り込みシート内での連続操作（silent）はスクリーン種別を変えず、都度スケルトンで
      // 画面を差し替えるとシートごとアンマウントされ選択を続けられなくなるため、対象外とする（#393）。
      if (options?.silent) {
        router.replace(url, { scroll: false });
      } else {
        startTransition(() => {
          router.replace(url, { scroll: false });
        });
      }
    },
    [router, pathname, searchParams],
  );

  const selectTab = useCallback((tab: MobileBottomNavTab) => navigate({ screen: tab }), [navigate]);

  const selectRepository = useCallback(
    (repository: ConnectedRepository) => navigate({ screen: "repo-detail", repo: repository.fullName }),
    [navigate],
  );

  const selectQuickView = useCallback(
    (nextView: NavViewId) =>
      navigate({
        screen: "issues",
        view: nextView,
        labels: mobileScreen.kind === "issues" ? mobileScreen.labels : undefined,
        // 遷移先ビューが状態を要求するなら自動で切り替え、要求しないなら現在の条件を保つ。
        // ホームから選んだ場合は絞り込み条件がクエリごと消えている（isStateExplicit=false）ため、
        // 同じ解決で遷移先ビューの既定値に落ちる。
        state: resolveStateOnViewChange(nextView, view, state, isStateExplicit),
        assignee: mobileScreen.kind === "issues" ? mobileScreen.assignee : undefined,
        sort: mobileScreen.kind === "issues" ? mobileScreen.sort : undefined,
      }),
    [navigate, mobileScreen, view, state, isStateExplicit],
  );

  // ホーム画面の「保存したフィルター」選択時、絞り込み条件をすべて置き換えてIssue一覧へ遷移する。
  const applyQuickFilter = useCallback(
    (quickFilter: QuickFilter) =>
      navigate({
        screen: "issues",
        view: quickFilter.view,
        labels: quickFilter.labels,
        state: quickFilter.state,
        assignee: quickFilter.assignee,
        sort: quickFilter.sort,
      }),
    [navigate],
  );

  const selectIssue = useCallback(
    (issue: Issue) =>
      navigate({
        screen: "issue-detail",
        issue: issue.id,
        repo: mobileScreen.kind === "repo-detail" ? mobileScreen.repository.fullName : null,
        view:
          mobileScreen.kind === "issues" || mobileScreen.kind === "repo-detail"
            ? mobileScreen.view
            : null,
        labels:
          mobileScreen.kind === "issues" || mobileScreen.kind === "repo-detail"
            ? mobileScreen.labels
            : null,
        state:
          mobileScreen.kind === "issues" || mobileScreen.kind === "repo-detail"
            ? mobileScreen.state
            : null,
        assignee:
          mobileScreen.kind === "issues" || mobileScreen.kind === "repo-detail"
            ? mobileScreen.assignee
            : null,
        sort:
          mobileScreen.kind === "issues" || mobileScreen.kind === "repo-detail"
            ? mobileScreen.sort
            : null,
      }),
    [navigate, mobileScreen],
  );

  // Issue一覧・リポジトリ別Issue一覧の画面内で絞り込みシート・タブ操作により変更された条件を
  // URLへ反映する。詳細画面への遷移でコンポーネントがアンマウントされても、URLがsource of
  // truthのため「戻る」で復元できる（#318）。
  const updateListFilters = useCallback(
    (patch: {
      view?: NavViewId;
      labels?: string[];
      state?: IssueStateFilter;
      assignee?: string | null;
      sort?: IssueSort;
    }) => {
      if (mobileScreen.kind !== "issues" && mobileScreen.kind !== "repo-detail") return;

      // 絞り込みシートで状態を選んだときはその選択が最優先。ビューだけを切り替えたときは、
      // 切り替え先ビューの要求・現在の明示選択を踏まえて状態を解決する（#475）。
      const nextState =
        patch.state ??
        resolveStateOnViewChange(
          patch.view ?? mobileScreen.view,
          mobileScreen.view,
          mobileScreen.state,
          isStateExplicit,
        );

      navigate(
        {
          screen: mobileScreen.kind === "issues" ? "issues" : "repo-detail",
          repo: mobileScreen.kind === "repo-detail" ? mobileScreen.repository.fullName : null,
          issue: mobileScreen.returnToIssueId,
          view: patch.view ?? mobileScreen.view,
          labels: patch.labels ?? mobileScreen.labels,
          state: nextState,
          assignee: patch.assignee !== undefined ? patch.assignee : mobileScreen.assignee,
          sort: patch.sort ?? mobileScreen.sort,
        },
        { silent: true },
      );
    },
    [navigate, mobileScreen, isStateExplicit],
  );

  const goBack = useCallback(() => {
    if (mobileScreen.kind !== "issue-detail" && mobileScreen.kind !== "repo-detail") {
      navigate({ screen: "home" });
      return;
    }

    const back = mobileScreen.back;
    const returnIssueId = mobileScreen.kind === "issue-detail" ? mobileScreen.issue.id : null;
    if (back.kind === "repo-detail") {
      navigate({
        screen: "repo-detail",
        repo: back.repository.fullName,
        issue: returnIssueId,
        view: back.view,
        labels: back.labels,
        state: back.state,
        assignee: back.assignee,
        sort: back.sort,
      });
    } else if (back.kind === "issues") {
      navigate({
        screen: "issues",
        view: back.view,
        labels: back.labels,
        issue: returnIssueId,
        state: back.state,
        assignee: back.assignee,
        sort: back.sort,
      });
    } else {
      navigate({ screen: back.kind });
    }
  }, [mobileScreen, navigate]);

  return {
    mobileScreen,
    isPending,
    selectTab,
    selectRepository,
    selectIssue,
    selectQuickView,
    applyQuickFilter,
    updateListFilters,
    goBack,
  };
}
