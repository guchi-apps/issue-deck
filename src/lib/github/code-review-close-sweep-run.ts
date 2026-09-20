import { db } from "@/lib/db";
import { CODE_REVIEW_TITLE_PREFIX, summarizeCodeReviewComments } from "@/lib/github/code-review";
import {
  buildCodeReviewAutoClosedComment,
  decideCompletedCodeReview,
  verifyCompletedCodeReview,
  type CodeReviewCloseSkipReason,
} from "@/lib/github/code-review-close-sweep";
import {
  codeReviewSummaryCacheKey,
  getCodeReviewSummaryCache,
  setCodeReviewSummaryCache,
} from "@/lib/github/code-review-report-cache";
import {
  createComment,
  fetchCommentsForIssue,
  hasReopenedEvent,
  updateIssue,
} from "@/lib/github/issues-api";

/**
 * 全指摘が対応済みになったコードレビューIssueを自動でcloseする（#3216）。
 * 判定の考え方は[`code-review-close-sweep.ts`](./code-review-close-sweep.ts)を参照。
 *
 * `runProgressSweep`の末尾から呼ぶ（滞留した`00.check-user`の回収・手作業ラベルの埋め直しと同じ
 * 相乗り）。専用のエンドポイントもpollerの呼び出しも足さない。
 *
 * **探し先はissue-deckのDB。** 開いている`[レビュー] `Issueと、指摘の見出しに一致するIssueの
 * stateはDB（webhookと再同期で追随している）から引く。GitHubへ問い合わせるのは、結果の要約が
 * キャッシュに無いときのコメント取得と、**closeすると決めた後の確認だけ**。要約は画面の一覧と同じ
 * プロセス内キャッシュ（`code-review-report-cache.ts`）を共用する。
 */

/**
 * 開け直しが確認できたレビューIssue（`<owner>/<repo>#<番号>`）。プロセスが生きている間だけ覚える。
 *
 * 人が開け直したものは、全指摘が対応済みのままでも閉じ直さない。覚えておかないと、開け直した
 * Issueごとに毎巡回（約5分）コメント取得とイベント取得が走り続ける。再起動で忘れても、
 * 確認が1回余分に走るだけ。
 */
const knownReopened = new Set<string>();

/** テスト用。プロセスをまたがないので本番では呼ばない */
export function resetCodeReviewCloseSweepMemoForTest(): void {
  knownReopened.clear();
}

export type CodeReviewClosedIssue = { repositoryFullName: string; issueNumber: number };

export async function sweepCompletedCodeReviews(params: {
  tokenFor: (installationId: number, cacheKey: string) => Promise<string>;
  countSkip: (reason: CodeReviewCloseSkipReason | "fetch_failed" | "action_failed") => void;
}): Promise<CodeReviewClosedIssue[]> {
  const targets = await db.issue.findMany({
    where: {
      state: "OPEN",
      title: { startsWith: CODE_REVIEW_TITLE_PREFIX },
      repository: { archived: false },
    },
    select: {
      number: true,
      commentCount: true,
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

  const closed: CodeReviewClosedIssue[] = [];
  for (const target of targets) {
    const { ownerLogin, name, fullName, installation } = target.repository;
    const issueKey = `${fullName}#${target.number}`;
    if (knownReopened.has(issueKey)) continue;

    try {
      const token = await params.tokenFor(installation.installationId, installation.id);

      const cacheKey = codeReviewSummaryCacheKey(ownerLogin, name, target.number);
      let summary = getCodeReviewSummaryCache(cacheKey, target.commentCount);
      if (!summary) {
        const comments = await fetchCommentsForIssue(ownerLogin, name, target.number, token);
        summary = summarizeCodeReviewComments(
          comments.map((comment) => ({ body: comment.body ?? "" })),
        );
        setCodeReviewSummaryCache(cacheKey, { summary, commentCount: target.commentCount });
      }
      // 結果が無い・指摘が無いレビューは平常時に毎巡回ここへ来る。DBもGitHubも引かずに抜ける。
      if (summary.state !== "reported" || summary.findingTitles.length === 0) continue;

      const findingRows = await db.issue.findMany({
        where: {
          repositoryId: target.repositoryId,
          title: { in: [...new Set(summary.findingTitles)] },
        },
        select: { number: true, title: true, state: true },
      });
      const decision = decideCompletedCodeReview({
        summary,
        issues: findingRows.map((row) => ({
          repositoryFullName: fullName,
          title: row.title,
          number: row.number,
          state: row.state === "CLOSED" ? "closed" : "open",
        })),
        repositoryFullName: fullName,
      });
      if (decision.action === "skip") continue;

      // ここからは「閉じる」と決めたものだけ。キャッシュした要約は最大5分遅れうるので、
      // 再レビューの依頼が後ろに来ていないか・結果が入れ替わっていないかを取り直して確かめる。
      const fresh = await fetchCommentsForIssue(ownerLogin, name, target.number, token);
      const verdict = verifyCompletedCodeReview({
        comments: fresh.map((comment) => ({ body: comment.body ?? "" })),
        findingTitles: summary.findingTitles,
      });
      if (verdict !== "ok") {
        params.countSkip(verdict);
        continue;
      }

      const reopened = await hasReopenedEvent(ownerLogin, name, target.number, token);
      // 確かめられなかったものは閉じない（次の巡回で引き直す）
      if (reopened === null) {
        params.countSkip("review_reopen_unknown");
        continue;
      }
      if (reopened) {
        knownReopened.add(issueKey);
        params.countSkip("review_reopened");
        continue;
      }

      try {
        await updateIssue(ownerLogin, name, target.number, token, {
          state: "closed",
          state_reason: "completed",
        });
      } catch (error) {
        console.error(`[progress-sweep] ${issueKey}のレビューIssueのclose:`, error);
        params.countSkip("action_failed");
        continue;
      }

      // 閉じた後のコメントに失敗しても、閉じた事実は取り消せない。成果としては数える
      try {
        await createComment(ownerLogin, name, target.number, token, {
          body: buildCodeReviewAutoClosedComment(decision.total),
        });
      } catch (error) {
        console.error(`[progress-sweep] ${issueKey}のレビューIssueへのコメント:`, error);
      }
      closed.push({ repositoryFullName: fullName, issueNumber: target.number });
    } catch (error) {
      // 1件の失敗で残りを止めない（次の巡回で拾い直せる）
      console.error(`[progress-sweep] ${issueKey}のレビューIssueの判定:`, error);
      params.countSkip("fetch_failed");
    }
  }

  return closed;
}
