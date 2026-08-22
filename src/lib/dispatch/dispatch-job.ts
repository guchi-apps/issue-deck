// 型だけのimport（コンパイル時に消える）。`host-checkout.ts`側も`DispatchHostView`を
// 型としてしか使わないため、実行時の循環importにはならない（`host-metrics.ts`と同じ）
import type { DispatchHostCheckout } from "@/lib/dispatch/host-checkout";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
// 型だけのimport（コンパイル時に消える）。`host-metrics.ts`側も`DispatchHostView`を
// 型としてしか使わないため、実行時の循環importにはならない
import type { DispatchHostMetrics } from "@/lib/dispatch/host-metrics";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
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
  | "SKIPPED"
  | "TIMEOUT"
  | "CANCELED";

/**
 * ジョブの種別（#1332）。Prismaの`DispatchJobKind`と同じ並び。
 *
 * - `LAUNCH` … セッションを立てる（従来のジョブ）
 * - `INTERRUPT` … 走っている処理を中断する（`tmux send-keys … C-c`）。セッションは残る
 * - `KILL` … セッションごと畳む（`tmux kill-session`）
 * - `QUESTION` … 読み取り専用の質問応答を1回走らせ、回答コメントを投稿する（#1294）。
 *   セッションは立てない。**まだ積む経路も払い出し口も無い**（器だけ。実行はStep 3）
 * - `INSTRUCTION` … 走っているセッションへ追加指示を1行流す（#1012）。pollerが3段階プロトコル
 *   （状態確認 → 本文のみ送出 → 反映の再確認 → 確定キーを別送）で送る
 * - `CROSS_REPO_QUESTION` … 複数リポジトリ横断の質問セッションを立てる（#1454）。**`QUESTION`とは
 *   別物**で、あちらは`claude -p`を1回走らせて終わる想定なのに対し、こちらは`LAUNCH`と同じく
 *   tmuxセッションを立てる（回答後もセッションが残り、追加指示で追い質問ができる）。参照する
 *   リポジトリは**そのホストが実行できると申告した全部**で、ジョブには載せない
 * - `PLAN_REVIEW` … 計画の関門（G1・#1218）のセッションを立てる（#1855）。計画コメントの投稿を
 *   契機に自動で積まれ、対象リポジトリの`origin/develop`のスナップショットを読んで指摘を
 *   Issueコメントへ投稿する。**worktreeは作らず、レビュー1本で終わってセッションごと畳む**
 * - `MANUAL_STEP_ABORT` … 走っている代行実行を止める（#1882）。pollerが
 *   `systemctl --user stop issue-deck-manual-step-<対象ジョブID>`を実行する。**セッションを
 *   操作するジョブではない**（相手はtmuxではなくtransient unit）ので`SESSION_CONTROL_JOB_KINDS`
 *   には入れない
 */
export type DispatchJobKind =
  | "LAUNCH"
  | "INTERRUPT"
  | "KILL"
  | "QUESTION"
  | "INSTRUCTION"
  | "CROSS_REPO_QUESTION"
  | "MANUAL_STEP"
  | "MANUAL_STEP_ABORT"
  | "PLAN_REVIEW"
  | "SELF_UPDATE";

/**
 * 既に立っているセッションを操作するジョブ（起動しないジョブ）。
 *
 * **払い出しの可否は種別ごとに違う。** `INTERRUPT`・`KILL`は`sessionControlCapable`、
 * `INSTRUCTION`は`instructionCapable`を申告したホストにだけ配る（`claimDispatchJobs`）。
 * 前者が送るのは固定の`C-c`だけなのに対し、後者は**内容のある文字列**を送るため、
 * 対応していないpollerへ渡したときの事故の質が違う。
 */
export const SESSION_CONTROL_JOB_KINDS = ["INTERRUPT", "KILL", "INSTRUCTION"] as const;

export type SessionControlJobKind = (typeof SESSION_CONTROL_JOB_KINDS)[number];

export function isSessionControlJobKind(kind: DispatchJobKind): kind is SessionControlJobKind {
  return (SESSION_CONTROL_JOB_KINDS as readonly DispatchJobKind[]).includes(kind);
}

/**
 * tmuxセッションを立てるジョブ＝**同時実行数の枠を消費するジョブ**（#1544）。
 *
 * 払い出しの空き計算（`claimDispatchJobs`）・画面の実行キュー（`summarizeDispatchQueue`）・
 * 「先頭へ上げる」（`prioritizeDispatchJob`）は、**すべて同じ集合を見る必要がある**。
 * 枠の計算だけが`CROSS_REPO_QUESTION`を含み画面が`LAUNCH`しか数えていなかったため、
 * 横断質問セッションが枠を埋めていても「実行中 0/2」と出ていた（#1454の追加が画面へ
 * 反映されていなかった）。
 *
 * 制御ジョブ（`SESSION_CONTROL_JOB_KINDS`）は含めない。あちらは**枠外で先に配られる**（#1332）。
 */
export const SESSION_LAUNCH_JOB_KINDS = ["LAUNCH", "CROSS_REPO_QUESTION", "PLAN_REVIEW"] as const;

export type SessionLaunchJobKind = (typeof SESSION_LAUNCH_JOB_KINDS)[number];

export function isSessionLaunchJobKind(kind: DispatchJobKind): kind is SessionLaunchJobKind {
  return (SESSION_LAUNCH_JOB_KINDS as readonly DispatchJobKind[]).includes(kind);
}

/** 画面・pollerとやり取りするときの表記（小文字）を内部の表現へ写す */
export function parseDispatchJobKind(value: unknown): DispatchJobKind | null {
  // **省略時は`LAUNCH`。** 既存の呼び出し元（一括投入・実装開始ダイアログ）は`kind`を送らない
  if (value === undefined || value === null || value === "launch") return "LAUNCH";
  if (value === "interrupt") return "INTERRUPT";
  if (value === "kill") return "KILL";
  if (value === "question") return "QUESTION";
  if (value === "instruction") return "INSTRUCTION";
  if (value === "cross_repo_question") return "CROSS_REPO_QUESTION";
  if (value === "manual_step") return "MANUAL_STEP";
  if (value === "manual_step_abort") return "MANUAL_STEP_ABORT";
  if (value === "plan_review") return "PLAN_REVIEW";
  if (value === "self_update") return "SELF_UPDATE";
  return null;
}

/**
 * セッションを立てず、tmuxにも触らないジョブ（#1828）。手作業の代行実行と、その中断（#1882）、
 * チェックアウトの更新（#1875）。
 *
 * **払い出しは制御ジョブと同じ「枠外」**（`SESSION_LAUNCH_JOB_KINDS`に入れない）で、
 * `QUEUED`のまま5分で`TIMEOUT`にするのも制御ジョブと揃える——**待たせるほど危険になる**
 * 性質が同じだから（何時間も後に届いたコマンドは、そのときのホストの状態に対する実行になる）。
 *
 * 一方で`SESSION_CONTROL_JOB_KINDS`には**入れない**。あちらはpollerがセッション名を組み立て直して
 * 突き合わせる種別の集合で、こちらは操作する相手がセッションではない。
 */
export const OUT_OF_BAND_JOB_KINDS = ["MANUAL_STEP", "MANUAL_STEP_ABORT", "SELF_UPDATE"] as const;

export function isOutOfBandJobKind(kind: DispatchJobKind): boolean {
  return (OUT_OF_BAND_JOB_KINDS as readonly DispatchJobKind[]).includes(kind);
}

/**
 * 追加指示の本文の上限（#1012）。長い指示はIssueコメントに書き、ここへは
 * 「コメントを読んでから続けて」の1行を流す運用にする。
 */
export const SESSION_INSTRUCTION_MAX_LENGTH = 500;

/**
 * 走っているセッションへ流す追加指示の本文を検証する（#1012）。**受け口とpollerの両方で行う。**
 *
 * - **改行を含まない1行に限る。** 複数行は確定キーの解釈が画面の実装に依存し、
 *   途中の改行が意図せず1回目の送信になりうる
 * - **制御文字・ESCを弾く。** `tmux send-keys -l`はリテラル送出だが、ここを端末へ生の
 *   エスケープシーケンスを流す経路にはしない（`\u0000`〜`\u001f`に改行・タブ・ESCが含まれる）
 *
 * 通れば前後の空白を落とした本文を、通らなければ`null`を返す。
 */
