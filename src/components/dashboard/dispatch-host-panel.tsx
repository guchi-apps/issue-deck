"use client";

import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  Monitor,
  Power,
  RefreshCw,
  Smartphone,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { DispatchIssueTitle } from "@/components/dashboard/dispatch-issue-title";
import {
  describeCodexPairingJob,
  describeCodexPairingRejection,
  formatCodexPairingCountdown,
  resolveCodexPairingRejection,
  type CodexPairingTone,
} from "@/lib/dispatch/codex-pairing";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import { isDispatchHostAtSessionCapacity } from "@/lib/dispatch/dispatch-job";
import {
  describeDispatchHostCheckout,
  describeDispatchHostSelfUpdate,
  type DispatchHostCheckoutRow,
  type DispatchHostCheckoutTone,
  type DispatchHostSelfUpdateRow,
} from "@/lib/dispatch/host-checkout";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import {
  describeDispatchHostLaunchHold,
  describeDispatchHostMetrics,
  formatHostMetricPercent,
  type DispatchHostMetricRow,
  type DispatchHostMetricTone,
} from "@/lib/dispatch/host-metrics";
import {
  describeDispatchHostReboot,
  describeDispatchHostRebootJob,
  describeRebootRejection,
  resolveRebootRejection,
  type DispatchHostRebootJobRow,
  type DispatchHostRebootRow,
} from "@/lib/dispatch/host-reboot";
import {
  describeSessionReap,
  summarizeIssueSession,
  type IssueSessionTone,
} from "@/lib/dispatch/issue-session";
import {
  selectHostCodexPairingJob,
  selectHostRebootJob,
  selectHostSelfUpdateJob,
  selectHostSessions,
} from "@/lib/dispatch/queue-summary";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { cn } from "@/lib/utils";

/**
 * ホストの様子（セッション本数・リソース使用率・動いているセッション）を1枚にまとめる（#1567）。
 *
 * **従来はセッションの本数（`サブPCのセッション 6/12`）しか出ていなかった。** その6本が何なのかは
 * `tmux ls`かops-dashboardを開くまで分からず、CPU・メモリも同様だったため、「もう1本起こして
 * よいか」を判断するたびにアプリを移ることになっていた。
 *
 * **PCの実行キュー（`dispatch-queue-button.tsx`）とスマホのホーム画面
 * （`mobile/mobile-home-screen.tsx`）が同じものを使う。** 片方だけに置くと、外出先で見たときに
 * 何が動いているのか分からないという元の状態がスマホ側に残る。
 * スマホ側は#1638でいったんヘッダーの実行状況シートへ移したが、ホームを開いても「いま何が
 * 動いているか」が分からなくなったため#1690で戻した。**同じ部品を2か所に置く代わりに、
 * ホームは`compact`で縮めたホストの様子（#1933）、ヘッダーのシートはそれに加えて動いている
 * セッションとキュー全体（順番待ち・失敗・停止操作）**という切り分けにしてある。
 *
 * **`compact`はスマホのホーム専用**（#1933）。使用率を横並びにし、セッションの一覧・
 * スクリプトの版（遅れているときを除く）・「更新して再起動」を落として、カード全体を
 * 実行状況シートを開くボタンにする。#1690で戻した時点のカードは縦242pxあり、それだけで
 * メニューの1行目を画面の外へ押し出していた。**#1638の「ホームから消えて分からなくなる」が
 * 再発しないのは、動いているセッションが消えるのではなく1タップ先へ移るだけだから**で、
 * 入力待ちのセッションがあることは縮めた側の見出しにも残す（`waitingCount`）。
 *
 * **セッションの行の文言・配色は`summarizeIssueSession`をそのまま使う**（Issue詳細の
 * `issue-session-status.tsx`と同じ）。ここで独自の言い方を作ると、同じセッションが画面に
 * よって違う状態に見える。
 *
 * **使用率で何かを止めることはしない。** 起動を止めているのはセッション本数の上限（#1361）と
 * 同時実行数だけで、ここは人が判断するための計器（`docs/multi-agent/gates.md`）。
 */

