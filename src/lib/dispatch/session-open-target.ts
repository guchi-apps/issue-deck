import { parseCodexThreadId, type DispatchSessionView } from "@/lib/dispatch/session-state";

/** Issue詳細から開ける実行セッションの共通表現。 */
export type SessionOpenTarget =
  | { kind: "claude"; url: string; label: string }
  | { kind: "codex"; url: string; label: string; threadId: string; host: string };

/** CodexのUUIDからだけDeep Linkを組み立てる。 */
export function buildCodexThreadUrl(threadId: string): string | null {
  const parsed = parseCodexThreadId(threadId);
  return parsed ? `codex://threads/${parsed}` : null;
}

/** UUIDを指定して、Remote host上でも再開できるフォールバック用のコマンドを作る。 */
export function buildCodexResumeCommand(threadId: string): string | null {
  const parsed = parseCodexThreadId(threadId);
  return parsed ? `codex resume ${parsed}` : null;
}

/**
 * エージェントごとの差異を画面から隠して、開けるセッションを1つの形で返す。
 * Claude CodeのURLは従来どおり生きているセッションにだけ出し、CodexはUUIDがある場合だけ出す。
 */
export function buildSessionOpenTarget(session: DispatchSessionView): SessionOpenTarget | null {
  if (session.codexThreadKnown !== null) {
    const threadId = session.codexThreadId ? parseCodexThreadId(session.codexThreadId) : null;
    const url = threadId ? buildCodexThreadUrl(threadId) : null;
    return threadId && url
      ? { kind: "codex", url, label: "Codexで開く", threadId, host: session.host }
      : null;
  }

  if (session.state !== "ALIVE" || !session.remoteControlUrl) return null;
  return { kind: "claude", url: session.remoteControlUrl, label: "Claude Codeアプリで開く" };
}
