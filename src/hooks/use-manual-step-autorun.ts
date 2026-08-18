"use client";

import { useCallback, useState } from "react";

/**
 * 手作業アシスタントの自動実行（#1869）の状態。
 *
 * **承認1回ぶんの状態で、持つのは画面だけ。** サーバーにもDBにも「自動で進めている」という
 * 状態は置かない——置くと、画面を閉じた後・別の端末から開いたときに誰が実行を進めるのかを
 * 決める必要が出る。ダイアログを閉じれば止まる、という分かりやすさをそのまま実装にする。
 *
 * 対象のIssueを持たないのは、呼び出し側（`ManualStepGuideContent`）がIssueごとに
 * `key={issue.id}`で作り直されるため。**Issueをまたいで自動では進まない**（次の手作業は
 * もう一度承認する）という決まりが、状態の置き場所として自然に守られる。
 */

/** 自動実行が止まっている理由 */
export type ManualStepAutoRunPause =
  /** 代行できない手順に来た（人が実行して「実行した・次へ」を押すと再開する） */
  | "user"
  /** 実行が失敗した（原因を見て、直してからもう一度承認する） */
  | "failed";

export type ManualStepAutoRunHandle = {
  /** 承認済みか（止まっている間もtrue） */
  active: boolean;
  /** いま次の項目を流してよいか */
  running: boolean;
  pausedBy: ManualStepAutoRunPause | null;
  /** この承認で流し終えた行（チェックの付かない確認コマンドを二度流さないための記録） */
  doneLines: ReadonlySet<number>;
  /** 失敗したときに出力をClaudeへ送ってよいか（承認パネルのチェック） */
  consent: boolean;
  setConsent: (consent: boolean) => void;
  start: () => void;
  stop: () => void;
  pause: (reason: ManualStepAutoRunPause) => void;
  resume: () => void;
  markDone: (line: number) => void;
};

export function useManualStepAutoRun(): ManualStepAutoRunHandle {
  const [active, setActive] = useState(false);
  const [pausedBy, setPausedBy] = useState<ManualStepAutoRunPause | null>(null);
  const [doneLines, setDoneLines] = useState<ReadonlySet<number>>(() => new Set());
  // 既定はオン。**押した1回にこの同意も含める**ので、外したい人は承認する前に外す
  const [consent, setConsent] = useState(true);

  const start = useCallback(() => {
    setActive(true);
    setPausedBy(null);
  }, []);

  const stop = useCallback(() => {
    setActive(false);
    setPausedBy(null);
  }, []);

  const pause = useCallback((reason: ManualStepAutoRunPause) => {
    setPausedBy(reason);
  }, []);

  // 止まっていた理由が解消したときだけ再開する（`active`が落ちていれば何もしない）
  const resume = useCallback(() => {
    setPausedBy(null);
  }, []);

  const markDone = useCallback((line: number) => {
    setDoneLines((prev) => (prev.has(line) ? prev : new Set([...prev, line])));
  }, []);

  return {
    active,
    running: active && pausedBy === null,
    pausedBy,
    doneLines,
    consent,
    setConsent,
    start,
    stop,
    pause,
    resume,
    markDone,
  };
}
