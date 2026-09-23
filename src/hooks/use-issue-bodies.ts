"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Issue } from "@/types/issue";

type LoadedBody = { body: string; updatedAt: string };

/**
 * 一覧で外されたIssueの本文（`bodyOmitted`。#3390）を、開いたIssueのぶんだけ取って埋め戻す。
 *
 * 返す`issues`は、取得済みの本文を差し込んだ一覧。**画面の下流（詳細・編集・要約・実装開始・
 * タスクリスト）はこれを受け取るので、本文を後から取ったことを意識しなくてよい。**
 * 取得中は`bodyOmitted`のまま、失敗したら`bodyLoadFailed`も立つ。
 *
 * **取得した本文は`updatedAt`で版を突き合わせる。** 編集やGitHub側の更新で一覧の`updatedAt`が
 * 進んだら、手元の本文は古いものとして使わず取り直す（古い本文のまま編集ダイアログを開くと、
 * 保存で新しい本文を上書きしてしまうため）。
 *
 * `request(id)`で取得を頼む。頼まれていないIssueは取らない——closedのIssueを片端から
 * 取り直すと、一覧から本文を外した意味が無くなる。
 */
export function useIssueBodies(issues: Issue[]) {
  const [requestedIds, setRequestedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [loaded, setLoaded] = useState<ReadonlyMap<string, LoadedBody>>(() => new Map());
  // 失敗した版（id → そのときの`updatedAt`）。版が進めば自然に取り直しの対象へ戻る
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const inFlight = useRef(new Set<string>());

  // 編集・closeの応答は本文入りで届く。開いているIssueのぶんを覚えておけば、次の周回で
  // 本文を外した版に置き換わっても取り直さずに済む（開いている詳細の本文が一瞬消えない）。
  // 効果ではなく描画中に合わせる（Reactの「前回の描画から状態を調整する」形。値が揃えば止まる）
  const seeds = collectBodySeeds(issues, requestedIds, loaded);
  if (seeds.length > 0) {
    setLoaded((prev) => {
      const next = new Map(prev);
      for (const issue of seeds) next.set(issue.id, { body: issue.body, updatedAt: issue.updatedAt });
      return next;
    });
  }

  const request = useCallback((issueId: string | null | undefined) => {
    if (!issueId) return;
    setRequestedIds((prev) => (prev.has(issueId) ? prev : new Set(prev).add(issueId)));
    // 開き直したら、失敗した版でももう一度取りに行く
    setFailed((prev) => {
      if (!prev.has(issueId)) return prev;
      const next = new Map(prev);
      next.delete(issueId);
      return next;
    });
  }, []);

  useEffect(() => {
    for (const issueId of requestedIds) {
      const issue = issues.find((item) => item.id === issueId);
      if (!issue?.bodyOmitted) continue;
      if (isFresh(loaded.get(issueId), issue)) continue;
      if (failed.get(issueId) === issue.updatedAt) continue;
      const key = `${issueId}@${issue.updatedAt}`;
      if (inFlight.current.has(key)) continue;

      inFlight.current.add(key);
      const failedAt = issue.updatedAt;
      void fetchIssueBody(issueId)
        .then((result) => {
          if (result) {
            setLoaded((prev) => new Map(prev).set(issueId, result));
          } else {
            setFailed((prev) => new Map(prev).set(issueId, failedAt));
          }
        })
        .finally(() => inFlight.current.delete(key));
    }
  }, [requestedIds, issues, loaded, failed]);

  // 差し込んだ版を元のIssue（とその本文）ごとに使い回す。ポーリングで一覧が届き直しても、
  // 変わっていないIssue（`reconcileIssues`が参照を保つ）は同じオブジェクトのままにするため。
  // 毎回作り直すと、開いた時点のIssueでフォームを初期化する編集ダイアログなどが巻き戻る
  const [hydratedCache] = useState(() => new WeakMap<Issue, { entry: LoadedBody; issue: Issue }>());
  const hydratedIssues = useMemo(
    () =>
      loaded.size === 0 && failed.size === 0
        ? issues
        : hydrateIssueBodies(issues, loaded, failed, hydratedCache),
    [issues, loaded, failed, hydratedCache],
  );

  return { issues: hydratedIssues, request };
}

/** 取得済みの本文を一覧へ差し込む（#3390）。本文を持っているIssue・未取得のIssueはそのまま返す */
export function hydrateIssueBodies(
  issues: Issue[],
  loaded: ReadonlyMap<string, LoadedBody>,
  failed: ReadonlyMap<string, string>,
  cache?: WeakMap<Issue, { entry: LoadedBody; issue: Issue }>,
): Issue[] {
  return issues.map((issue) => {
    if (!issue.bodyOmitted) return issue;
    const entry = loaded.get(issue.id);
    if (isFresh(entry, issue)) {
      const cached = cache?.get(issue);
      if (cached?.entry === entry) return cached.issue;
      const { bodyOmitted: _omitted, bodyLoadFailed: _failed, ...rest } = issue;
      const hydrated: Issue = { ...rest, body: entry.body };
      cache?.set(issue, { entry, issue: hydrated });
      return hydrated;
    }
    if (failed.get(issue.id) === issue.updatedAt) return { ...issue, bodyLoadFailed: true };
    return issue;
  });
}

/** 頼まれたIssueのうち、本文入りで届いていて手元の本文と食い違うもの */
function collectBodySeeds(
  issues: Issue[],
  requestedIds: ReadonlySet<string>,
  loaded: ReadonlyMap<string, LoadedBody>,
): Issue[] {
  if (requestedIds.size === 0) return [];
  return issues.filter((issue) => {
    if (issue.bodyOmitted || !requestedIds.has(issue.id)) return false;
    const entry = loaded.get(issue.id);
    return entry?.body !== issue.body || entry.updatedAt !== issue.updatedAt;
  });
}

/**
 * 手元の本文が一覧の版以降か。DBの方が一覧より新しい（取得の間に更新が入った）場合も使ってよい。
 * どちらも`toISOString()`の形なので、文字列の大小がそのまま時刻の前後になる
 */
function isFresh(entry: LoadedBody | undefined, issue: Issue): entry is LoadedBody {
  return entry !== undefined && entry.updatedAt >= issue.updatedAt;
}

async function fetchIssueBody(issueId: string): Promise<LoadedBody | null> {
  try {
    const res = await fetch(`/api/issues/body?id=${encodeURIComponent(issueId)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { body?: unknown; updatedAt?: unknown };
    if (typeof data.body !== "string" || typeof data.updatedAt !== "string") return null;
    return { body: data.body, updatedAt: data.updatedAt };
  } catch {
    return null;
  }
}
