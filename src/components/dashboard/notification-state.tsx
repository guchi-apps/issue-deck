"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import { useRepositoryReleaseStatuses } from "@/hooks/use-repository-release-statuses";
import {
  buildNotifications,
  countBadgeNotifications,
  describeNotificationCount,
  groupNotifications,
  hasErrorNotification,
  type NotificationGroup,
  type NotificationItem,
} from "@/lib/notifications";
import { countReleaseActivity, type ReleaseActivityCounts } from "@/lib/release-activity";
import {
  countReleaseMergePending,
  type ReleaseMergePendingCounts,
} from "@/lib/release-merge-pending";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";
import type { ConnectedRepository } from "@/types/repository";

/**
 * ベルを開いている間の再取得間隔（#1909）。
 *
 * **開いている間だけ**で、閉じれば止まる。閉じている間のバックグラウンド再取得は従来どおり
 * 5分間隔（`use-repository-release-statuses.ts`）で、こちらは「開いて見ている人が、放って
 * おいても変化に気づける」ための間隔。実行キュー（5秒／20秒。叩き先はDBのみ）より長いのは、
 * 1巡でリリース状況（リポジトリ横断）とPull Request一覧を取り直すため。
 */
const POLL_INTERVAL_MS = 30_000;

/**
 * 取得中の表示（アイコンの回転）を保つ下限（#1773と同じ理由）。素直に「取得している間だけ」に
 * すると、速く返ったときに回転が1周もせず点滅にしか見えない。
 */
const MIN_FETCHING_MS = 500;

type NotificationState = {
  items: NotificationItem[];
  groups: { group: NotificationGroup; items: NotificationItem[] }[];
  /**
   * ベルに重ねる件数バッジの数字（#1936）。**手作業待ちを含まない**ので`items.length`とは
   * 一致しないことがある。理由は`lib/notifications.ts`の`BADGE_EXCLUDED_GROUPS`を参照。
   */
  badgeCount: number;
  /**
   * 開いたときの見出しに出す件数の文言（#1936）。バッジに数えていない手作業待ちがあるときは
   * `4件・手作業待ち1件`のように内訳が付き、バッジとの差がその場で読める。
   */
  countLabel: string;
  /** 1件でも失敗が混ざっているか（バッジを赤にする条件） */
  hasError: boolean;
  /**
   * developへ・mainへの反映待ちの本数（#2055）。スマホのフッターの「ブランチ」タブが
   * 合計をバッジに出す。**まだ取れていない間はnull**（0件と区別する）。
   *
   * ベルの`badgeCount`とは母集団が違う——あちらは確認待ち・PR・リリースを合わせた
   * 「対応が必要なもの」全体で、こちらはリリース系のマージ待ちだけ。
   */
  releaseMergePending: ReleaseMergePendingCounts | null;
  /**
   * リリース・デプロイが片付いていないリポジトリ数と、その内訳（#2167）。
   * PCの左メニューとスマホのホームの「ブランチ」行が件数とオレンジの丸に使う。
   * **まだ取れていない間はnull**（0件と区別する）。
   *
   * `releaseMergePending`とは数える単位が違う——あちらは人が押す番になったPRの**本数**で、
   * こちらは片付いていない**リポジトリ数**（マージ待ちに限らず、実行中・失敗も含む）。
   * **左メニューで非表示にしたリポジトリは除く**（押して開くブランチ画面と母集団を揃える）。
   */
  releaseActivity: ReleaseActivityCounts | null;
  /**
   * ベルの材料（リリース状況・Issue一覧・Pull Request一覧）をまとめて取り直す（#1909）。
   * 開いている間の自動更新と、右上の更新ボタンの両方がこれを呼ぶ。
   */
  refresh: () => void;
  /** 取得が飛んでいる間。自動更新でも真になる（更新アイコンを回すため） */
  isFetching: boolean;
  /** 最後に取得できた時刻（epoch ms）。まだ一度も取れていなければnull */
  fetchedAt: number | null;
  /** 開いている間の自動更新の間隔。文言（「30秒ごと」）と古さの判定にも使う */
  pollIntervalMs: number;
  /**
   * 通知の材料そのもの。スマホのベルが遷移に使う`useMobileScreen`が要求するため配る
   * （現在地の解決に一覧が要る）。表示には使わない。
   */
  issues: Issue[];
  repositories: ConnectedRepository[];
};

const EMPTY_STATE: NotificationState = {
  items: [],
  groups: [],
  badgeCount: 0,
  countLabel: "0件",
  hasError: false,
  releaseMergePending: null,
  releaseActivity: null,
  refresh: () => {},
  isFetching: false,
  fetchedAt: null,
  pollIntervalMs: POLL_INTERVAL_MS,
  issues: [],
  repositories: [],
};

const NotificationStateContext = createContext<NotificationState>(EMPTY_STATE);

