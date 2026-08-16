import { isIssueExecutionPending, type DispatchJobView } from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { isLocalSessionIssue } from "@/lib/github/project-status-dispatch";

/**
 * あるIssueの実装が**どこで走っているか**の解決（#1262）。
 *
 * 実行先が画面のどこにも出ていなかったため、次の2つが起きていた。
 *
 * 1. サブPC実行のIssueが、実装中ずっと「起動待ち」と表示される。判定
 *    （`workflow-status-steps.tsx`の`awaitingDispatch`）が「Statusは進んでいるのにGitHub Actionsの
 *    実行が紐づいていない」を異常とみなすが、**サブPC実行ではActionsの実行が最初から存在しない**
 * 2. そのIssueをActions実行だと思って20秒ごとにGitHub APIへ問い合わせ続ける
 *    （`use-issues-workflow-running.ts`）
 *
 * どちらも「Actionsの実行を期待してよいか」が分かれば消える。**新しいテーブルは増やさない。**
 * 判断材料は既にあるものだけで足りる。
 *
 * | 材料 | 分かること | 寿命 |
 * |---|---|---|
 * | `DispatchSession`（#1217） | どのホストで走っているか | 24時間（`GONE`も含む） |
 * | `DispatchJob`（#1179） | どのホストへ積んだか | 24時間（終了済みぶん） |
 * | `11.local`ラベル | **Actionsが動かないこと**（無人実行の停止フラグ） | セッションが外すまで |
 *
 * **`11.local`を併用するのが要点。** ジョブ・セッションの記録は24時間で落ちるため、それだけに
 * 頼ると「3日前にサブPCで着手してまだ実装中」のIssueで誤表示が戻ってくる。`11.local`は
 * `claude-issue-dispatch.yml`がそのIssueに対して何もしないことを意味するので、**付いている限り
 * Actionsの実行は存在しない**と言い切れる。
 *
 * Prismaに触れないため、クライアントコンポーネントからimportできる（`dispatch-job.ts`と同じ扱い。
 * `jobs.ts`・`sessions.ts`はできない）。
 */
export type IssueExecutionTarget = {
  /**
   * 走っている（走らせた）サブPCのホスト名。**`null`は「ホスト名までは分からない」**であって、
   * 「Actionsで走っている」ではない（`11.local`だけが付いている場合など）。
   */
  host: string | null;
  /**
   * GitHub Actionsの実行が紐づくことを期待してよいか。
   *
   * **`false`のとき、実行が無いことを異常として扱ってはいけない。** 「起動待ち」の表示も、
   * 実行状況のポーリングも、ここが`true`のときだけ意味を持つ。
   */
  expectsActionsRun: boolean;
};

/** 画面に出す実行先の短い名前。ホスト名が分かればそれを、分からなければ経路の種別を返す */
export function describeIssueExecutionTarget(target: IssueExecutionTarget): string {
  if (target.host) return formatDispatchHostName(target.host);
  return target.expectsActionsRun ? "Actions" : "ローカル";
}

function newestSessionForIssue(
  sessions: readonly DispatchSessionView[],
  repositoryFullName: string,
  issueNumber: number,
): DispatchSessionView | null {
  const mine = sessions.filter(
    (session) =>
      session.repositoryFullName === repositoryFullName && session.issueNumber === issueNumber,
  );
  if (mine.length === 0) return null;
  // 生きているものを優先する。終わったセッションの残骸より、今動いている方が実行先として正しい
  const alive = mine.find((session) => session.state === "ALIVE");
  if (alive) return alive;
  return [...mine].sort((a, b) => b.lastReportedAt.localeCompare(a.lastReportedAt))[0];
}

function newestJobForIssue(
  jobs: readonly DispatchJobView[],
  repositoryFullName: string,
  issueNumber: number,
): DispatchJobView | null {
  const mine = jobs.filter(
    (job) => job.repositoryFullName === repositoryFullName && job.issueNumber === issueNumber,
  );
  if (mine.length === 0) return null;
  return [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * Issueの実行先を解決する。
 *
 * ホスト名の出所はセッション優先・ジョブが次点。**セッションを優先するのは、ジョブの寿命が
 * 「tmuxセッションが立った」ところで終わっているため**（`docs/multi-agent/gates.md`）。
 * 起動後に実際どこで動いているかを知っているのはセッション側。
 */
export function resolveIssueExecutionTarget(params: {
  repositoryFullName: string;
  issueNumber: number;
  labels: readonly { name: string }[];
  jobs?: readonly DispatchJobView[];
  sessions?: readonly DispatchSessionView[];
}): IssueExecutionTarget {
  const { repositoryFullName, issueNumber, labels, jobs = [], sessions = [] } = params;

  const session = newestSessionForIssue(sessions, repositoryFullName, issueNumber);
  const job = session ? null : newestJobForIssue(jobs, repositoryFullName, issueNumber);
  const host = session?.host ?? job?.targetHost ?? null;
  const isLocal = isLocalSessionIssue(labels);

  return { host, expectsActionsRun: host === null && !isLocal };
}

/**
 * そのIssueの実行が**もう始められているか**（#1815）。**開始の主導線（塗りつぶしのボタン）を
 * 出すかどうかだけ**の判定で、`isIssueExecutionPending`より広い。
 *
 * 実体（未完了のジョブ・生きているセッション）に加えて`11.local`ラベルを見る。ジョブ・
 * セッションはpull型で画面へ届くまでに間があり、**押した直後は実体がまだ何も見えていない**。
 * 実際、Issueを作成して続けて起動した直後の詳細画面では、ジョブを積んだのが別のダイアログ
 * （自前の取得口を持つ）だったために20秒間まったく反映されず、押す前と同じ「サブPCで開始」が
 * 全幅で残っていた。**`11.local`は積むより先に付けている**ので、実体が見えない間もこの
 * ラベルだけは届いている。
 *
 * **起動そのものを塞ぐ判定には使わない。** ラベルはセッションが外すまで残り、落ちたセッションを
 * 立て直したい場面でも付いたままになる。立て直しの導線（枠線の「サブPCで開始」・
 * `StartLocalSessionButton`）は`isIssueExecutionPending`の方で判断し、こちらでは消さない。
 *
 * `dispatch-job.ts`ではなくここに置くのは、**`11.local`の判定（`project-status-dispatch.ts`）が
 * 進捗の定義（`issue-progress.ts`＝lucide-reactのアイコンを持つ）まで連れてくる**ため。
 * `dispatch-job.ts`はAPIルート・ジョブの払い出しからも読む純粋関数の置き場で、そこへ画面用の
 * 依存を持ち込まない。
 */
export function isIssueExecutionStarted(params: {
  /** そのIssueへ積んだ起動ジョブ（`findDispatchJobForIssue`の結果） */
  job: Pick<DispatchJobView, "status"> | null;
  /** 動いているセッション（`findBlockingSession`の結果） */
  blockingSession: DispatchSessionView | null;
  /** Issueに付いているラベル */
  labels: readonly { name: string }[];
}): boolean {
  if (isIssueExecutionPending(params)) return true;
  return isLocalSessionIssue(params.labels);
}
