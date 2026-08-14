import { parseRepositoryFullName } from "@/lib/local-session";

/**
 * 起動後のtmuxセッションの状態判定（#1217）。
 *
 * `DispatchJob`の寿命は「tmuxセッションが立った」ところで終わっており（`run_job()`が
 * その時点で`succeeded`を報告する）、**立った後のセッションは誰も見ていない**。
 * ここはその穴のうち、**フックでは埋められない部分だけ**を担当する。
 *
 * 担当範囲を切っている理由は、#1219（Claude Codeの`Notification`/`Stop`フックによる
 * リアルタイム通知）との住み分けにある。境界は「フックが飛ぶか」。
 *
 * - 入力待ち・完了・停滞 → **#1219**。セッションが生きていれば正確に飛ぶ
 * - 異常終了・セッション消失 → **ここ**。プロセスごと死ぬとフックは発火しないため、
 *   tmuxを見に行くしかない
 *
 * **画面（`capture-pane`）の内容は読まない。** 画面の文字列から状態を推定する方式は
 * 既に実地で誤判定している（「プランモードではフッターが`esc to interrupt`にならない」ことに
 * 気づかず、作業中を停止と誤って通知した。#1219・#1223に記録がある）。読むのはtmuxの
 * メタデータだけに限る。
 *
 * DBに触る処理は`src/lib/dispatch/sessions.ts`。ここは値の判定だけを持ち、テストで固定できる
 * ようにしている（`jobs.ts`と`dispatch-job.ts`の分け方に倣う）。
 */

/**
 * セッションの状態。
 *
 * - `ALIVE` … ペインが生きている
 * - `EXITED` … 正常終了したペインが残っている
 * - `FAILED` … 異常終了したペインが残っている（**引き上げる唯一の状態**）
 * - `GONE` … 報告に含まれなくなった（セッションが消えた）
 */
export type DispatchSessionState = "ALIVE" | "EXITED" | "FAILED" | "GONE";

/**
 * セッション自身がフック（#1219）から報告してくる様子（#1264）。
 *
 * pollerが見ているtmuxのメタデータでは**人の入力を待っているかどうかが分からない**。
 * そこだけをフックから受け取る。境界は`gates.md`の「フックが飛ぶか」と同じで、
 * ここに入るのはセッションが生きている間しか飛ばないものに限る。
 *
 * **古い値が残り続けないことが前提。** `WAITING_INPUT`が解けるのは次の4つ。
 *
 * 1. `PostToolUse`フック（`WORKING`へ。#1357）
 * 2. `Stop`フック（`RESPONDED`へ）
 * 3. セッションの消滅（pollerの報告で`EXITED`/`FAILED`/`GONE`へ。**表示が状態を優先するだけで、
 *    列の値自体は残る**）
 * 4. 同じ名前で立ち上がり直したときの破棄（`isRevivedSession`。#1353）
 *
 * 4が無いと、3で残った値が起動し直した次のセッションへそのまま引き継がれる。
 *
 * **`WORKING`は`RESPONDED`では代用できない**（#1357）。承認プロンプトに人が答えたことを知らせる
 * フックは無く、答えた直後に必ず飛ぶのは「承認したツールが走った」`PostToolUse`だけ。そこで
 * `RESPONDED`を送ると「応答を終えています／次の指示を待っている場合があります」と出るため、
 * 作業中の表示としては誤りになる。
 *
 * **`WORKING`は「答えた直後」にしか報告されない。** `PostToolUse`はツールの実行ごとに飛ぶため、
 * ホスト側（`scripts/lib/session-state.sh`の`.event`）で「直前が`permission_prompt`のとき」だけに
 * 間引いている。作業中ずっと届く値ではないので、これを使って停滞を測らない。
 */
export type DispatchSessionActivity = "WAITING_INPUT" | "WORKING" | "RESPONDED";

/** フックが送ってくる1件ぶんの報告 */
export type DispatchSessionActivityReport = {
  repositoryFullName: string;
  issueNumber: number;
  activity: DispatchSessionActivity;
  /** `claude --remote-control`のURL。取れないこともある */
  remoteControlUrl: string | null;
};

/** フックのイベント名（`session-notify.sh`が送る値）を内部の表現へ写す */
export function parseDispatchSessionActivity(value: unknown): DispatchSessionActivity | null {
  if (value === "waiting_input") return "WAITING_INPUT";
  if (value === "working") return "WORKING";
  if (value === "responded") return "RESPONDED";
  return null;
}

