/**
 * 新規Issueの書きかけをリモートセッション画面へ渡す一時保管（#5628）。
 *
 * 本文は長くなりうるためURLには載せず、ブラウザ内のモジュール変数で受け渡す。
 * 保管するのは1件だけで、期限が切れるか、起動が受け付けられたら破棄する。
 */
export const REMOTE_SESSION_HANDOFF_TTL_MS = 10 * 60 * 1000;

type Handoff = { repositoryFullName: string; prompt: string; savedAt: number };

let pending: Handoff | null = null;

export function setRemoteSessionHandoff(repositoryFullName: string, prompt: string, now = Date.now()): void {
  pending = { repositoryFullName, prompt, savedAt: now };
}

/** 指定リポジトリ宛ての転記文を返す（消さない。StrictModeで初期化が2回走っても同じ値を読めるように）。 */
export function peekRemoteSessionHandoff(repositoryFullName: string | null, now = Date.now()): string | null {
  if (!pending || !repositoryFullName) return null;
  if (now - pending.savedAt > REMOTE_SESSION_HANDOFF_TTL_MS) {
    pending = null;
    return null;
  }
  return pending.repositoryFullName === repositoryFullName ? pending.prompt : null;
}

export function clearRemoteSessionHandoff(): void {
  pending = null;
}
