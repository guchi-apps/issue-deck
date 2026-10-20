"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { RemoteSessionState, RemoteSessionView } from "@/lib/dispatch/remote-session-rules";

/** 起動を待っている間の再取得間隔。URLが届いたらすぐ移動したいので短くする */
const LAUNCHING_POLL_MS = 3_000;
const IDLE_POLL_MS = 15_000;
/**
 * 起動してからURLを待つ上限。pollerはURLが出るまで最大90秒待ってから報告するため、それに
 * 受け渡しの余裕を足す。過ぎたら自動移動はやめ、一覧の「開く」に任せる
 */
const AUTO_OPEN_TIMEOUT_MS = 150_000;

export type RemoteSessionLaunch = {
  sessionId: string;
  repositoryFullName: string;
  startedAt: number;
  /** URLを待つのをやめた（時間切れ・失敗） */
  gaveUp: boolean;
};

/**
 * リモートセッション（#4743）の状態取得・起動・終了。起動した1件はURLが届いた時点で
 * `onReady`を呼ぶ（画面はそこでClaude Codeアプリへ移動する）。
 */
export function useRemoteSessions(params: { active: boolean; onReady: (url: string) => void }) {
  const { active, onReady } = params;
  const [state, setState] = useState<RemoteSessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launch, setLaunch] = useState<RemoteSessionLaunch | null>(null);
  const [pending, setPending] = useState(false);
  // 取得のたびに起動中の1件を照らし合わせるため、最新の値を参照で持つ（取得の関数を作り直さない）
  const launchRef = useRef<RemoteSessionLaunch | null>(null);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const updateLaunch = useCallback((next: RemoteSessionLaunch | null) => {
    launchRef.current = next;
    setLaunch(next);
  }, []);

  const refresh = useCallback(async () => {
    let next: RemoteSessionState;
    try {
      const response = await fetch("/api/remote-sessions", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      next = (await response.json()) as RemoteSessionState;
    } catch {
      setError("リモートセッションの状態を取得できませんでした。");
      return;
    }
    setState(next);
    setError(null);

    // 起動した1件のURLが届いたら移動する。失敗・時間切れなら待つのをやめる
    const current = launchRef.current;
    if (!current || current.gaveUp) return;
    const session = next.sessions.find((item) => item.id === current.sessionId);
    if (session?.remoteControlUrl && session.status === "running") {
      updateLaunch(null);
      onReadyRef.current(session.remoteControlUrl);
      return;
    }
    if (
      session?.status === "failed" ||
      session?.status === "ended" ||
      Date.now() - current.startedAt > AUTO_OPEN_TIMEOUT_MS
    ) {
      updateLaunch({ ...current, gaveUp: true });
    }
  }, [updateLaunch]);

  const waiting = launch !== null && !launch.gaveUp;

  useEffect(() => {
    if (!active) return;
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), waiting ? LAUNCHING_POLL_MS : IDLE_POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [active, refresh, waiting]);

  const start = useCallback(
    async (repositoryFullName: string) => {
      setPending(true);
      setError(null);
      try {
        const response = await fetch("/api/remote-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repositoryFullName }),
        });
        const body = (await response.json().catch(() => null)) as
          | { session?: RemoteSessionView; message?: string }
          | null;
        if (!response.ok || !body?.session) {
          setError(body?.message ?? "リモートセッションを起動できませんでした。");
          return;
        }
        updateLaunch({ sessionId: body.session.id, repositoryFullName, startedAt: Date.now(), gaveUp: false });
        await refresh();
      } finally {
        setPending(false);
      }
    },
    [refresh, updateLaunch],
  );

  /** 終了したセッションを会話ごと再開する（#4874）。起動と同じく、URLが届いたら移動する */
  const resume = useCallback(
    async (session: RemoteSessionView) => {
      setPending(true);
      setError(null);
      try {
        const response = await fetch("/api/remote-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resumeId: session.id }),
        });
        const body = (await response.json().catch(() => null)) as
          | { session?: RemoteSessionView; message?: string }
          | null;
        if (!response.ok || !body?.session) {
          setError(body?.message ?? "リモートセッションを再開できませんでした。");
          return;
        }
        updateLaunch({
          sessionId: body.session.id,
          repositoryFullName: session.repositoryFullName,
          startedAt: Date.now(),
          gaveUp: false,
        });
        await refresh();
      } finally {
        setPending(false);
      }
    },
    [refresh, updateLaunch],
  );

  const stop = useCallback(
    async (id: string) => {
      setError(null);
      const response = await fetch(`/api/remote-sessions?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "リモートセッションを終了できませんでした。");
      }
      await refresh();
    },
    [refresh],
  );

  const dismissLaunch = useCallback(() => updateLaunch(null), [updateLaunch]);

  return { state, error, launch, pending, start, resume, stop, refresh, dismissLaunch };
}
