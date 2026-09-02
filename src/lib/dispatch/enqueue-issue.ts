import {
  ACTIONS_RUNNING_ENQUEUE_REASON,
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
  /**
   * GitHub Actionsの実行が進行中のIssueのid（#2032）。**含まれていたら積まない。**
   *
   * ジョブ・セッションはサブPC側の記録なので、Actionsで走っているIssueはどちらにも現れない。
   * 呼び出し元が既に持っている実行状況（`use-issues-workflow-running.ts`）をそのまま渡す。
   * **渡さなければ従来どおり**——実行状況を持っていない呼び出し元は判定材料を増やさない。
   */
  actionsRunningIssueIds?: ReadonlySet<string>;
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
 * 「次にやること」の自動開始（`issue-order-dialog.tsx`）が使う。手順は
 * 起動先を決める → 積めるか見る → 積む → 積めたときだけ`11.local`を付ける、の順。
 *
 * **積めなかったときは`11.local`を付けない。** 付けると、実行が始まっていないのに
 * 無人実行（`claude-issue-dispatch.yml`）までそのIssueに触れなくなる。
 *
 * `labelsToAdd`は積む前に付けたいオプションのラベル。**積むより先に付ける。**
 * `21.plan-required`等はサブPCのランチャーが起動直後に読む（`scripts/start-issue.sh`）ため、
 * 積んだ後に付けると、払い出しがその隙間に入ったときに読まれない。「実装を開始」ダイアログも
 * 同じ理由で先に付けている（`applyOptionLabels`）。**書き込みが`11.local`と2回に分かれるが、
 * 1回にまとめると「積めたときだけ付ける」`11.local`の決まりを破ることになる。**
 * **既に付いているラベルは外さない**（足すだけ）。積めなかったときにオプションのラベルだけが
 * 残ることはあるが、押す前の判定（`resolveDispatchTargetRejection`）を通ってから書くので、
 * 残るのはAPI側で弾かれた場合に限られる。
 *
 * セッションの生存（`findBlockingSession`）を先に見るのは、押す前に理由を出すため。
 * 最終的な判定はAPI側（`enqueueDispatchJob`）が行う。
 */
export async function enqueueIssueToDefaultHost(
  issue: Issue,
  deps: EnqueueIssueDeps,
  labelsToAdd: readonly string[] = [],
): Promise<EnqueueIssueOutcome> {
  // GitHub Actionsで走っている最中のIssueは積まない（#2032）。**ラベルを付ける前に返す**
  // ——`11.local`もオプションのラベルも、積めないのに書き込むと無人実行まで止めてしまう。
  // 理由が`DispatchEnqueueRejection`ではなく専用の文言なのは、あちらがAPI側
  // （`enqueueDispatchJob`）の判定と1対1で対応する取り決めのため（`dispatch-job.ts`の注記）
  if (deps.actionsRunningIssueIds?.has(issue.id)) {
    return { ok: false, reason: ACTIONS_RUNNING_ENQUEUE_REASON };
  }

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

  // オプションのラベルは**積む前**に付ける（上の注記）。ラベル付けに失敗しても積み込みは行う
  // （オプションが効かないより、起動しない方が重い）
  const currentNames = issue.labels.map((label) => label.name);
  const namesWithOptions = [...new Set([...currentNames, ...labelsToAdd])];
  if (namesWithOptions.length !== currentNames.length) {
    await deps.updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      labels: namesWithOptions,
    });
  }

  const enqueued = await deps.enqueue({
    repositoryFullName: issue.repositoryFullName,
    issueNumber: issue.number,
    hostName,
  });
  if (!enqueued) {
    return { ok: false, reason: deps.enqueueError ?? "積めませんでした" };
  }

  // 上の書き込みが失敗していても、ここで両方まとめて送り直す形になるので取りこぼさない
  const nextNames = labelNamesWithLocal(namesWithOptions.map((name) => ({ name })));
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
