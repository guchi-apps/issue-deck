import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import { formatRelativeDate } from "@/lib/format-relative-date";

/**
 * ホストごとの再起動（#2496）。実行キューのホストのカードから、押してよいかを確かめて押す。
 *
 * **置き場所は「更新して再起動」（#1875）の隣。** 押してよいかの判断に要る計器
 * （セッション本数・応答・使用率）が既にそのカードへ揃っているためで、設定画面へ置くと
 * 同じ状態を取りにいくポーリングをもう1本増やすことになる（計画レビューの指摘1）。
 *
 * **`SELF_UPDATE`（#1875の「更新して再起動」）とは別物。** あちらが畳むのはpollerのプロセスだけで、
 * `exec`で入れ替わるため走っている実装セッションは残る（#1927）。こちらは**OSごと落ちる**ので、
 * tmuxのセッションは全部消えて会話も戻らない。同じ「再起動」でも失うものが違うため、判定も
 * 見せ方も分けてある。
 *
 * **なぜ画面に置くのか。** サブPCのカーネル更新は`/var/run/reboot-required`が立ったまま
 * 適用されず（2026-08-29時点で9日）、落とすには毎回sshして`tmux ls`でセッションの有無を
 * 数える手作業が要っていた（guchi-apps/question#52・guchi-apps/subpc#68）。数える材料は
 * pollerの申告として既に届いているので、確認とボタンを1か所に置く。
 *
 * **自動では押さない。** 時刻で無条件に落とす仕組み（`unattended-upgrades`の`Automatic-Reboot`・
 * 定時のtimer）は走っているセッションを問答無用で殺すため採らない。ここが作るのは
 * 「いま落としてよいか」を読める計器と、人が押すボタンだけ（`docs/multi-agent/gates.md`）。
 *
 * Prismaに触れないため、クライアントコンポーネントからimportできる
 * （`host-checkout.ts`・`host-metrics.ts`と同じ形）。
 */

/**
 * 申告1回ぶんの再起動まわりの状態。
 *
 * **`required`だけが必須。** `/var/run/reboot-required`の有無はファイルを1つ見れば必ず分かる
 * 一方、残りは取れないことがある（ファイルが無ければmtimeも無い）。取れなかった項目のために
 * 全体を落とすと、いちばん確実な事実まで見えなくなる（`parseDispatchHostCheckout`と同じ向き）。
 */
export type DispatchHostReboot = {
  /** `/var/run/reboot-required`があるか＝カーネル等の更新が適用待ちか */
  required: boolean;
  /** そのファイルのmtime。いつから放置されているかを読むためのもの。無ければ`null` */
  requiredSince: string | null;
  /** ホストの起動時刻。稼働日数として出す。取れなければ`null` */
  bootedAt: string | null;
};

function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * pollerが送ってきた`rebootState`を検証する。
 *
 * **`required`が読めなければ全体を`null`にする**（申告していない古いpoller）。逆に、
 * `requiredSince`・`bootedAt`が欠けても全体は落とさず、その項目だけを`null`にする。
 */
export function parseDispatchHostReboot(value: unknown): DispatchHostReboot | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.required !== "boolean") return null;

  return {
    required: input.required,
    requiredSince: parseIsoDate(input.requiredSince),
    bootedAt: parseIsoDate(input.bootedAt),
  };
}

/**
 * 画面に出す重さ。**使用率（`DispatchHostMetricTone`）・チェックアウト（`DispatchHostCheckoutTone`）と
 * 同じ3段階**にして、同じ色が画面の中で違う重さを指さないようにする。
 */
export type DispatchHostRebootTone = "normal" | "warn" | "critical";

/**
 * ホストのカードに出す1行。**チェックアウトの行（`DispatchHostCheckoutRow`）と同じ形**にして、
 * 隣り合う2行が違う組み立てにならないようにしてある。
 */
export type DispatchHostRebootRow = {
  /** 「稼働 13日」。いつから落としていないかという事実そのもの */
  uptime: string;
  /** 「更新の適用待ち」「適用待ちなし」。再起動が要るかを1語で表す */
  status: string;
  /** 状態の補足（いつから適用待ちか）。無ければ`null` */
  detail: string | null;
  tone: DispatchHostRebootTone;
};

/**
 * 再起動まわりの申告を、カードの1行へ直す。**出せない場合は`null`**（行ごと出さない）。
 *
 * 出さないのは次の2つで、どちらも使用率・チェックアウトと同じ理由。古い申告を今の姿として
 * 見せない。
 *
 * - 申告が無い（古いpoller・読めなかった巡）
 * - ホストが応答していない（`online`がfalse）
 */
export function describeDispatchHostReboot(
  host: DispatchHostView,
  now: Date = new Date(),
): DispatchHostRebootRow | null {
  const reboot = host.reboot;
  if (!reboot || !host.online) return null;

  const uptime = formatUptime(reboot.bootedAt, now) ?? "稼働時間不明";

  if (!reboot.required) {
    return { uptime, status: "適用待ちなし", detail: null, tone: "normal" };
  }
  return {
    uptime,
    status: "更新の適用待ち",
    detail: reboot.requiredSince
      ? `${formatRelativeDate(reboot.requiredSince, now.getTime())}から`
      : null,
    tone: "warn",
  };
}

