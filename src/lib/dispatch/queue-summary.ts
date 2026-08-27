import {
  isActiveDispatchJobStatus,
  isDispatchHostAtSessionCapacity,
  isSessionControlJobKind,
  isSessionLaunchJobKind,
  type DispatchHostView,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { formatLaunchHoldMetric } from "@/lib/dispatch/host-metrics";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

/**
 * 実行キューの要約（#1266）。
 *
 * GitHub Actionsで並列に一括で流す使い方をやめ、**サブPCで順に流す**形にしたため
 * （#1261）、「今どこまで進んでいて、あと何本待っているか」を1か所で見られる必要が出た。
 *
 * **並びは払い出し（`claimDispatchJob`）と同じ。** `queuePriority`の降順 → `createdAt`の
 * 昇順で、画面に見えている順番と実際に走る順番が一致する。`queuePriority`は既定0なので、
 * 「先頭へ上げる」（#1541）を押していないキューは従来どおり積んだ順に流れる。
 */

/** 未完了ジョブのうち、実際に走っているとみなす状態 */
function isRunningStatus(job: DispatchJobView): boolean {
  return job.status === "CLAIMED" || job.status === "RUNNING";
}

export type DispatchQueueSummary = {
  /** 走っているジョブ（積んだ順） */
  running: DispatchJobView[];
  /** 順番待ち（積んだ順＝払い出される順） */
  queued: DispatchJobView[];
  /** 直近24時間に失敗・タイムアウトしたもの（新しい順） */
  failed: DispatchJobView[];
  /**
   * まだ届いていない制御ジョブ＝停止・セッション終了・追加指示（#1519）。積んだ順。
   *
   * **`running`・`queued`とは別に持ち、件数にも数えない。** 制御ジョブは同時実行数の枠を
   * 使わず、枠外で先に払い出される（#1332・#1544）。ここを混ぜると「実行中 3/2」のような
   * 数え方になる。それでも一覧に出すのは、pull型ぶん届くまで数秒〜30秒あり、その間
   * **積んだことがキューのどこにも出ない**ため（「押したのに何も起きない」に見える）。
   *
   * 終わったものは入れない。結果はそのIssueのセッション表示（`issue-session-status.tsx`）に出る。
   */
  controls: DispatchJobView[];
  /** 同時実行数の上限。ホストの申告と設定の小さい方が入る（不明ならnull） */
  concurrency: number | null;
  /** 積まれているジョブの件数。走っている数＋待っている数 */
  activeCount: number;
  /**
   * ホストで生きているセッション本数とその上限（#2265）。**バッジに出す数字はこちら。**
   * 応答していて本数を申告しているホストが1台も無ければ`null`（`liveSessions`と`maxSessions`は
   * 同時にnullになる）。
   *
   * **`activeCount`では「今どれだけ埋まっているか」を出せない。** ジョブはtmuxセッションが
   * 立った時点で`succeeded`になるため、10本走っていてもジョブの件数は0〜1にしかならず、
   * バッジがサブPCの混み具合を映していなかった。数え方の元は`summarizeDispatchSessionCapacity`と
   * 同じホストの申告（`*-issue-<番号>`のtmuxセッション数／`DISPATCH_MAX_SESSIONS`・既定12）。
   */
  liveSessions: number | null;
  maxSessions: number | null;
};

export function summarizeDispatchQueue(
  jobs: readonly DispatchJobView[],
  concurrency: number | null,
  hosts: readonly DispatchHostView[] = [],
): DispatchQueueSummary {
  // **同時実行数の枠を使うジョブだけを数える**（#1332・#1544）。セッションの停止・終了は
  // 枠を使わず、tmuxを1回叩いて終わるため、ここへ混ぜると「実行中 3/2」のような数え方になる。
  // 制御ジョブの状態はそのIssueのセッション表示（`issue-session-status.tsx`）に出る。
  // 逆に**横断質問（#1454）は`LAUNCH`と同じ枠で走る**ので数える（`claimDispatchJobs`の空きの
  // 計算と同じ集合＝`SESSION_LAUNCH_JOB_KINDS`。ずれると、枠が埋まっていても「実行中 0/2」と出る）
  const launchJobs = [...jobs].filter((job) => isSessionLaunchJobKind(job.kind));

  // 走る順。`queuePriority`が同じなら積んだ順（既定は全件0なので従来と同じ並びになる）
  const byRunOrder = [...launchJobs].sort(
    (a, b) => b.queuePriority - a.queuePriority || a.createdAt.localeCompare(b.createdAt),
  );

  const running = byRunOrder.filter(isRunningStatus);
  const queued = byRunOrder.filter((job) => job.status === "QUEUED");
  // **終わったものは走る順ではなく新しい順に出す。** 「直近の失敗」で見たいのは順番ではなく
  // 直近かどうかで、先頭へ上げたジョブが後から失敗したときに古い失敗より上へ来てしまう
  const failed = launchJobs
    .filter((job) => job.status === "FAILED" || job.status === "TIMEOUT")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // 制御ジョブ（#1519）。**未完了のものだけ**を、`launchJobs`とは別に組む。数える集合
  // （`activeCount`・`describeDispatchQueueLoad`・`cancelableDispatchJobs`）へは入れない
  const controls = [...jobs]
    .filter((job) => isSessionControlJobKind(job.kind) && isActiveDispatchJobStatus(job.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // 生きているセッション本数（#2265）。**応答していて本数を申告しているホストだけを足す**
  // （`describeDispatchQueueStall`と同じ絞り方）。どちらも無ければ`null`にして、バッジ側が
  // 従来どおりジョブの件数へ落とせるようにする。
  //
  // **`online`で絞るのは、ホストの行が消えないため。** `listDispatchState`は`findMany`で全件
  // 返すので、pollerが止まったホストの`liveSessions`は最後の値のまま残り続ける。絞らないと、
  // バッジが古い数字（例: 12）で固まったまま「今12本走っている」と読める状態になる。
  const capacities = summarizeDispatchSessionCapacity(hosts.filter((host) => host.online));
  const sessionTotals =
    capacities.length === 0
      ? null
      : capacities.reduce(
          (total, capacity) => ({ live: total.live + capacity.live, max: total.max + capacity.max }),
          { live: 0, max: 0 },
        );

  return {
    running,
    queued,
    failed,
    controls,
    concurrency,
    activeCount: running.length + queued.length,
    liveSessions: sessionTotals?.live ?? null,
    maxSessions: sessionTotals?.max ?? null,
  };
}

/**
 * バッジに出す件数（#2265）。**応答していてセッション本数を申告しているホストがあればそれを出す。**
 *
 * 申告が1台も無いとき（古いpollerだけの環境・pollerが止まっている間）に限り、従来どおり
 * 積まれているジョブの件数を出す。判定材料が無いことを理由にバッジを消すと、ジョブを積んだこと
 * 自体が画面から消える。
 */
export function countDispatchQueueBadge(summary: DispatchQueueSummary): number {
  return summary.liveSessions ?? summary.activeCount;
}

/**
 * 生きているセッション本数の1行（例:「セッション 10/12」。#2265）。申告が無ければ`null`。
 *
 * バッジの数字が何を指しているかを`title`で答えるためのもの。**キューの「実行中 n/m」とは
 * 別物**（あちらはジョブと同時実行数で、セッションが立った時点で数から外れる）。
 */
export function describeDispatchSessionLoad(summary: DispatchQueueSummary): string | null {
  if (summary.liveSessions === null || summary.maxSessions === null) return null;
  return `セッション ${summary.liveSessions}/${summary.maxSessions}`;
}

/** 実行キューのポップオーバーの見出しに添える1行（例:「実行中 2/2・待機 3」） */
export function describeDispatchQueueLoad(summary: DispatchQueueSummary): string {
  const running =
    summary.concurrency === null
      ? `実行中 ${summary.running.length}`
      : `実行中 ${summary.running.length}/${summary.concurrency}`;
  const queued = summary.queued.length > 0 ? `待機 ${summary.queued.length}` : null;
  return [running, queued].filter(Boolean).join("・");
}

/**
 * セッション本数の空き（#1394）。
 *
 * **同時実行数（`concurrency`）では待機の理由を説明できない。** あちらはジョブの払い出しにしか
 * 効かず、ジョブはtmuxセッションが立った時点で`succeeded`になるため、実際に起動を止めているのは
 * `DISPATCH_MAX_SESSIONS`（#1361）の方。上限に達している間、pollerは起動ジョブを取りに来ない。
 *
 * これが画面に出ていないと、「正常に上限で待っている」状態と「pollerが落ちている」状態が
 * 順番待ちの表示だけからは区別できない。
 */
export type DispatchSessionCapacity = {
  hostName: string;
  live: number;
  max: number;
  /** 上限に達しており、このホストは起動ジョブを取りに来ない */
  atCapacity: boolean;
};

/**
 * 申告のあるホストのセッション本数をまとめる。
 *
 * **本数を申告していないホスト（古いpoller）は落とす。** 判定材料が無いまま0本として並べると、
 * 実際には埋まっているホストが空いているように見える。
 */
export function summarizeDispatchSessionCapacity(
  hosts: readonly DispatchHostView[],
): DispatchSessionCapacity[] {
  return hosts
    .filter((host) => host.maxSessions !== null && host.liveSessions !== null)
    .map((host) => ({
      hostName: host.name,
      live: host.liveSessions as number,
      max: host.maxSessions as number,
      atCapacity: isDispatchHostAtSessionCapacity(host),
    }));
}

/**
 * そのホストで見せるセッション（#1567）。
 *
 * **`ALIVE`と`FAILED`だけを出す。** `EXITED`・`GONE`は人が作業を終えて畳んだ場合がほとんどで、
 * 24時間ぶん残っている（`GONE_SESSION_RETENTION_MS`）。それを並べると、今動いているものが
 * 終わったものに埋もれる。逆に`FAILED`を落とさないのは、**セッションの異常終了はこの一覧を
 * 除くとキューのどこにも出ない**ため（「直近の失敗」に出るのはジョブの失敗で、あちらは
 * tmuxが立った時点で終わっている）。
 *
 * 並びは生きているものが先で、その中では新しい報告が上。
 */
export function selectHostSessions(
  sessions: readonly DispatchSessionView[],
  hostName: string,
): DispatchSessionView[] {
  return sessions
    .filter(
      (session) =>
        session.host === hostName && (session.state === "ALIVE" || session.state === "FAILED"),
    )
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === "ALIVE" ? -1 : 1;
      return b.lastReportedAt.localeCompare(a.lastReportedAt);
    });
}

/**
 * そのホストへ最後に積んだチェックアウトの更新（#1927）。無ければ`null`。
 *
 * **`SELF_UPDATE`はキューの一覧（`summarizeDispatchQueue`）に出ない。** 起動ジョブでも制御
 * ジョブでもないため`running`・`queued`・`failed`・`controls`のどれにも入らず、押した結果が
 * 画面のどこにも出ないまま終わっていた（#1927。実際には全件失敗していたのに「ボタンが
 * 反応しない」としか見えなかった）。ホストのカードは押した本人が見ている場所なので、
 * そこへ出すために1件だけ引く。
 */
export function selectHostSelfUpdateJob(
  jobs: readonly DispatchJobView[],
  hostName: string,
): DispatchJobView | null {
  return (
    [...jobs]
      .filter((job) => job.kind === "SELF_UPDATE" && job.targetHost === hostName)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
}

/**
 * 順番待ちが進まない理由（#1394）。理由が無ければ`null`。
 *
 * **応答しているホストだけを見る。** 落ちているホストは「上限で待っている」のではなく
 * 「取りに来られない」ので、別の話として扱う（そちらは従来どおり`online`の表示が持つ）。
 */
export function describeDispatchQueueStall(
  summary: DispatchQueueSummary,
  hosts: readonly DispatchHostView[],
): string | null {
  if (summary.queued.length === 0) return null;

  const online = hosts.filter((host) => host.online);

  const blocked = summarizeDispatchSessionCapacity(online).filter((capacity) => capacity.atCapacity);
  if (blocked.length > 0) {
    const names = blocked
      .map((capacity) => `${formatDispatchHostName(capacity.hostName)}（${capacity.live}/${capacity.max}本）`)
      .join("・");
    return `${names}がセッション本数の上限に達しているため、順番待ちは進みません。作業が終わったセッションが畳まれると自動で再開します。`;
  }

  // 本数に空きがあっても、メモリ・SWAPが逼迫していればpollerは起動ジョブを取りに来ない（#2095）。
  // **本数の上限の後に見る。** 両方に当てはまるホストでは畳むのが先で、そちらの方が待っている
  // 人にできることが具体的（畳めば余力も戻る）
  const holding = online.flatMap((host) =>
    host.launchHold === null ? [] : [{ name: host.name, hold: host.launchHold }],
  );
  if (holding.length > 0) {
    const names = holding
      .map(({ name, hold }) => `${formatDispatchHostName(name)}（${formatLaunchHoldMetric(hold)}）`)
      .join("・");
    return `${names}のメモリ・SWAPが逼迫しているため、順番待ちは進みません。走っている作業が終わって余力が戻ると自動で再開します。`;
  }

  return null;
}

/**
 * 1件のジョブが順番待ちのまま進まない理由（#1394）。理由が無ければ`null`。
 *
 * キュー全体の`describeDispatchQueueStall`と同じ説明を、**押した本人が見ている場所**
 * （Issue詳細のボタンの下）にも出すためのもの。ヘッダーのポップオーバーは開かないと見えず、
 * 「押したのに始まらない」と気づくのはIssueの画面の方が先。
 */
export function describeDispatchJobWaitReason(
  job: DispatchJobView,
  hosts: readonly DispatchHostView[],
): string | null {
  // 横断質問セッション（#1454）もtmuxセッションを立て、pollerのセッション本数
  // （`count_issue_sessions`は`<repo>-issue-<番号>`を数える）に入るため同じ理由で待たされる（#1544）
  if (job.status !== "QUEUED" || !isSessionLaunchJobKind(job.kind)) return null;
  const host = hosts.find((candidate) => candidate.name === job.targetHost);
  // 落ちているホストは「上限で待っている」のではなく「取りに来られない」。別の話として扱う
  if (!host || !host.online) return null;
  if (isDispatchHostAtSessionCapacity(host)) {
    return `${formatDispatchHostName(host.name)}のセッションが上限（${host.liveSessions}/${host.maxSessions}本）に達しているため、まだ起動できません。作業が終わったセッションが畳まれると順に起動します。`;
  }
  // 本数に空きがあっても、メモリ・SWAPが逼迫している間は取りに来ない（#2095）。
  // **待っている人にできることが違う**ので、本数の上限とは別の文で説明する
  if (host.launchHold !== null) {
    return `${formatDispatchHostName(host.name)}の${formatLaunchHoldMetric(host.launchHold)}のため、まだ起動できません。走っている作業が終わって余力が戻ると順に起動します。`;
  }
  return null;
}

/** まとめて取り消せるジョブ（`queued`・`claimed`まで。`running`は途中で止めると中途半端なworktreeが残る） */
export function cancelableDispatchJobs(
  summary: DispatchQueueSummary,
): DispatchJobView[] {
  return [...summary.queued, ...summary.running.filter((job) => job.status === "CLAIMED")];
}

/** 未完了ジョブが1件でもあるか（ポーリング間隔の切り替えと同じ判定を画面でも使う） */
export function hasActiveDispatchJobs(jobs: readonly DispatchJobView[]): boolean {
  return jobs.some((job) => isActiveDispatchJobStatus(job.status));
}
