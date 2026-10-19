/**
 * リモートセッション（#4743）の判定と表示。**DBに触らない側**で、画面とAPIが同じ関数を使う。
 *
 * リモートセッションは、リポジトリだけを指定してサブPCに立てるClaude Codeのセッション
 * （`claude --remote-control`付き）。会話はClaude Codeアプリ側で行い、issue-deckは
 * 起動・一覧・終了だけを持つ。設計は docs/remote-session.md。
 */

/** 状態。`starting`（起動ジョブ待ち）→`running`→`ended`、または`failed` */
export const REMOTE_SESSION_STATUSES = ["starting", "running", "ended", "failed"] as const;

export type RemoteSessionStatus = (typeof REMOTE_SESSION_STATUSES)[number];

/** 終わっていない状態。一覧に出し、上限の計上に使う */
export const ACTIVE_REMOTE_SESSION_STATUSES: readonly RemoteSessionStatus[] = ["starting", "running"];

export function parseRemoteSessionStatus(value: unknown): RemoteSessionStatus {
  return (REMOTE_SESSION_STATUSES as readonly unknown[]).includes(value)
    ? (value as RemoteSessionStatus)
    : "failed";
}

/**
 * 1ホストで同時に動かせるリモートセッションの本数。**pollerの`REMOTE_SESSION_MAX`と揃える**
 * （最終的な判定はtmuxを見られるpoller側。ここは押す前に断るための写し）。
 */
export const REMOTE_SESSION_MAX_PER_HOST = 3;

/** `DispatchJob.issueNumber`の埋め草。リモートセッションはIssueに紐づかない */
export const REMOTE_SESSION_ISSUE_NUMBER = 0;

/**
 * tmuxのセッション名。**`<リポジトリ名>-remote-<8文字>`**で、実装セッションの`-issue-<番号>`の
 * 規約から外す（外さないと引き上げ・停滞検知・自動再開の対象に混ざる）。pollerの
 * `REMOTE_SESSION_NAME_PATTERN`と同じ形。
 */
export const REMOTE_SESSION_NAME_PATTERN = /^[A-Za-z0-9_-]+-remote-[a-z0-9]{8}$/;

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function buildRemoteSessionName(
  repositoryFullName: string,
  random: () => number = Math.random,
): string {
  // tmuxはセッション名の`.`・`:`を受け付けないため、他のランチャーの`SAFE_REPO`と同じく置き換える
  const repo = (repositoryFullName.split("/")[1] ?? repositoryFullName).replace(/[^A-Za-z0-9_-]/g, "-");
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += SUFFIX_ALPHABET[Math.floor(random() * SUFFIX_ALPHABET.length) % SUFFIX_ALPHABET.length];
  }
  return `${repo}-remote-${suffix}`;
}

/** 起動を断る理由。**画面にそのまま出す前提**で`describeRemoteSessionRejection`が文言を持つ */
export type RemoteSessionRejection =
  | "no_host"
  | "host_offline"
  | "unsupported"
  | "repository_not_runnable"
  | "limit_reached";

/** 判定に要るホストの情報 */
export type RemoteSessionHostInfo = {
  name: string;
  online: boolean;
  remoteSessionCapable: boolean;
  repositories: string[];
  activeCount: number;
};

/**
 * そのホストでそのリポジトリのセッションを起動できるか。起動できるなら`null`。
 *
 * 順序は「押した人が次に何をすればよいか」が分かる順（オフライン→pollerが古い→未登録→上限）。
 */
export function resolveRemoteSessionRejection(
  host: RemoteSessionHostInfo | null,
  repositoryFullName: string,
): RemoteSessionRejection | null {
  if (!host) return "no_host";
  if (!host.online) return "host_offline";
  if (!host.remoteSessionCapable) return "unsupported";
  if (!host.repositories.includes(repositoryFullName)) return "repository_not_runnable";
  if (host.activeCount >= REMOTE_SESSION_MAX_PER_HOST) return "limit_reached";
  return null;
}

export function describeRemoteSessionRejection(rejection: RemoteSessionRejection): string {
  switch (rejection) {
    case "no_host":
      return "起動できるホストがありません。サブPCのpollerが動いているか確認してください。";
    case "host_offline":
      return "サブPCがオフラインです。";
    case "unsupported":
      return "サブPCのpollerがリモートセッションに対応していません。設定の実行環境から「更新して再起動」を押してください。";
    case "repository_not_runnable":
      return "このリポジトリはサブPCに登録されていません。";
    case "limit_reached":
      return `同時に動かせるリモートセッションは${REMOTE_SESSION_MAX_PER_HOST}本までです。使っていないセッションを終了してください。`;
  }
}

