import { parseRepositoryFullName } from "@/lib/local-session";

/**
 * サブPCへのディスパッチ（#1179）で使う純粋関数と定数。
 *
 * DBに触る処理は`src/lib/dispatch/jobs.ts`、認証は`dispatch-auth.ts`。ここは
 * 「値の検証」と「時間で状態が変わる判定」だけを持ち、テストで固定できるようにしている。
 */

/** ジョブの状態。Prismaの`DispatchJobStatus`と同じ並び */
export type DispatchJobStatus =
  | "QUEUED"
  | "CLAIMED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMEOUT"
  | "CANCELED";

/**
 * 「まだ終わっていない」状態。この間だけ`activeKey`が入り、同じIssueに対して
 * 2件目を積めない（unique制約でDBが保証する）。
 */
export const ACTIVE_DISPATCH_JOB_STATUSES: readonly DispatchJobStatus[] = [
  "QUEUED",
  "CLAIMED",
  "RUNNING",
];

export function isActiveDispatchJobStatus(status: DispatchJobStatus): boolean {
  return ACTIVE_DISPATCH_JOB_STATUSES.includes(status);
}

/**
 * ホストが生存していると見なす猶予（ミリ秒）。pollerのポーリング間隔は60秒なので、
 * 一時的な取りこぼしでofflineに倒れないよう数回分の余裕を取る。
 */
export const DISPATCH_HOST_ONLINE_WINDOW_MS = 5 * 60 * 1000;

/**
 * claimしたまま`running`へ進まないジョブを見限るまでの時間（ミリ秒）。
 * pollerがclaim直後に落ちた場合がこれに当たる。
 */
export const DISPATCH_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * `running`のままheartbeatが途絶えたジョブを見限るまでの時間（ミリ秒）。
 *
 * `running`は「worktree作成〜pnpm install〜tmux起動」の最中で、冷えた状態では数分かかる
 * （#1177の実測でビルド単体が35秒、3本並行で88秒）。短すぎると正常な起動をtimeoutで
 * 潰すため、claimのタイムアウトと同じ幅を取る。
 */
export const DISPATCH_HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000;

/** ホスト名に許可する文字。パスやtmuxのターゲット指定に混ざらない範囲へ絞る */
const HOST_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function parseDispatchHostName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!HOST_NAME_PATTERN.test(trimmed)) return null;
  // `.`を許可文字に含めているため`.`・`..`自体が通る。ホスト名としても実在しないので弾く
  if (/^\.+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * ディスパッチ対象（リポジトリ・Issue番号）を検証する。
 *
 * owner/repoの検証は`src/lib/local-session.ts`の`parseRepositoryFullName`を使い回す。
 * この値は最終的にサブPC側でパスの一部・シェル引数になるため、**ワンクリック起動と
 * 同じ文字集合に揃える**（片側だけを緩めると、緩めた側が単独で穴になる）。
 */
export function parseDispatchTarget(
  repository: unknown,
  issue: unknown,
): { repositoryFullName: string; issueNumber: number } | null {
  if (typeof repository !== "string") return null;
  if (!parseRepositoryFullName(repository)) return null;
  if (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0) return null;
  return { repositoryFullName: repository, issueNumber: issue };
}

/**
 * 未完了ジョブの一意キー。`DispatchJob.activeKey`に入れ、終了時にnullへ戻す。
 * MySQLのunique indexは複数のNULLを許すため、これで「未完了は1件まで」が成立する。
 */
export function buildDispatchActiveKey(repositoryFullName: string, issueNumber: number): string {
  return `${repositoryFullName}#${issueNumber}`;
}

/** 申告が届いてから一定時間内なら生存とみなす */
export function isDispatchHostOnline(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() <= DISPATCH_HOST_ONLINE_WINDOW_MS;
}

/**
 * ホストが申告した実行可能リポジトリのJSON配列を読む。**壊れていれば空配列**を返し、
 * 「何も実行できないホスト」として扱う。例外を投げると申告の破損だけで画面が落ちる。
 */
export function parseDispatchHostRepositories(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is string => typeof item === "string" && parseRepositoryFullName(item) !== null,
  );
}

/** 申告として保存する形（重複を落とし、検証を通ったものだけ） */
export function normalizeDispatchHostRepositories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (!parseRepositoryFullName(item)) continue;
    seen.add(item);
  }
  return [...seen].sort();
}

/**
 * issue-deck側の上限とホスト側の申告から、実際に払い出してよい本数を決める。
 * **小さい方を採る。** 設定値がホストの実力を超えていても、ホストが自分で守れる。
 */
export function resolveDispatchConcurrency(
  settingLimit: number,
  hostMaxConcurrency: number | null,
): number {
  if (hostMaxConcurrency === null || hostMaxConcurrency <= 0) return settingLimit;
  return Math.min(settingLimit, hostMaxConcurrency);
}

/** pollerが報告してよい状態。`timeout`・`canceled`はissue-deck側だけが付ける */
export type DispatchReportStatus = "running" | "succeeded" | "failed";

export function parseDispatchReportStatus(value: unknown): DispatchReportStatus | null {
  if (value === "running" || value === "succeeded" || value === "failed") return value;
  return null;
}

/**
 * ジョブを積めない理由。**画面にそのまま出す前提**で、
 * 「投げたのに何も起きない」状態を作らないための情報（#1179のコメント）。
 */
export type DispatchEnqueueRejection =
  | "host_unknown"
  | "host_offline"
  | "repository_not_runnable"
  | "already_queued";

export function describeDispatchEnqueueRejection(
  rejection: DispatchEnqueueRejection,
  context: { hostName: string; repositoryFullName?: string },
): string {
  switch (rejection) {
    case "host_unknown":
      return `${context.hostName} からの申告がまだ届いていません。ディスパッチのpollerが動いているか確認してください。`;
    case "host_offline":
      return `${context.hostName} が応答していません（最後の申告から時間が経ちすぎています）。`;
    case "repository_not_runnable":
      return `${context.repositoryFullName ?? "このリポジトリ"} は ${context.hostName} で実行できません（cloneされていないか、ローカル起動に対応していません）。`;
    case "already_queued":
      return "このIssueには実行中または待機中のジョブが既にあります。";
  }
}

/** 起動が届かなかったジョブに残す理由（timeoutの内訳） */
export function describeDispatchTimeout(status: "CLAIMED" | "RUNNING"): string {
  return status === "CLAIMED"
    ? "起動先がジョブを取得したまま開始しませんでした（ホストが停止した可能性があります）。"
    : "起動処理からの応答が途絶えました。tmuxセッションが残っていないか確認してください。";
}