/** 「稼働 13日」。日をまたいでいなければ時間で出す。起動時刻が取れなければ`null` */
function formatUptime(bootedAt: string | null, now: Date): string | null {
  if (!bootedAt) return null;
  const booted = new Date(bootedAt).getTime();
  if (Number.isNaN(booted)) return null;
  const elapsed = now.getTime() - booted;
  const days = Math.floor(elapsed / (24 * 60 * 60 * 1000));
  if (days >= 1) return `稼働 ${days}日`;
  const hours = Math.floor(elapsed / (60 * 60 * 1000));
  return hours >= 1 ? `稼働 ${hours}時間` : "起動したばかり";
}

/**
 * 積めない理由。**画面と受け口（`enqueueRebootJob`）が同じ判定を使う**——画面が押せると
 * 判断した操作だけが届く前提にはせず、サーバー側でもう一度やり直す（`resolvePreviewRejection`と
 * 同じ形）。
 */
export type RebootRejection =
  | "host_not_found"
  | "offline"
  | "not_capable"
  | "sessions_running"
  | "sessions_unknown"
  | "already_queued";

/** 押せない理由を返す。押せるなら`null` */
export function resolveRebootRejection(params: {
  host: DispatchHostView | null;
  /** 未処理の再起動が既にあるか。**受け口では`false`で呼ぶ**（最終的な排他はactiveKeyの制約） */
  hasQueuedJob: boolean;
}): RebootRejection | null {
  const host = params.host;
  if (!host) return "host_not_found";
  if (!host.online) return "offline";
  if (host.rebootCapable !== true) return "not_capable";
  // **本数が分からないホストでは押させない。** 再起動は取り返しがつかないので、
  // 「たぶん0本」で落とす判断はしない（`isDispatchHostAtSessionCapacity`が判定材料の
  // 無いホストを`false`へ倒すのとは向きが逆で、こちらは安全側が「押させない」）
  if (host.liveSessions === null) return "sessions_unknown";
  if (host.liveSessions > 0) return "sessions_running";
  if (params.hasQueuedJob) return "already_queued";
  return null;
}

/** 押せない理由を、そのまま画面に出す文にする */
export function describeRebootRejection(rejection: RebootRejection, hostName: string): string {
  switch (rejection) {
    case "host_not_found":
      return `${hostName} はまだ申告していません。pollerが動いているか確認してください。`;
    case "offline":
      return `${hostName} が応答していません。再起動の途中であれば、戻ってくると押せるようになります。`;
    case "not_capable":
      return `${hostName} のpollerはパスワード無しで再起動できません（サブPCのsudoの許可が要ります）。`;
    case "sessions_unknown":
      return `${hostName} がセッション本数を申告していません。本数が分からないまま再起動はできません。`;
    case "sessions_running":
      return "セッションが走っている間は押せません。終わるのを待つか、実行キューから閉じてください。";
    case "already_queued":
      return `${hostName} の再起動は既に積まれています。`;
  }
}

/**
 * 押した再起動の結果をボタンの下に出し続ける時間。
 *
 * **`SELF_UPDATE_RESULT_WINDOW_MS`（#1927）と同じ10分**にしてある。終了したジョブは24時間ぶん
 * 画面へ返るため（`listDispatchState`）、そのまま出すと翌日まで「再起動しました」が残る。
 */
const REBOOT_RESULT_WINDOW_MS = 10 * 60 * 1000;

/** 押した「再起動する」がいまどうなっているか */
export type DispatchHostRebootJobRow = {
  label: string;
  tone: DispatchHostRebootTone;
  /** まだ結果が出ていない（届くのを待っている・落ちている最中）。押し直させないために使う */
  pending: boolean;
};

/**
 * 積んだ再起動の状態を、カードの1行へ直す。出すものが無ければ`null`。
 *
 * **押した結果を出す場所がここしか無い。** `REBOOT`は起動ジョブでも制御ジョブでもないため
 * 実行キューの一覧に出ず、pollerが返した失敗（例:「セッションが3本走っています」）は
 * 画面のどこにも現れないまま24時間で消える（`describeDispatchHostSelfUpdate`と同じ理由）。
 *
 * **`SUCCEEDED`でも`pending`を寝かせない。** 成功はpollerが`sudo reboot`を打った時点の報告で、
 * そこからホストが実際に落ちて戻るまで数十秒ある。押せる顔に戻すと、落ちている最中に
 * もう一度押されて、戻ってきた瞬間に2回目が走る。
 */
export function describeDispatchHostRebootJob(
  job: DispatchJobView | null,
  now: Date = new Date(),
): DispatchHostRebootJobRow | null {
  if (!job) return null;

  if (job.status === "QUEUED") {
    return {
      label: "再起動を積みました。届くまで数秒〜30秒。新しいセッションの起動を止めています。",
      tone: "warn",
      pending: true,
    };
  }
  if (job.status === "CLAIMED" || job.status === "RUNNING") {
    return { label: "再起動しています", tone: "warn", pending: true };
  }

  const finishedAt = job.finishedAt ? new Date(job.finishedAt).getTime() : null;
  if (finishedAt === null || now.getTime() - finishedAt > REBOOT_RESULT_WINDOW_MS) return null;

  if (job.status === "SUCCEEDED") {
    // pollerの`message`をそのまま出す（journaldに残る文言と画面の文言を食い違わせない）
    return {
      label: job.message ?? "再起動を開始しました。",
      tone: "warn",
      pending: true,
    };
  }
  if (job.status === "CANCELED") {
    return { label: "再起動を取り消しました。", tone: "normal", pending: false };
  }
  return {
    label: `再起動できませんでした: ${job.message ?? "理由が返っていません。"}`,
    tone: "critical",
    pending: false,
  };
}