/**
 * 起動先のホストを選ぶ。**そのリポジトリを起動できるホストを優先**し、無ければ断る理由が
 * 一番先に進んでいるホスト（＝押した人にいちばん役立つ理由が出るホスト）を返す。
 */
export function pickRemoteSessionHost(
  hosts: readonly RemoteSessionHostInfo[],
  repositoryFullName: string,
): RemoteSessionHostInfo | null {
  const order: (RemoteSessionRejection | null)[] = [
    null,
    "limit_reached",
    "repository_not_runnable",
    "unsupported",
    "host_offline",
  ];
  let best: RemoteSessionHostInfo | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const host of hosts) {
    const rank = order.indexOf(resolveRemoteSessionRejection(host, repositoryFullName));
    if (rank !== -1 && rank < bestRank) {
      best = host;
      bestRank = rank;
    }
  }
  return best;
}

/** 画面へ返すリモートセッション */
export type RemoteSessionView = {
  id: string;
  repositoryFullName: string;
  host: string;
  tmuxSessionName: string;
  status: RemoteSessionStatus;
  remoteControlUrl: string | null;
  failureMessage: string | null;
  /** 終了ジョブを積んで結果を待っている */
  stopping: boolean;
  createdAt: string;
  lastSeenAt: string | null;
};

/**
 * 実行状況のホストカード（#4836）に並べる、そのホストのリモートセッション。
 * 終わったもの（`ended`・`failed`）は除き、起動の古い順に並べる。
 */
export function selectHostRemoteSessions(
  sessions: readonly RemoteSessionView[],
  hostName: string,
): RemoteSessionView[] {
  return sessions
    .filter(
      (session) => session.host === hostName && ACTIVE_REMOTE_SESSION_STATUSES.includes(session.status),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** `GET /api/remote-sessions`の応答 */
export type RemoteSessionState = {
  sessions: RemoteSessionView[];
  hosts: RemoteSessionHostInfo[];
  maxPerHost: number;
};

/** pollerがホスト申告で送ってくる、生きているリモートセッション */
export type ReportedRemoteSession = {
  tmuxSessionName: string;
  remoteControlUrl: string | null;
};

const MAX_REPORTED_REMOTE_SESSIONS = 20;

/**
 * ホスト申告の`remoteSessions`を検証する。**配列でなければ`null`（未申告＝古いpoller）**で、
 * そのときは突き合わせをしない（空配列と取り違えると、全部を終了扱いにしてしまう）。
 */
export function parseReportedRemoteSessions(
  value: unknown,
  parseUrl: (value: unknown) => string | null,
): ReportedRemoteSession[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const sessions: ReportedRemoteSession[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { tmuxSessionName, remoteControlUrl } = item as Record<string, unknown>;
    if (typeof tmuxSessionName !== "string" || !REMOTE_SESSION_NAME_PATTERN.test(tmuxSessionName)) continue;
    if (seen.has(tmuxSessionName)) continue;
    seen.add(tmuxSessionName);
    sessions.push({ tmuxSessionName, remoteControlUrl: parseUrl(remoteControlUrl) });
    if (sessions.length === MAX_REPORTED_REMOTE_SESSIONS) break;
  }
  return sessions;
}

/** 無操作でpollerが自動終了したセッションに残す理由（#4871） */
export const REMOTE_SESSION_IDLE_ENDED_MESSAGE = "一定時間操作が無かったため、自動で終了しました。";

/**
 * ホスト申告の`remoteSessionsIdleEnded`（直近に無操作で自動終了したセッション名）を検証する。
 * **配列でなければ`null`（未申告＝古いpoller）**。形の合わない名前は捨てる。
 */
export function parseIdleEndedRemoteSessions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !REMOTE_SESSION_NAME_PATTERN.test(item)) continue;
    names.add(item);
    if (names.size === MAX_REPORTED_REMOTE_SESSIONS) break;
  }
  return [...names];
}

/** 状態の表示名 */
export function describeRemoteSessionStatus(status: RemoteSessionStatus): string {
  switch (status) {
    case "starting":
      return "起動中";
    case "running":
      return "稼働中";
    case "ended":
      return "終了";
    case "failed":
      return "起動失敗";
  }
}
