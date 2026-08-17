import {
  describeDispatchEnqueueRejection,
  findBlockingSession,
  resolveDefaultDispatchHost,
  resolveDispatchTargetRejection,
  type DispatchHostView,
} from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { labelNamesWithLocal } from "@/lib/github/project-status-dispatch";
import type { Issue } from "@/types/issue";

/**
 * 1件のIssueをサブPCへ積むのに必要な依存。
 *
 * フックの型（`DispatchStateHandle`）ではなく構造で受け取る。`lib/`から`hooks/`へ依存させず、
 * テストからも素の値で呼べるようにするため。
 */
export type EnqueueIssueDeps = {
  hosts: readonly DispatchHostView[];
  sessions: readonly DispatchSessionView[];
  enqueue: (input: {
    repositoryFullName: string;
    issueNumber: number;
    hostName: string;
  }) => Promise<boolean>;
  /** `enqueue`が`false`を返したときの理由（`dispatch.error`） */
  enqueueError: string | null;
  updateIssue: (input: {
    repositoryFullName: string;
    number: number;
    labels: string[];
  }) => Promise<Issue | null>;
};

export type EnqueueIssueOutcome =
  | { ok: true; hostName: string }
  | { ok: false; reason: string };

/**
 * Issue1件を、積める起動先（サブPC）へ積む（#1266・#1853）。
 *
 * **「まとめて積む」（`bulk-dispatch-bar.tsx`）と「次にやること」の自動開始
 * （`issue-order-dialog.tsx`）で共有する。** どちらも手順は同じ
 * （起動先を決める → 積めるか見る → 積む → 積めたときだけ`11.local`を付ける）で、
 * 2か所に書くと`11.local`を付ける条件のような細部が片方だけずれる。
 *
 * **積めなかったときは`11.local`を付けない。** 付けると、実行が始まっていないのに
 * 無人実行（`claude-issue-dispatch.yml`）までそのIssueに触れなくなる。
 *
 * セッションの生存（`findBlockingSession`）を先に見るのは、押す前に理由を出すため。
 * 最終的な判定はAPI側（`enqueueDispatchJob`）が行う。
 */
export async function enqueueIssueToDefaultHost(
  issue: Issue,
  deps: EnqueueIssueDeps,
): Promise<EnqueueIssueOutcome> {
  const blockingSession = findBlockingSession({
    sessions: deps.sessions,
    hosts: deps.hosts,
    repositoryFullName: issue.repositoryFullName,
    issueNumber: issue.number,
  });

  const hostName = resolveDefaultDispatchHost({
    hosts: deps.hosts,
    repositoryFullName: issue.repositoryFullName,
    // 未完了ジョブの有無はAPI側が最終判定する（`activeKey`のunique制約）
    hasActiveJob: false,
    blockingSession,
  });

  // 積める起動先が無いときは**先頭のホストで理由を組み立てる**。「起動先がありません」だけでは、
  // pollerが動いていないのか、そのリポジトリがcloneされていないのかを押した側から区別できない
  const host =
    (hostName ? deps.hosts.find((candidate) => candidate.name === hostName) : deps.hosts[0]) ??
    null;
  const rejection = resolveDispatchTargetRejection({
    host,
    repositoryFullName: issue.repositoryFullName,
    hasActiveJob: false,
    blockingSession,
  });

  if (!hostName || rejection) {
    return {
      ok: false,
      reason:
        rejection && host
          ? describeDispatchEnqueueRejection(rejection, {
              hostName: host.name,
              repositoryFullName: issue.repositoryFullName,
              session: blockingSession,
            })
          : "積める起動先がありません",
    };
  }

  const enqueued = await deps.enqueue({
    repositoryFullName: issue.repositoryFullName,
    issueNumber: issue.number,
    hostName,
  });
  if (!enqueued) {
    return { ok: false, reason: deps.enqueueError ?? "積めませんでした" };
  }

  const nextNames = labelNamesWithLocal(issue.labels);
  if (nextNames) {
    // ラベル付けに失敗しても積み込み自体は成功として扱う（起動できないより軽い）
    await deps.updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      labels: nextNames,
    });
  }

  return { ok: true, hostName };
}