/**
 * 通知ベル（#1614）が読む材料を1か所で用意して配る（#1772）。
 *
 * **ベルを置く場所がPCのトップバー1か所ではなくなったため、フックの呼び出しをここへ引き上げた。**
 * スマホのヘッダーは画面ごとに別物で、そこへ置くベルが自分で
 * `useRepositoryReleaseStatuses`を呼ぶと、`/api/repositories/release-pending-merges`の
 * ポーリングが2本走る——PCのトップバーは`hidden md:flex`でCSSで隠れているだけで、スマホでも
 * mountされたままだからで、どちらのレイアウトを見ているかはJS側からは判別できない
 * （`use-reference-navigation.ts`と同じ事情）。
 *
 * **取り直しもここが持つ**（#1909）。ベルの中身は3つの取得口（リリース状況・Issue一覧・
 * Pull Request一覧）から組み立てているので、「対応が必要なものを取り直す」を1つの操作として
 * 出すには、3つをまとめて呼べる場所が要る。開いている間の自動更新も右上の更新ボタンも
 * これを呼ぶ。
 *
 * **開いていない間は何も増やさない。** 自動更新を回すのはベルの中身の側
 * （`notification-refresh-button.tsx`）で、ポップオーバー・シートは閉じている間そもそも
 * 描かれない。
 *
 * **Providerの外では0件を返す。** ベルを置いたスマホの各画面は画面単体でテストしており、
 * Providerを必須にすると、ベルを足した画面のテストがすべてProviderのラップを要求される。
 */
export function NotificationProvider({
  repositories,
  issues,
  pullRequests,
  checkUserRunningIssueIds,
  onRefreshIssues,
  onRefreshPullRequests,
  isRefreshingPullRequests = false,
  children,
}: {
  repositories: ConnectedRepository[];
  issues: Issue[];
  /** リポジトリ横断のPR。TopBarの絞り込みは適用しない（#1750） */
  pullRequests: PullRequestSummary[];
  /**
   * 確認待ちのうち、まだエージェントが動いていて押せる操作が無いIssueのid（#2174）。
   * 左メニューの件数と同じ集合を受け取り、その行を「実行中」として弱く出す。
   */
  checkUserRunningIssueIds?: ReadonlySet<string>;
  /**
   * Issue一覧の取り直し（#1909）。取得できたかを返す——失敗を成功として数えると、
   * 取れていないのに「たった今更新」と出てしまう。渡さない場合はIssueを取り直さない
   * （10秒ごとのポーリングに任せる）。
   */
  onRefreshIssues?: () => Promise<boolean>;
  /**
   * Pull Request一覧の取り直し（#1909）。**これだけは投げっぱなし**で、取得の完了は
   * `isRefreshingPullRequests`で見る（`usePullRequests`が待てる形を返していないため）。
   *
   * 渡すのは自動更新と同じ扱いの`refreshInBackground`。`refresh`だと後ろに開いているPR一覧が
   * 30秒ごとに「読み込み中...」へ戻る。
   */
  onRefreshPullRequests?: () => void;
  isRefreshingPullRequests?: boolean;
  children: ReactNode;
}) {
  // 連携しているリポジトリが1件でもあれば取りに行く（スマホのリポジトリ一覧と同じ条件）。
  // **`hasClaudeWorkflow`では絞らない**（#1727）。あれは`claude-issue-dispatch.yml`の有無で
  // 「リリースworkflow導入済み」を代用していたもので、無人実行を入れずにリリースフローだけを
  // 載せたリポジトリ（`subpc`・`vps`）が通知から丸ごと抜け落ちる。実際にどのリポジトリを
  // 対象にするかはAPI側が`release-develop-to-main.yml`の実在で決める。
  const hasConnectedRepository = repositories.length > 0;
  const { data: releaseStatuses, refetch } = useRepositoryReleaseStatuses(hasConnectedRepository);

  const [isSelfFetching, setIsSelfFetching] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  // 前の取得が飛んでいる間は次を投げない（遅い応答が重なるとGitHub APIを無駄に消費する）
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsSelfFetching(true);
    const startedAt = Date.now();
    try {
      const [releaseOk, issuesOk] = await Promise.all([
        // 連携リポジトリが無ければそもそも取りに行っていないので、取れた扱いにする
        hasConnectedRepository ? refetch().then((data) => data !== null) : Promise.resolve(true),
        onRefreshIssues ? onRefreshIssues() : Promise.resolve(true),
      ]);
      onRefreshPullRequests?.();
      // **取れなかった周は`fetchedAt`を進めない**（#1773と同じ）。進めると、取れていないのに
      // 「たった今更新」と出て、古いまま固まっていることに気づけない
      if (releaseOk && issuesOk) setFetchedAt(Date.now());
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_FETCHING_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_FETCHING_MS - elapsed));
      }
    } finally {
      inFlightRef.current = false;
      setIsSelfFetching(false);
    }
  }, [hasConnectedRepository, refetch, onRefreshIssues, onRefreshPullRequests]);

  const value = useMemo<NotificationState>(() => {
    const items = buildNotifications({
      issues,
      pullRequests,
      releaseStatuses,
      checkUserRunningIssueIds,
    });
    return {
      items,
      groups: groupNotifications(items),
      badgeCount: countBadgeNotifications(items),
      countLabel: describeNotificationCount(items),
      hasError: hasErrorNotification(items),
      releaseMergePending: countReleaseMergePending(releaseStatuses),
      releaseActivity: countReleaseActivity(releaseStatuses, repositories),
      refresh: () => void refresh(),
      // PR一覧の取得は投げっぱなしなので、回転が止まる条件にこちらも入れる
      isFetching: isSelfFetching || isRefreshingPullRequests,
      fetchedAt,
      pollIntervalMs: POLL_INTERVAL_MS,
      issues,
      repositories,
    };
  }, [
    issues,
    repositories,
    pullRequests,
    checkUserRunningIssueIds,
    releaseStatuses,
    refresh,
    isSelfFetching,
    isRefreshingPullRequests,
    fetchedAt,
  ]);

  return (
    <NotificationStateContext.Provider value={value}>{children}</NotificationStateContext.Provider>
  );
}

export function useNotificationState(): NotificationState {
  return useContext(NotificationStateContext);
}
