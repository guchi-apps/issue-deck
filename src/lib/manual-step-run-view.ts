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
 *
 * `FINISHED`・`STOPPED`の文言を出す画面は#2073で無くなった（`listManualStepRunViews`が
 * 返すのは`RUNNING`と`PAUSED`だけ）。分岐は状態の網羅として残す——`stopManualStepRun`等が
 * その場で返す1件はこの型のままで、状態が増えたときにここで気づけるようにしておく。
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

/** 一覧の入口に出すバッジと、その中身の見出しに使う集計（#2119） */
export type ManualStepRunSummary = {
  /** 走っている（止まっているものを含む）実行の件数 */
  count: number;
  /** 全実行を合わせた進み具合 */
  done: number;
  total: number;
  /** 1件でも動いているか（バッジの回転を出すかどうか） */
  running: boolean;
  /** 1件でも失敗して止まっているか（バッジごと赤へ寄せるかどうか） */
  failed: boolean;
};

export function summarizeManualStepRuns(
  runs: readonly ManualStepRunView[],
): ManualStepRunSummary {
  return {
    count: runs.length,
    done: runs.reduce((sum, run) => sum + run.done, 0),
    total: runs.reduce((sum, run) => sum + run.total, 0),
    running: runs.some((run) => run.status === "RUNNING"),
    failed: runs.some((run) => isFailedManualStepRun(run)),
  };
}

/** 失敗して止まっているか。理由が`USER`（人が実行する手順で待っている）ものは含めない */
export function isFailedManualStepRun(run: ManualStepRunView): boolean {
  return (
    run.status === "PAUSED" &&
    (run.pausedReason === "FAILED" || run.pausedReason === "ENQUEUE_FAILED")
  );
}

/**
 * バッジの文言（#2119）。**1件のときは今までどおり`自動実行 2 / 5`のまま**——押せるように
 * なっただけの変更で文言まで変えると、見慣れた表示が理由も無く変わる。
 *
 * 複数走っているときだけ件数を先に出す。#1882の作りは先頭1件しか拾っておらず、2本目以降が
 * 走っていることが画面のどこにも出ていなかった。
 */
export function describeManualStepRunBadge(summary: ManualStepRunSummary): string {
  const progress = `${summary.done} / ${summary.total}`;
  return summary.count > 1 ? `自動実行 ${summary.count}件 ${progress}` : `自動実行 ${progress}`;
}

/**
 * 一覧に並べる順（#2119）。**押す必要があるものを上に置く**——失敗して止まっているもの、
 * 次に人が実行する手順で待っているもの、走っていて放っておいてよいもの、の順。
 *
 * 同じ段の中では受け取った順（`listManualStepRunViews`は`startedAt`の新しい順）を保つ。
 */
export function sortManualStepRunsForList(
  runs: readonly ManualStepRunView[],
): ManualStepRunView[] {
  const rank = (run: ManualStepRunView): number => {
    if (isFailedManualStepRun(run)) return 0;
    if (run.status === "PAUSED") return 1;
    return 2;
  };
  return [...runs].sort((a, b) => rank(a) - rank(b));
}
