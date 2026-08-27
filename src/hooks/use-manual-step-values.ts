"use client";

import { useCallback, useEffect, useState } from "react";

import { normalizeManualStepPlaceholderValues } from "@/lib/manual-step-command";

const STORAGE_KEY_PREFIX = "issue-deck:manual-step-values:";

/**
 * 手作業の`<控えたkey>`へ人が埋めた値を、Issueごとに持つ（#2403）。
 *
 * **localStorageではなくsessionStorageを使う。** 埋めるのはトークン・キーであることが多い。
 * スマホでこの画面を使う人はターミナルアプリへ切り替えて戻ってくるため、切り替えの間に
 * Safariがタブを捨てても値が残る必要がある一方、次に開いたときまで端末へ残す理由は無い。
 * **タブを閉じれば消える**という約束を画面にも書く（`ManualStepPlaceholderFill`）。
 *
 * **サーバーへ送るのは「承認して実行」を押したときだけ**で、Issueの本文にもコメントにも
 * 書かない。送った値はジョブが終わった時点でサーバー側が捨てる（`reportDispatchJob`）。
 *
 * 保存する形は`normalizeManualStepPlaceholderValues`を通したものだけにする。読むときも
 * 同じ関数を通すので、**ストレージを手で書き換えても差し込める形は変わらない**
 * （差し込んでよい形を決めるのは、この画面ではなく`lib/manual-step-command.ts`の1か所）。
 */
export type ManualStepValuesHandle = {
  /** いま埋まっている値（`<控えたkey>` → 値）。1件も無ければ`null` */
  values: Record<string, string> | null;
  /** 1件を書き換える。空文字を渡すとその穴を未入力へ戻す */
  setValue: (placeholder: string, value: string) => void;
  /** このIssueぶんをまとめて捨てる（画面の「値を消す」） */
  clear: () => void;
};

export function useManualStepValues(issueKey: string | null): ManualStepValuesHandle {
  const [values, setValues] = useState<Record<string, string> | null>(null);

  // **読むのはマウント後**（`usePersistedState`と同じ）。SSRの結果と初回描画をずらさないため、
  // 初期値は常に`null`にして、マウント後にsessionStorageの値を反映する
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValues(issueKey === null ? null : read(issueKey));
  }, [issueKey]);

  const write = useCallback(
    (next: Record<string, string> | null) => {
      setValues(next);
      if (issueKey === null) return;
      try {
        const key = `${STORAGE_KEY_PREFIX}${issueKey}`;
        if (next === null) window.sessionStorage.removeItem(key);
        else window.sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        // sessionStorageが使えない環境（プライベートモード・容量超過）では、
        // このタブの中（Reactの状態）だけで持つ。入力そのものは止めない
      }
    },
    [issueKey],
  );

  const setValue = useCallback(
    (placeholder: string, value: string) => {
      const merged = { ...(values ?? {}), [placeholder]: value };
      write(normalizeManualStepPlaceholderValues(merged));
    },
    [values, write],
  );

  const clear = useCallback(() => write(null), [write]);

  return { values, setValue, clear };
}

function read(issueKey: string): Record<string, string> | null {
  try {
    const raw = window.sessionStorage.getItem(`${STORAGE_KEY_PREFIX}${issueKey}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return normalizeManualStepPlaceholderValues(parsed as Record<string, unknown>);
  } catch {
    // 使えない環境・壊れたJSONでは「まだ何も埋めていない」として扱う
    return null;
  }
}
