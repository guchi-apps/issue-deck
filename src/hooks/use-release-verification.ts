"use client";

import { useEffect, useState } from "react";

import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";

const ACTIVE_POLL_MS = 5_000;
const RETRY_POLL_MS = 15_000;

/**
 * リリースPRの統合検証・全体AIレビューの状態（PCのリリースPR詳細用。#4238）。
 * 検証は数分〜数十分かかるので、完了していない区分があるあいだだけ短い間隔（5秒）で取り直す
 * （#4277。待機→工程→完了の進捗を追うため）。**取得に失敗しても止めず、間隔を空けて取り直す**
 * ——通信断のあいだに完了しても、戻った時点で追従させる。失敗は`error`に残し、「記録なし」とは
 * 区別する。`enabled`がfalseの間は取得しない。`reloadToken`を変えると即座に取り直す
 */
export function useReleaseVerification(
  repositoryFullName: string,
  pullRequestNumber: number,
  enabled: boolean,
  reloadToken = 0,
): { verification: ReleaseVerificationSummary | null; error: string | null } {
  const key = `${repositoryFullName}#${pullRequestNumber}`;
  const [loaded, setLoaded] = useState<{ key: string; verification: ReleaseVerificationSummary } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const [owner, repo] = repositoryFullName.split("/");
    const params = new URLSearchParams({ owner, repo, pullRequest: String(pullRequestNumber) });

    const load = async () => {
      let delay: number | null = null;
      try {
        const res = await fetch(`/api/repositories/release/verification?${params.toString()}`, {
          signal: controller.signal,
        });
        if (res.status === 404) return; // リリースPRではない（旧世代など）。何も出さない
        if (!res.ok) throw new Error(`検証の状態を取得できませんでした (${res.status})`);
        const body: { verification?: ReleaseVerificationSummary } = await res.json();
        if (!body.verification) throw new Error("検証の状態の応答が不正です");
        setLoaded({ key, verification: body.verification });
        setFailure(null);
        const states = [body.verification.integration.state, body.verification.aiReview.state];
        if (states.some((state) => state === "waiting" || state === "running")) delay = ACTIVE_POLL_MS;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setFailure({ key, message: err instanceof Error ? err.message : String(err) });
        delay = RETRY_POLL_MS;
      }
      if (delay !== null && !controller.signal.aborted) timer = setTimeout(load, delay);
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, key, repositoryFullName, pullRequestNumber, reloadToken]);

  return {
    verification: loaded?.key === key ? loaded.verification : null,
    error: failure?.key === key ? failure.message : null,
  };
}
