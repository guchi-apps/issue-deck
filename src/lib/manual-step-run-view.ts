/**
 * 手作業アシスタントの自動実行（#1869）を画面へ出すための型と文言（#1882）。
 *
 * **サーバー側の実体（`lib/manual-step-run.ts`）とは分けてある。** あちらはDBとGitHubに触るので、
 * クライアントコンポーネントから読み込めない。ここには`GET /api/dispatch`が返す形と、
 * その説明文だけを置く。
 */

/** 自動実行の状態。Prismaの`ManualStepRunStatus`と同じ並び */
export type ManualStepRunStatus = "RUNNING" | "PAUSED" | "FINISHED" | "STOPPED";

/** 止まっている理由。Prismaの`ManualStepRunPause`と同じ並び */
export type ManualStepRunPause = "USER" | "FAILED" | "ENQUEUE_FAILED";

export type ManualStepRunView = {
  repositoryFullName: string;
  issueNumber: number;
  /** Issueのタイトル（引けなければ`null`。`DispatchJobView`と同じ扱い） */
  issueTitle: string | null;
  /** issue-deckのIssue詳細を開くためのid（引けなければ`null`。押せない導線を作らない） */
  issueId: string | null;
  targetHost: string;
  status: ManualStepRunStatus;
  pausedReason: ManualStepRunPause | null;
  /** 流し終えた件数と全体の件数（手順＋完了の確認） */
  done: number;
  total: number;
  /** いま流している（止まっているならそこで待っている）項目の本文中の行番号 */
  currentLine: number | null;
  /** その項目の見出し（実行計画の`text`） */
  currentLabel: string | null;
  /** いま積んでいる代行実行ジョブのid。画面が結果のパネルを引き当てるのに使う */
  currentJobId: string | null;
  /** 止まった理由・中断の結果など、そのまま出す一文 */
  message: string | null;
  /** 失敗したときに出力をClaudeへ送ってよいか（承認時のチェック） */
  diagnoseConsent: boolean;
  startedAt: string;
  finishedAt: string | null;
};

/** まだ画面が面倒を見る必要のある実行か（走っている・止まっている） */
export function isActiveManualStepRun(status: ManualStepRunStatus): boolean {
  return status === "RUNNING" || status === "PAUSED";
}

/**
 * 進み具合の1行（#1882）。**止まっているときはその理由まで出す**——止まっていることに
 * 気づかないまま画面を見続けるのがいちばん困る状態で、次に何を押せばよいかも変わる。
 */
export function describeManualStepRun(run: ManualStepRunView): string {
  switch (run.status) {
    case "RUNNING":
      return `自動実行中 ${Math.min(run.done + 1, run.total)} / ${run.total}`;
    case "PAUSED":
      switch (run.pausedReason) {
        case "USER":
          return "あなたが実行する手順で止まっています";
        case "FAILED":
          return "失敗したため止まっています";
        default:
          return "実行を積めなかったため止まっています";
      }
    case "FINISHED":
      return "自動実行が終わりました";
    case "STOPPED":
      return "自動実行を中断しました";
  }
}

/** 進み具合の割合（0〜100）。件数が0のときは0 */
export function manualStepRunProgressPercent(run: ManualStepRunView): number {
  if (run.total === 0) return 0;
  return Math.round((run.done / run.total) * 100);
}

/** そのIssueの自動実行を引く（`GET /api/dispatch`が返した一覧から） */
export function findManualStepRun(
  runs: readonly ManualStepRunView[],
  repositoryFullName: string,
  issueNumber: number,
): ManualStepRunView | null {
  return (
    runs.find(
      (run) => run.repositoryFullName === repositoryFullName && run.issueNumber === issueNumber,
    ) ?? null
  );
}