const METRIC_TONE_CLASS: Record<DispatchHostMetricTone, { bar: string; text: string }> = {
  normal: { bar: "bg-muted-foreground/60", text: "text-muted-foreground" },
  warn: { bar: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" },
  critical: { bar: "bg-destructive", text: "text-destructive" },
};

/**
 * チェックアウトの鮮度（#1612）の配色。**使用率と同じ3段階の同じ色**にして、画面の中で
 * 同じ色が違う重さを指さないようにする。
 */
const CHECKOUT_TONE_CLASS: Record<DispatchHostCheckoutTone, string> = {
  normal: "text-muted-foreground",
  warn: "text-amber-700 dark:text-amber-400",
  critical: "text-destructive",
};

const SESSION_TONE_CLASS: Record<IssueSessionTone, string> = {
  running: "bg-primary",
  waiting: "bg-amber-500",
  done: "bg-muted-foreground",
  error: "bg-destructive",
};

const SESSION_TEXT_CLASS: Record<IssueSessionTone, string> = {
  running: "text-muted-foreground",
  waiting: "text-amber-700 dark:text-amber-400",
  done: "text-muted-foreground",
  error: "text-destructive",
};

export function DispatchHostPanel({
  hosts,
  sessions,
  jobs = [],
  onOpenIssue,
  onRequestSelfUpdate,
  onRequestReboot,
  onRequestCodexPairing,
  compact = false,
  onOpenDetail,
}: {
  hosts: readonly DispatchHostView[];
  sessions: readonly DispatchSessionView[];
  /**
   * 積まれているジョブ（#1927）。**チェックアウトの更新（`SELF_UPDATE`）の結果を出すためだけに
   * 受け取る。** 渡さなければ従来どおり、押した後は何も出ない。
   */
  jobs?: readonly DispatchJobView[];
  /**
   * セッションの行のタイトルから、そのIssueの詳細を開く（#1625）。渡さなければタイトルは
   * ただの文字列のまま（従来の表示）。**Issueのidが引けている行にだけリンクを出す**ので、
   * 押しても何も起きない行は生まれない。
   */
  onOpenIssue?: (issueId: string) => void;
  /**
   * チェックアウトの更新を積む（#1875）。渡さなければボタンを出さない（`onOpenIssue`と同じ形）。
   *
   * これが無かった頃は`ssh`して`git pull && systemctl restart`する手作業Issueが、共有
   * ワークフローやpollerを直すたびに起票されていた（#1858・#1867）。
   */
  onRequestSelfUpdate?: (
    hostName: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * ホストごと再起動する（#2496）。渡さなければボタンを出さない（`onRequestSelfUpdate`と同じ形）。
   *
   * **「更新して再起動」とは別物。** あちらが畳むのはpollerのプロセスだけで走っているセッションは
   * 残るが、こちらはOSごと落ちる。これが無かった頃は、カーネル更新を当てるたびにsshして
   * `tmux ls`でセッションの有無を数えてから`sudo reboot`する手作業が要っていた
   * （guchi-apps/question#52・guchi-apps/subpc#68）。
   */
  onRequestReboot?: (
    hostName: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * CodexのペアリングコードをホストへPushして発行させる（#2524）。渡さなければ出さない
   * （`onRequestReboot`と同じ形）。
   *
   * **Claude CodeのRemote Control（#1219）と違い、セッションの行ではなくカードに置く。**
   * Codexが出すのはURLではなく`XXXX-XXXX`のペアリングコードで、繋がる先は
   * **そのホストのCodexセッション全部**（`serverName`はホスト名）。Issueごとのリンクとして
   * 出すと、押したIssueだけに繋がると誤解させる。
   */
  onRequestCodexPairing?: (
    hostName: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * 縮めた版で出す（#1933）。スマホのホーム専用で、使用率を横並びにしてセッションの一覧・
   * スクリプトの版（遅れているときを除く）・「更新して再起動」を落とす。
   * **`jobs`・`onRequestSelfUpdate`は渡さなくてよい**——押した結果を出す先はシート側になる。
   */
  compact?: boolean;
  /**
   * カード全体を押したときの受け取り手（#1933）。渡すとカードがボタンになる。
   * **`compact`と組にして使う**——縮めていない版はセッションの行にリンクを、更新の行に
   * ボタンを持っており、ボタンで包むとその中にボタンが入る。
   */
  onOpenDetail?: () => void;
}) {
  if (hosts.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {hosts.map((host) => (
        <HostCard
          key={host.name}
          host={host}
          sessions={selectHostSessions(sessions, host.name)}
          selfUpdateJob={selectHostSelfUpdateJob(jobs, host.name)}
          rebootJob={selectHostRebootJob(jobs, host.name)}
          codexPairingJob={selectHostCodexPairingJob(jobs, host.name)}
          onOpenIssue={onOpenIssue}
          onRequestSelfUpdate={onRequestSelfUpdate}
          onRequestReboot={onRequestReboot}
          onRequestCodexPairing={onRequestCodexPairing}
          compact={compact}
          onOpenDetail={onOpenDetail}
        />
      ))}
    </div>
  );
}

function HostCard({
  host,
  sessions,
  selfUpdateJob,
  rebootJob,
  codexPairingJob,
  onOpenIssue,
  onRequestSelfUpdate,
  onRequestReboot,
  onRequestCodexPairing,
  compact,
  onOpenDetail,
}: {
  host: DispatchHostView;
  sessions: DispatchSessionView[];
  selfUpdateJob: DispatchJobView | null;
  rebootJob: DispatchJobView | null;
  codexPairingJob: DispatchJobView | null;
  onOpenIssue?: (issueId: string) => void;
  onRequestSelfUpdate?: (
    hostName: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  onRequestReboot?: (
    hostName: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  onRequestCodexPairing?: (
    hostName: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  compact?: boolean;
  onOpenDetail?: () => void;
}) {
  const metrics = describeDispatchHostMetrics(host);
  // メモリ・SWAPの逼迫で新しいセッションの起動を見送っているか（#2095）。**出さないと
  // 「順番待ちのまま進まない」としか見えず、pollerが落ちている状態と区別が付かない**（#1394と同じ）
  const launchHold = describeDispatchHostLaunchHold(host);
  // いま動いているスクリプトがどの版か（#1612）。**pollerは自分と同じチェックアウトの
  // 回収スクリプト・ランチャーを動かすため、developへマージしただけでは効かない。**
  // ここに出しておかないと、効いていないことに気付く手掛かりがどこにも無い
  const checkout = describeDispatchHostCheckout(host);
  const atCapacity = isDispatchHostAtSessionCapacity(host);
  // 申告していない古いpollerでは本数そのものが不明。0本と混ぜない（#1394）
  const hasSessionCount = host.maxSessions !== null && host.liveSessions !== null;
  // 押した更新がどうなったか（#1927）。**遅れが解消した後も、結果が出るまでは出し続ける**
  // （成功すれば`behindCount`は0になるが、そこでボタンごと消すと「押しても何も起きなかった」
  // ままに見える）
  const selfUpdate = describeDispatchHostSelfUpdate(selfUpdateJob);
  const canSelfUpdate =
    onRequestSelfUpdate !== undefined &&
    host.selfUpdateCapable === true &&
    ((host.checkout?.behindCount ?? 0) > 0 || selfUpdate !== null);
  // ホストごと再起動できるか（#2496）。**「更新して再起動」とは別物**で、こちらはOSごと落ちる
  const reboot = describeDispatchHostReboot(host);
  const rebootResult = describeDispatchHostRebootJob(rebootJob);
  // **出すのは「再起動が要る」ときと、押した結果がまだ読める間だけ**（`canSelfUpdate`と同じ形）。
  // 常に置くと、落とす理由が無いときにも取り返しのつかないボタンがカードに並び続ける。
  // 落とすのは`/var/run/reboot-required`があるときだけ、という#52の結論とも揃う
  const canReboot =
    onRequestReboot !== undefined &&
    host.rebootCapable === true &&
    (reboot?.tone === "warn" || rebootResult !== null);
  // CodexのRemote Control相当（#2524）。**`canReboot`と違って常に出す。**
  // あちらは「落とす理由があるときだけ」出せばよいが、こちらは押したいと思ったときが
  // 出ていてほしいときそのもの（Codexのセッションが走っているかどうかは、押す前には
  // 画面から読み取れない——`codex agents`の一覧を機械可読で取る手段が無いため）。
  //
  // **行の組み立ては`CodexPairingRow`の中で行う**（`RebootRow`とはここが違う）。
  // コードには10分の寿命があり、残り時間を1秒ごとに数え直す必要があるため
  const canCodexPairing =
    onRequestCodexPairing !== undefined && host.codexRemoteControlCapable === true;

  if (compact) {
    return (
      <CompactHostCard
        host={host}
        metrics={metrics}
        checkout={checkout}
        launchHold={launchHold}
        atCapacity={atCapacity}
        hasSessionCount={hasSessionCount}
        waitingCount={countWaitingSessions(sessions)}
        onOpenDetail={onOpenDetail}
      />
    );
  }

  return (
    <div className="rounded-md border p-2">
      <HostHeading host={host} atCapacity={atCapacity} hasSessionCount={hasSessionCount} />

      {checkout && (
        <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px]">
          <span className="truncate text-muted-foreground">スクリプト {checkout.version}</span>
          <span className={cn("shrink-0", CHECKOUT_TONE_CLASS[checkout.tone])}>
            {checkout.status}
            {checkout.detail ? `・${checkout.detail}` : ""}
          </span>
        </div>
      )}

      {/* **遅れているときと、押した更新の結果がまだ読める間だけ出す。** 常に置くと、押す意味が
          無い状態でも再起動だけが走り、そのぶんジョブの払い出しが止まる。対応していない
          pollerにも出さない（配っても未知の種別として失敗するだけ） */}
      {canSelfUpdate && (
        <SelfUpdateRow
          hostName={host.name}
          selfUpdate={selfUpdate}
          onRequestSelfUpdate={onRequestSelfUpdate}
        />
      )}

      {/* **スクリプトの版の下、使用率の上に置く。** 判断に使うのは「いつから落としていないか」と
          「セッションが何本走っているか」で、後者は見出しに出ている。カードの中で
          「ホストそのものの状態」を上へ、「いま動いているもの」を下へ並べる順に合わせる */}
      {canReboot && reboot && (
        <RebootRow
          hostName={host.name}
          reboot={reboot}
          result={rebootResult}
          rejection={resolveRebootRejection({
            host,
            hasQueuedJob: rebootResult?.pending === true,
          })}
          onRequestReboot={onRequestReboot}
        />
      )}

      {/* **再起動の下、使用率の上に置く。** ここまでが「ホストそのものへの操作」で、
          下は計器と動いているセッション。Codexのセッションはホスト単位でしか指せないため、
          セッションの一覧の側ではなくこちらに属する */}
      {canCodexPairing && (
        <CodexPairingRow
          host={host}
          job={codexPairingJob}
          onRequestCodexPairing={onRequestCodexPairing}
        />
      )}

      {metrics && (
        <div className="mt-1.5 grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1">
          {metrics.map((metric) => (
            <MetricRow key={metric.label} {...metric} />
          ))}
        </div>
      )}

      {/* **使用率の直後に置く。** 見送りの理由はその数字そのものなので、離すと何を見て
          止まっているのかが読み取れない（#2095） */}
      {launchHold && <LaunchHoldRow message={launchHold} />}

      {sessions.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 border-t pt-2">
          {sessions.map((session) => (
            <SessionRow
              key={session.tmuxSessionName}
              session={session}
              onOpenIssue={onOpenIssue}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * チェックアウトの更新を積むボタンと、その結果（#1875・#1927）。
 *
 * **押した結果を必ずこの場に出す。** 以前は`void dispatch.requestSelfUpdate(...)`で戻り値を
 * 捨てており、積めなかった場合（未処理の更新がある・pollerが対応していない）も、届いた後に
 * pollerが失敗を返した場合も画面には何も出なかった。`SELF_UPDATE`は実行キューの一覧にも
 * 出ないため、「押しても反応しない」以外の見え方が無かった（#1927）。
 *
 * 押せない状態にするのは**届くのを待っている間だけ**。連打しても
 * `activeKey`のunique制約で弾かれるが、その拒否を見せても押した人にできることは無い。
 */
function SelfUpdateRow({
  hostName,
  selfUpdate,
  onRequestSelfUpdate,
}: {
  hostName: string;
  selfUpdate: DispatchHostSelfUpdateRow | null;
  onRequestSelfUpdate: (
    hostName: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  const [sending, setSending] = useState(false);
  // 積めなかった理由（#1927）。**次に押すまで残す**（消えると押した結果が無かったことになる）
  const [error, setError] = useState<string | null>(null);
  const pending = sending || (selfUpdate?.pending ?? false);
  const notice = error
    ? { label: error, tone: "critical" as DispatchHostCheckoutTone }
    : selfUpdate;

  async function request() {
    setSending(true);
    setError(null);
    try {
      const result = await onRequestSelfUpdate(hostName);
      if (!result.ok) setError(result.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-1.5 flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-[11px]"
        disabled={pending}
        onClick={() => void request()}
      >
        {pending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
        更新して再起動
      </Button>
      {notice && (
        <span className={cn("text-right text-[11px]", CHECKOUT_TONE_CLASS[notice.tone])}>
          {notice.label}
        </span>
      )}
    </div>
  );
}

/**
 * ホストごと再起動するボタンと、その状態（#2496）。
 *
 * **`SelfUpdateRow`と同じ組み立てにしてある**（右寄せのボタン＋その下に1行）。隣り合う2つの
 * 「再起動」が違う顔をしていると、押す前にどちらがどちらか読み取れない。
 *
 * **違うのは押せない理由を出すこと。** 「更新して再起動」は押せるかどうかがチェックアウトの
 * 遅れだけで決まるが、こちらはセッションが0本であることが要る。理由を出さずに押せなくすると、
 * 「なぜ押せないのか」が画面のどこにも無い状態になる。
 *
 * **押した結果もここに出す。** `REBOOT`は起動ジョブでも制御ジョブでもないため実行キューの
 * 一覧に出ず、pollerが返した失敗（「セッションが3本走っています」）が画面に現れないまま
 * 24時間で消える（#1927で`SELF_UPDATE`が踏んだのと同じ罠）。
 */
function RebootRow({
  hostName,
  reboot,
  result,
  rejection,
  onRequestReboot,
}: {
  hostName: string;
  reboot: DispatchHostRebootRow;
  result: DispatchHostRebootJobRow | null;
  rejection: ReturnType<typeof resolveRebootRejection>;
  onRequestReboot: (
    hostName: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  const [sending, setSending] = useState(false);
  // 積めなかった理由（#1927と同じ）。**次に押すまで残す**（消えると押した結果が無かったことになる）
  const [error, setError] = useState<string | null>(null);
  // **確認を1枚挟む。** 押し間違えても戻せない（GUIが無いホストなので、上がってこなければ
  // 物理コンソールが要る）操作で、ここだけは`C-c`のような取り消せる操作と同じ重さにしない
  const [confirming, setConfirming] = useState(false);

  const pending = sending || (result?.pending ?? false);
  const disabled = pending || rejection !== null;
  const notice = error
    ? { label: error, tone: "critical" as DispatchHostCheckoutTone }
    : result
      ? { label: result.label, tone: result.tone }
      : rejection
        ? { label: describeRebootRejection(rejection, hostName), tone: "warn" as const }
        : null;

  async function request() {
    setConfirming(false);
    setSending(true);
    setError(null);
    try {
      const res = await onRequestReboot(hostName);
      if (!res.ok) setError(res.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-muted-foreground">再起動 {reboot.uptime}</span>
        <span className={cn("shrink-0", CHECKOUT_TONE_CLASS[reboot.tone])}>
          {reboot.status}
          {reboot.detail ? `・${reboot.detail}` : ""}
        </span>
      </div>

      <div className="mt-1.5 flex flex-col items-end gap-1">
        {confirming ? (
          // **確認はその場で出す。** ダイアログにすると、押した本人がどのホストのカードから
          // 押したのかを確認の中でもう一度読み直すことになる
          <div className="flex w-full flex-col items-end gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-2">
            <span className="w-full text-left text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">{hostName}</span>{" "}
              をOSごと落とします。走っているセッションは戻らず、開発サーバーも止まります
              （常駐サービスは起動後に自分で戻ります）。
            </span>
            <span className="flex gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => setConfirming(false)}
              >
                やめる
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => void request()}
              >
                再起動する
              </Button>
            </span>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            disabled={disabled}
            onClick={() => setConfirming(true)}
          >
            {pending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Power className="size-3" />
            )}
            再起動する
          </Button>
        )}
        {notice && (
          <span className={cn("text-right text-[11px]", CHECKOUT_TONE_CLASS[notice.tone])}>
            {notice.label}
          </span>
        )}
      </div>
    </>
  );
}


/**
 * CodexのRemote Control相当（#2524）。ペアリングコードを発行するボタンと、出てきたコード。
 *
 * **`RebootRow`・`SelfUpdateRow`と同じ組み立て**（右寄せのボタン＋その下に結果の1行）に
 * してあるが、**出てくるものが違う**——ここに出るのは結果の文ではなく、押した人が別の端末へ
 * 打ち込む`XXXX-XXXX`のコードそのもの。そのため等幅で大きく出し、コピーのボタンと
 * 残り時間を添える。
 *
 * **コードは資格情報。** 期限（10分）を過ぎたものは`describeCodexPairingJob`が返さないので、
 * ここには出ない。押した人のブラウザの外（Issueコメント・通知・pollerのログ）へは出さない。
 *
 * **繋がる先はホストごと。** 1枚のコードで、そのホストで走っているCodexのセッションが
 * 全部見える（`serverName`はホスト名で、Issueごとには分かれない）。押す前にその旨を出しておく。
 */
function CodexPairingRow({
  host,
  job,
  onRequestCodexPairing,
}: {
  host: DispatchHostView;
  job: DispatchJobView | null;
  onRequestCodexPairing: (
    hostName: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  const hostName = host.name;
  const [sending, setSending] = useState(false);
  // 積めなかった理由（`RebootRow`と同じ）。**次に押すまで残す**（消えると押した結果が無かったことになる）
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 残り時間を数え直すための現在時刻（#2524）。**ポーリングの間隔に任せない。**
  // ジョブが終わるとキューのポーリングは20秒間隔（`IDLE_POLL_INTERVAL_MS`）へ落ちるため、
  // そのままだとカウントダウンが20秒刻みで飛び、**切れたコードが最大20秒残る**
  const [now, setNow] = useState(() => Date.now());

  const result = describeCodexPairingJob(job, new Date(now));
  const pending = sending || (result?.pending ?? false);
  const rejection = resolveCodexPairingRejection({ host, hasQueuedJob: pending });
  const disabled = pending || rejection !== null;
  const code = result?.code ?? null;
  const countdown = formatCodexPairingCountdown(result?.expiresInSeconds ?? null);
  const notice = error
    ? { label: error, tone: "critical" as CodexPairingTone }
    : result
      ? { label: result.label, tone: result.tone }
      : rejection
        ? { label: describeCodexPairingRejection(rejection, hostName), tone: "warn" as const }
        : null;

  // **コードが出ている間だけ回す。** 出ていなければ数えるものが無く、無駄に再描画するだけ
  const counting = code !== null;
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [counting]);

  async function request() {
    setSending(true);
    setError(null);
    setCopied(false);
    try {
      const res = await onRequestCodexPairing(hostName);
      if (!res.ok) setError(res.message);
    } finally {
      setSending(false);
    }
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // クリップボードが使えない環境（httpのLAN越しなど）では、コードは目で読める場所に
      // 出ているので何もしない。押せなかったことを理由として出すほどのことではない
    }
  }

  return (
    <div className="mt-1.5 flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-[11px]"
        disabled={disabled}
        onClick={() => void request()}
      >
        {pending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Smartphone className="size-3" />
        )}
        Codexに繋ぐ
      </Button>

      {/* 出てきたコード。**押した人がこれを別の端末へ打ち込む**ので、行の中で最も読みやすくする */}
      {code && (
        <div className="flex w-full items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
          <span className="font-mono text-sm font-semibold tracking-widest tabular-nums">
            {code}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {countdown && <span className="text-[11px] text-muted-foreground">{countdown}</span>}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              onClick={() => void copy()}
              aria-label="ペアリングコードをコピー"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            </Button>
          </span>
        </div>
      )}

      {notice && (
        <span className={cn("text-right text-[11px]", CHECKOUT_TONE_CLASS[notice.tone])}>
          {notice.label}
        </span>
      )}

      {/* **繋がる先を押す前に出す。** Issueごとに分かれないことは、コードを見てからでは分からない */}
      {!code && !notice && (
        <span className="text-right text-[11px] text-muted-foreground">
          ChatGPTアプリから{formatDispatchHostName(hostName)}のCodexセッション全部に繋がります
        </span>
      )}
    </div>
  );
}

/**
 * カードの1行目（ホスト名とセッション本数）。**縮めた版と従来の版で同じものを出す**——
 * ここだけ別々に書くと、片方の上限の色や応答なしの文言が古いまま残る。
 */
function HostHeading({
  host,
  atCapacity,
  hasSessionCount,
  trailing,
}: {
  host: DispatchHostView;
  atCapacity: boolean;
  hasSessionCount: boolean;
  /** 右端に足すもの（縮めた版の入力待ちの印と山括弧） */
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="flex items-center gap-1.5 text-xs font-medium">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            host.online ? "bg-primary" : "bg-muted-foreground",
          )}
        />
        {formatDispatchHostName(host.name)}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {host.online ? (
          hasSessionCount && (
            <span className={cn("text-[11px] text-muted-foreground", atCapacity && "text-destructive")}>
              セッション {host.liveSessions}/{host.maxSessions}
            </span>
          )
        ) : (
          // 応答していないホストは本数も使用率も出さない。最後の申告の時刻だけを出して、
          // 「動いていない」と「見えていない」を取り違えないようにする
          <span className="text-[11px] text-muted-foreground">
            応答していません・{formatRelativeDate(host.lastSeenAt)}
          </span>
        )}
        {trailing}
      </span>
    </div>
  );
}

/**
 * 人の入力を待っているセッションの本数（#1933）。**縮めた版の見出しに残す唯一のセッションの
 * 情報**で、これが無いと変更後のホームには「シートを開くべきとき」を示すものが何も無くなる
 * （「セッション 6/12」は本数でしかなく、ホームの「実行中」はIssueの進捗の件数）。
 *
 * 数えるのは`summarizeIssueSession`の`waiting`で、入力待ち（`WAITING_INPUT`）とまだ開始して
 * いない（`NOT_STARTED`）の両方が入る。**どちらも人が答えるまで進まない**ので、ホームでは
 * 分けない（違いはシートの行に出る）。
 */
function countWaitingSessions(sessions: DispatchSessionView[]): number {
  return sessions.filter((session) => summarizeIssueSession(session).tone === "waiting").length;
}

/**
 * 縮めた版のカード（#1933）。スマホのホームだけがこれを使う。
 *
 * **使用率は横並びにして、実数（`7.6 / 15.6 GB`）を落とす。** 4列に入れると読める字幅に
 * ならないためで、実数は押した先の実行状況シートに従来どおり出る。SWAPを申告していない
 * ホストでは`describeDispatchHostMetrics`が行ごと返さないので、その場合は3列になる。
 *
 * **スクリプトの版は遅れているときだけ出す。** 常に出すと縮めた意味が無くなる一方、
 * 遅れは「developへマージしたのに効いていない」ことに気付く唯一の手掛かり（#1612）なので、
 * ここだけは残す。「更新して再起動」（#1875・#1927）は押した結果を出す先ごとシート側にあり、
 * ここには置かない（カード全体が開くボタンなので、中にボタンを重ねられない）。
 *
 * **文字サイズ・余白を変えるときは`CompactHostCardSkeleton`も直す**（#2090）。取得できるまでの
 * 場所取りが同じ高さでなくなると、差し替わった瞬間に下のメニューが動く。ずれたことは
 * `dispatch-host-panel.test.tsx`の「高さを決めるクラスが実物と一致する」が落ちて分かる。
 */
function CompactHostCard({
  host,
  metrics,
  checkout,
  launchHold,
  atCapacity,
  hasSessionCount,
  waitingCount,
  onOpenDetail,
}: {
  host: DispatchHostView;
  metrics: DispatchHostMetricRow[] | null;
  checkout: DispatchHostCheckoutRow | null;
  launchHold: string | null;
  atCapacity: boolean;
  hasSessionCount: boolean;
  waitingCount: number;
  onOpenDetail?: () => void;
}) {
  const body = (
    <>
      <HostHeading
        host={host}
        atCapacity={atCapacity}
        hasSessionCount={hasSessionCount}
        trailing={
          <>
            {waitingCount > 0 && (
              <span className="text-[11px] text-amber-700 dark:text-amber-400">
                入力待ち {waitingCount}
              </span>
            )}
            {onOpenDetail && (
              <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            )}
          </>
        }
      />

      {checkout && checkout.tone !== "normal" && (
        <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px]">
          <span className="truncate text-muted-foreground">スクリプト {checkout.version}</span>
          <span className={cn("shrink-0", CHECKOUT_TONE_CLASS[checkout.tone])}>
            {checkout.status}
          </span>
        </div>
      )}

      {metrics && (
        <div
          className={cn("mt-2 grid gap-2", metrics.length === 4 ? "grid-cols-4" : "grid-cols-3")}
        >
          {metrics.map((metric) => (
            <CompactMetric key={metric.label} {...metric} />
          ))}
        </div>
      )}

      {/* **縮めた版でも落とさない**（#2095）。ホームで「実行中」が増えないことに気付くのが
          いちばん早く、そこに理由が無いと結局サブPCを見に行くことになる */}
      {launchHold && <LaunchHoldRow message={launchHold} />}
    </>
  );

  if (!onOpenDetail) return <div className="rounded-md border p-2">{body}</div>;

  return (
    <button
      type="button"
      onClick={onOpenDetail}
      aria-label={`${formatDispatchHostName(host.name)}の実行状況を開く`}
      className="w-full rounded-md border p-2 text-left hover:bg-accent active:bg-accent"
    >
      {body}
    </button>
  );
}

/**
 * 起動を見送っていることの1行（#2095）。**PCの実行キューとスマホのホームで同じものを使う。**
 *
 * 配色は使用率が振り切れたときと同じ`destructive`。セッション本数の上限（見出しの
 * 「セッション 12/12」）と同じ重さで、どちらも「押しても今は起動しない」ことを指す。
 */
function LaunchHoldRow({ message }: { message: string }) {
  return <p className="mt-1.5 text-[11px] text-destructive">{message}</p>;
}

/**
 * 縮めた版のカードを取得できるまでの間、同じ高さで置いておくスケルトン（#2090）。
 *
 * **`hosts`は取得前も`[]`なので、`hosts.length > 0`で出し分けている呼び出し側からは
 * 「まだ届いていない」と「1台も申告していない」の区別が付かず、届くまでカードごと消えていた。**
 * スマホのホームではこのカードの下にメニューが並んでいるため、届いた瞬間に押したい行が
 * カード1枚ぶん下へ落ちる。開いてすぐ押した指が別の行に当たるのはこれが理由（#2090の再現画面）。
 *
 * **高さは`CompactHostCard`と同じ組み方から取る。** 固定の`min-h-*`を置くと、カード側の
 * 字の大きさや行数を変えたときに黙ってずれる。ここでは実物と同じ入れ子・同じ文字サイズの
 * クラスを並べ、**文字だけ`text-transparent`にして背景を敷く**ので、行の高さは実物と一致する
 * （`text-[10px]`のような任意値のクラスは行の高さを継承の`1.5`から計算するため、
 * 同じクラスを置くこと自体が高さの一致になる）。**`CompactHostCard`を直すときはここも直す。**
 *
 * 使用率は実物が4列（SWAPを申告していないホストでは3列）だが、**列数は高さに影響しない**ので
 * ここは4列で固定してよい。
 *
 * **合わせているのは「応答していて使用率を申告している」1通りだけ**（#2090の計画レビュー指摘1）。
 * 実物の高さは3通りある。取得するまでどれになるかは分からないので、いちばん普通の1通りに
 * 合わせ、残りは差ぶんだけ動くのを許す（`min-h-*`を実物とスケルトンに揃えて置く手もあるが、
 * いちばん高い状態に合わせることになり、普通の状態のカードに常に空きができる）。
 *
 * - 応答していて最新: 見出し＋使用率。**ここに合わせている**（ずれ0）
 * - 応答していて遅れている・遅れ不明: 上にスクリプトの版が1行増える（`mt-1`＋16.5px＝約21px
 *   ぶん下へ動く）。`describeDispatchHostCheckout`は`behindCount`が0以外か`null`なら
 *   `tone`を`normal`以外にするため、developが進んで「更新して再起動」を押すまでの間はこちら
 * - 応答していない: `describeDispatchHostMetrics`が`null`を返して使用率ごと消え、見出しだけの
 *   カードになる（約51px縮む）。pollerが止まっているときだけなので、そのときは縮むに任せる
 * - メモリ・SWAPの逼迫で起動を見送っている（#2095）: 使用率の下に1行増える。逼迫している
 *   間だけなので、遅れているときと同じく差ぶんだけ動くのを許す
 */
export function CompactHostCardSkeleton() {
  return (
    <div className="rounded-md border p-2" data-testid="dispatch-host-skeleton">
      {/* 中身のない飾りなので読み上げからは外し、代わりに状況を1行だけ渡す */}
      <span className="sr-only" role="status">
        サブPCの状態を読み込み中
      </span>
      <div aria-hidden>
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <Skeleton className="size-1.5 shrink-0 rounded-full" />
            <Skeleton className="rounded-sm text-transparent">サブPC</Skeleton>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Skeleton className="rounded-sm text-[11px] text-transparent">セッション 0/0</Skeleton>
          </span>
        </div>

        <div className="mt-2 grid grid-cols-4 gap-2">
          {SKELETON_METRIC_LABELS.map((label) => (
            <span key={label} className="flex min-w-0 flex-col gap-0.5">
              <Skeleton className="truncate rounded-sm text-[10px] text-transparent">
                {label}
              </Skeleton>
              <Skeleton className="rounded-sm text-[13px] font-semibold text-transparent tabular-nums">
                00%
              </Skeleton>
              <Skeleton className="h-1 rounded-full" />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * スケルトンの4列に敷く見出し。**実物と同じ文字列を使う**（`text-transparent`で見えないが、
 * 帯の幅が実物と同じになるので、差し替わったときに横方向も動かない）。
 */
const SKELETON_METRIC_LABELS = ["CPU", "メモリ", "SWAP", "ディスク"] as const;

/** 縮めた版の1つぶん。割合を主役にして、目盛りはその下に細く敷く */
function CompactMetric({ label, percent, tone }: DispatchHostMetricRow) {
  const toneClass = METRIC_TONE_CLASS[tone];
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-[10px] text-muted-foreground">{label}</span>
      <span className={cn("text-[13px] font-semibold tabular-nums", toneClass.text)}>
        {formatHostMetricPercent(percent)}
      </span>
      <span className="h-1 rounded-full bg-muted" aria-hidden>
        <span
          className={cn("block h-full rounded-full", toneClass.bar)}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </span>
    </span>
  );
}

function MetricRow({
  label,
  percent,
  detail,
  tone,
}: {
  label: string;
  percent: number;
  detail: string | null;
  tone: DispatchHostMetricTone;
}) {
  const toneClass = METRIC_TONE_CLASS[tone];
  return (
    <>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span
        className="h-1.5 rounded-full bg-muted"
        // 数字は右のラベルが読み上げる。目盛りは装飾なので読み上げ対象から外す
        aria-hidden
      >
        <span
          className={cn("block h-full rounded-full", toneClass.bar)}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </span>
      <span className={cn("text-[11px] tabular-nums", toneClass.text)}>
        {formatHostMetricPercent(percent)}
        {detail ? `・${detail}` : ""}
      </span>
    </>
  );
}

function SessionRow({
  session,
  onOpenIssue,
}: {
  session: DispatchSessionView;
  onOpenIssue?: (issueId: string) => void;
}) {
  const summary = summarizeIssueSession(session);
  const repoName = session.repositoryFullName.split("/")[1] ?? session.repositoryFullName;
  // 自動終了までの残り時間（#1817）。**文言は`describeSessionReap`をそのまま使う**（Issue詳細と
  // 同じ状態が、画面によって違う言い方にならないようにする）。理由の1行はここには出さない
  // （行が2倍になるので、詳しくはIssueを開いてもらう）
  const reapNotice = describeSessionReap(session);

  return (
    <li className="flex items-start gap-1.5 text-xs">
      <span
        aria-hidden
        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", SESSION_TONE_CLASS[summary.tone])}
      />
      <span className="min-w-0 flex-1">
        {/*
          タイトルはそのIssueの詳細への導線（#1625）。右のアイコンがRemote Control・開発サーバー
          という**issue-deckの外**へ出る導線なのに対し、こちらはこの画面の中で開く
        */}
        <DispatchIssueTitle
          issueNumber={session.issueNumber}
          issueTitle={session.issueTitle}
          issueId={session.issueId}
          onOpenIssue={onOpenIssue}
        />
        <span className={cn("block truncate", SESSION_TEXT_CLASS[summary.tone])}>
          {repoName}・{summary.shortLabel}・{formatRelativeDate(summary.at)}
          {reapNotice && (
            <>
              ・<span className="text-amber-700 dark:text-amber-400">{reapNotice.label}</span>
            </>
          )}
        </span>
      </span>
      {/*
        入力待ちのときに答える唯一の出口（#1264）。ここに出しておくと、Issueを開かずに
        キューからそのまま答えに行ける
      */}
      {summary.remoteControlUrl && (
        <a
          href={summary.remoteControlUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Remote Controlを開く"
          aria-label={`#${session.issueNumber}のRemote Controlを開く`}
          className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
      {/* tailnetへ出した開発サーバー（#1265）。生きているセッションでだけ出る */}
      {summary.previewUrl && (
        <a
          href={summary.previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="開発サーバーを開く"
          aria-label={`#${session.issueNumber}の開発サーバーを開く`}
          className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Monitor className="size-3.5" />
        </a>
      )}
    </li>
  );
}
