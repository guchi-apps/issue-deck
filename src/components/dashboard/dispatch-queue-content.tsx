"use client";

import { AlertTriangle, ArrowUp, Loader2, X } from "lucide-react";

import { DispatchHostPanel } from "@/components/dashboard/dispatch-host-panel";
import { DispatchIssueTitle } from "@/components/dashboard/dispatch-issue-title";
import { Button } from "@/components/ui/button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  describeDispatchJobKind,
  describeDispatchJobStatus,
  isCancelableDispatchJobStatus,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  cancelableDispatchJobs,
  describeDispatchQueueLoad,
  describeDispatchQueueStall,
  summarizeDispatchQueue,
  type DispatchQueueSummary,
} from "@/lib/dispatch/queue-summary";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { cn } from "@/lib/utils";

/**
 * 実行キューの中身（#1266・#1638）。
 *
 * **PCのポップオーバー（`dispatch-queue-button.tsx`）とスマホのボトムシート
 * （`mobile/mobile-dispatch-status-button.tsx`）が同じものを出す。** 出し方（ポップオーバーか
 * シートか）と置き場所だけが違い、中身が食い違う理由が無いため共通化してある（#1638）。
 *
 * **並びは払い出し（`claimDispatchJob`）と同じ。** `queuePriority`の降順 → `createdAt`の昇順で、
 * 画面の順番と実際に走る順番が一致する。
 *
 * **先頭にホストの様子を出す**（#1567・`dispatch-host-panel.tsx`）。従来はセッションの本数
 * （`サブPCのセッション 6/12`）しか出ておらず、その6本が何なのかとホストの余力を見るには
 * `tmux ls`かops-dashboardを開くしかなかった。
 *
 * **「順番待ち」の2行目以降の↑は先頭へ上げる操作**（#1541）。夜にまとめて積んだあと
 * 「これを次に流したい」が出てくるが、キューは積んだ順で固定されていて、取り消して積み直すと
 * 最後尾へ回るだけだった。先頭の行に出さないのは、押しても何も変わらないため。
 *
 * 取り消せるのは`QUEUED`と`CLAIMED`まで。`RUNNING`はworktreeの作成や依存インストールの最中で、
 * 途中で止めると中途半端なworktreeとブランチが残る（#1179の取り決めをそのまま守る）。
 *
 * **「直近の失敗」の×は取り消しではなく表示を消す操作**（#1479）。終了したジョブは24時間
 * 出続けるため、対処が済んだ失敗を畳めないと、新しい失敗が古いものに埋もれる。消しても
 * DBの行と失敗理由は残る（`dismissDispatchJob`）。
 *
 * **行はIssueのタイトルと種別を主役にする**（#1519）。従来は`issue-deck #1519`と番号しか
 * 出ておらず、何のジョブが積まれているのかがGitHubを開くまで分からなかった。種別チップは
 * 全種別に出す（`実装`／`横断質問`ほか）。**`QUEUED`のときは状態ラベルがどちらも「順番待ち」**に
 * なるため、状態だけでは起動と横断質問を見分けられない。
 *
 * **そのタイトルはIssue詳細への導線でもある**（#1625）。ここに出ているIssueを開くのに一覧へ
 * 戻って探し直す必要があった。**開いている器を閉じてから遷移するのは呼び出し側の役目**——
 * 開いたまま後ろの画面だけが変わると何が起きたのか分からないため、`onOpenIssue`には
 * 閉じる処理を挟んだものを渡す。
 */
