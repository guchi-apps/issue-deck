import { db } from "@/lib/db";
import {
  decideSessionPlanRequest,
  recordSessionPlanCodexDelivery,
} from "@/lib/dispatch/plan-requests";
import { notifyCodexSessionDecision } from "@/lib/dispatch/codex-decision-notify";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { resolveSessionPlanCheckUser } from "@/lib/dispatch/session-plan";
import { PLAN_REVIEW_REFLECT_REQUEST_TEXT } from "@/lib/dispatch/session-plan-request";
import { createComment } from "@/lib/github/issues-api";
import { pickPlanReviewAdoptionByJev } from "@/lib/claude/plan-review-pick";
import {
  hasBlockingFindings,
  parsePlanReview,
  type ParsedPlanReview,
} from "@/lib/github/plan-review";
import {
  PLAN_REVIEW_UNRESOLVED_MARKER,
  planReviewOrdinalOf,
} from "@/lib/dispatch/plan-review-kind";
import { parseRepositoryFullName } from "@/lib/local-session";

/**
 * 計画レビュー（G1）を、届いた時点で、Jevが採用と判断した指摘だけ自動で計画へ反映させる（#3616・#3648）。
 *
 * **これまでは、人が指摘を読んで「レビューを反映して計画を出し直す」を押していた**（#3521・#3554）。
 * 計画を出すと直ちに確認待ちのPush通知が鳴るため、レビューが届く前に人が呼ばれ、届いたあとも
 * 人が押すまで計画が動かなかった。
 *
 * ここでは`supervisor:plan-review`コメントの到着（GitHubのWebhook）を契機に、画面の一括ボタンと
 * **同じ固定文面**（`PLAN_REVIEW_REFLECT_REQUEST_TEXT`）を「修正」として書き込む。承認ではない
 * （G1が承認しない原則は保つ。承認は人が押す）。`SessionPlanRequest`へ書き、Codexには既存の
 * 継続指示を積む。端末へキーを送る経路は無い。
 *
 * 守っていることは次のとおり。
 *
 * - **Claude CodeとCodexの実装セッション。** Codexへは既存の`codex queue`による固定の継続指示を
 *   ディスパッチジョブとして積む。Claude Codeは計画待ちのフックが決定を受け取るため、通知関数は何もしない
 * - **採用かどうかはJevが決める**（#3648）。設定（`AppSetting.planReviewAutoReflectEnabled`）がOFF、
 *   Jevが「採用しない」と答えた、Jevの答えが取れなかったときは反映せず、人へ通知する
 * - **自動反映は初回レビューの後の1回だけ**（#3765。#3648の「指摘がなくなるまで繰り返す」を置き換えた）。
 *   修正後は解消確認1回（`plan-review-kind.ts`）で終わり、そこで重大な問題が残れば**自動修正を止めて
 *   人へ引き継ぐ**。補足（実装時に対応できるもの）だけの指摘では反映しない。上限の設定
 *   （`AppSetting.planReviewAutoReflectMaxRounds`）は1を超えて効かない
 * - **人が決めるべき「判断」を含むレビューは送らない**（#3660）。選ぶのは人なので、固定文面で
 *   先に出し直させず、判断カードでの選択を待つ
 * - **今の計画へのレビューだけ。** 届いたレビューのジョブが今の計画待ちより前に積まれていれば、
 *   前の計画へのレビューなので反映しない（出し直した直後に遅れて届いた古い指摘で次の計画を直させない）
 * - **`noFindings`のときは送らない。** 指摘に分けられなかった本文は、画面と同じく一括の依頼文で送る
 * - **決定コメントに`plan-reviser`を付けない。** 付けると`findPendingPlanReviewComment`が
 *   「応答済み」と読み、実装セッションの応答が無いまま指摘が消える
 * - **どの終わり方でも、最後にジョブへ`planReviewDecidedAt`を書く。** 一覧・通知の保留・承認パネルは
 *   これが入るまで「作成中」として扱うので、書き漏れると通知が保留の上限まで遅れる
 */

export const PLAN_REVIEW_MARKER = "<!-- supervisor:plan-review -->";

/** 自動反映を記録するコメントのマーカー。`plan-reviser`とは別物にする（上記） */
export const PLAN_REVIEW_AUTO_REFLECT_MARKER = "<!-- issue-deck:plan-review-auto-reflect -->";

/**
 * 連続して自動反映する回数の上限（#3765）。通常の自動運用は「初回レビュー1回 → 必要な計画修正 →
 * 解消確認1回」までで、自動反映は初回レビューの後の1回だけ。旧既定の5を設定に持つホストでも
 * **設定値はこの値を超えて効かない**（`Math.min`で切る）ので、旧設定で新方針が迂回されない。
 */
