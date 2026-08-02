"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useTransition } from "react";

import type { MobileBottomNavTab } from "@/components/dashboard/mobile-bottom-nav";
import { navViews } from "@/lib/nav-views";
import type { Issue, NavViewId } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

export type MobileScreen =
  | { kind: "home" }
  | { kind: "issues"; view: NavViewId; returnToIssueId: string | null }
  | { kind: "repos" }
  | { kind: "settings" }
  | {
      kind: "repo-detail";
      repository: ConnectedRepository;
      returnToIssueId: string | null;
      back: MobileScreen;
    }
  | { kind: "issue-detail"; issue: Issue; back: MobileScreen };

function isNavViewId(value: string | null): value is NavViewId {
  return value !== null && navViews.some((view) => view.id === value);
}

// スマホ画面の現在地をURLクエリ（mscreen/mrepo/missue）に保持する。
// ステートのみで管理するとページ更新時に必ずホーム画面へ戻ってしまうため。
export function useMobileScreen(issues: Issue[], repositories: ConnectedRepository[]) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const screenParam = searchParams.get("mscreen");
  const repoParam = searchParams.get("mrepo");
  const issueParam = searchParams.get("missue");
  const viewParam = searchParams.get("mview");

  const mobileScreen = useMemo<MobileScreen>(() => {
    if (screenParam === "issue-detail") {
      const issue = issues.find((item) => item.id === issueParam);
      if (!issue) return { kind: "home" };

      const repository = repoParam
        ? repositories.find((repo) => repo.fullName === repoParam)
        : undefined;
      const back: MobileScreen = repository
        ? { kind: "repo-detail", repository, returnToIssueId: null, back: { kind: "repos" } }
        : { kind: "issues", view: isNavViewId(viewParam) ? viewParam : "all", returnToIssueId: null };

      return { kind: "issue-detail", issue, back };
    }

    if (screenParam === "repo-detail") {
      const repository = repositories.find((repo) => repo.fullName === repoParam);
      if (!repository) return { kind: "home" };
      return { kind: "repo-detail", repository, returnToIssueId: issueParam, back: { kind: "repos" } };
    }

    if (screenParam === "issues") {
      return {
        kind: "issues",
        view: isNavViewId(viewParam) ? viewParam : "all",
        returnToIssueId: issueParam,
      };
    }

    if (screenParam === "repos" || screenParam === "settings") {
      return { kind: screenParam };
    }

    return { kind: "home" };
  }, [screenParam, repoParam, issueParam, viewParam, issues, repositories]);

  const navigate = useCallback(
    (next: {
      screen: MobileBottomNavTab | "issue-detail" | "repo-detail";
      repo?: string | null;
      issue?: string | null;
      view?: NavViewId | null;
    }) => {
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

      // 画面遷移用のクエリ変更はページ全体のデータ再取得を伴うため、遷移完了までに間が
      // 生じうる。startTransitionでラップしisPendingを公開し、その間はスケルトンを表示する（#221）。
      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      });
    },
    [router, pathname, searchParams],
  );

  const selectTab = useCallback((tab: MobileBottomNavTab) => navigate({ screen: tab }), [navigate]);

  const selectRepository = useCallback(
    (repository: ConnectedRepository) => navigate({ screen: "repo-detail", repo: repository.fullName }),
    [navigate],
  );

  const selectQuickView = useCallback(
    (view: NavViewId) => navigate({ screen: "issues", view }),
    [navigate],
  );

  const selectIssue = useCallback(
    (issue: Issue) =>
      navigate({
        screen: "issue-detail",
        issue: issue.id,
        repo: mobileScreen.kind === "repo-detail" ? mobileScreen.repository.fullName : null,
        view: mobileScreen.kind === "issues" ? mobileScreen.view : null,
      }),
    [navigate, mobileScreen],
  );

  const goBack = useCallback(() => {
    if (mobileScreen.kind !== "issue-detail" && mobileScreen.kind !== "repo-detail") {
      navigate({ screen: "home" });
      return;
    }

    const back = mobileScreen.back;
    const returnIssueId = mobileScreen.kind === "issue-detail" ? mobileScreen.issue.id : null;
    if (back.kind === "repo-detail") {
      navigate({ screen: "repo-detail", repo: back.repository.fullName, issue: returnIssueId });
    } else if (back.kind === "issues") {
      navigate({ screen: "issues", view: back.view, issue: returnIssueId });
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
    goBack,
  };
}