export function parseSessionInstruction(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > SESSION_INSTRUCTION_MAX_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

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
 * 画面へ返すジョブ。DBの行をそのまま出さず、必要な項目だけを整える。
 *
 * **型をここ（DBに触らない側）に置く**のは、クライアントコンポーネント（#1180の起動先選択）が
 * `jobs.ts`をimportせずに同じ形を参照できるようにするため。`jobs.ts`はPrismaクライアントを
 * 読み込むため、そちらをimportするとブラウザ向けのバンドルへ入ってしまう。
 */
export type DispatchJobView = {
  id: string;
  repositoryFullName: string;
  issueNumber: number;
  /**
   * Issueのタイトル（#1519）。**DBのIssueキャッシュから引けたときだけ入る。**
   *
   * 実行キューの行に番号しか出ないと、番号を覚えていないIssueはGitHubを開くまで何のジョブか
   * 分からない。夜にまとめて積むと順番待ちが並ぶため、「これを先頭へ上げる」（#1541）を
   * 押す判断がその場でできなかった。
   *
   * **引けなくても`null`で通す**（同期前・GitHub Appを外したリポジトリ）。タイトルが無いことを
   * 理由に行を落としたり例外にしたりすると、キュー全体が見えなくなる方が害が大きい。
   */
  issueTitle: string | null;
  /**
   * Issueのid（#1625）。**行のタイトルをissue-deckのIssue詳細への導線にするために返す。**
   *
   * 番号（`issueNumber`）だけでは画面から詳細を開けない。選択中のIssueはidで持っており
   * （`?issue=<id>`）、リポジトリと番号からidを引くのは画面側の仕事ではないため、タイトルと
   * 同じ引き当て（`resolveDispatchIssues`）でここへ入れる。
   *
   * **画面の`Issue.id`と同じ`String(githubIssueId)`であること**（#1671）。DBの行id（cuid）を
   * 入れると一覧のどのIssueにも一致せず、押しても詳細が開かない（スマホはホームへ落ちる）。
   *
   * **引けなければ`null`で、そのときはリンクにしない**（`issueTitle`と同じ条件で揃う）。押しても
   * 何も起きない行を作るより、番号だけのプレーンな行のままにする方がよい。
   */
  issueId: string | null;
  targetHost: string;
  /** 何をするジョブか（#1332）。省略しない（画面が起動ジョブと制御ジョブを取り違えないため） */
  kind: DispatchJobKind;
  status: DispatchJobStatus;
  message: string | null;
  /**
   * 追加指示の本文（#1012。`kind`が`INSTRUCTION`のときだけ入る）。
   *
   * **画面に出すために返す。** pull型なので届くまで最大1分ほどかかり、その間に何を送ったのかが
   * 見えないと、送り直してよいのか（同じ指示が二重に届かないか）判断できない。
   */
  instruction: string | null;
  /**
   * 代行実行したコマンド（#1828。`kind`が`MANUAL_STEP`のときだけ入る）。
   *
   * **サーバーが手作業Issueの本文から抽出し直したものが入る。** 画面はこれを「承認したものと
   * 同じか」の確認に使えるが、実行そのものはこの値で行われる（画面から届いた文字列は照合専用）。
   */
  command: string | null;
  /** 代行実行した手順の行番号（#1828）。画面がジョブと手順を対応付ける */
  manualStepLine: number | null;
  /**
   * 止める対象のジョブid（#1882。`kind`が`MANUAL_STEP_ABORT`のときだけ入る）。
   *
   * 画面は「この実行を止めようとしている中断ジョブがあるか」をこれで引く（中断も届くまで
   * 最大1巡かかるため、押した後に何も出ないと押し直してよいのか分からない）。
   */
  targetJobId: string | null;
  /** 代行実行の終了コード（#1828）。`0`のときだけ画面が手順のチェックを付ける */
  exitCode: number | null;
  /**
   * 代行実行の出力（#1828。末尾を残して切ったもの）。
   *
   * **シークレットが混ざりうるため、ログイン必須のこの画面より外へは出さない**
   * （GitHubのIssueにも通知にも載せない）。
   */
  commandOutput: string | null;
  tmuxSessionName: string | null;
  /**
   * 順番待ちの中で先に払い出す度合い（#1541。大きいほど先）。
   *
   * **画面はこれで並べ替えたうえで、値そのものは出さない。** 押した結果は「1番になった」
   * という並びの変化として見えれば十分で、数値を出すと意味を説明する必要が出る。
   */
  queuePriority: number;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

/** 画面へ返すホスト。実行可能リポジトリは配列に展開し、生存判定も済ませて渡す */
export type DispatchHostView = {
  name: string;
  repositories: string[];
  contractVersion: number | null;
  online: boolean;
  lastSeenAt: string;
  /**
   * スクリーンショットを撮れるか（#1268）。**`null`は「申告していない」**（古いpoller）で、
   * `false`（撮れない）とは区別する。判定材料が無いことを理由に選択肢を塞がないため。
   */
  screenshotCapable: boolean | null;
  /**
   * 走っているセッションを画面から操作できるか（#1332）。**`null`（未申告＝古いpoller）は
   * 「できない」として扱う**。`screenshotCapable`とは逆で、判定材料が無いまま制御ジョブを
   * 配ると、古いpollerは`kind`を読まないため起動ジョブとして解釈してしまう。
   */
  sessionControlCapable: boolean | null;
  /**
   * 走っているセッションへ追加指示を流せるか（#1012）。3段階プロトコルを実装したpollerだけが
   * 申告する。**`null`（未申告）は「できない」として扱う**（`sessionControlCapable`と同じ）。
   *
   * **`sessionControlCapable`と分けて持つ。** あちらが送るのは固定の`C-c`だけなのに対し、
   * こちらは**内容のある文字列**を送るため、対応していないpollerへ渡したときの事故の質が違う。
   */
  instructionCapable: boolean | null;
  /**
   * 複数リポジトリ横断の質問セッション（#1454）を起こせるか。**`null`（未申告）は「できない」として
   * 扱う**（`sessionControlCapable`と同じ）。古いpollerは未知の種別を`failed`で返すため、
   * 配ると質問が必ず失われる。
   */
  crossRepoQuestionCapable: boolean | null;
  /**
   * 手作業アシスタントからの代行実行（#1828）を実行できるか。**`null`（未申告）は「できない」として
   * 扱う**（`sessionControlCapable`と同じ）。
   *
   * **`instructionCapable`とも分けて持つ。** あちらは走っているセッションの入力欄へ1行流すだけで、
   * こちらは**シェルでコマンドを実行する**。同じ「文字列を届ける」でも、届いた先で起きることが違う。
   */
  manualStepCapable: boolean | null;
  /**
   * 走っている代行実行を止められるか（#1882）。**`null`（未申告）は「できない」として扱う**
   * （`manualStepCapable`と同じ向き）。
   *
   * **画面はこれを見て、中断の効き目を先に伝える。** 止められないホストでは「打ち切り
   * （5分）まで待つことになります」と出す。押せば止まるように見せて実際は止まらない、
   * という状態を作らないための材料。
   */
  manualStepAbortCapable: boolean | null;
  /**
   * 計画の関門（G1・#1218）のセッションを起こせるか（#1855）。**`null`（未申告）は「できない」として
   * 扱う**（`crossRepoQuestionCapable`と同じ）。
   *
   * **判定材料が無いことを理由に配らない向きは、この種別でいちばん効く。** 計画レビューは
   * 計画コメントの投稿を契機に自動で積まれるため、対応していないpollerへ配ると、計画を出すたびに
   * 未知の種別として`failed`になったジョブが画面へ並ぶ。
   */
  planReviewCapable: boolean | null;

  /**
   * チェックアウトの更新と自己再起動ができるか（#1875）。**`null`（未申告）は「できない」として
   * 扱う**（他のCapableと同じ）。`manualStepCapable`と分けて持つ理由はスキーマ側のコメント参照。
   */
  selfUpdateCapable: boolean | null;
  /**
   * 生かしておく実装セッションの本数の上限（#1361）と、申告した時点で生きていた本数（#1394）。
   *
   * **同時実行数（`concurrency`）とは別物。** あちらはジョブの払い出しにしか効かず、ジョブは
   * tmuxセッションが立った時点で`succeeded`になるため、本数を止めているのはこちらだけ。
   * 上限に達している間、pollerは起動ジョブを取りに行かない（制御ジョブだけを受け取る）。
   *
   * **`null`は「申告していない」**（古いpoller）。0本であることとは区別する。
   */
  maxSessions: number | null;
  liveSessions: number | null;
  /**
   * 申告した時点のリソース使用率（#1567）。**申告していなければ`null`**（古いpoller・
   * 取得に失敗した巡）。5つの値はまとめて入るかまとめて`null`かのどちらかで、
   * 部分的には埋まらない（`parseDispatchHostMetrics`）。
   *
   * **割り当ての判定には使わない。** 起動を止めているのは`maxSessions`と同時実行数だけで、
   * こちらは画面へ出すための写し。
   */
  metrics: DispatchHostMetrics | null;
  /**
   * pollerが動かしているチェックアウトの版（#1612）。**申告していなければ`null`**
   * （古いpoller・gitが無い・読めなかった巡）。
   *
   * **`contractVersion`・`agentVersion`とは別物。** あちらは約束を変えたときに手で上げる
   * 版数で、チェックアウトの鮮度とは無関係（実際、版数が同じまま97コミット遅れていた）。
   *
   * **割り当ての判定には使わない**（`metrics`と同じ立場）。遅れているホストへジョブを
   * 配らない、といった判断はしない。取り込むかどうかは人が決める。
   */
  checkout: DispatchHostCheckout | null;
};

/**
 * ホストがセッション本数の上限に達しているか（#1394）。
 *
 * **判定材料が揃っているときだけ真を返す。** 申告していない古いpollerでは`null`が入るため、
 * そこで「達している」と決めると、実際には動いているホストに止まっている旨の説明が出る。
 */
export function isDispatchHostAtSessionCapacity(host: DispatchHostView): boolean {
  if (host.maxSessions === null || host.liveSessions === null) return false;
  return host.liveSessions >= host.maxSessions;
}

/**
 * ホストが生存していると見なす猶予（ミリ秒）。pollerのポーリング間隔は既定30秒なので、
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

/**
 * 積んだまま取りに来られない制御ジョブ（#1332）を見限るまでの時間（ミリ秒）。
 *
 * **起動ジョブと違い、待たせるほど危険になる。** `QUEUED`のまま残った`C-c`が何時間も後に
 * 届くと、そのときセッションでは別の作業が走っている。ポーリング間隔（既定30秒）の
 * 数回ぶんを過ぎたら「届かなかった」として落とす。
 */
export const DISPATCH_CONTROL_QUEUE_TIMEOUT_MS = 5 * 60 * 1000;

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
 *
 * **種別ごとに名前空間を分ける**（#1332）。起動ジョブは従来どおり`owner/repo#番号`で、制御ジョブは
 * `interrupt:owner/repo#番号`のように前置きする。制御ジョブでnullにすると起動ジョブとは
 * 衝突しない代わりに、スマホでの連打ぶんだけ`C-c`が積まれる。前置きなら衝突せず、
 * 「同じIssueに未処理の停止は1件まで」もDBが保証する。
 *
 * **質問ジョブ（`QUESTION`）だけは`null`を返す**（#1294）。「未完了は1件まで」は実装ジョブの
 * 二重起動を防ぐための制約で、質問には当てはまらない。ここでキーを取ると
 * **実装ジョブが走っているIssueに質問を積めなくなる**（質問はまさに実装中に割り込んで聞くための
 * 機能なので、それでは意味が無い）。同じIssueに質問が並ぶこと自体は害にならない。
 */
// 質問以外は必ずキーを持つ。**呼び出し元（Issue一覧の順番待ち表示など）に不要なnull分岐を
// 増やさないよう、種別を渡さない・質問以外を渡す呼び方では`string`を返す**とオーバーロードで示す
export function buildDispatchActiveKey(
  repositoryFullName: string,
  issueNumber: number,
  kind?: Exclude<DispatchJobKind, "QUESTION">,
): string;
export function buildDispatchActiveKey(
  repositoryFullName: string,
  issueNumber: number,
  kind: DispatchJobKind,
): string | null;
export function buildDispatchActiveKey(
  repositoryFullName: string,
  issueNumber: number,
  kind: DispatchJobKind = "LAUNCH",
): string | null {
  if (kind === "QUESTION") return null;
  const target = `${repositoryFullName}#${issueNumber}`;
  return kind === "LAUNCH" ? target : `${kind.toLowerCase()}:${target}`;
}

/**
 * チェックアウトの更新（#1875）が使う`DispatchJob`の埋め草。
 *
 * **このジョブはIssueに紐づかない**（ホストに対する操作）が、`DispatchJob`は
 * `repositoryFullName`・`issueNumber`を必須で持つ。pollerが動かしているチェックアウトは
 * issue-deck自身なので、リポジトリはそれを入れ、番号は「Issueではない」印として0を置く。
 */
export const SELF_UPDATE_REPOSITORY = "guchi-apps/issue-deck";
export const SELF_UPDATE_ISSUE_NUMBER = 0;

/**
 * 更新ジョブの活性キー。**Issueではなくホストで一意にする。**
 *
 * 同じホストへ更新を二重に積むと、1本目の再起動中に2本目が届いて中途半端な状態になる。
 * `buildDispatchActiveKey`が作る`self_update:owner/repo#0`と混ざらないよう`host:`を挟む。
 */
export function buildSelfUpdateActiveKey(hostName: string): string {
  return `self_update:host:${hostName}`;
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
export type DispatchReportStatus = "running" | "succeeded" | "failed" | "skipped";

export function parseDispatchReportStatus(value: unknown): DispatchReportStatus | null {
  if (value === "running" || value === "succeeded" || value === "failed") return value;
  // 起動を見送ったときの報告（#1229）。**古いpollerは送ってこない**ため、受け口だけが先に
  // 新しくなっても従来どおり動く
  if (value === "skipped") return value;
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
  | "already_queued"
  | "session_alive";

export function describeDispatchEnqueueRejection(
  rejection: DispatchEnqueueRejection,
  context: {
    hostName: string;
    repositoryFullName?: string;
    /** `session_alive`のときに、既に動いているセッションの居場所を添えるための情報 */
    session?: Pick<DispatchSessionView, "host" | "tmuxSessionName"> | null;
  },
): string {
  switch (rejection) {
    case "host_unknown":
      return `${formatDispatchHostName(context.hostName)} からの申告がまだ届いていません。ディスパッチのpollerが動いているか確認してください。`;
    case "host_offline":
      return `${formatDispatchHostName(context.hostName)} が応答していません（最後の申告から時間が経ちすぎています）。`;
    case "repository_not_runnable":
      return `${context.repositoryFullName ?? "このリポジトリ"} は ${formatDispatchHostName(context.hostName)} で実行できません（cloneされていないか、ローカル起動に対応していません）。`;
    case "already_queued":
      return "このIssueには実行中または待機中のジョブが既にあります。";
    case "session_alive": {
      // **セッション名まで出す。** 畳むにはサブPCでその名前を指す必要があり、名前が無いと
      // 「押せないが、どうすれば押せるようになるか分からない」で終わる
      const where = context.session
        ? `${formatDispatchHostName(context.session.host)}で「${context.session.tmuxSessionName}」`
        : "起動先で このIssueのセッション";
      const how = context.session
        ? `${formatDispatchHostName(context.session.host)}で \`tmux kill-session -t ${context.session.tmuxSessionName}\` を実行してください`
        : "起動先でtmuxセッションを畳んでください";
      // 畳んでも次のセッション報告（既定30秒間隔）が届くまでは押せないままになる。#1321で解消予定
      return `${where}が動いています。作り直す場合は${how}（畳んでから押せるようになるまで最大1分ほどかかります）。`;
    }
  }
}

/**
 * 制御ジョブ（#1332）の呼び方。**画面のボタンとジョブの状態表示で同じ言葉を使う。**
 * 押したボタンと画面に出る文言が違うと、届いたのかどうかが分からなくなる。
 */
export const SESSION_CONTROL_LABELS = {
  INTERRUPT: {
    /** ボタンの文言 */
    action: "停止",
    /** 積んだ直後（まだ届いていない） */
    sending: "停止を送信しました",
    /** poller側で実行できた */
    done: "停止を送りました",
    /** 実行できなかった */
    failed: "停止できませんでした",
  },
  KILL: {
    action: "セッションを閉じる",
    sending: "セッションの終了を送信しました",
    done: "セッションを閉じました",
    failed: "セッションを閉じられませんでした",
  },
  INSTRUCTION: {
    action: "追加指示を送る",
    sending: "追加指示を送信しました",
    done: "追加指示を送りました",
    failed: "追加指示を送れませんでした",
  },
} as const satisfies Record<SessionControlJobKind, Record<string, string>>;

/**
 * ジョブの種別の呼び方（#1519）。実行キューの行に出すチップの文言。
 *
 * **すべての種別に文言を持たせる。** 既定の`LAUNCH`だけ無印にすると「チップが無い＝実装」という
 * 暗黙のルールを覚える必要が出る。状態ラベル（`describeDispatchJobStatus`）だけでは、
 * **`QUEUED`のときに`LAUNCH`と`CROSS_REPO_QUESTION`がどちらも「順番待ち」**になり区別が付かない。
 *
 * 制御ジョブは`SESSION_CONTROL_LABELS`の`action`（＝押したボタンの文言）をそのまま使う。
 * 押したボタンとキューに出る言葉が違うと、それが自分の押したものかどうか分からなくなる。
 */
export function describeDispatchJobKind(kind: DispatchJobKind): string {
  switch (kind) {
    case "LAUNCH":
      return "実装";
    case "QUESTION":
      return "質問";
    case "CROSS_REPO_QUESTION":
      return "横断質問";
    case "MANUAL_STEP":
      return "手作業の代行";
    case "MANUAL_STEP_ABORT":
      return "代行の中断";
    case "PLAN_REVIEW":
      return "計画レビュー";
    case "SELF_UPDATE":
      return "チェックアウトの更新";
    case "INTERRUPT":
    case "KILL":
    case "INSTRUCTION":
      return SESSION_CONTROL_LABELS[kind].action;
  }
}

/**
 * 手作業の代行実行（#1828）を押せない理由。**画面にそのまま出す前提**。
 *
 * 起動側（`DispatchEnqueueRejection`）・制御ジョブ側（`SessionControlRejection`）と同じ立場のもので、
 * 判定は画面とAPIで同じ関数（`resolveManualStepExecutionRejection`）を使う。
 */
export type ManualStepExecutionRejection =
  | "not_manual_step"
  | "device_not_subpc"
  | "no_command"
  | "interactive_command"
  | "placeholder_command"
  | "host_unknown"
  | "host_offline"
  | "manual_step_unsupported"
  | "already_queued"
  | "body_changed";

export function describeManualStepExecutionRejection(
  rejection: ManualStepExecutionRejection,
  context: {
    hostName: string;
    device?: string | null;
    /** 対話が要ると判定されたコマンドの表記（`interactive_command`のときだけ使う） */
    interactiveCommand?: string | null;
    /** プレースホルダと判定された表記（`placeholder_command`のときだけ使う。#2051） */
    placeholder?: string | null;
  },
): string {
  switch (rejection) {
    case "not_manual_step":
      return "この Issue は手作業Issue（`71.manual-step`）ではないため代行できません。";
    case "device_not_subpc":
      // **どこで実行する手作業なのかまで書く。** VPS・1Password・GitHub App・ブラウザでの設定は
      // issue-deckから到達できず、代行できるようになる見込みも無い（「更新すれば押せる」ではない）
      return context.device
        ? `この手作業は${context.device}で実行するため、画面からは代行できません。手順どおり実行して「実行した・次へ」で進めてください。`
        : "この手作業はサブPC以外で実行するため、画面からは代行できません。手順どおり実行して「実行した・次へ」で進めてください。";
    case "no_command":
      // 0個・2個以上のどちらもここに来る。**どちらなのかは書き分けない**——実行する側にとっては
      // 「この手順は代行できない」で同じで、直すには本文を1手順1コマンドに書き直すしかない
      return "この手順は代行できません。実行するコマンドのブロックがちょうど1つ書かれている手順だけを代行します。";
    case "interactive_command":
      // **代行できるようになる見込みが無い理由**（`device_not_subpc`と同じ立場）。
      // 代行実行のシェルには標準入力が無く、サインインの答えを渡せない。ここだけは人が
      // 実行して、続きは自動実行に任せてもらう（#2025）
      return context.interactiveCommand
        ? `この手順には対話が必要なコマンド（${context.interactiveCommand}）が含まれるため代行できません。${formatDispatchHostName(context.hostName)} の端末で実行してから、続きへ進めてください。`
        : `この手順には対話が必要なコマンドが含まれるため代行できません。${formatDispatchHostName(context.hostName)} の端末で実行してから、続きへ進めてください。`;
    case "placeholder_command":
      // **代行できるようになる見込みが無い理由**（`interactive_command`と同じ立場）。
      // 値が埋まっていないコマンドは、積んでも失敗するか——`KEY=<値>`のように
      // シェルのリダイレクトとして解釈されて——意図しない失敗の仕方をする（#2051）
      return context.placeholder
        ? `この手順には値を埋めるプレースホルダ（\`${context.placeholder}\`）が含まれるため代行できません。値を埋めて ${formatDispatchHostName(context.hostName)} の端末で実行してから、続きへ進めてください。`
        : `この手順には値を埋めるプレースホルダが含まれるため代行できません。値を埋めて ${formatDispatchHostName(context.hostName)} の端末で実行してから、続きへ進めてください。`;
    case "host_unknown":
      return `${formatDispatchHostName(context.hostName)} からの申告がまだ届いていません。ディスパッチのpollerが動いているか確認してください。`;
    case "host_offline":
      return `${formatDispatchHostName(context.hostName)} が応答していません（最後の申告から時間が経ちすぎています）。`;
    case "manual_step_unsupported":
      return `${formatDispatchHostName(context.hostName)} のpollerが手作業の代行実行に対応していません（更新してから押せるようになります）。`;
    case "already_queued":
      return "この手作業には未処理の代行実行が既にあります。";
    case "body_changed":
      // **押した後にしか出ない。** 承認した内容とサーバーが読み直した本文が食い違った場合で、
      // 実行はしていない（画面を更新して、変わった内容を見てから押し直してもらう）
      return "本文が変わったため実行しませんでした。画面を更新して、実行する内容をもう一度確かめてください。";
  }
}

/**
 * 手作業の代行実行を押せるか、**押される前に**判定する（#1828）。
 *
 * 判定の並びと文言は`enqueueManualStepJob`（`jobs.ts`）と同じものを使う。片方だけが持つと
 * 「押せるのにAPIが拒否する」（その逆も）が生まれるのは、起動側（#1180）・制御ジョブ（#1332）と同じ。
 *
 * **`body_changed`はここでは返さない。** 画面が見ている本文＝人が承認した本文なので、
 * ずれを検出できるのはサーバーだけ（押した後にしか分からない）。
 */
export function resolveManualStepExecutionRejection(params: {
  host: Pick<DispatchHostView, "online" | "manualStepCapable"> | null | undefined;
  /** 対象が手作業Issue（`71.manual-step`）か */
  isManualStepIssue: boolean;
  /** `## 前提条件`の「実行するデバイス」がサブPCか */
  isSubpcDevice: boolean;
  /** その手順から実行するコマンドを1つだけ取り出せたか */
  hasCommand: boolean;
  /**
   * そのコマンドに含まれる、対話が要るコマンドの表記（`findInteractiveCommand`の結果。#2025）。
   * **判定そのものは`lib/manual-step-command.ts`が持つ**——ここで文字列を見ると、画面・API・
   * 自動実行がそれぞれ別の条件を持つことになる。
   */
  interactiveCommand: string | null;
  /**
   * そのコマンドに含まれる、人が値を埋めるプレースホルダの表記（`findPlaceholder`の結果。#2051）。
   * **判定そのものは`lib/manual-step-command.ts`が持つ**——`interactiveCommand`と同じ理由。
   */
  placeholder: string | null;
  hasActiveJob: boolean;
}): ManualStepExecutionRejection | null {
  // **Issueと手順の性質を先に見る。** ホストの都合（更新すれば押せる）と違い、こちらは
  // そもそも代行の対象外で、ホストの状態を理由に出しても直す手がかりにならない
  if (!params.isManualStepIssue) return "not_manual_step";
  if (!params.isSubpcDevice) return "device_not_subpc";
  if (!params.hasCommand) return "no_command";
  // **ホストの都合より先に見る。** 更新すれば押せるようになるものではなく、人が実行するしかない
  if (params.interactiveCommand) return "interactive_command";
  // **こちらもホストの都合より先に見る**（#2051）。穴が空いたまま積むと、失敗するだけでなく
  // `KEY=<値>`がリダイレクトとして解釈されるなど、意図しない失敗の仕方をする
  if (params.placeholder) return "placeholder_command";
  if (!params.host) return "host_unknown";
  if (!params.host.online) return "host_offline";
  if (params.host.manualStepCapable !== true) return "manual_step_unsupported";
  if (params.hasActiveJob) return "already_queued";
  return null;
}

/**
 * セッションを操作できない理由（#1332）。**画面にそのまま出す前提**で、
 * 起動側の`DispatchEnqueueRejection`と同じ立場のもの。
 */
export type SessionControlRejection =
  | "host_unknown"
  | "host_offline"
  | "session_control_unsupported"
  | "instruction_unsupported"
  | "session_not_found"
  | "session_not_alive"
  | "already_queued";

export function describeSessionControlRejection(
  rejection: SessionControlRejection,
  context: { hostName: string; kind: SessionControlJobKind },
): string {
  const label = SESSION_CONTROL_LABELS[context.kind];
  switch (rejection) {
    case "host_unknown":
      return `${formatDispatchHostName(context.hostName)} からの申告がまだ届いていません。ディスパッチのpollerが動いているか確認してください。`;
    case "host_offline":
      return `${formatDispatchHostName(context.hostName)} が応答していません（最後の申告から時間が経ちすぎています）。`;
    case "session_control_unsupported":
      // **何をすれば押せるようになるかまで書く。** pollerはサブPC側の作業ツリーから動くため、
      // 更新するのは人の作業になる（issue-deck側を新しくしても解消しない）
      return `${formatDispatchHostName(context.hostName)} のpollerがセッションの操作に対応していません（更新してから押せるようになります）。`;
    case "instruction_unsupported":
      // **停止・終了とは別に断る**（#1012）。あちらに対応していても、文字列を送る3段階
      // プロトコルはpollerを更新しないと入らない
      return `${formatDispatchHostName(context.hostName)} のpollerが追加指示の送信に対応していません（更新してから押せるようになります）。`;
    case "session_not_found":
      return `${formatDispatchHostName(context.hostName)} にこのIssueのセッションが見当たりません。`;
    case "session_not_alive":
      return "このセッションは既に終了しています。";
    case "already_queued":
      return `このIssueには未処理の${label.action}が既にあります。`;
  }
}

/**
 * セッションを操作できるか、**押される前に**判定する（#1332）。
 *
 * 判定の並びと文言は`enqueueSessionControlJob`（`jobs.ts`）と同じものを使う。画面だけに置くと
 * 「押せるのにAPIが拒否する」（その逆も）が生まれるのは、起動側（#1180）と同じ。
 */
export function resolveSessionControlRejection(params: {
  host:
    | Pick<DispatchHostView, "online" | "sessionControlCapable" | "instructionCapable">
    | null
    | undefined;
  session: Pick<DispatchSessionView, "state"> | null | undefined;
  kind: SessionControlJobKind;
  hasActiveControlJob: boolean;
}): SessionControlRejection | null {
  if (!params.host) return "host_unknown";
  if (!params.host.online) return "host_offline";
  // **対応の申告は種別で分けて見る**（#1012）。停止・終了に対応していても、内容のある文字列を
  // 送る3段階プロトコルは別に申告が要る
  if (params.kind === "INSTRUCTION") {
    if (params.host.instructionCapable !== true) return "instruction_unsupported";
  } else if (params.host.sessionControlCapable !== true) {
    return "session_control_unsupported";
  }
  if (!params.session) return "session_not_found";
  // **`INTERRUPT`・`INSTRUCTION`は生きているセッションにしか意味が無い**（死んだペインには
  // 送る相手がいない）。`KILL`は逆に、終了したペインが残っている（`EXITED`/`FAILED`）
  // セッションを片付ける用途があるので許す
  if (params.session.state === "GONE") return "session_not_found";
  if (params.kind !== "KILL" && params.session.state !== "ALIVE") return "session_not_alive";
  if (params.hasActiveControlJob) return "already_queued";
  return null;
}

/**
 * 起動先として選べない理由を、**押される前に**判定する（#1180）。
 *
 * 判定の並びと理由の文言は`enqueueDispatchJob`（`jobs.ts`）と同じものを使う。片方だけで
 * 判定を持つと、画面では押せるのにAPIが拒否する（またはその逆）状態が生まれる。ここは
 * 「押せてしまわないようにする」ための先出しで、**最終的な拒否はAPI側が行う**
 * （申告が古い・押した瞬間にホストが落ちる、といったずれは避けられない）。
 */
export function resolveDispatchTargetRejection(params: {
  host: Pick<DispatchHostView, "online" | "repositories"> | null | undefined;
  repositoryFullName: string;
  hasActiveJob: boolean;
  /** 既に動いているセッション（`findBlockingSession`の戻り値）。無ければ`null` */
  blockingSession: Pick<DispatchSessionView, "host" | "tmuxSessionName"> | null;
}): DispatchEnqueueRejection | null {
  if (!params.host) return "host_unknown";
  if (!params.host.online) return "host_offline";
  if (!params.host.repositories.includes(params.repositoryFullName)) {
    return "repository_not_runnable";
  }
  if (params.hasActiveJob) return "already_queued";
  // **セッションの判定は未完了ジョブの後ろ。** 両方あてはまる場合は、押した直後から見えている
  // ジョブの方が利用者にとって直近の事実で、そちらを出す方が話が通じる
  if (params.blockingSession) return "session_alive";
  return null;
}

/**
 * 複数リポジトリ横断の質問セッション（#1454）を起こせない理由。
 *
 * 起動ジョブ（`DispatchEnqueueRejection`）と似ているが、**`repository_not_runnable`が無い**のが
 * 要点。横断質問セッションはworktreeを作らず、記録先リポジトリには`gh issue comment`で書くだけ
 * なので、記録先がサブPCにcloneされている必要が無い。代わりに「参照できるリポジトリが1件も無い」
 * を見る（cloneが1つも無いホストでは、質問に答える材料そのものが無い）。
 */
export type CrossRepoQuestionRejection =
  | "host_unknown"
  | "host_offline"
  | "cross_repo_question_unsupported"
  | "no_runnable_repositories"
  | "already_queued"
  | "session_alive";

export function describeCrossRepoQuestionRejection(
  rejection: CrossRepoQuestionRejection,
  context: { hostName: string },
): string {
  switch (rejection) {
    case "host_unknown":
      return `${formatDispatchHostName(context.hostName)} からの申告がまだ届いていません。ディスパッチのpollerが動いているか確認してください。`;
    case "host_offline":
      return `${formatDispatchHostName(context.hostName)} が応答していません（最後の申告から時間が経ちすぎています）。`;
    case "cross_repo_question_unsupported":
      // **何をすれば押せるようになるかまで書く**（`session_control_unsupported`と同じ）。
      // pollerはサブPC側の作業ツリーから動くため、更新するのは人の作業になる
      return `${formatDispatchHostName(context.hostName)} のpollerが横断質問に対応していません（更新してから押せるようになります）。`;
    case "no_runnable_repositories":
      return `${formatDispatchHostName(context.hostName)} に参照できるリポジトリが1つもありません（cloneと \`local-repos.conf\` への記載を確認してください）。`;
    case "already_queued":
      return "この質問Issueには実行中または待機中のジョブが既にあります。";
    case "session_alive":
      return "この質問Issueのセッションは既に動いています。追加で聞く場合は、そのセッションへ追加指示を送ってください。";
  }
}

/**
 * 横断質問を起こせない理由を、**押される前に**判定する（#1454）。
 *
 * 判定の並びと文言は`enqueueCrossRepoQuestionJob`（`jobs.ts`）と同じものを使う。片方だけで
 * 持つと「画面では押せるのにAPIが断る」状態が生まれるのは、起動側（#1180）・制御側（#1332）と同じ。
 */
export function resolveCrossRepoQuestionRejection(params: {
  host:
    | Pick<DispatchHostView, "online" | "crossRepoQuestionCapable" | "repositories">
    | null
    | undefined;
  hasActiveJob: boolean;
  blockingSession: Pick<DispatchSessionView, "host" | "tmuxSessionName"> | null;
}): CrossRepoQuestionRejection | null {
  if (!params.host) return "host_unknown";
  if (!params.host.online) return "host_offline";
  if (params.host.crossRepoQuestionCapable !== true) return "cross_repo_question_unsupported";
  if (params.host.repositories.length === 0) return "no_runnable_repositories";
  if (params.hasActiveJob) return "already_queued";
  if (params.blockingSession) return "session_alive";
  return null;
}

/**
 * 横断質問の既定の起動先を決める（#1454）。選べるホストが1台も無ければ`null`。
 *
 * 起動ジョブの`resolveDefaultDispatchHost`と同じ立場だが、**GitHub Actionsへのフォールバックは
 * 無い**（Actionsは1リポジトリしかチェックアウトしないため、横断質問はサブPC限定）。
 */
export function resolveDefaultCrossRepoQuestionHost(
  hosts: readonly DispatchHostView[],
): string | null {
  return (
    hosts.find(
      (host) =>
        resolveCrossRepoQuestionRejection({ host, hasActiveJob: false, blockingSession: null }) ===
        null,
    )?.name ?? null
  );
}

/**
 * 計画の関門（G1・#1855）のセッションを起こせない理由。
 *
 * 横断質問（`CrossRepoQuestionRejection`）と似ているが、要点は2つ違う。
 *
 * - **`repository_not_runnable`がある。** 計画レビューは対象リポジトリのコードを読んで計画と
 *   突き合わせるので、そのリポジトリがcloneされている必要がある（横断質問は記録先のcloneが要らない）
 * - **`session_alive`が無い。** 計画を出したセッションは承認待ちで生きているのが常態で、
 *   そこで弾くと**自動起動が常に断られる**（この機能そのものが成立しない）
 */
export type PlanReviewRejection =
  | "host_unknown"
  | "host_offline"
  | "plan_review_unsupported"
  | "repository_not_runnable"
  | "already_queued";

export function describePlanReviewRejection(
  rejection: PlanReviewRejection,
  context: { hostName: string; repositoryFullName?: string },
): string {
  switch (rejection) {
    case "host_unknown":
      return `${formatDispatchHostName(context.hostName)} からの申告がまだ届いていません。ディスパッチのpollerが動いているか確認してください。`;
    case "host_offline":
      return `${formatDispatchHostName(context.hostName)} が応答していません（最後の申告から時間が経ちすぎています）。`;
    case "plan_review_unsupported":
      // **何をすれば押せるようになるかまで書く**（`cross_repo_question_unsupported`と同じ）。
      // pollerはサブPC側の作業ツリーから動くため、更新するのは人の作業になる
      return `${formatDispatchHostName(context.hostName)} のpollerが計画レビューに対応していません（更新してから押せるようになります）。`;
    case "repository_not_runnable":
      return `${context.repositoryFullName ?? "このリポジトリ"} は ${formatDispatchHostName(context.hostName)} で実行できません（cloneされていないか、ローカル起動に対応していません）。`;
    case "already_queued":
      return "このIssueには実行中または待機中の計画レビューが既にあります。";
  }
}

/**
 * 計画レビューを起こせない理由を、**押される前に**判定する（#1855）。
 *
 * 判定の並びと文言は`enqueuePlanReviewJob`（`jobs.ts`）と同じものを使う。片方だけで持つと
 * 「画面では押せるのにAPIが断る」状態が生まれるのは、起動側（#1180）・制御側（#1332）と同じ。
 */
export function resolvePlanReviewRejection(params: {
  host: Pick<DispatchHostView, "online" | "planReviewCapable" | "repositories"> | null | undefined;
  repositoryFullName: string;
  hasActiveJob: boolean;
}): PlanReviewRejection | null {
  if (!params.host) return "host_unknown";
  if (!params.host.online) return "host_offline";
  if (params.host.planReviewCapable !== true) return "plan_review_unsupported";
  if (!params.host.repositories.includes(params.repositoryFullName)) {
    return "repository_not_runnable";
  }
  if (params.hasActiveJob) return "already_queued";
  return null;
}

/**
 * 計画レビューの既定の起動先を決める（#1855）。選べるホストが1台も無ければ`null`。
 *
 * **GitHub Actionsへのフォールバックは無い**（`resolveDefaultCrossRepoQuestionHost`と同じ）。
 * 無人実行のG1は`reusable-issue-dispatch.yml`が計画提示の直後に自分で走らせるもので、
 * こちらから積む相手ではない。
 */
export function resolveDefaultPlanReviewHost(
  hosts: readonly DispatchHostView[],
  repositoryFullName: string,
): string | null {
  return (
    hosts.find(
      (host) =>
        resolvePlanReviewRejection({ host, repositoryFullName, hasActiveJob: false }) === null,
    )?.name ?? null
  );
}

/**
 * そのIssueの起動を止めるべきセッションを探す（#1311）。
 *
 * 起動済みのIssueをもう一度積むと、pollerの重複起動ガードに弾かれるまで（実測で最大75秒）
 * 待たされたうえで何も起きない。**押した時点で無駄だと分かるものは押させない。**
 *
 * 判定は3つ。
 *
 * - **`ALIVE`だけを見る。** `paneDead`のセッションは`EXITED`/`FAILED`になるが、そちらは
 *   前回の終了の痕跡で、`start-issue.sh`は畳んで作り直す。ここで止めると**二度と起動できなくなる**
 * - **所属ホストが応答している場合だけ止める。** pollerが落ちている間、行は`ALIVE`のまま
 *   古びる（`GONE`へ倒すのは「報告に含まれなかった」ときだけ）。判定材料が無いことと
 *   「動いている」ことは違う（`resolveScreenshotRejection`と同じ立場）
 * - **ホストは問わない。** ホストAで動いているIssueをホストBへ積むのは、各pollerが自分の
 *   tmuxしか見ないため向こう側では防げない
 *
 * `issue-execution-target.ts`の`newestSessionForIssue`とは別に持つ。あちらは「実行先を知る」
 * ためにALIVEを**優先**する（無ければ終了済みも返す）が、ここはALIVEに**限る**必要がある。
 */
export function findBlockingSession(params: {
  sessions: readonly DispatchSessionView[];
  hosts: readonly Pick<DispatchHostView, "name" | "online">[];
  repositoryFullName: string;
  issueNumber: number;
}): DispatchSessionView | null {
  return (
    params.sessions.find(
      (session) =>
        session.state === "ALIVE" &&
        session.repositoryFullName === params.repositoryFullName &&
        session.issueNumber === params.issueNumber &&
        (params.hosts.find((host) => host.name === session.host)?.online ?? false),
    ) ?? null
  );
}

/**
 * GitHub Actionsの実行が進行中か（#2032）。**`completed`以外はすべて進行中**（`queued`で
 * 順番待ちのものも含む。走り出す前に積めてしまえば結果は同じ）。
 *
 * **`null`／`undefined`は「進行中ではない」ではなく「分からない」。** 実行ログのリンクは
 * Actions側がIssueへコメントして初めて画面に現れるため、起動直後の数十秒はここが`null`に
 * なる。それでも`false`（＝止めない）を返すのは、**分からないことを理由に起動を塞ぐと
 * Actionsを一度も使っていないIssueまで積めなくなる**ため。塞ぎ切れない隙間は残るが、
 * 実際に問題になっているのは「Actionsが数分〜数十分走っている最中に押せる」方であり、
 * そちらはリンクが出た時点から消える。
 */
export function isActionsRunInProgress(
  /** そのIssueに紐づく実行（`useIssueWorkflowRun`の`run`／`/api/issues/workflow-run`の応答） */
  run: { status: string } | null | undefined,
): boolean {
  return run != null && run.status !== "completed";
}

/**
 * Actionsが走っている間、サブPCへ積めない理由の文言（#2032）。
 *
 * **`describeDispatchEnqueueRejection`とは別に持つ。** あちらの`DispatchEnqueueRejection`は
 * API側（`enqueueDispatchJob`）の判定と1対1で対応する取り決めで、API側はActionsの実行状況を
 * 持っていない（画面のポーリング結果が判定材料）。そこへ混ぜると「画面にしか無い拒否理由」が
 * 拒否一覧に並び、対応が崩れる。
 *
 * 積む導線が複数ある（「まとめて実行」・「セッションを復旧」）ので、文言だけはここで揃える。
 */
export const ACTIONS_RUNNING_ENQUEUE_REASON =
  "GitHub Actionsの実行が進行中です。同じブランチを2つの経路が進めることになるため、実行が終わるまでサブPCへは積めません。";

/**
 * そのIssueの実行が**もう始まっているか**（#1667）。開始の導線を出すかどうかの判定に使う。
 *
 * **未完了のジョブ（順番待ち・受け取り済み・起動中）か、生きているセッションか、進行中の
 * GitHub Actionsの実行があれば`true`。** どれも既存の判定
 * （`isActiveDispatchJobStatus`・`findBlockingSession`・`isActionsRunInProgress`）をそのまま読む。
 *
 * 積んだ直後のIssueは、進捗（Project Status）がまだ`Ready`のままで
 * （報告するのは起動したランチャー側・#1236）、`canStartImplementation`は`true`を返し続ける。
 * そのうえ**自分が積んだジョブでサブPCが塞がるため既定の実行先がGitHub Actionsへ移り**、
 * 「順番待ち」の真下に押せる「GitHub Actionsで開始」が並ぶ。押せば二重に走る。
 *
 * **Actionsの実行を見るのは逆向きの穴を塞ぐため**（#2032）。「GitHub Actions」→「サブPC」の
 * 順で開始すると、どこにも止めるものが無く両方が走る——ジョブもセッションもまだ無く、停止
 * フラグ（`11.local`）はActions側が判定を終えた後では効かない。同じ`issue-<番号>`ブランチを
 * 2つの経路が別々に進めることになる。
 *
 * **失敗・取り消し・起動済みで終わったジョブでは`false`に戻る**（未完了ではなくなる）。
 * Actionsの実行も`completed`になれば`false`へ戻るので、**落ちたセッション・失敗した実行を
 * 立て直す導線まで塞がない。**
 */
export function isIssueExecutionPending(params: {
  /** そのIssueへ積んだ起動ジョブ（`findDispatchJobForIssue`の結果） */
  job: Pick<DispatchJobView, "status"> | null;
  /** 動いているセッション（`findBlockingSession`の結果） */
  blockingSession: DispatchSessionView | null;
  /**
   * そのIssueで走っているGitHub Actionsの実行（`useIssueWorkflowRun`の`run`）。#2032。
   *
   * **省略できる。** 実行状況を持っていない画面（取得口を増やしたくない場所）からは渡さず、
   * ジョブとセッションだけで判定する。
   */
  actionsRun?: { status: string } | null;
}): boolean {
  if (params.job !== null && isActiveDispatchJobStatus(params.job.status)) return true;
  if (params.blockingSession !== null) return true;
  return isActionsRunInProgress(params.actionsRun);
}

/**
 * ジョブの状態の見せ方（#1180）。**`succeeded`は「tmuxセッションが立ち上がった」まで**で
 * 実装の完了ではないため、「完了」ではなく「起動しました」と書く。以降の進捗は
 * Project Statusが持つ唯一の正（progress-status-architecture.md）。
 */
export type DispatchJobTone = "pending" | "running" | "success" | "error" | "muted";

export function describeDispatchJobStatus(
  status: DispatchJobStatus,
  /** 制御ジョブ（#1332）・質問ジョブ（#1294）は「起動しました」では意味が通らないため、種別で文言を変える */
  kind: DispatchJobKind = "LAUNCH",
): {
  label: string;
  tone: DispatchJobTone;
} {
  if (kind === "QUESTION") return describeQuestionJobStatus(status);
  if (kind === "CROSS_REPO_QUESTION") return describeCrossRepoQuestionJobStatus(status);
  if (kind === "MANUAL_STEP") return describeManualStepJobStatus(status);
  if (kind === "PLAN_REVIEW") return describePlanReviewJobStatus(status);
  if (kind !== "LAUNCH") return describeSessionControlJobStatus(status, kind);
  switch (status) {
    case "QUEUED":
      return { label: "順番待ち", tone: "pending" };
    case "CLAIMED":
      return { label: "起動先が受け取りました", tone: "pending" };
    case "RUNNING":
      return { label: "起動中", tone: "running" };
    case "SUCCEEDED":
      return { label: "起動しました", tone: "success" };
    case "FAILED":
      return { label: "失敗", tone: "error" };
    // 起動を見送っただけで、何も壊れていない（#1229）。**赤くしない。**
    // 正常に働いた安全機構を「失敗」として見せると、ログと突き合わせるまで起動できなかったのか
    // どうか判断できない（#1224で実際に起きた）
    case "SKIPPED":
      return { label: "起動済みのため見送り", tone: "muted" };
    case "TIMEOUT":
      return { label: "応答なし", tone: "error" };
    case "CANCELED":
      return { label: "取り消し済み", tone: "muted" };
  }
}

/**
 * 制御ジョブ（#1332）の状態の見せ方。
 *
 * **押してから効くまでの間（`QUEUED`）を「送信しました」と出す。** pull型なので最大で
 * ポーリング間隔（既定30秒）は何も起きず、そこを黙っていると押せていないように見える。
 */
/**
 * 質問ジョブ（#1294）の状態の見せ方。
 *
 * **起動ジョブと寿命の意味が違う。** 起動ジョブの`succeeded`は「tmuxセッションが立った」までで、
 * そこから先はProject Statusが持つ。質問ジョブにはその続きが無く、
 * **`succeeded`は「回答コメントが投稿された」まで**を指す。だから「起動しました」ではなく
 * 「回答しました」と書く（実行はStep 3。文言の出し分けだけを先に入れている）。
 */
function describeQuestionJobStatus(status: DispatchJobStatus): {
  label: string;
  tone: DispatchJobTone;
} {
  switch (status) {
    case "QUEUED":
      return { label: "順番待ち", tone: "pending" };
    case "CLAIMED":
      return { label: "起動先が受け取りました", tone: "pending" };
    case "RUNNING":
      return { label: "回答中", tone: "running" };
    case "SUCCEEDED":
      return { label: "回答しました", tone: "success" };
    case "FAILED":
      return { label: "回答できませんでした", tone: "error" };
    case "SKIPPED":
      return { label: "回答を見送りました", tone: "muted" };
    case "TIMEOUT":
      return { label: "応答なし", tone: "error" };
    case "CANCELED":
      return { label: "取り消し済み", tone: "muted" };
  }
}

/**
 * 横断質問ジョブ（#1454）の状態の見せ方。
 *
 * **`succeeded`は「質問セッションが立った」まで**で、回答が投稿されたことではない（そこは
 * `QUESTION`（#1294）と違う）。回答はIssueのコメントとして返るため、そちらを見てもらう。
 */
function describeCrossRepoQuestionJobStatus(status: DispatchJobStatus): {
  label: string;
  tone: DispatchJobTone;
} {
  switch (status) {
    case "QUEUED":
      return { label: "順番待ち", tone: "pending" };
    case "CLAIMED":
      return { label: "起動先が受け取りました", tone: "pending" };
    case "RUNNING":
      return { label: "質問セッションを起動中", tone: "running" };
    case "SUCCEEDED":
      return { label: "質問セッションを起動しました", tone: "success" };
    case "FAILED":
      return { label: "失敗", tone: "error" };
    case "SKIPPED":
      return { label: "起動済みのため見送り", tone: "muted" };
    case "TIMEOUT":
      return { label: "応答なし", tone: "error" };
    case "CANCELED":
      return { label: "取り消し済み", tone: "muted" };
  }
}

/**
 * 計画レビュー（G1・#1855）の状態の見せ方。
 *
 * **`succeeded`は「レビューのセッションが立った」まで**で、指摘が投稿されたことではない
 * （`CROSS_REPO_QUESTION`と同じ立場）。指摘はIssueのコメントとして返るため、そちらを見てもらう。
 *
 * **`skipped`は「レビューしなかった」**（同じ計画のレビューが既に動いていた・対象の計画が
 * 見つからなかった）。何も壊れていないので赤くしない。
 */
function describePlanReviewJobStatus(status: DispatchJobStatus): {
  label: string;
  tone: DispatchJobTone;
} {
  switch (status) {
    case "QUEUED":
      return { label: "順番待ち", tone: "pending" };
    case "CLAIMED":
      return { label: "起動先が受け取りました", tone: "pending" };
    case "RUNNING":
      return { label: "計画レビューを起動中", tone: "running" };
    case "SUCCEEDED":
      return { label: "計画レビューを起動しました", tone: "success" };
    case "FAILED":
      return { label: "計画レビューを起動できませんでした", tone: "error" };
    case "SKIPPED":
      return { label: "起動済みのため見送り", tone: "muted" };
    case "TIMEOUT":
      return { label: "応答なし", tone: "error" };
    case "CANCELED":
      return { label: "取り消し済み", tone: "muted" };
  }
}

/**
 * 手作業の代行実行（#1828）の状態の見せ方。
 *
 * **`succeeded`は「コマンドが終了コード0で終わった」まで**。ここだけは他の種別と違い、
 * ジョブの成否がやりたかったこと（手順の実行）の成否と一致する——起動ジョブのように
 * 「その先はProject Statusが持つ」という続きが無い。
 *
 * **押してから届くまで（`QUEUED`）を黙らない。** pull型なので最大でポーリング間隔
 * （既定30秒）は何も起きず、そこを黙っていると押せていないように見える（#1332と同じ）。
 */
function describeManualStepJobStatus(status: DispatchJobStatus): {
  label: string;
  tone: DispatchJobTone;
} {
  switch (status) {
    case "QUEUED":
      return { label: "サブPCへ送信しました", tone: "pending" };
    case "CLAIMED":
      return { label: "サブPCが受け取りました", tone: "pending" };
    case "RUNNING":
      return { label: "実行中", tone: "running" };
    case "SUCCEEDED":
      return { label: "実行しました", tone: "success" };
    case "FAILED":
      return { label: "失敗しました", tone: "error" };
    // pollerが実行しなかった場合（本文と照合できなかった・`gh`が使えない）。**何も実行して
    // いない**ので、失敗と同じ赤にはしない。理由は`message`に入る
    case "SKIPPED":
      return { label: "実行を見送りました", tone: "muted" };
    case "TIMEOUT":
      return { label: "サブPCへ届きませんでした", tone: "error" };
    case "CANCELED":
      return { label: "取り消し済み", tone: "muted" };
  }
}

function describeSessionControlJobStatus(
  status: DispatchJobStatus,
  kind: DispatchJobKind,
): { label: string; tone: DispatchJobTone } {
  const label = isSessionControlJobKind(kind)
    ? SESSION_CONTROL_LABELS[kind]
    : SESSION_CONTROL_LABELS.INTERRUPT;
  switch (status) {
    case "QUEUED":
    case "CLAIMED":
    case "RUNNING":
      return { label: label.sending, tone: "pending" };
    case "SUCCEEDED":
      return { label: label.done, tone: "success" };
    case "FAILED":
      return { label: label.failed, tone: "error" };
    // 操作しようとしたセッションが既に無かった場合（poller側の`skipped`）。
    // **止めたかったものが止まっているので赤くしない**
    //
    // **追加指示（#1012）の`skipped`は意味が違う。** 3段階プロトコルの状態確認で
    // 「いま送ってはいけない」と判断した（承認プロンプト表示中・作業中・入力欄に打ちかけが
    // ある）ときで、セッションは動いている。理由はジョブの`message`に入るので、
    // ここでは「送らなかった」ことだけを言い、断定しない
    case "SKIPPED":
      return {
        label: kind === "INSTRUCTION" ? "送信を見送りました" : "セッションは既にありませんでした",
        tone: "muted",
      };
    case "TIMEOUT":
      return { label: "起動先へ届きませんでした", tone: "error" };
    case "CANCELED":
      return { label: "取り消し済み", tone: "muted" };
  }
}

/** 画面から取り消せる状態か（`running`は途中で止めると中途半端なworktreeが残るため不可） */
export function isCancelableDispatchJobStatus(status: DispatchJobStatus): boolean {
  return status === "QUEUED" || status === "CLAIMED";
}

/**
 * あるIssueについて画面に出すジョブを1件選ぶ（#1180）。
 *
 * 未完了のものを最優先し、無ければ直近に作られたものを返す。**終わったジョブも出す**のは、
 * 押した結果（起動した・失敗した）が消えると「押しても何も起きなかった」と区別が付かないため。
 * APIが返す範囲そのものが直近24時間に絞られている（`FINISHED_JOB_RETENTION_MS`）。
 */
export function findDispatchJobForIssue(
  jobs: readonly DispatchJobView[],
  repositoryFullName: string,
  issueNumber: number,
): DispatchJobView | null {
  // **起動ジョブに限る**（#1332）。呼び出し元は戻り値の未完了判定をそのまま
  // 「起動を塞ぐか」（`hasActiveJob`）に使うため、制御ジョブが混ざると停止を押した瞬間に
  // 起動が押せなくなる。制御ジョブは`findSessionControlJobForIssue`が返す
  return findJobForIssue(jobs, repositoryFullName, issueNumber, (job) => job.kind === "LAUNCH");
}

/**
 * あるIssueについて画面に出す制御ジョブ（#1332）を1件選ぶ。
 * 選び方は`findDispatchJobForIssue`と同じで、対象が制御ジョブ（`INTERRUPT`/`KILL`）になる。
 */
export function findSessionControlJobForIssue(
  jobs: readonly DispatchJobView[],
  repositoryFullName: string,
  issueNumber: number,
): DispatchJobView | null {
  return findJobForIssue(jobs, repositoryFullName, issueNumber, (job) =>
    isSessionControlJobKind(job.kind),
  );
}

/**
 * あるIssueについて画面に出す横断質問ジョブ（#1454）を1件選ぶ。
 *
 * **起動ジョブとは別に返す**（`findDispatchJobForIssue`が`LAUNCH`に限っているのと同じ理由）。
 * 呼び出し元は起動ジョブの未完了判定を「起動を塞ぐか」に使うため、混ぜると質問を積んだ瞬間に
 * 実装の起動が押せなくなる。
 */
export function findCrossRepoQuestionJobForIssue(
  jobs: readonly DispatchJobView[],
  repositoryFullName: string,
  issueNumber: number,
): DispatchJobView | null {
  return findJobForIssue(
    jobs,
    repositoryFullName,
    issueNumber,
    (job) => job.kind === "CROSS_REPO_QUESTION",
  );
}

/**
 * ある手順について画面に出す代行実行ジョブ（#1828）を1件選ぶ。
 *
 * **手順の行番号まで一致するものに限る。** 同じIssueの別の手順の結果を、いま開いている手順の
 * 結果として出すと、実行していないコマンドが成功したように見える。
 *
 * `manualStepLine`を持たない行（古いジョブ）はどの手順にも一致しない。
 */
export function findManualStepJobForStep(
  jobs: readonly DispatchJobView[],
  repositoryFullName: string,
  issueNumber: number,
  stepLine: number,
): DispatchJobView | null {
  return findJobForIssue(
    jobs,
    repositoryFullName,
    issueNumber,
    (job) => job.kind === "MANUAL_STEP" && job.manualStepLine === stepLine,
  );
}

/** そのIssueに未処理の代行実行があるか（`activeKey`はIssue単位なので、手順で分けない） */
export function findManualStepJobForIssue(
  jobs: readonly DispatchJobView[],
  repositoryFullName: string,
  issueNumber: number,
): DispatchJobView | null {
  return findJobForIssue(
    jobs,
    repositoryFullName,
    issueNumber,
    (job) => job.kind === "MANUAL_STEP",
  );
}

/**
 * ある代行実行を止めようとしている中断ジョブ（#1882）を1件選ぶ。
 *
 * **押した中断が届くまでにも最大1巡（既定30秒）かかる。** その間に画面へ何も出ないと、
 * 押せていないのか届いていないのかが分からず押し直すことになるため、未処理の中断ジョブを
 * 引けるようにしておく。
 */
export function findManualStepAbortJobForJob(
  jobs: readonly DispatchJobView[],
  targetJobId: string,
): DispatchJobView | null {
  return (
    jobs.find((job) => job.kind === "MANUAL_STEP_ABORT" && job.targetJobId === targetJobId) ?? null
  );
}

/**
 * 走っている代行実行を止められない理由（#1882）。**画面にそのまま出す前提**。
 *
 * `null`なら押せる。ここで返す理由は「押しても効かない」ことの説明であって、中断の操作
 * （自動実行を止めること）自体は常に行える——止められないのは**走っている1件**だけ。
 */
export type ManualStepAbortRejection = "host_unknown" | "host_offline" | "abort_unsupported";

export function describeManualStepAbortRejection(
  rejection: ManualStepAbortRejection,
  context: { hostName: string; timeoutMinutes: number },
): string {
  switch (rejection) {
    case "host_unknown":
      return `${context.hostName}が見つからないため、走っているコマンドは止められません（${context.timeoutMinutes}分で打ち切られます）。`;
    case "host_offline":
      return `${context.hostName}が応答していないため、走っているコマンドは止められません（${context.timeoutMinutes}分で打ち切られます）。`;
    case "abort_unsupported":
      // **「更新すれば止められる」ことまで書く。** 止められない理由がpollerの版であることが
      // 分かれば、次にやること（poller更新の手作業）へ繋がる
      return `${context.hostName}のpollerが中断に対応していないため、走っているコマンドは止められません（${context.timeoutMinutes}分で打ち切られます）。pollerを更新すると止められるようになります。`;
  }
}

export function resolveManualStepAbortRejection(
  host: Pick<DispatchHostView, "online" | "manualStepAbortCapable"> | null | undefined,
): ManualStepAbortRejection | null {
  if (!host) return "host_unknown";
  if (!host.online) return "host_offline";
  if (host.manualStepAbortCapable !== true) return "abort_unsupported";
  return null;
}

/**
 * あるIssueについて画面に出す計画レビュージョブ（#1855）を1件選ぶ。
 *
 * **起動ジョブとは別に返す**（`findCrossRepoQuestionJobForIssue`と同じ理由）。計画レビューは
 * 実装セッションが動いている最中に走るのが常態なので、混ぜると計画を出した瞬間に
 * そのIssueの実装の起動が押せなくなる。
 */
export function findPlanReviewJobForIssue(
  jobs: readonly DispatchJobView[],
  repositoryFullName: string,
  issueNumber: number,
): DispatchJobView | null {
  return findJobForIssue(
    jobs,
    repositoryFullName,
    issueNumber,
    (job) => job.kind === "PLAN_REVIEW",
  );
}

function findJobForIssue(
  jobs: readonly DispatchJobView[],
  repositoryFullName: string,
  issueNumber: number,
  matches: (job: DispatchJobView) => boolean,
): DispatchJobView | null {
  const mine = jobs.filter(
    (job) =>
      job.repositoryFullName === repositoryFullName &&
      job.issueNumber === issueNumber &&
      matches(job),
  );
  if (mine.length === 0) return null;

  const byNewest = [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return byNewest.find((job) => isActiveDispatchJobStatus(job.status)) ?? byNewest[0];
}

/**
 * 既定の実行先を決める（#1262）。**サブPCが既定で、GitHub Actionsはフォールバック。**
 *
 * 選べないホスト（応答していない・そのリポジトリを実行できない・未完了ジョブがある・
 * 既にセッションが動いている）は飛ばし、
 * 1つも無ければ`null`＝GitHub Actionsを返す。判定は`resolveDispatchTargetRejection`と同じものを
 * 使う。**ボタンの文言とダイアログの既定選択が別々に決まると、押す前に見えていた実行先と
 * 実際に起動する先がずれる。**
 */
export function resolveDefaultDispatchHost(params: {
  hosts: readonly DispatchHostView[];
  repositoryFullName: string;
  hasActiveJob: boolean;
  blockingSession: Pick<DispatchSessionView, "host" | "tmuxSessionName"> | null;
}): string | null {
  const { hosts, repositoryFullName, hasActiveJob, blockingSession } = params;
  return (
    hosts.find(
      (host) =>
        resolveDispatchTargetRejection({
          host,
          repositoryFullName,
          hasActiveJob,
          blockingSession,
        }) === null,
    )?.name ?? null
  );
}

/**
 * 手作業の代行実行（#1828）を行うホストを決める。
 *
 * **実行できるリポジトリ（`repositories`）は見ない。** 代行するのはホスト上のコマンドで、
 * worktreeを作るわけではないため、対象の手作業Issueがどのリポジトリのものかは関係がない
 * （実際、`~/apps/issue-deck`を更新する手作業は他リポジトリのIssueとしても起票されうる）。
 *
 * 対応しているホストが無ければ**先頭のホストを返す**。押せない理由（未対応・応答なし）を
 * 出すのに相手の名前が要るためで、`null`になるのは申告が1件も無いときだけ。
 */
export function resolveManualStepHost(
  hosts: readonly DispatchHostView[],
): DispatchHostView | null {
  return hosts.find((host) => host.online && host.manualStepCapable === true) ?? hosts[0] ?? null;
}

/**
 * そのホストで`24.screenshot-required`を選べるか（#1268）。
 *
 * 選べない理由を返す。選べるなら`null`。**申告していないホスト（古いpoller）は塞がない** —
 * 判定材料が無いことと「撮れない」ことは違う。
 *
 * 無人実行では依存の追加をその場で確認する相手がいないため（CLAUDE.md）、撮れないホストで
 * このラベルを付けると**実行できないまま止まる**。押す前に理由を出す。
 */
export function resolveScreenshotRejection(host: DispatchHostView | null): string | null {
  if (!host) return null;
  if (host.screenshotCapable === false) {
    return `${formatDispatchHostName(host.name)}にPlaywrightのブラウザが入っていないため、スクリーンショットを取得できません。`;
  }
  return null;
}

/**
 * 取りに来られないまま失効した制御ジョブ（#1332）に残す理由。
 *
 * **時間が経った操作は届けない方が安全。** 何時間も後に`C-c`が着弾すると、そのとき
 * セッションでは別の作業が走っている。
 */
export function describeDispatchControlTimeout(): string {
  return "起動先が取りに来なかったため取り消しました（pollerが動いているか確認してください）。";
}

/** 起動が届かなかったジョブに残す理由（timeoutの内訳） */
export function describeDispatchTimeout(status: "CLAIMED" | "RUNNING"): string {
  return status === "CLAIMED"
    ? "起動先がジョブを取得したまま開始しませんでした（ホストが停止した可能性があります）。"
    : "起動処理からの応答が途絶えました。tmuxセッションが残っていないか確認してください。";
}

/**
 * 完了の報告だけが届かなかった起動ジョブに残す理由（#1620）。
 *
 * pollerは報告に失敗しても再送しない（`report_job`は数回試して諦める）ため、tmuxセッションは
 * 立っているのに`RUNNING`のまま残るジョブができる。それをそのままタイムアウトさせると、
 * **同じIssueが実行キューの「実行中」（セッション一覧）と「直近の失敗」に同時に出る。**
 */
export function describeDispatchReportLost(tmuxSessionName: string): string {
  return `起動先からの完了報告が届きませんでしたが、tmuxセッション ${tmuxSessionName} が動いているため起動できたものとして扱います。`;
}