export const PLAN_REVIEW_AUTO_REFLECT_MAX_ROUNDS = 1;

export type PlanReviewAutoReflectResult =
  | { reflected: true }
  | {
      reflected: false;
      reason:
        | "not_review"
        | "no_findings"
        | "no_blocking"
        | "unresolved"
        | "has_decisions"
        | "no_job"
        | "no_request"
        | "stale_review"
        | "disabled"
        | "limit"
        | "not_adopted"
        | "lost_race";
    };

export function isPlanReviewCommentBody(body: string): boolean {
  return body.includes(PLAN_REVIEW_MARKER);
}

export function buildPlanReviewAutoReflectCommentBody(): string {
  return [
    "🔁 **計画レビューの指摘を自動で反映するよう、セッションへ修正を送りました。**",
    "",
    "Jevが重大な指摘を採用すると判断したので、セッションは指摘を元のコード・要求と照らして確かめ、採用か根拠付きの反論を記録して計画を出し直します。出し直した計画には、前回の重大な指摘が解消したかを確かめる解消確認を1回だけ行い、自動の見直しはそこで終わります。",
    "",
    PLAN_REVIEW_AUTO_REFLECT_MARKER,
  ].join("\n");
}

/** 届いたレビューのジョブ。`markPlanReviewPosted`が記録したもの。記録できなかったら`null` */
export type PostedPlanReviewJob = { jobId: string; createdAt: Date } | null;

export async function autoReflectPlanReview(params: {
  repositoryFullName: string;
  issueNumber: number;
  commentBody: string;
  postedJob: PostedPlanReviewJob;
  now?: Date;
}): Promise<PlanReviewAutoReflectResult> {
  if (!isPlanReviewCommentBody(params.commentBody)) return { reflected: false, reason: "not_review" };
  try {
    return await decideAutoReflect(params);
  } finally {
    // どの終わり方でも採否の確定を残す（上の説明）。失敗しても握りつぶす（保留は上限で外れる）
    if (params.postedJob) await markPlanReviewDecided(params.postedJob.jobId, params.now ?? new Date());
  }
}

async function markPlanReviewDecided(jobId: string, now: Date) {
  try {
    await db.dispatchJob.update({ where: { id: jobId }, data: { planReviewDecidedAt: now } });
  } catch (error) {
    console.error(`[dispatch] 計画レビューの採否の確定を記録できませんでした（${jobId}）`, error);
  }
}

/**
 * 人が最後に決めた計画待ちより後の、自動反映（`decidedByUserId=null`の修正）の連続回数。
 * 人が画面から送った修正・承認でも数え直す（#3648。#3660は人の修正も回数に含めていたが、
 * 「指摘がなくなるまで続けたい」ため、人が介入した後はその次のレビューからまた判定する）。
 */
async function countConsecutiveAutoReflects(target: {
  repositoryFullName: string;
  issueNumber: number;
}): Promise<number> {
  const lastHuman = await db.sessionPlanRequest.findFirst({
    where: { ...target, decidedByUserId: { not: null } },
    orderBy: { decidedAt: "desc" },
    select: { decidedAt: true },
  });
  return db.sessionPlanRequest.count({
    where: {
      ...target,
      status: "REVISION_REQUESTED",
      decidedByUserId: null,
      ...(lastHuman?.decidedAt ? { decidedAt: { gt: lastHuman.decidedAt } } : {}),
    },
  });
}

