"use client";

import { useEffect, useMemo, useState } from "react";

import { isManualStepIssue } from "@/lib/github/approval-labels";
import {
  extractManualStepReferences,
  resolveManualStepPrerequisites,
  summarizeManualStepPrerequisites,
  type ManualStepPrerequisite,
  type ManualStepPrerequisiteSummary,
} from "@/lib/manual-step-prerequisites";
import type { Issue } from "@/types/issue";
import type { IssuePullRequest, IssuePullRequestListResponse } from "@/types/pull-request";

const EMPTY_PULL_REQUESTS: IssuePullRequest[] = [];
const EMPTY_PREREQUISITES: ManualStepPrerequisite[] = [];

export type UseManualStepPrerequisitesResult = {
  prerequisites: ManualStepPrerequisite[];
  /** 参照が1件も無ければnull（画面は前提条件のブロックごと出さない） */
  summary: ManualStepPrerequisiteSummary | null;
};

/**
 * 手作業Issue（`71.manual-step`）が待っている相手の状況を集める（#1705）。
 *
 * Issueの参照は画面がすでに持っているキャッシュから引くので**GitHub APIを消費しない**。
 * Issueとして見つからなかった番号だけ、PRの可能性として既存の`/api/issues/pull-requests`で
 * 1回だけ引く（同じ番号空間にIssueとPRが同居するため、番号だけでは区別できない）。
 * **ポーリングはしない**——手作業の前提が数十秒で変わることはなく、Issue詳細を開き直せば
 * 取り直される。
 *
 * PRとして引きに行くのは手作業Issue自身のリポジトリの番号だけ。`owner/repo#123`形式で
 * 別リポジトリを指した参照は、そのリポジトリのIssueがキャッシュにあれば解決でき、
 * 無ければ「状態不明」（＝待ちに数えない）になる。
 */
export function useManualStepPrerequisites(
  issue: Issue | null,
  issues: Issue[],
): UseManualStepPrerequisitesResult {
  const [pullRequests, setPullRequests] = useState<IssuePullRequest[]>(EMPTY_PULL_REQUESTS);

  const references = useMemo(() => {
    if (!issue || !isManualStepIssue(issue.labels)) return [];
    return extractManualStepReferences(issue.body, issue.repositoryFullName, issue.number);
  }, [issue]);

  const repositoryFullName = issue?.repositoryFullName ?? null;
  const [owner, repo] = repositoryFullName ? repositoryFullName.split("/") : [null, null];

  // Issueキャッシュで解決できなかった番号だけをPRとして引く。配列は毎レンダー新しい参照に
  // なるため、依存配列にはクエリ文字列そのものを使う（`use-issue-pull-requests.ts`と同じ）
  const unresolvedKey = useMemo(() => {
    if (!repositoryFullName) return "";
    const known = new Set(
      issues
        .filter((candidate) => candidate.repositoryFullName === repositoryFullName)
        .map((candidate) => candidate.number),
    );
    return references
      .filter(
        (reference) =>
          reference.repositoryFullName === repositoryFullName && !known.has(reference.number),
      )
      .map((reference) => reference.number)
      .join(",");
  }, [references, issues, repositoryFullName]);

  useEffect(() => {
    if (!owner || !repo || unresolvedKey === "") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPullRequests(EMPTY_PULL_REQUESTS);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      try {
        const res = await fetch(
          `/api/issues/pull-requests?owner=${owner}&repo=${repo}&numbers=${unresolvedKey}`,
          { signal: controller.signal },
        );
        if (!res.ok) return;
        const data: IssuePullRequestListResponse = await res.json();
        if (cancelled) return;
        setPullRequests(data.pullRequests);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // 取得できなければ「状態不明」として出るだけで、画面は壊れない
      }
    }

    load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [owner, repo, unresolvedKey]);

  return useMemo(() => {
    if (references.length === 0 || !repositoryFullName) {
      return { prerequisites: EMPTY_PREREQUISITES, summary: null };
    }
    const prerequisites = resolveManualStepPrerequisites(
      references,
      issues,
      pullRequests,
      repositoryFullName,
    );
    return {
      prerequisites,
      summary: summarizeManualStepPrerequisites(prerequisites, repositoryFullName),
    };
  }, [references, issues, pullRequests, repositoryFullName]);
}
