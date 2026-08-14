"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { GithubReference } from "@/lib/github-reference";

type GithubReferenceNavigation = {
  /** Issue・PRの参照をIssueDeckの画面内で開く */
  openReference: (reference: GithubReference) => void;
};

const GithubReferenceNavigationContext = createContext<GithubReferenceNavigation | null>(null);

/**
 * 画面内のIssue・PRリンクをアプリ内遷移にするための受け口（#1260）。
 *
 * 遷移そのもの（どのIssueを選ぶ・どのペインへ切り替える）は`IssueDeckShell`だけが持ち、
 * ここではその関数を配るだけにしている。リンクはMarkdown本文の中のような深い位置にも
 * 現れるため、propsのバケツリレーではなくcontextで渡す。
 *
 * **providerが無い場所ではnullを返す。** リンク側はその場合に従来どおりGitHubを開く
 * 外部リンクとして振る舞うので、ダイアログ単体のテストや将来の別画面でも壊れない。
 */
export function GithubReferenceNavigationProvider({
  openReference,
  children,
}: {
  openReference: (reference: GithubReference) => void;
  children: ReactNode;
}) {
  return (
    <GithubReferenceNavigationContext.Provider value={{ openReference }}>
      {children}
    </GithubReferenceNavigationContext.Provider>
  );
}

export function useGithubReferenceNavigation(): GithubReferenceNavigation | null {
  return useContext(GithubReferenceNavigationContext);
}
