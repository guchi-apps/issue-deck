"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import type { MobileBottomNavTab } from "@/components/dashboard/mobile-bottom-nav";
import { useHistoryNavigation, type HistoryMode } from "@/hooks/use-history-navigation";
import type { IssueSort, IssueStateFilter } from "@/hooks/use-issue-filters";
import {
  getNavViewDefaultState,
  isNavViewId,
  resolveStateOnViewChange,
} from "@/lib/nav-views";
import { DEFAULT_PULL_REQUEST_VIEW } from "@/lib/pull-request-views";
import type { Issue, NavViewId } from "@/types/issue";
import type { PullRequestViewId } from "@/types/pull-request";
import type { ConnectedRepository } from "@/types/repository";

/**
 * 全リポジトリ横断のIssue一覧（`mscreen=issues`）をどこから開いたか。URLの`mfrom`が正で、
 * 未指定は`tab`。戻り先（`goBack`）とフッターの点灯（`resolveBottomNavTab`）に効く。
 */
export type MobileIssuesOrigin = "tab" | "home" | "repos";

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
      // ボトムナビの「Issue」タブから直接開いたか（"tab"）、ホームの「よくつかう
      // フィルター」「保存したフィルター」からのドリルダウンか（"home"）、「Issue」タブの
      // リポジトリ一覧にある「すべてのリポジトリのIssue」からか（"repos"、#1951）。
      // "tab"以外は戻る導線（ヘッダーの戻るボタン・右スワイプ）を表示する（#525）。
      // **戻り先とフッターの点灯（`mobile-nav-tab.ts`）はこの値だけで決まる。**
      // "home"と"repos"を一緒くたにすると、リポジトリ一覧から開いたのにホームへ戻る。
      origin: MobileIssuesOrigin;
    }
  | { kind: "repos" }
  // 設定（#1638でボトムナビから外し、ホームのヘッダー右上の歯車から開く画面になった）。
  // `mscreen=settings`のURLはそのまま生きている
  | { kind: "settings" }
  // PR一覧（#1058）。どの状態別ビューを見ているかは`prview`クエリ（PCと共有）が持つ（#1312）。
  // #1436でボトムナビのタブを持つようになったため、Issue一覧と同じく遷移元（`origin`）で
  // 戻る導線の有無を切り替える（ホームの「Pull Request」からのドリルダウンでのみ出す）
  | { kind: "pull-requests"; origin: "tab" | "home" }
  // ブランチ（#1455）。当初はホームからのドリルダウンだけで開く画面だったが、
  // #1638でボトムナビの4枠目（旧「設定」）を受け取り、タブから直接開く画面になった
  | { kind: "flow" }
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

/**
 * フッターの「PR」タブから開くときのビュー（#1436・#2176）。
 *
 * **元は「実行中」だったが「マージ待ち」へ変えた（#2176）。** 実行中のPRはCIの結果を待つ
 * しかなく、タブを押した直後に手を動かせるのは「あとはマージするだけ」のPRの方。取得する
 * PRの母集団（`usePullRequests`の`scope`）はビューに依存しないので、どちらでも通信は増えない。
 *
 * 切り替えたいときは画面下端のビュー行・左右スワイプで1タップ・1スワイプで移れる
 * （`mobile-pull-requests-screen.tsx`）。`DEFAULT_PULL_REQUEST_VIEW`（`all`）は画面内のリンクから
 * マージ済みPRを直接開く経路（#1260）のための既定なので、そちらは変えない。
 */
const PULL_REQUEST_TAB_DEFAULT_VIEW: PullRequestViewId = "completed";