export function DispatchQueueContent({
  dispatch,
  onOpenIssue,
}: {
  dispatch: DispatchStateHandle;
  /** 行のタイトルからIssue詳細を開く（#1625）。渡さなければタイトルはただの文字列のまま */
  onOpenIssue?: (issueId: string) => void;
}) {
  const summary = summarizeDispatchQueue(dispatch.jobs, dispatch.concurrency);
  const stall = describeDispatchQueueStall(summary, dispatch.hosts);
  const cancelable = cancelableDispatchJobs(summary);

  async function cancelAll() {
    // 1件ずつ順に投げる。**まとめて投げると、拒否された理由がどれのものか分からなくなる**
    for (const job of cancelable) {
      await dispatch.cancel(job.id);
    }
  }

  async function dismissAllFailed() {
    // 取り消しと同じく1件ずつ順に投げる（#1479）
    for (const job of summary.failed) {
      await dispatch.dismiss(job.id);
    }
  }

  return (
    <>
      {/*
        ホストの様子（#1567）。セッション本数と上限（#1394）・リソース使用率・そのホストで
        動いているセッションを1枚にまとめている。**同時実行数の隣に並べて出す**のは従来と
        同じ理由で、名前が似ていて役割が違う2つの上限を別の場所に置くと、どちらが起動を
        止めているのか読み取れないため
      */}
      <DispatchHostPanel
        hosts={dispatch.hosts}
        sessions={dispatch.sessions}
        onOpenIssue={onOpenIssue}
      />

      {/* 順番待ちが進まない理由。無いと「押しても何も起きない」としか見えない（#1394） */}
      {stall && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{stall}</span>
        </p>
      )}

      {summary.activeCount === 0 &&
        summary.failed.length === 0 &&
        summary.controls.length === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            積まれているジョブはありません。Issueの「実装を開始」から積むと、上限
            {summary.concurrency === null ? "" : `（${summary.concurrency}本）`}
            まで並行し、あとは順番に流れます。
          </p>
        )}

      <QueueSection
        title="実行中"
        jobs={summary.running}
        onCancel={dispatch.cancel}
        onOpenIssue={onOpenIssue}
      />
      <QueueSection
        title="順番待ち"
        jobs={summary.queued}
        onCancel={dispatch.cancel}
        onPrioritize={dispatch.prioritize}
        onOpenIssue={onOpenIssue}
        showOrder
      />
      {/*
        まだ届いていない停止・セッション終了・追加指示（#1519）。**上の実行中・順番待ちとは
        数え方が違う**（同時実行数の枠を使わず、枠外で先に払い出される）ので、注記を添えて
        別の節にする。ここを混ぜると「実行中 3/2」になる（#1544）
      */}
      <QueueSection
        title="送信中の操作"
        note="同時実行数の枠は使わず、先に届きます。"
        jobs={summary.controls}
        onOpenIssue={onOpenIssue}
      />
      <QueueSection
        title="直近の失敗"
        jobs={summary.failed}
        onDismiss={dispatch.dismiss}
        onOpenIssue={onOpenIssue}
      />

      {cancelable.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          className="mt-3 w-full"
          disabled={dispatch.isSubmitting}
          onClick={() => void cancelAll()}
        >
          {dispatch.isSubmitting ? <Loader2 className="animate-spin" /> : <X />}
          まとめて取り消す（{cancelable.length}件）
        </Button>
      )}
      {/*
        失敗が1件だけなら行の×で足りるので出さない。溜まったときにだけ、1件ずつ押させない
        ための導線として出す
      */}
      {summary.failed.length > 1 && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full text-muted-foreground"
          disabled={dispatch.isSubmitting}
          onClick={() => void dismissAllFailed()}
        >
          {dispatch.isSubmitting ? <Loader2 className="animate-spin" /> : <X />}
          失敗の表示をすべて消す（{summary.failed.length}件）
        </Button>
      )}
      {/*
        このキューが何を映しているかの但し書き（#1567）。**GitHub Actionsでの無人実行は
        ここには出ない**（`DispatchJob`を通らずGitHub側で走り、実行中かどうかはIssue一覧の
        バッジ＝`use-issues-workflow-running.ts`が示す）。同じ「実行」でも経路が別なので、
        出ていないことを止まっていると読まれないよう画面上で答えておく
      */}
      <p className="mt-3 border-t pt-2 text-[11px] text-muted-foreground">
        このキューはサブPCのような常駐ホストの分だけです。GitHub Actionsでの無人実行はここには出ません。
      </p>

      {dispatch.error && <p className="mt-2 text-xs text-destructive">{dispatch.error}</p>}
    </>
  );
}

/**
 * 実行キューを開くボタンに重ねる印（#1519・#1638）。PCのトップバーとスマホのヘッダーで
 * 同じ規則にする。
 *
 * - 動いているものがあれば件数バッジ
 * - **動いてはいないが見るべき失敗が残っているときはドット**。件数バッジは`activeCount`にしか
 *   出ないため、失敗だけが残っているとボタンが無印になり、開くまで気づけなかった。件数ではなく
 *   ドットにしているのは、押して確かめてほしいのが「何件あるか」ではなく「何が失敗したか」のため
 */
export function DispatchQueueBadge({ summary }: { summary: DispatchQueueSummary }) {
  if (summary.activeCount > 0) {
    return (
      <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
        {summary.activeCount}
      </span>
    );
  }

  if (summary.failed.length > 0) {
    return (
      <span
        aria-hidden
        className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-destructive"
      />
    );
  }

  return null;
}

/** ボタンのtitle・シートの見出しに添える負荷の要約（#1519）。失敗も文言に出す */
export function describeDispatchQueueTitle(summary: DispatchQueueSummary): string {
  return `${describeDispatchQueueLoad(summary)}${
    summary.failed.length > 0 ? `・失敗 ${summary.failed.length}` : ""
  }`;
}