async function decideAutoReflect(params: {
  repositoryFullName: string;
  issueNumber: number;
  commentBody: string;
  postedJob: PostedPlanReviewJob;
  now?: Date;
}): Promise<PlanReviewAutoReflectResult> {
  const now = params.now ?? new Date();

  // 「指摘なし」だけ見送る。分けられなかった本文も、画面と同じく一括の依頼文で送る
  const parsed = parsePlanReview(params.commentBody);
  if (parsed.noFindings) {
    return { reflected: false, reason: "no_findings" };
  }

  // どのレビュージョブのコメントか分からなければ、今の計画へのものと確かめられない
  if (!params.postedJob) return { reflected: false, reason: "no_job" };

  const target = { repositoryFullName: params.repositoryFullName, issueNumber: params.issueNumber };

  // 解消確認（このエポックで2回目以降のレビュー）は自動修正をしない。重大な問題や人の判断が残って
  // いれば、未解消点と次の操作をまとめて人へ引き継ぐ（#3765）
  const ordinal = await planReviewOrdinalOf(target, params.postedJob.jobId);
  if (ordinal >= 2) {
    if (!hasBlockingFindings(parsed) && parsed.decisions.length === 0) {
      return { reflected: false, reason: "no_blocking" };
    }
    await postUnresolvedComment(params.repositoryFullName, params.issueNumber, parsed);
    return { reflected: false, reason: "unresolved" };
  }

  // 人が決める「判断」はJevに任せない。通知して、判断カードで人が選ぶ（#3660）
  if (parsed.decisions.length > 0) return { reflected: false, reason: "has_decisions" };

  // 補足だけなら計画を出し直させない。実装時に対応できる（#3765）
  if (!hasBlockingFindings(parsed)) return { reflected: false, reason: "no_blocking" };

  const request = await db.sessionPlanRequest.findFirst({
    where: { ...target, status: "WAITING", expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!request) return { reflected: false, reason: "no_request" };

  // 前の計画へのレビューが遅れて届いた。今の計画には反映しない。**計画待ちはレビューのジョブより
  // 先に作られる前提**（`POST /api/dispatch/sessions/plan`。#3697）。逆順だと今の計画のレビューまで
  // 毎回ここで落ちる
  if (params.postedJob.createdAt < request.createdAt) return { reflected: false, reason: "stale_review" };

  const settings = await db.appSetting.findUnique({
    where: { id: 1 },
    select: { planReviewAutoReflectEnabled: true, planReviewAutoReflectMaxRounds: true },
  });
  if (settings && !settings.planReviewAutoReflectEnabled) return { reflected: false, reason: "disabled" };

  const maxRounds = Math.min(
    settings?.planReviewAutoReflectMaxRounds ?? PLAN_REVIEW_AUTO_REFLECT_MAX_ROUNDS,
    PLAN_REVIEW_AUTO_REFLECT_MAX_ROUNDS,
  );
  if ((await countConsecutiveAutoReflects(target)) >= maxRounds) return { reflected: false, reason: "limit" };

  // 採否はJevが決める。決められない（`null`）・採用しないなら通知側へ倒す
  const adopted = await pickPlanReviewAdoptionByJev(params.commentBody);
  if (adopted !== true) return { reflected: false, reason: "not_adopted" };

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
  await notifyCodexPlanRevision({
    repositoryFullName: params.repositoryFullName,
    issueNumber: params.issueNumber,
    requestId: request.id,
  });
  return { reflected: true };
}

/**
 * Codexは計画待ちをポーリングせずターンを終えるため、画面からの修正と同じ継続指示を積む。
 * Claude Codeでは計画待ちのフックが決定を受け取るので、`notifyCodexSessionDecision`は何もしない。
 */
async function notifyCodexPlanRevision(params: {
  repositoryFullName: string;
  issueNumber: number;
  requestId: string;
}) {
  try {
    const notified = await notifyCodexSessionDecision({
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      kind: "plan-revision",
      requestedByUserId: null,
    });
    if (notified.ok || (notified.reason !== "not_codex" && notified.reason !== "no_session")) {
      await recordSessionPlanCodexDelivery({
        id: params.requestId,
        queued: notified.ok,
        summary: notified.ok ? null : notified.message,
      });
    }
  } catch (error) {
    // 自動反映の判断はすでに保存済み。配送失敗でWebhook処理まで失敗させない
    console.error(
      `[dispatch] Codexへ計画レビューの修正指示を配送できませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
  }
}

export function buildPlanReviewUnresolvedCommentBody(review: ParsedPlanReview): string {
  const blocking = review.findings.filter((finding) => finding.severity !== "note");
  const lines = ["⚠️ **解消確認の後も、重大な問題または人の判断が残っています。自動の修正はここで止めました。**", ""];
  if (blocking.length > 0) {
    lines.push("未解消の重大な指摘:", ...blocking.map((finding) => `- ${finding.number}. ${finding.title}`), "");
  }
  if (review.decisions.length > 0) {
    lines.push("人が決める論点:", ...review.decisions.map((decision) => `- 判断${decision.number}. ${decision.title}`), "");
  }
  lines.push(
    "次の操作: 解消確認のレビュー本文を読み、計画を直して承認するか、方針を決めて修正を送ってください。人が修正を送っても全体レビューは自動では再開しません（追加のレビューは「計画をレビュー」から依頼できます）。",
    "",
    PLAN_REVIEW_UNRESOLVED_MARKER,
  );
  return lines.join("\n");
}

async function postUnresolvedComment(
  repositoryFullName: string,
  issueNumber: number,
  review: ParsedPlanReview,
) {
  const parsed = parseRepositoryFullName(repositoryFullName);
  if (!parsed) return;
  try {
    const token = await resolveInstallationToken(repositoryFullName);
    if (!token) return;
    await createComment(parsed.owner, parsed.repo, issueNumber, token, {
      body: buildPlanReviewUnresolvedCommentBody(review),
    });
  } catch (error) {
    console.error(
      `[dispatch] 計画レビューの未解消点をIssueへ残せませんでした（${repositoryFullName}#${issueNumber}）`,
      error,
    );
  }
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