/**
 * プレビューのURLとして受け入れる形（#1265）。**tailnet内のhttp URLだけを通す。**
 *
 * `tailscale serve`はHTTPS証明書が未有効なため`--http`（平文）でしか出せず、ホスト名は
 * MagicDNSの`*.ts.net`になる。ここを緩めると、共有シークレットを持つ相手から任意のリンクを
 * 画面へ差し込まれる。
 */
export function parsePreviewUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (!url.hostname.endsWith(".ts.net")) return null;
  return url.toString();
}

/**
 * Remote ControlのURLとして受け入れる形。**`https://claude.ai/`配下だけを通す。**
 * 画面にリンクとして出す値なので、任意のURLを受け取ると共有シークレットを持つ相手から
 * 好きなリンクを差し込まれることになる。
 */
export function parseRemoteControlUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "claude.ai") return null;
  return url.toString();
}

/** pollerが1セッションについて報告してくる生の値 */
export type DispatchSessionReport = {
  tmuxSessionName: string;
  repositoryFullName: string;
  issueNumber: number;
  paneDead: boolean;
  /** 死んだペインのプロセスの終了コード。取得できない場合はnull */
  paneDeadStatus: number | null;
};

/** 画面へ返すセッション。DBの行をそのまま出さず、必要な項目だけを整える */
export type DispatchSessionView = {
  host: string;
  tmuxSessionName: string;
  repositoryFullName: string;
  issueNumber: number;
  state: DispatchSessionState;
  exitStatus: number | null;
  firstSeenAt: string;
  lastReportedAt: string;
  /** 直近の様子（#1264）。報告が無ければ`null` */
  activity: DispatchSessionActivity | null;
  activityAt: string | null;
  remoteControlUrl: string | null;
  /** tailnetへ出した開発サーバーのURL（#1265）。`23.preview-required`のセッションでだけ埋まる */
  previewUrl: string | null;
};

/**
 * tmuxセッション名からリポジトリ名とIssue番号を取り出す。
 *
 * 名前は`scripts/start-issue.sh`の`tmux_session_name()`が`<リポジトリ名>-issue-<番号>`で作る。
 * リポジトリ名側は`[^A-Za-z0-9_-]`を`-`へ潰した後の値なので、`-issue-`という区切りは
 * リポジトリ名の中にも現れうる（`foo-issue-tracker-issue-12`など）。そのため**末尾から**
 * 探して分解する。
 */
export function parseSessionName(name: string): { repoName: string; issueNumber: number } | null {
  const matched = /^(.+)-issue-([1-9][0-9]*)$/.exec(name);
  if (!matched) return null;
  const repoName = matched[1];
  if (!repoName) return null;
  const issueNumber = Number.parseInt(matched[2], 10);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;
  return { repoName, issueNumber };
}

/**
 * セッション名に含まれるリポジトリ名（ownerを含まない）から`owner/repo`を復元する。
 *
 * **候補が2件以上あるときはnullを返す。** 別ownerに同名のリポジトリがある場合、どちらの
 * Issueなのかを名前だけからは決められない。ここで当てずっぽうに1件選ぶと、**無関係なIssueへ
 * 引き上げのコメントを投稿する**ことになるため、曖昧なら扱わない側へ倒す。
 */
export function resolveRepositoryFullName(
  repoName: string,
  candidates: readonly string[],
): string | null {
  const matches = new Set<string>();
  for (const candidate of candidates) {
    const parsed = parseRepositoryFullName(candidate);
    if (!parsed) continue;
    if (parsed.repo === repoName) matches.add(candidate);
  }
  if (matches.size !== 1) return null;
  return [...matches][0];
}

/**
 * ペインの生死と終了コードから状態を決める。
 *
 * **`paneDead`だけで異常終了と判断してはいけない。** `scripts/start-issue.sh`は
 * `remain-on-exit failed`（tmux 3.2以降）を試し、**失敗したら`on`へ落とす**。
 * メインPCのWSLはtmux 3.0aで`on`側を通るため、**正常終了でもペインが残る**。
 * `paneDead`を異常終了として扱うと、正常に終わったセッションのたびに`00.check-user`が付く。
 *
 * 終了コードが取れない場合も`EXITED`へ倒す。**曖昧なときは鳴らさない**方向に寄せる
 * （鳴らしすぎた通知は読まれなくなり、本当の異常終了まで埋もれる）。
 */
export function resolveSessionState(params: {
  paneDead: boolean;
  paneDeadStatus: number | null;
}): DispatchSessionState {
  if (!params.paneDead) return "ALIVE";
  if (params.paneDeadStatus === null) return "EXITED";
  return params.paneDeadStatus === 0 ? "EXITED" : "FAILED";
}

