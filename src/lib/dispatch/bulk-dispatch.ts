import {
  findBlockingSession,
  findDispatchJobForIssue,
  isActiveDispatchJobStatus,
  resolveDefaultDispatchHost,
  type DispatchHostView,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import type { Issue } from "@/types/issue";

/**
 * 「まとめて実行」の判定に使う、いま画面が持っているディスパッチの状態（#1993）。
 *
 * **`isLoaded`は受け取らない。** 取得前の`hosts`は`[]`で、この判定は必ず0件＝入口のバーが
 * 出ない状態になるため、待つのと結果が変わらない。`isLoaded`を見ているのは**押した瞬間に
 * 積みに行く**経路（「次にやること」の自動開始・#1666・#1810）で、あちらは待たないと必ず
 * 失敗する。こちらは人が押すまで何も起こさない。
 */
export type BulkDispatchContext = {
  hosts: readonly DispatchHostView[];
  jobs: readonly DispatchJobView[];
  sessions: readonly DispatchSessionView[];
};

/**
 * そのIssueをいま積める起動先（#1993）。積めなければ`null`。
 *
 * **判定材料は「実装を開始」ダイアログと同じ**（`findDispatchJobForIssue`の未完了判定と
 * `findBlockingSession`）。ここで独自の条件を書き足すと、1件ずつ積む導線と食い違う。
 * 最終的な判定はAPI側（`enqueueDispatchJob`）が行うため、ここは押す前に出す目安に留まる。
 */
export function resolveBulkDispatchHost(issue: Issue, context: BulkDispatchContext): string | null {
  if (issue.state !== "open") return null;
  const job = findDispatchJobForIssue(context.jobs, issue.repositoryFullName, issue.number);
  return resolveDefaultDispatchHost({
    hosts: context.hosts,
    repositoryFullName: issue.repositoryFullName,
    hasActiveJob: job !== null && isActiveDispatchJobStatus(job.status),
    blockingSession: findBlockingSession({
      sessions: context.sessions,
      hosts: context.hosts,
      repositoryFullName: issue.repositoryFullName,
      issueNumber: issue.number,
    }),
  });
}

/**
 * いまこの一覧から「まとめて実行」できるIssue（#1993）。
 *
 * 一覧の上に入口のバーを出すかどうか（2件以上あるか）と、選択中のIssueで積み込みを押せるか
 * （1件でもあるか）の両方がこれを見る。**closeしたIssue・既に走っている（積んである）Issueは
 * 数えない** — 数えると、押しても何も起きない件数が入口に出る。
 */
export function bulkDispatchableIssues(
  issues: readonly Issue[],
  context: BulkDispatchContext,
): Issue[] {
  if (context.hosts.length === 0) return [];
  return issues.filter((issue) => resolveBulkDispatchHost(issue, context) !== null);
}
