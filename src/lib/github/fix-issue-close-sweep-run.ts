import { db } from "@/lib/db";
import {
  buildFixIssueAutoClosedComment,
  decideFixIssueClose,
  type FixIssueCloseSkipReason,
} from "@/lib/github/fix-issue-close-sweep";
import { createComment, hasReopenedEvent, updateIssue } from "@/lib/github/issues-api";
import {
  extractTargetPullRequestNumber,
  TARGET_PULL_REQUEST_MARKER_PREFIX,
} from "@/lib/github/pull-request-fix-issue";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";

/**
 * 「修正Issueを起案」が作った修正Issueのうち、対象PRがマージされたものを自動closeする（#3353）。
 * 判定の考え方は[`fix-issue-close-sweep.ts`](./fix-issue-close-sweep.ts)を参照。
 *
 * `runProgressSweep`の末尾から呼ぶ（コードレビューIssueの自動close・#3216と同じ相乗り）。
 *
 * **探し先はissue-deckのDB。** `対象PR: #NN`マーカーを含むopenなIssueをDBの本文検索で絞り、
 * 対象PRの状態だけをGitHubへ問い合わせる。
 */

/**
 * 開け直しが確認できた修正Issue（`<owner>/<repo>#<番号>`）。プロセスが生きている間だけ覚える
 * （`code-review-close-sweep-run.ts`の`knownReopened`と同じ理由）。
 */
const knownReopened = new Set<string>();

/** テスト用。プロセスをまたがないので本番では呼ばない */
export function resetFixIssueCloseSweepMemoForTest(): void {
  knownReopened.clear();
}

export type FixIssueClosedIssue = { repositoryFullName: string; issueNumber: number };

export async function sweepClosableFixIssues(params: {
  tokenFor: (installationId: number, cacheKey: string) => Promise<string>;
  countSkip: (reason: FixIssueCloseSkipReason | "fetch_failed" | "action_failed") => void;
}): Promise<FixIssueClosedIssue[]> {
  const targets = await db.issue.findMany({
    where: {
      state: "OPEN",
      body: { contains: TARGET_PULL_REQUEST_MARKER_PREFIX },
      repository: { archived: false },
    },
    select: {
      number: true,
      body: true,
      repositoryId: true,
      repository: {
        select: {
          ownerLogin: true,
          name: true,
          fullName: true,
          installation: { select: { id: true, installationId: true } },
        },
      },
    },
    orderBy: { number: "asc" },
  });
  if (targets.length === 0) return [];

  const closed: FixIssueClosedIssue[] = [];
  for (const target of targets) {
    const { ownerLogin, name, fullName, installation } = target.repository;
    const issueKey = `${fullName}#${target.number}`;
    if (knownReopened.has(issueKey)) continue;

    // DBの`contains`検索はprefixの一致だけを見るため、番号を取り出せないものは
    // 対象外として黙って抜ける（マーカーが変な形で埋まっているケースは想定していない）
    const pullRequestNumber = extractTargetPullRequestNumber(target.body);
    if (pullRequestNumber === null) continue;

    try {
      const token = await params.tokenFor(installation.installationId, installation.id);
      const pullRequest = await fetchPullRequest(ownerLogin, name, pullRequestNumber, token);

      const decision = decideFixIssueClose({
        pullRequest: {
          merged: pullRequest.merged,
          state: pullRequest.state === "open" ? "open" : "closed",
        },
      });
      // 大多数はここで抜ける（対象PRがまだopen）。閉じると決めたものだけ先へ進む。
      if (decision.action === "skip") continue;

      const reopened = await hasReopenedEvent(ownerLogin, name, target.number, token);
      // 確かめられなかったものは閉じない（次の巡回で引き直す）
      if (reopened === null) {
        params.countSkip("fix_issue_reopen_unknown");
        continue;
      }
      if (reopened) {
        knownReopened.add(issueKey);
        params.countSkip("fix_issue_reopened");
        continue;
      }

      try {
        await updateIssue(ownerLogin, name, target.number, token, {
          state: "closed",
          state_reason: "completed",
        });
      } catch (error) {
        console.error(`[progress-sweep] ${issueKey}の修正Issueのclose:`, error);
        params.countSkip("action_failed");
        continue;
      }

      // 閉じた後のコメントに失敗しても、閉じた事実は取り消せない。成果としては数える
      try {
        await createComment(ownerLogin, name, target.number, token, {
          body: buildFixIssueAutoClosedComment(pullRequestNumber),
        });
      } catch (error) {
        console.error(`[progress-sweep] ${issueKey}の修正Issueへのコメント:`, error);
      }
      closed.push({ repositoryFullName: fullName, issueNumber: target.number });
    } catch (error) {
      // 1件の失敗で残りを止めない（次の巡回で拾い直せる）
      console.error(`[progress-sweep] ${issueKey}の修正Issueの判定:`, error);
      params.countSkip("fetch_failed");
    }
  }

  return closed;
}
