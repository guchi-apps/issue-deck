"use client";

import { useEffect, useMemo, useState } from "react";

import { isManualStepIssue } from "@/lib/github/approval-labels";
import { computeIssueDependents, type IssueDependent } from "@/lib/issue-dependents";
import {
  collectPrerequisiteReferences,
  resolveManualStepPrerequisites,
  summarizeManualStepPrerequisites,
  type ManualStepPrerequisite,
  type ManualStepPrerequisiteSummary,
} from "@/lib/manual-step-prerequisites";
import type { Issue } from "@/types/issue";
import type { IssuePullRequest, IssuePullRequestListResponse } from "@/types/pull-request";

const EMPTY_PULL_REQUESTS: IssuePullRequest[] = [];
const EMPTY_PREREQUISITES: ManualStepPrerequisite[] = [];
const EMPTY_DEPENDENTS: IssueDependent[] = [];

export type UseManualStepPrerequisitesResult = {
  prerequisites: ManualStepPrerequisite[];
  /** 参照が1件も無ければnull（画面は前提条件のブロックごと出さない） */
  summary: ManualStepPrerequisiteSummary | null;
  /** 逆向き——このIssueの完了を待っているIssue（#2003）。無ければ空配列 */
  dependents: IssueDependent[];
};

/**
 * Issueが待っている相手と、逆に自分を待っている相手の状況を集める
 * （#1705。#2003で手作業Issue以外へ広げ、逆向きも返すようにした）。
 *
 * Issueの参照は画面がすでに持っているキャッシュから引くので**GitHub APIを消費しない**。
 * Issueとして見つからなかった番号だけ、PRの可能性として既存の`/api/issues/pull-requests`で
 * 1回だけ引く（同じ番号空間にIssueとPRが同居するため、番号だけでは区別できない）。
 * **ポーリングはしない**——前提が数十秒で変わることはなく、Issue詳細を開き直せば取り直される。
 *
 * PRとして引きに行くのはIssue自身のリポジトリの番号だけ。`owner/repo#123`形式で
 * 別リポジトリを指した参照は、そのリポジトリのIssueがキャッシュにあれば解決でき、
 * 無ければ「状態不明」（＝待ちに数えない）になる。
 */
export function useManualStepPrerequisites(
  issue: Issue | null,
  issues: Issue[],
): UseManualStepPrerequisitesResult {
  const [pullRequests, setPullRequests] = useState<IssuePullRequest[]>(EMPTY_PULL_REQUESTS);

  const references = useMemo(() => {
    if (!issue) return [];
    return collectPrerequisiteReferences(issue, issues);
  }, [issue, issues]);

  const dependents = useMemo(() => {
    if (!issue) return EMPTY_DEPENDENTS;
    return computeIssueDependents(issue, issues);
  }, [issue, issues]);

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

  const manualStep = issue !== null && isManualStepIssue(issue.labels);

  return useMemo(() => {
    if (references.length === 0 || !repositoryFullName) {
      return { prerequisites: EMPTY_PREREQUISITES, summary: null, dependents };
    }
    const prerequisites = resolveManualStepPrerequisites(
      references,
      issues,
      pullRequests,
      repositoryFullName,
    );
    return {
      prerequisites,
      summary: summarizeManualStepPrerequisites(prerequisites, repositoryFullName, { manualStep }),
      dependents,
    };
  }, [references, issues, pullRequests, repositoryFullName, manualStep, dependents]);
}
