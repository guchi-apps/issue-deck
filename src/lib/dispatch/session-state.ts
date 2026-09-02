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
 *
 * **`NOT_STARTED`だけはフックではなくpollerが報告する**（#1465）。Claude Codeの起動確認
 * （初めてクローンしたリポジトリで出るフォルダの信頼確認）で止まっている間は、まだ
 * セッションが始まっていないためフックが1つも飛ばず、**画面には何も出ないまま操作が
 * 止まる**。そこだけは「フックが飛ばないこと自体」を計器にするしかない。判定材料は
 * ホスト側の印（`scripts/lib/session-state.sh`の`.starting`。ランチャーが起動直前に置き、
 * `SessionStart`フックが消す）で、画面の文字列は読まない。
 */
export type DispatchSessionActivity = "WAITING_INPUT" | "WORKING" | "RESPONDED" | "NOT_STARTED";

/** フックが送ってくる1件ぶんの報告 */
export type DispatchSessionActivityReport = {
  repositoryFullName: string;
  issueNumber: number;
  activity: DispatchSessionActivity;
  /** `claude --remote-control`のURL。取れないこともある */
  remoteControlUrl: string | null;
};

/**
 * フックのイベント名（`session-notify.sh`が送る値）を内部の表現へ写す。
 *
 * **`NOT_STARTED`はここでは受け取らない**（#1465）。あれはpollerの一括報告
 * （`claudeStarting`）だけが立てる値で、フックから送られてくることは無い。
 */
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

/**
 * セッションを自動で畳む理由（#1817）。**サブPCの`scripts/reap-sessions.sh`が判定した経路**で、
 * 値そのものはあちらの`hold_until_reap`が書く。
 *
 * **文言は運ばず、コードだけを運ぶ。** 画面に出す言い方をスクリプト側に持たせると、同じ状態が
 * ログと画面で2通りの言い方になり、直すときに片方だけ変わる（`shortLabel`を`label`と同じ分岐で
 * 作っているのと同じ理由）。
 */
export const SESSION_REAP_REASONS = [
  /** Issueがcloseされた */
  "ISSUE_CLOSED",
  /** `issue-<番号>`のPRがマージされた */
  "PR_MERGED",
  /** PRを作り、`11.local`を外してレビューへ引き渡した（#1541） */
  "HANDOFF_PR_OPEN",
  /** PRを作らずにローカル作業を終えた（#1600） */
  "HANDOFF_NO_PR",
  /** 横断質問セッションで、質問Issueがcloseされた（#1454） */
  "QUESTION_CLOSED",
  /** 横断質問セッションが放置されている（#1648） */
  "QUESTION_IDLE",
  /** worktreeが削除されている（#2422） */
  "WORKTREE_GONE",
] as const;

export type DispatchSessionReapReason = (typeof SESSION_REAP_REASONS)[number];

/**
 * セッションがいま何をしているか（#2705）。**サブPCの`scripts/lib/session-step.sh`が
 * Claude Codeのフックから受け取ったツール名とコマンドを畳んだ結果**で、値そのものはあちらが書く。
 *
 * `DispatchSessionActivity`とは別物。あちらは「人を待っているか・応答が終わったか」で、
 * こちらは作業の中身。**両方を並べて初めて「サブPC・実行中／実装中」になる。**
 *
 * **文言は運ばず、コードだけを運ぶ**（`SESSION_REAP_REASONS`と同じ理由）。画面に出す言い方を
 * スクリプト側に持たせると、同じ状態がログと画面で2通りの言い方になる。
 *
 * **コマンドの原文は運ばない。** `--token=…`のような行がそのままDBと画面へ出るのを避けるため、
 * 分類はホスト側で済ませてある。ここに自由文字列は入らない。
 */
export const SESSION_STEPS = [
  /** 計画を書いている（`ExitPlanMode`） */
  "PLANNING",
  /** 読んで調べている（`Read`・`Grep`・`git log`など） */
  "EXPLORING",
  /** ファイルを書き換えている（`Edit`・`Write`） */
  "EDITING",
  /** Lint（`pnpm lint`・`eslint`など） */
  "LINTING",
  /** 型チェック（`tsc`・`pnpm typecheck`） */
  "TYPECHECKING",
  /** テスト（`pnpm test`・`vitest`など） */
  "TESTING",
  /** ビルド（`pnpm build`など） */
  "BUILDING",
  /** コミット（`git add`・`git commit`） */
  "COMMITTING",
  /** push（`git push`） */
  "PUSHING",
  /** Pull Requestの作成・更新（`gh pr create`など） */
  "PR",
  /** Issueへの記録（`gh issue comment`など） */
  "ISSUE",
  /** アーティファクトの公開（`Artifact`） */
  "ARTIFACT",
  /** 上のどれにも当たらないコマンド */
  "RUNNING",
] as const;

