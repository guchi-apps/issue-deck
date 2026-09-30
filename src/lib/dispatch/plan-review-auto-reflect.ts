import { db } from "@/lib/db";
import { decideSessionPlanRequest } from "@/lib/dispatch/plan-requests";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { resolveSessionPlanCheckUser } from "@/lib/dispatch/session-plan";
import { PLAN_REVIEW_REFLECT_REQUEST_TEXT } from "@/lib/dispatch/session-plan-request";
import { createComment } from "@/lib/github/issues-api";
import { parsePlanReview } from "@/lib/github/plan-review";
import { parseRepositoryFullName } from "@/lib/local-session";

/**
 * 計画レビュー（G1）を、届いた時点で自動で計画へ反映させる（#3616）。
 *
 * **これまでは、人が指摘を読んで「レビューを反映して計画を出し直す」を押していた**（#3521・#3554）。
 * 計画を出すと直ちに確認待ちのPush通知が鳴るため、レビューが届く前に人が呼ばれ、届いたあとも
 * 人が押すまで計画が動かなかった。
 *
 * ここでは`supervisor:plan-review`コメントの到着（GitHubのWebhook）を契機に、画面の一括ボタンと
 * **同じ固定文面**（`PLAN_REVIEW_REFLECT_REQUEST_TEXT`）を「修正」として書き込む。承認ではない
 * （G1が承認しない原則は保つ。承認は人が押す）。フックが待っている`SessionPlanRequest`へ書くだけで、
 * 端末へキーを送る経路は無い。
 *
 * 守っていることは4つ。
 *
 * - **Claude Codeのセッションだけ。** Codexへの継続指示は`codex queue`で送るため、人の操作を挟まない
 *   自動送信を新しく作らない
 * - **1つのIssueにつき1回まで。** 反映後の計画へのレビューは、通常どおり人が読んで決める。
 *   **人が画面から送った修正も1回に数える**（#3660。判断カードで選んで出し直させたあとの
 *   2回目のレビューまで自動で反映すると、人が読んで決める前提が崩れる）
 * - **人が決めるべき「判断」を含むレビューは送らない**（#3660）。選ぶのは人なので、固定文面で
 *   先に出し直させず、判断カードでの選択を待つ
 * - **`noFindings`のときは送らない。** 指摘に分けられなかった本文は、画面と同じく一括の依頼文で送る
 * - **決定コメントに`plan-reviser`を付けない。** 付けると`findPendingPlanReviewComment`が
 *   「応答済み」と読み、実装セッションの応答が無いまま指摘が消える
 */

export const PLAN_REVIEW_MARKER = "<!-- supervisor:plan-review -->";

/** 自動反映を記録するコメントのマーカー。`plan-reviser`とは別物にする（上記） */
export const PLAN_REVIEW_AUTO_REFLECT_MARKER = "<!-- issue-deck:plan-review-auto-reflect -->";

/** 1つのIssueで自動反映する回数の上限 */
export const PLAN_REVIEW_AUTO_REFLECT_MAX_ROUNDS = 1;

export type PlanReviewAutoReflectResult =
  | { reflected: true }
  | {
      reflected: false;
      reason: "not_review" | "no_findings" | "has_decisions" | "no_request" | "not_claude" | "limit" | "lost_race";
    };

export function isPlanReviewCommentBody(body: string): boolean {
  return body.includes(PLAN_REVIEW_MARKER);
}

export function buildPlanReviewAutoReflectCommentBody(): string {
  return [
    "🔁 **計画レビューの指摘を自動で反映するよう、セッションへ修正を送りました。**",
    "",
    "セッションは指摘を自分で確かめ、取り込んだ計画を出し直します（自動反映は1つのIssueにつき1回です）。出し直された計画は、通常どおり承認を待ちます。",
    "",
    PLAN_REVIEW_AUTO_REFLECT_MARKER,
  ].join("\n");
}

export async function autoReflectPlanReview(params: {
  repositoryFullName: string;
  issueNumber: number;
  commentBody: string;
  now?: Date;
}): Promise<PlanReviewAutoReflectResult> {
  if (!isPlanReviewCommentBody(params.commentBody)) return { reflected: false, reason: "not_review" };
  const now = params.now ?? new Date();

  // 「指摘なし」だけ見送る。分けられなかった本文も、画面と同じく一括の依頼文で送る
  const parsed = parsePlanReview(params.commentBody);
  if (parsed.noFindings) {
    return { reflected: false, reason: "no_findings" };
  }

  if (parsed.decisions.length > 0) return { reflected: false, reason: "has_decisions" };

  const target = { repositoryFullName: params.repositoryFullName, issueNumber: params.issueNumber };
  const request = await db.sessionPlanRequest.findFirst({
    where: { ...target, status: "WAITING", expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!request) return { reflected: false, reason: "no_request" };

  const job = await db.dispatchJob.findFirst({
    where: { ...target, kind: "PLAN_REVIEW" },
    orderBy: { createdAt: "desc" },
    select: { agent: true },
  });
  if (job?.agent !== "claude") return { reflected: false, reason: "not_claude" };

  const done = await db.sessionPlanRequest.count({
    where: { ...target, status: "REVISION_REQUESTED" },
  });
  if (done >= PLAN_REVIEW_AUTO_REFLECT_MAX_ROUNDS) return { reflected: false, reason: "limit" };

  const decided = await decideSessionPlanRequest({
    id: request.id,
    decision: "revise",
    revisionText: PLAN_REVIEW_REFLECT_REQUEST_TEXT,
    decidedByUserId: null,
    now,
  });
  if (!decided.ok) return { reflected: false, reason: "lost_race" };

  // 決定はもうDBに入っている。以降の失敗は握りつぶす（画面の「修正」と同じ）
  await postAutoReflectComment(params.repositoryFullName, params.issueNumber);
  await resolveSessionPlanCheckUser(target);
  return { reflected: true };
}

async function postAutoReflectComment(repositoryFullName: string, issueNumber: number) {
  const parsed = parseRepositoryFullName(repositoryFullName);
  if (!parsed) return;
  try {
    const token = await resolveInstallationToken(repositoryFullName);
    if (!token) return;
    await createComment(parsed.owner, parsed.repo, issueNumber, token, {
      body: buildPlanReviewAutoReflectCommentBody(),
    });
  } catch (error) {
    console.error(
      `[dispatch] 計画レビューの自動反映をIssueへ残せませんでした（${repositoryFullName}#${issueNumber}）`,
      error,
    );
  }
}