function QueueSection({
  title,
  note = null,
  jobs,
  onCancel = null,
  onDismiss = null,
  onPrioritize = null,
  onOpenIssue,
  showOrder = false,
}: {
  title: string;
  /** 節の見出しの下に出す補足（#1519）。「送信中の操作」が枠を使わないことの説明に使う */
  note?: string | null;
  jobs: DispatchJobView[];
  /**
   * 省略すると取り消しボタンを出さない（終わったジョブ）。渡した場合も、**取り消せる状態の
   * 行にだけ**ボタンを出す（`RUNNING`はworktreeの作成途中で、止めると中途半端な状態が残る）。
   */
  onCancel?: ((jobId: string) => Promise<boolean>) | null;
  /**
   * 表示を消す操作（#1479）。**`onCancel`とpropsを分けている。** 同じ×印でも、片方は走る前の
   * ジョブを止める操作、もう片方は終わったジョブの表示を畳むだけの操作で、取り違えると
   * 実行中のものを消せてしまう。渡すのは「直近の失敗」だけ。
   */
  onDismiss?: ((jobId: string) => Promise<boolean>) | null;
  /**
   * 先頭へ上げる操作（#1541）。渡すのは「順番待ち」だけで、**先頭の行には出さない**
   * （押しても何も変わらない）。`onCancel`・`onDismiss`とpropsを分けているのと同じ理由で
   * 独立させている。
   */
  onPrioritize?: ((jobId: string) => Promise<boolean>) | null;
  /**
   * 行のタイトルからIssue詳細を開く（#1625）。**すべての節へ渡す**（実行中・順番待ち・
   * 送信中の操作・直近の失敗）。失敗した行こそIssueを開いて経緯を見たいので、節によって
   * 押せたり押せなかったりしないようにする。
   */
  onOpenIssue?: (issueId: string) => void;
  showOrder?: boolean;
}) {
  if (jobs.length === 0) return null;

  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {note && <p className="text-[11px] text-muted-foreground/80">{note}</p>}
      <ul className="mt-1 flex flex-col gap-1">
        {jobs.map((job, index) => {
          // 種別を必ず渡す（#1294。省略すると種別が増えたときに文言が黙って「起動しました」になる）
          const status = describeDispatchJobStatus(job.status, job.kind);
          return (
            <li key={job.id} className="flex items-start gap-2 text-xs">
              {showOrder && (
                <span className="mt-0.5 w-4 shrink-0 text-right text-muted-foreground">
                  {index + 1}
                </span>
              )}
              <span className="min-w-0 flex-1">
                {/*
                  1行目は**種別・番号・タイトル**（#1519）。番号だけでは何のジョブか分からず、
                  タイトルは行の中で最も幅が要るのでここへ置く。**引けなければ番号だけ**に戻す
                  （「（タイトル不明）」のような穴埋めを出すと、実際のタイトルと紛らわしい）
                */}
                <span className="flex min-w-0 items-baseline gap-1">
                  <span className="shrink-0 rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
                    {describeDispatchJobKind(job.kind)}
                  </span>
                  {/*
                    幅が決まった器（ポップオーバー・シート）に出すので、長いタイトルはホバーで補う。
                    タイトルはそのIssueの詳細への導線でもある（#1625）
                  */}
                  <DispatchIssueTitle
                    className="min-w-0"
                    issueNumber={job.issueNumber}
                    issueTitle={job.issueTitle}
                    issueId={job.issueId}
                    onOpenIssue={onOpenIssue}
                  />
                </span>
                <span
                  className={cn(
                    "block truncate text-muted-foreground",
                    status.tone === "error" && "text-destructive",
                  )}
                >
                  {job.repositoryFullName.split("/")[1]}・{formatDispatchHostName(job.targetHost)}・
                  {status.label}・{formatRelativeDate(job.createdAt)}
                </span>
                {/* 失敗理由はホバーではなく本文で出す（主な用途が外出先のスマホ） */}
                {job.message && (
                  <span className="block whitespace-normal text-muted-foreground">{job.message}</span>
                )}
                {/*
                  追加指示の本文（#1012）。**届くまで最大1分あるので、何を送ったのかが見えないと
                  送り直してよいか判断できない。** Issue詳細のセッション表示と同じ書式で出す
                  （`issue-session-status.tsx`）
                */}
                {job.instruction && (
                  <span className="block whitespace-normal text-muted-foreground">
                    「{job.instruction}」
                  </span>
                )}
              </span>
              {onPrioritize && index > 0 && (
                <button
                  type="button"
                  aria-label={`#${job.issueNumber}のジョブを先頭へ上げる`}
                  title="先頭へ上げる（次に実行されます）"
                  className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => void onPrioritize(job.id)}
                >
                  <ArrowUp className="size-3.5" />
                </button>
              )}
              {onCancel && isCancelableDispatchJobStatus(job.status) && (
                <button
                  type="button"
                  aria-label={`#${job.issueNumber}のジョブを取り消す`}
                  className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => void onCancel(job.id)}
                >
                  <X className="size-3.5" />
                </button>
              )}
              {onDismiss && (
                <button
                  type="button"
                  aria-label={`#${job.issueNumber}の失敗の表示を消す`}
                  title="表示を消す（失敗の記録は残ります）"
                  className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => void onDismiss(job.id)}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
