"use client";

import { useCallback, useSyncExternalStore } from "react";

import type { ReleaseCandidate, ReleaseCandidatesSource } from "@/lib/release-candidate-checks";

const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 60_000;
const RETRY_POLL_MS = 15_000;

const LOADING: ReleaseCandidatesSource = { status: "loading" };

type Entry = {
  source: ReleaseCandidatesSource;
  listeners: Set<() => void>;
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/** リポジトリごとに1つ。一覧の全行・詳細・ブランチ画面が同じ取得を共有する（行ごとに取らない） */
const entries = new Map<string, Entry>();

function isActive(candidates: readonly ReleaseCandidate[]): boolean {
  return candidates.some((candidate) =>
    [candidate.verification.integration.state, candidate.verification.aiReview.state, candidate.verification.mac.state].some(
      (state) => state === "waiting" || state === "running",
    ),
  );
}

function publish(entry: Entry, source: ReleaseCandidatesSource) {
  entry.source = source;
  entry.listeners.forEach((listener) => listener());
}

async function load(repositoryFullName: string, entry: Entry) {
  const [owner, repo] = repositoryFullName.split("/");
  entry.controller = new AbortController();
  const signal = entry.controller.signal;
  let delay = IDLE_POLL_MS;
  try {
    const res = await fetch(`/api/repositories/release/candidates?${new URLSearchParams({ owner, repo })}`, { signal });
    if (!res.ok) throw new Error(`リリース候補の検証状態を取得できませんでした (${res.status})`);
    const body: { candidates?: ReleaseCandidate[] } = await res.json();
    if (!Array.isArray(body.candidates)) throw new Error("リリース候補の応答が不正です");
    publish(entry, { status: "loaded", candidates: body.candidates });
    if (isActive(body.candidates)) delay = ACTIVE_POLL_MS;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    publish(entry, { status: "error", message: err instanceof Error ? err.message : String(err) });
    delay = RETRY_POLL_MS;
  }
  if (!signal.aborted) entry.timer = setTimeout(() => void load(repositoryFullName, entry), delay);
}

/**
 * リポジトリのリリース候補と、各候補の検証結果（全体レビュー・統合検証・Mac検証。#4366）。
 * 検証は起動せず読むだけ。表示している間だけ取り直し、進行中は5秒、そうでなければ60秒間隔で追従する。
 * 取得に失敗しても止めず、間隔を空けて取り直す（失敗は`error`で、候補なしとは区別する）。
 * 全員が表示をやめたら取得結果も捨て、次に開いたときは古い結果を見せずに取り直す。
 */
export function useReleaseCandidates(repositoryFullName: string): ReleaseCandidatesSource {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let entry = entries.get(repositoryFullName);
      if (!entry) {
        entry = { source: LOADING, listeners: new Set(), controller: null, timer: undefined };
        entries.set(repositoryFullName, entry);
        void load(repositoryFullName, entry);
      }
      const current = entry;
      current.listeners.add(onChange);
      return () => {
        current.listeners.delete(onChange);
        if (current.listeners.size === 0) {
          current.controller?.abort();
          clearTimeout(current.timer);
          entries.delete(repositoryFullName);
        }
      };
    },
    [repositoryFullName],
  );
  return useSyncExternalStore(
    subscribe,
    () => entries.get(repositoryFullName)?.source ?? LOADING,
    () => LOADING,
  );
}
