"use client";

import { useCallback, useEffect, useState } from "react";

import type { SessionArtifactView } from "@/lib/dispatch/session-artifact";
import type { Issue } from "@/types/issue";

const EMPTY: SessionArtifactView[] = [];

type UseIssueArtifactsResult = {
  artifacts: SessionArtifactView[];
  isLoading: boolean;
  /** 公開されたばかりのものを拾い直す。セクションの「更新」から呼ぶ */
  reload: () => void;
};

/**
 * 選択中のIssueが持つアーティファクト（#2154）を取得する。
 *
 * `use-issue-sub-issues.ts`と同じ形で、**識別子に依存させてポーリングによる再取得では
 * 走らせない**（表示中のセクションが定期的に読み込み中へ差し替わるのを防ぐ）。
 *
 * **自動では追いかけない。** アーティファクトが増えるのはセッションが公開した瞬間だけで、
 * それに合わせて引き直す価値のあるポーリング間隔が無い（見たいときに`reload`を押す方が早い）。
 */
export function useIssueArtifacts(issue: Issue | null): UseIssueArtifactsResult {
  const [artifacts, setArtifacts] = useState<SessionArtifactView[]>(EMPTY);
  const [isLoading, setIsLoading] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const repositoryFullName = issue?.repositoryFullName ?? null;
  const issueNumber = issue?.number ?? null;

  useEffect(() => {
    if (!repositoryFullName || issueNumber === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setArtifacts(EMPTY);
      return;
    }

    const [owner, repo] = repositoryFullName.split("/");
    const controller = new AbortController();
    setIsLoading(true);

    fetch(`/api/issues/artifacts?owner=${owner}&repo=${repo}&number=${issueNumber}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`artifacts fetch failed (${res.status})`);
        return (await res.json()) as { artifacts?: SessionArtifactView[] };
      })
      .then((data) => setArtifacts(data.artifacts ?? EMPTY))
      // **失敗しても空にするだけ。** セクションが出ないだけで、claude.aiのURLは
      // Issueコメントに残っているので見る手段は無くならない
      .catch(() => {
        if (!controller.signal.aborted) setArtifacts(EMPTY);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [repositoryFullName, issueNumber, reloadCount]);

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  return { artifacts, isLoading, reload };
}
