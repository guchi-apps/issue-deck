"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useRepositoryReleaseStatuses } from "@/hooks/use-repository-release-statuses";
import {
  buildNotifications,
  groupNotifications,
  hasErrorNotification,
  type NotificationGroup,
  type NotificationItem,
} from "@/lib/notifications";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";
import type { ConnectedRepository } from "@/types/repository";

type NotificationState = {
  items: NotificationItem[];
  groups: { group: NotificationGroup; items: NotificationItem[] }[];
  /** 1件でも失敗が混ざっているか（バッジを赤にする条件） */
  hasError: boolean;
  /** ベルを開いたときの取り直し。バックグラウンドの再取得は5分間隔のため */
  refetch: () => void;
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
  hasError: false,
  refetch: () => {},
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
 * **追加のGitHub API消費はゼロ。** Issue・PRは`IssueDeckShell`が既に取得済みのものを受け取り、
 * リリース状況の取得は従来どおり1本のまま。何を通知にするかの判定は`lib/notifications.ts`
 * （純粋関数）にある。
 *
 * **Providerの外では0件を返す。** ベルを置いたスマホの各画面は画面単体でテストしており、
 * Providerを必須にすると、ベルを足した画面のテストがすべてProviderのラップを要求される。
 */
export function NotificationProvider({
  repositories,
  issues,
  pullRequests,
  children,
}: {
  repositories: ConnectedRepository[];
  issues: Issue[];
  /** リポジトリ横断のPR。TopBarの絞り込みは適用しない（#1750） */
  pullRequests: PullRequestSummary[];
  children: ReactNode;
}) {
  // 連携しているリポジトリが1件でもあれば取りに行く（スマホのリポジトリ一覧と同じ条件）。
  // **`hasClaudeWorkflow`では絞らない**（#1727）。あれは`claude-issue-dispatch.yml`の有無で
  // 「リリースworkflow導入済み」を代用していたもので、無人実行を入れずにリリースフローだけを
  // 載せたリポジトリ（`subpc`・`vps`）が通知から丸ごと抜け落ちる。実際にどのリポジトリを
  // 対象にするかはAPI側が`release-develop-to-main.yml`の実在で決める。
  const hasConnectedRepository = repositories.length > 0;
  const { data: releaseStatuses, refetch } = useRepositoryReleaseStatuses(hasConnectedRepository);

  const value = useMemo<NotificationState>(() => {
    const items = buildNotifications({ issues, pullRequests, releaseStatuses });
    return {
      items,
      groups: groupNotifications(items),
      hasError: hasErrorNotification(items),
      refetch: () => void refetch(),
      issues,
      repositories,
    };
  }, [issues, repositories, pullRequests, releaseStatuses, refetch]);

  return (
    <NotificationStateContext.Provider value={value}>{children}</NotificationStateContext.Provider>
  );
}

export function useNotificationState(): NotificationState {
  return useContext(NotificationStateContext);
}