/**
 * 引き上げ（Issueコメント＋`00.check-user`）を行うか。
 *
 * **`FAILED`へ遷移した時だけ真。** 同じ状態が続く間は偽（pollerは60秒ごとに同じ報告を送ってくるので、
 * 状態だけで判定すると毎分コメントが増える）。`escalatedState`に「どの状態で引き上げ済みか」を
 * 持たせ、それと比べる。
 *
 * 一度復帰して再び落ちた場合（`FAILED` → `ALIVE` → `FAILED`）は改めて引き上げる。
 * 2回目の異常終了は1回目とは別の出来事のため。
 */
export function shouldEscalateSession(
  escalatedState: DispatchSessionState | null,
  nextState: DispatchSessionState,
): boolean {
  if (nextState !== "FAILED") return false;
  return escalatedState !== "FAILED";
}

/**
 * 報告を受けたあとに`escalatedState`へ入れる値。
 *
 * `FAILED`以外へ移ったら**クリアする**。クリアしないと、復帰後に再び落ちたときの
 * 2回目の引き上げが起きない。
 */
export function nextEscalatedState(
  escalatedState: DispatchSessionState | null,
  nextState: DispatchSessionState,
  escalated: boolean,
): DispatchSessionState | null {
  if (escalated) return nextState;
  if (nextState !== "FAILED") return null;
  return escalatedState;
}

/**
 * その報告で、行が**別のセッションのものとして立ち上がり直した**か（#1353）。
 *
 * セッションの行は`(host, tmuxSessionName)`で引く。名前は`<リポジトリ名>-issue-<番号>`固定で、
 * 消えた行も24時間残す（`GONE_SESSION_RETENTION_MS`）ため、**同じIssueで起動し直すと前の
 * セッションの行がそのまま再利用される**。ここで前のセッションの`activity`を引き継ぐと、
 * 入力待ちのまま畳んだセッションのオレンジの「入力を待っています」が、次のセッションの
 * 起動直後に何事も無かったように復活する（#1353で報告された症状）。
 *
 * `run-issue-session.sh`の`cleanup`がホスト側の状態ファイルを消しているのと同じ理由
 * （#1256「残すと、次に同じ名前で立ったセッションが前回の`Stop`を引き継いだように見える」）を、
 * DBの行にも適用する。
 *
 * **`ALIVE`でなくなった行が`ALIVE`へ戻る瞬間だけを見る。** `ALIVE`が続いている間は同じ
 * セッションなので触らない。ペインが死んで残っているだけの`EXITED`/`FAILED`から戻ることは
 * 無い（死んだペインは生き返らない）が、`GONE`（報告に含まれなくなった）からは戻りうる。
 */
export function isRevivedSession(
  previousState: DispatchSessionState | undefined | null,
  nextState: DispatchSessionState,
): boolean {
  if (!previousState) return false;
  return previousState !== "ALIVE" && nextState === "ALIVE";
}

/** ホスト名として許す長さ。DBの列と報告の受け口で同じ上限を使う */
export const DISPATCH_SESSION_NAME_MAX_LENGTH = 191;

/**
 * tmuxセッション名として受け入れる形。**長さだけを見る。**
 *
 * `<リポジトリ名>-issue-<番号>`以外の名前を弾かないのは、この値が行の照合キーにしか使われず、
 * 一致しなければ何も起きないため（`parseSessionName`は名前からIssueを割り出す用途で、
 * そちらは当てが外れると無関係なIssueへコメントしうるので厳しく見ている）。
 */
export function parseDispatchSessionName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > DISPATCH_SESSION_NAME_MAX_LENGTH) return null;
  return value;
}

/**
 * pollerから届いた1件を検証する。**issue-deck側でも検証をやり直す**（多層防御）。
 * 値はIssueコメントの投稿先を決めるのに使われるため、ここが最後の砦になる。
 */
export function parseDispatchSessionReport(value: unknown): DispatchSessionReport | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;

  const tmuxSessionName = parseDispatchSessionName(input.tmuxSessionName);
  if (!tmuxSessionName) return null;

  const repositoryFullName = input.repositoryFullName;
  if (typeof repositoryFullName !== "string") return null;
  if (!parseRepositoryFullName(repositoryFullName)) return null;

  const issueNumber = input.issueNumber;
  if (typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    return null;
  }

  if (typeof input.paneDead !== "boolean") return null;

  const rawStatus = input.paneDeadStatus;
  let paneDeadStatus: number | null = null;
  if (rawStatus !== null && rawStatus !== undefined) {
    if (typeof rawStatus !== "number" || !Number.isSafeInteger(rawStatus)) return null;
    paneDeadStatus = rawStatus;
  }

  return {
    tmuxSessionName,
    repositoryFullName,
    issueNumber,
    paneDead: input.paneDead,
    paneDeadStatus,
  };
}