// スマホ画面の現在地をURLクエリ（mscreen/mrepo/missue/mview/mlabels/mstate/massignee/msort）に保持する。
// ステートのみで管理するとページ更新時に必ずホーム画面へ戻ってしまい、Issue詳細から一覧へ
// 戻ったときにも絞り込み条件（状態・担当者・並び順・ラベル）がリセットされてしまうため（#318）。
export function useMobileScreen(issues: Issue[], repositories: ConnectedRepository[]) {
  const searchParams = useSearchParams();
  const { navigateParams, goBackOrFallback } = useHistoryNavigation();

  const screenParam = searchParams.get("mscreen");
  const repoParam = searchParams.get("mrepo");
  const issueParam = searchParams.get("missue");
  const viewParam = searchParams.get("mview");
  const labelsParam = searchParams.get("mlabels");
  const stateParam = searchParams.get("mstate");
  const assigneeParam = searchParams.get("massignee");
  const sortParam = searchParams.get("msort");
  const fromParam = searchParams.get("mfrom");
  const origin: MobileIssuesOrigin =
    fromParam === "home" || fromParam === "repos" ? fromParam : "tab";
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
            origin,
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
        origin,
      };
    }

    if (screenParam === "repos") {
      return { kind: "repos" };
    }

    if (screenParam === "settings") {
      return { kind: "settings" };
    }

    if (screenParam === "pull-requests") {
      // PR一覧の遷移元は"tab"か"home"だけ（"repos"はIssue一覧のための値・#1951）
      return { kind: "pull-requests", origin: origin === "home" ? "home" : "tab" };
    }

    if (screenParam === "flow") {
      return { kind: "flow" };
    }

    return { kind: "home" };
  }, [screenParam, repoParam, issueParam, view, labels, state, assignee, sort, origin, issues, repositories]);

  const navigate = useCallback(
    (
      next: {
        // `issues`（全リポジトリ横断のIssue一覧）はフッターのタブから外れたが、ホームからの
        // ドリルダウン先としては残るため、タブの集合とは別に列挙する（#1436）。
        // `settings`も#1638でタブから外れ、ホームのヘッダーから開く画面になった
        screen: MobileBottomNavTab | "issues" | "issue-detail" | "repo-detail" | "settings";
        repo?: string | null;
        issue?: string | null;
        view?: NavViewId | null;
        labels?: string[] | null;
        state?: IssueStateFilter | null;
        assignee?: string | null;
        sort?: IssueSort | null;
        origin?: MobileIssuesOrigin | null;
        /** PR一覧の状態別ビュー（#1312）。PCと同じ`prview`クエリを共有する */
        prview?: PullRequestViewId | null;
      },
      options?: { silent?: boolean; history?: HistoryMode },
    ) => {
      const mutate = (params: URLSearchParams) => {
        if (next.screen === "home") {
          params.delete("mscreen");
        } else {
          params.set("mscreen", next.screen);
        }

        // 重ねて開いていたPR詳細は畳む（#2149）。下の画面が変わったのに重ね表示だけ残ると、
        // 閉じた先が押したときの画面ではなくなる。
        params.delete("prmodal");

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

        // PC版の選択中Issue（#1396）。スマホとPCは同じURLを共有し、どちらのレイアウトを
        // 見ているかはCSSのブレークポイントでしか決まらないため、両方の現在地を1回の更新で
        // 揃える（#1260と同じ理由）。一覧に戻ったときの`missue`は選択位置を覚えるためだけの
        // ものなので、PC側は詳細を開いている場合だけ立てる。
        if (next.screen === "issue-detail" && next.issue) {
          params.set("issue", next.issue);
        } else {
          params.delete("issue");
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

        if (next.origin === "home" || next.origin === "repos") {
          params.set("mfrom", next.origin);
        } else {
          params.delete("mfrom");
        }

        // 既定値と同じprviewはクエリに残さない（PC側のapplyFilterParamと同じ運用）。
        // 未指定（undefined）のときは現在の値をそのまま引き継ぐ。
        if (next.prview === DEFAULT_PULL_REQUEST_VIEW) {
          params.delete("prview");
        } else if (next.prview) {
          params.set("prview", next.prview);
        }
      };

      // 画面が変わる遷移だけ履歴を積む。絞り込みシート内での連続操作（silent）まで積むと、
      // 戻る操作が条件の巻き戻しに費やされて前の画面へ着かなくなる（#1396）。
      //
      // 以前はここでstartTransitionを掛け、遷移が終わるまで全画面スケルトンを出していた（#221）。
      // URLの更新がサーバーを往復しなくなり待ちが無くなったため（#1597・use-history-navigation）、
      // スケルトンごと外している。
      navigateParams(mutate, {
        history: options?.history ?? (options?.silent ? "replace" : "push"),
      });
    },
    [navigateParams],
  );

  const selectTab = useCallback(
    (tab: MobileBottomNavTab) =>
      navigate(
        tab === "pull-requests"
          ? { screen: tab, prview: PULL_REQUEST_TAB_DEFAULT_VIEW }
          : { screen: tab },
      ),
    [navigate],
  );

  // ホームからPR一覧へ遷移する（#1058）。Issueの絞り込み条件は引き継がない。
  // どの状態別ビューを開くかはホームで選んだ項目が決める（#1312）。
  // フッターのタブから開いた場合と区別して戻る導線を出すため、遷移元を残す（#1436）。
  const selectPullRequests = useCallback(
    (prview: PullRequestViewId) =>
      navigate({ screen: "pull-requests", prview, origin: "home" }),
    [navigate],
  );

  // PR一覧の画面内タブでビューを切り替える（#1436）。Issue一覧のタブ切り替え
  // （updateListFilters）と同じくsilent＝履歴を積まず、スケルトンも挟まない。
  // 同じ見た目の操作なのに戻る操作の重みが画面ごとに変わると読めなくなるため（#1396）。
  const selectPullRequestView = useCallback(
    (prview: PullRequestViewId) =>
      navigate(
        {
          screen: "pull-requests",
          prview,
          origin: mobileScreen.kind === "pull-requests" ? mobileScreen.origin : undefined,
        },
        { silent: true },
      ),
    [navigate, mobileScreen],
  );

  // ホームのヘッダーから設定画面へ遷移する（#1638）。フッターのタブから外したため、
  // `selectTab`ではなくこちらを使う。戻る導線はヘッダーの戻るボタン（goBack）が受け持つ。
  const selectSettings = useCallback(() => navigate({ screen: "settings" }), [navigate]);

  const selectRepository = useCallback(
    (repository: ConnectedRepository) => navigate({ screen: "repo-detail", repo: repository.fullName }),
    [navigate],
  );

  // Issue詳細画面のリポジトリ名クリックなど、ConnectedRepositoryオブジェクトを持たず
  // fullNameだけが分かっている場合の遷移用（#997）。
  const selectRepositoryByFullName = useCallback(
    (fullName: string) => navigate({ screen: "repo-detail", repo: fullName }),
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
        // ホームの「よくつかうフィルター」からの遷移のため、戻る導線を有効にする（#525）。
        origin: "home",
      }),
    [navigate, mobileScreen, view, state, isStateExplicit],
  );

  // 「Issue」タブのリポジトリ一覧から、全リポジトリ横断のIssue一覧を開く（#1951）。
  // ホームの「よくつかうフィルター」（selectQuickView）と違い、絞り込み条件は引き継がずに
  // 「すべてのIssue」の既定の状態で開く——リポジトリ一覧には引き継ぐ条件が無い。
  const selectAllIssues = useCallback(
    () => navigate({ screen: "issues", view: "all", origin: "repos" }),
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
        origin: mobileScreen.kind === "issues" ? mobileScreen.origin : undefined,
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
          // フィルター変更・タブ切替では遷移元は変わらないため、戻る導線の有無を維持する（#525）。
          origin: mobileScreen.kind === "issues" ? mobileScreen.origin : undefined,
        },
        { silent: true },
      );
    },
    [navigate, mobileScreen, isStateExplicit],
  );

  // ヘッダーの戻るボタン・右スワイプ（#525）。ブラウザ・OSの戻ると同じ位置へ着かせたいので、
  // 自分が積んだ履歴があるならそれを巻き戻す（#1396）。共有URLで詳細画面をいきなり開いた
  // 場合は巻き戻せる履歴が無いため、従来どおり戻り先を計算して遷移する。こちらは戻る操作
  // なので履歴を積まない（積むと戻る操作のたびに履歴が伸びていく）。
  const goBack = useCallback(() => {
    goBackOrFallback(() => {
      if (mobileScreen.kind !== "issue-detail" && mobileScreen.kind !== "repo-detail") {
        // リポジトリ一覧から開いた横断Issue一覧はリポジトリ一覧へ戻す（#1951）。
        // 巻き戻せる履歴が無い（共有URLで直接開いた）ときだけここを通る
        const fallback =
          mobileScreen.kind === "issues" && mobileScreen.origin === "repos" ? "repos" : "home";
        navigate({ screen: fallback }, { history: "replace" });
        return;
      }

      const back = mobileScreen.back;
      const returnIssueId = mobileScreen.kind === "issue-detail" ? mobileScreen.issue.id : null;
      if (back.kind === "repo-detail") {
        navigate(
          {
            screen: "repo-detail",
            repo: back.repository.fullName,
            issue: returnIssueId,
            view: back.view,
            labels: back.labels,
            state: back.state,
            assignee: back.assignee,
            sort: back.sort,
          },
          { history: "replace" },
        );
      } else if (back.kind === "issues") {
        navigate(
          {
            screen: "issues",
            view: back.view,
            labels: back.labels,
            issue: returnIssueId,
            state: back.state,
            assignee: back.assignee,
            sort: back.sort,
            origin: back.origin,
          },
          { history: "replace" },
        );
      } else {
        navigate({ screen: back.kind }, { history: "replace" });
      }
    });
  }, [mobileScreen, navigate, goBackOrFallback]);

  return {
    mobileScreen,
    selectTab,
    selectPullRequests,
    selectPullRequestView,
    selectSettings,
    selectRepository,
    selectRepositoryByFullName,
    selectIssue,
    selectQuickView,
    selectAllIssues,
    updateListFilters,
    goBack,
  };
}