export type DispatchSessionStep = (typeof SESSION_STEPS)[number];

/**
 * ステップとして受け入れる値。**知らないコードはnullへ落とす。**
 *
 * `parseSessionReapReason`と同じ扱いで、報告全体は通す。サブPCのスクリプトはissue-deck本体より
 * 新しいことも古いこともあるため、語彙が増えた側で報告ごと弾くと、そのホストのセッションが
 * 全部「消えた」と判定される。
 */
export function parseSessionStep(value: unknown): DispatchSessionStep | null {
  if (typeof value !== "string") return null;
  return (SESSION_STEPS as readonly string[]).includes(value)
    ? (value as DispatchSessionStep)
    : null;
}

/**
 * ステップに入った時刻として受け入れる値（ISO8601）。パースできなければnull。
 *
 * `parseSessionReapAt`と同じく、**壊れていてもこの項目だけを落とす**（報告全体は通す）。
 */
export function parseSessionStepAt(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * 畳む理由として受け入れる値。**知らないコードはnullへ落とす。**
 *
 * サブPCのスクリプトは`~/apps/issue-deck`のチェックアウトから走り、issue-deck本体より
 * 新しいことも古いこともある（`docs/multi-agent/subpc-dispatch.md`）。知らないコードで報告
 * ごと弾くと、そのホストのセッションが全部「消えた」と判定される（受け口は1件でも壊れていたら
 * 全体を拒否する）ため、**この項目だけを落として残りは通す。**
 */
export function parseSessionReapReason(value: unknown): DispatchSessionReapReason | null {
  if (typeof value !== "string") return null;
  return (SESSION_REAP_REASONS as readonly string[]).includes(value)
    ? (value as DispatchSessionReapReason)
    : null;
}

/**
 * 畳む予定の時刻として受け入れる値（ISO8601）。パースできなければnull。
 *
 * 理由コードと同じく、**壊れていてもこの項目だけを落とす**（報告全体は通す）。
 */
export function parseSessionReapAt(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** pollerが1セッションについて報告してくる生の値 */
export type DispatchSessionReport = {
  tmuxSessionName: string;
  repositoryFullName: string;
  issueNumber: number;
  paneDead: boolean;
  /** 死んだペインのプロセスの終了コード。取得できない場合はnull */
  paneDeadStatus: number | null;
  /**
   * Claude Code本体がまだ開始していないまま、猶予（poller側の既定3分）を過ぎているか（#1465）。
   *
   * **`undefined`（項目そのものが無い）と`false`は別物。** 送ってこないのは`.starting`の印を
   * 置かない古いランチャー・古いpollerで、そのホストについては何も判断できない。`false`は
   * 「新しいpollerが見たうえで、止まってはいない」で、これを受けて`NOT_STARTED`を解く。
   */
  claudeStarting?: boolean;
  /**
   * 自動で畳む予定（#1817）。ISO8601。**猶予待ちのセッションでだけ埋まり、それ以外はnull**。
   *
   * `claudeStarting`と同じく、**`undefined`（項目そのものが無い）と`null`は別物**。無いのは
   * 古いpollerで、そのホストについては何も判断できないため既存の値を触らない。`null`は
   * 「新しいpollerが見たうえで、畳む予定は無い」で、これを受けて予定を消す。
   */
  reapAt?: string | null;
  /** 畳む理由（#1817）。`reapAt`と対で扱う */
  reapReason?: DispatchSessionReapReason | null;
  /**
   * Codexのセッションで、`codex queue`の宛先（スレッドUUID）が分かっているか（#2519）。
   *
   * **3値ある。** `null`＝Codexのセッションではない（Claude Code）。`false`＝Codexだが、
   * ディレクトリの信頼確認に答えるまでフックが飛ばず宛先が取れていない。`true`＝送れる。
   *
   * `claudeStarting`・`reapAt`と同じく、**`undefined`（項目そのものが無い）と`null`は別物**。
   * 無いのは古いpollerで、そのホストについては何も判断できないため既存の値を触らない。
   */
  codexThreadKnown?: boolean | null;
  /**
   * いま何をしているか（#2705）。**フックが書いた印をpollerが運ぶだけ**で、issue-deck側は
   * 判定に加わらない。
   *
   * `reapAt`・`reapReason`と同じく、**`undefined`（項目そのものが無い）と`null`は別物**。
   * 無いのは古いpollerで、そのホストについては何も判断できないため既存の値を触らない。
   * `null`は「新しいpollerが見たうえで、まだ何も申告が無い」。
   */
  step?: DispatchSessionStep | null;
  stepAt?: string | null;
  stepSeenAt?: string | null;
};

/** 画面へ返すセッション。DBの行をそのまま出さず、必要な項目だけを整える */
export type DispatchSessionView = {
  host: string;
  tmuxSessionName: string;
  repositoryFullName: string;
  issueNumber: number;
  /**
   * Issueのタイトル（#1567）。**既定は`null`。**キャッシュ済みのIssueから引けたときだけ入る
   * （実行キューのジョブの行と同じ扱い＝`DispatchJobView.issueTitle`）。
   *
   * 引けなければ番号だけを出す。「（タイトル不明）」のような穴埋めは、実際のタイトルと
   * 紛らわしいので入れない。
   */
  issueTitle: string | null;
  /**
   * Issueのid（#1625）。タイトルと同じく`listDispatchState`が一括で引き当てる。
   * 行のタイトルからIssue詳細を開くために使い、**引けなければ`null`＝リンクにしない**
   * （`DispatchJobView.issueId`と同じ扱い）。**識別子も同じ`String(githubIssueId)`**（#1671）。
   */
  issueId: string | null;
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
  /**
   * 自動で畳む予定（#1817）。畳む条件が揃い、猶予が経つのを待っているセッションでだけ埋まる。
   * 画面に出す形にするのは`describeSessionReap`（`issue-session.ts`）。
   */
  reapAt: string | null;
  reapReason: DispatchSessionReapReason | null;
  /**
   * Codexのセッションで、追加指示の宛先（スレッドUUID）が分かっているか（#2519）。
   * `null`はClaude Codeのセッション（または申告しない古いpoller）で、従来どおり送れる。
   *
   * **`false`のあいだは追加指示を送れない**（`resolveSessionControlRejection`が断る）。
   */
  codexThreadKnown: boolean | null;
  /**
   * いま何をしているか（#2705）と、そのステップに入った時刻。申告が無ければ`null`。
   * 画面に出す形にするのは`describeSessionStep`（`issue-session.ts`）。
   */
  step: DispatchSessionStep | null;
  stepAt: string | null;
  /** 最後にそのステップのツールが走った時刻。`activityAt`との比較で「いま走っているか」を出す */
  stepSeenAt: string | null;
  /**
   * そのセッションが**実際に使っているモデル**のID（#2723）。例: `["claude-opus-5"]`。
   *
   * 起動時に指定した値（`DispatchJob.claudeModel`）ではなく、転記の集計
   * （`SessionUsage.models`）から引いた実物。「おまかせ」「CLIの既定」で立てたときに
   * 何で動いているのかが、これでしか分からない。
   *
   * **空配列は「まだ分からない」**（最初の応答が集計されるまでは出ない。pollerの報告は5分ごと）。
   * Claude Codeが小さな処理で別のモデルを使うと2つ以上並ぶ。
   */
  models: string[];
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
 * **`FAILED`へ遷移した時だけ真。** 同じ状態が続く間は偽（pollerは1巡ごとに同じ報告を送ってくるので、
 * 状態だけで判定すると巡のたびにコメントが増える）。`escalatedState`に「どの状態で引き上げ済みか」を
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

/**
 * 「まだ開始していない」（`NOT_STARTED`）をどう書き換えるか（#1465）。
 *
 * - `none` … 触らない
 * - `enter` … `NOT_STARTED`へ入る。**この遷移でだけ引き上げる**（Issueコメント＋`00.check-user`）
 * - `leave` … `NOT_STARTED`から出る（人が答えてClaude Codeが始まった）。付けた`00.check-user`を外す
 */
export type StartingActivityTransition = "none" | "enter" | "leave";

/**
 * pollerの`claudeStarting`から、その行の`activity`をどう動かすかを決める。
 *
 * **`ALIVE`のときしか動かさない。** 終わったセッションに「まだ開始していない」を書いても
 * 待つ相手がいない（`recordDispatchSessionActivity`が`ALIVE`の行だけを更新するのと同じ理由）。
 *
 * **入り直しは起こさない。** `enter`は`NOT_STARTED`ではない行にだけ返す。pollerは1巡ごとに
 * 同じ報告を送ってくるので、これが無いと巡のたびにコメントが増える（`shouldEscalateSession`と同じ形）。
 *
 * **`WAITING_INPUT`等が既に立っている行は上書きしない。** フックが飛んだ＝Claude Codeは
 * 始まっているので、印が消し損ねているだけと見て、フック側の値を信じる。
 */
export function resolveStartingActivityTransition(params: {
  state: DispatchSessionState;
  /** 直前の`activity`。立ち上がり直した行（`isRevivedSession`）ではnullを渡す */
  previousActivity: DispatchSessionActivity | null;
  claudeStarting: boolean | undefined;
}): StartingActivityTransition {
  if (params.claudeStarting === undefined) return "none";
  if (params.state !== "ALIVE") return "none";
  if (params.claudeStarting) {
    if (params.previousActivity === null) return "enter";
    return "none";
  }
  return params.previousActivity === "NOT_STARTED" ? "leave" : "none";
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

  // 古いpollerは送ってこない（#1465）。**無い場合は`undefined`のまま残す**（`false`へ倒すと、
  // 判断材料を持っていないホストの報告が`NOT_STARTED`を解いてしまう）
  const rawStarting = input.claudeStarting;
  let claudeStarting: boolean | undefined;
  if (rawStarting !== null && rawStarting !== undefined) {
    if (typeof rawStarting !== "boolean") return null;
    claudeStarting = rawStarting;
  }

  // 畳む予定（#1817）。**壊れていても報告全体は通す**（この項目だけを落とす）。時刻と理由は
  // 揃って初めて意味を持つので、片方でも読めなければ両方nullにする（理由の無い終了予告を
  // 画面へ出さない）
  const hasReapField = "reapAt" in input || "reapReason" in input;
  const reapAt = parseSessionReapAt(input.reapAt);
  const reapReason = parseSessionReapReason(input.reapReason);
  const reap =
    reapAt === null || reapReason === null ? { reapAt: null, reapReason: null } : { reapAt, reapReason };

  // Codexのセッションの宛先（#2519）。**`null`（Codexではない）と`undefined`（古いpoller）を
  // 分ける**。boolean・nullのどちらでもない値は、項目ごと無かったことにする（報告全体は通す）
  const rawCodexThread = input.codexThreadKnown;
  let codexThreadKnown: boolean | null | undefined;
  if (rawCodexThread === null || typeof rawCodexThread === "boolean") {
    codexThreadKnown = rawCodexThread;
  }

  // いま何をしているか（#2705）。**`reap`と同じ扱い**——壊れていても報告全体は通し、コードと
  // 時刻は揃って初めて意味を持つので、片方でも読めなければ両方nullにする（経過時間を出せない
  // ステップを画面へ出さない）
  const hasStepField = "step" in input || "stepAt" in input;
  const stepCode = parseSessionStep(input.step);
  const stepAt = parseSessionStepAt(input.stepAt);
  const stepSeenAt = parseSessionStepAt(input.stepSeenAt);
  const step =
    stepCode === null || stepAt === null || stepSeenAt === null
      ? { step: null, stepAt: null, stepSeenAt: null }
      : { step: stepCode, stepAt, stepSeenAt };

  return {
    tmuxSessionName,
    repositoryFullName,
    issueNumber,
    paneDead: input.paneDead,
    paneDeadStatus,
    ...(claudeStarting === undefined ? {} : { claudeStarting }),
    // 古いpollerは送ってこない。`undefined`のまま残すと既存の値を触らない
    ...(hasReapField ? reap : {}),
    ...(codexThreadKnown === undefined ? {} : { codexThreadKnown }),
    ...(hasStepField ? step : {}),
  };
}
