"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { IssueLabel } from "@/types/issue";

/**
 * 複数リポジトリの**定義済みラベル名**を取る（#1993）。
 *
 * 「まとめて実行」バーが、選んだIssueで共通して選べるオプションを決めるのに使う
 * （`commonStartImplementationOptions`）。1リポジトリぶんの`useIssueRepoMeta`と取得先
 * （`/api/issues/meta`）は同じで、**リポジトリごとに1回だけ**取りに行き結果を持ち回る。
 *
 * - **取得は1リポジトリにつき1回きり**。選択を変えるたびに取り直すと、チェックを付け外しする
 *   だけで取得が走る
 * - **取得に失敗したリポジトリは結果に入らない。** 呼び出し側は「判定材料が無い」として扱う
 *   （`commonStartImplementationOptions`）
 * - `isLoading`は**要求されたリポジトリのどれかがまだ返っていない**こと。オプションは確定してから
 *   出す（取得の途中で選択肢が増減すると、押そうとしたチップが指の下で入れ替わる・#1666）
 */
export function useRepositoryLabelNames(repositoryFullNames: readonly string[]): {
  labelNamesByRepository: ReadonlyMap<string, readonly string[]>;
  isLoading: boolean;
} {
  const [labelNamesByRepository, setLabelNamesByRepository] = useState<
    ReadonlyMap<string, readonly string[]>
  >(() => new Map());
  /** 取得を始めたリポジトリ（失敗したものも含む）。二重に取りに行かないための印 */
  const requestedRef = useRef(new Set<string>());
  /** 取得が終わったリポジトリ。失敗したぶんは結果に入らないため、これとは別に持つ */
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());

  // 配列の同一性ではなく中身で効果を回す（親が毎回新しい配列を作っても取得を増やさない）
  const key = useMemo(
    () => [...new Set(repositoryFullNames)].sort().join(","),
    [repositoryFullNames],
  );

  useEffect(() => {
    const names = key === "" ? [] : key.split(",");
    const missing = names.filter((name) => !requestedRef.current.has(name));
    if (missing.length === 0) return;
    for (const name of missing) requestedRef.current.add(name);

    // **取り消しの旗を持たない。** 効果が二重に走る環境（React StrictMode）では、1回目の取得を
    // 取り消したまま2回目が`requestedRef`で弾かれ、`isLoading`が下りなくなる。取得の結果は
    // キャッシュとして持つだけなので、外れた後に届いても害が無い
    void Promise.all(
      missing.map(async (fullName) => {
        const [owner, repo] = fullName.split("/");
        try {
          const res = await fetch(`/api/issues/meta?owner=${owner}&repo=${repo}`);
          if (!res.ok) return null;
          const data: { labels: IssueLabel[] } = await res.json();
          return [fullName, data.labels.map((label) => label.name)] as const;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      setLabelNamesByRepository((prev) => {
        const next = new Map(prev);
        for (const result of results) {
          if (result) next.set(result[0], result[1]);
        }
        return next;
      });
      setSettled((prev) => new Set([...prev, ...missing]));
    });
  }, [key]);

  const isLoading = useMemo(() => {
    const names = key === "" ? [] : key.split(",");
    return names.some((name) => !settled.has(name));
  }, [key, settled]);

  return { labelNamesByRepository, isLoading };
}
