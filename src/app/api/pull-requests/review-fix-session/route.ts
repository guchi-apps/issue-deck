import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { isDispatchHostOnline, parseDispatchHostRepositories } from "@/lib/dispatch/dispatch-job";
import { enqueueDispatchJob, enqueueSessionControlJob } from "@/lib/dispatch/jobs";
import {
  buildReviewFixFailureComment,
  buildReviewFixRequestComment,
  buildReviewFixRequestText,
  resolveReviewFixSessionRoute,
  REVIEW_FIX_NOTE_MAX_LENGTH,
  REVIEW_FIX_SESSION_INSTRUCTION,
  type ReviewFixSessionRoute,
} from "@/lib/dispatch/review-fix-session";
import { findDispatchSessionForIssue } from "@/lib/dispatch/sessions";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  addIssueLabels,
  createComment,
  fetchCommentsForIssue,
  fetchIssueState,
  GithubApiError,
} from "@/lib/github/issues-api";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { findCurrentFixRequest } from "@/lib/github/pull-request-fix-request-service";
import { REVIEW_COMMENT_VERDICT_LABEL, selectPullRequestReviewComment } from "@/lib/github/pull-request-review-comment";
import { needsReviewAttention, parsePullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { LOCAL_LABEL_NAME, posterMarker } from "@/lib/github/project-status-dispatch";
import { resolveReviewVerdictFreshness } from "@/lib/github/review-verdict-freshness";
import { previewModeGuard } from "@/lib/preview-mode";
import { summarizeReviewConcerns } from "@/lib/pull-request-review-action";

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("pull_request_review_fix_session", () => handlePOST(request));
}

const ISSUE_BRANCH_PATTERN = /^issue-(\d+)$/;

/**
 * PRのレビュー指摘を、元Issueのセッションで直させる（#5493。設計は`review-fix-session.ts`）。
 *
 * **押すのは人で、セッションへ流す本文は受け取らない。** 受け取るのは対象PRと、Issueコメントへ
 * 足す任意の方針メモだけ。依頼コメントの文面はサーバーが作り、動いているセッションへは固定の
 * 1行（`REVIEW_FIX_SESSION_INSTRUCTION`）しか送らない（`docs/multi-agent/gates.md`の
 * 「固定文面を1クリックで送る」）。
 *
 * 順序は**コメント投稿 → ジョブ投入**。起動・再開ではセッションが起動時にIssueのコメントを読むため、
 * 先に投稿しておかないと依頼が載らない。ジョブを積めなかったら依頼へ失敗の印を付け、PR詳細を
 * 「中断」表示（再送できる）にする。
 *
 * **`00.check-user`はここでは外さない。** 動いているセッションへの1行は、届いた（`succeeded`の
 * 報告）時点で`POST /api/dispatch/report`が`01.check-merge`まで外す。再開・起動は既存の
 * 「セッションを復旧」と同じくラベルを触らない（`11.local`だけ付ける）。
 */
async function handlePOST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload: { owner?: unknown; repo?: unknown; number?: unknown; note?: unknown } = await request
    .json()
    .catch(() => ({}));
  const { owner, repo, number, note } = payload;
  if (
    typeof owner !== "string" ||
    !owner ||
    typeof repo !== "string" ||
    !repo ||
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number <= 0 ||
    (note !== undefined && typeof note !== "string") ||
    (typeof note === "string" && note.length > REVIEW_FIX_NOTE_MAX_LENGTH)
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const repositoryFullName = `${owner}/${repo}`;

  const repository = await db.repository.findFirst({
    where: { fullName: repositoryFullName, installation: { userInstallations: { some: { userId: user.id } } } },
    include: { installation: true },
  });
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const [pullRequest, prComments] = await Promise.all([
      fetchPullRequest(owner, repo, number, token),
      fetchCommentsForIssue(owner, repo, number, token),
    ]);

    if (pullRequest.state !== "open" || pullRequest.merged || pullRequest.draft) {
      return reject("not_open", "このPRはopenではないため、修正を依頼できません。", 409);
    }
    const branch = ISSUE_BRANCH_PATTERN.exec(pullRequest.head.ref);
    if (!branch) {
      return reject("no_linked_issue", `${pullRequest.head.ref} は issue-<番号> ブランチではないため、依頼を渡すIssueがありません。`, 409);
    }
    const issueNumber = Number(branch[1]);
    const headSha = pullRequest.head.sha;

    // **いまのHEADに対する要修正・要確認があるときだけ受ける。** 古い判定や判定なしで押されたら、
    // 何を直すのかが決まらない（画面の言い分をそのまま信じない）
    const verdict = parsePullRequestReviewVerdict(pullRequest.body);
    if (
      !verdict ||
      !needsReviewAttention(verdict.reviewKind) ||
      resolveReviewVerdictFreshness({ reviewedSha: verdict.reviewedSha, headSha }) === "stale"
    ) {
      return reject("no_current_findings", "いまのコミットに対する要修正・要確認の判定がありません。画面を更新してください。", 409);
    }

    if ((await fetchIssueState(owner, repo, issueNumber, token)) !== "open") {
      return reject("issue_not_open", `Issue #${issueNumber} がopenではないため、依頼できません。`, 409);
    }

    const issueComments = await fetchCommentsForIssue(owner, repo, issueNumber, token);
    if (findCurrentFixRequest(issueComments, headSha)) {
      return reject("already_requested", "このコミットへの修正依頼は既に出ています。pushと再レビューを待ってください。", 409);
    }

    const session = await findDispatchSessionForIssue({ repositoryFullName, issueNumber });
    const route = resolveReviewFixSessionRoute(session);
    // 記録が無いときの起動先は、ここで1台に決まる場合だけにする（複数あると選べない）。
    // **コメントを投稿する前に確かめる**——決まらないのに依頼だけ残すと、届かない依頼が積もる
    let launchHost: string | null = null;
    if (route.kind === "launch") {
      launchHost = await pickLaunchHost(repositoryFullName);
      if (!launchHost) {
        return reject(
          "no_launch_host",
          "このIssueのセッションの記録が無く、起動先のホストを1台に決められません。Issue詳細の「実装を開始」から起動してください。",
          409,
        );
      }
    }

    const review = selectPullRequestReviewComment(
      prComments.map((comment) => ({ body: comment.body, createdAt: comment.created_at, htmlUrl: comment.html_url ?? null })),
      headSha,
    );
    const currentReview = review && !review.isStale ? review : null;
    const text = buildReviewFixRequestText({
      pullRequestNumber: number,
      headSha,
      headRef: pullRequest.head.ref,
      verdictLabel: REVIEW_COMMENT_VERDICT_LABEL[verdict.reviewKind],
      reviewUrl: currentReview?.htmlUrl ?? pullRequest.html_url,
      concerns: currentReview ? summarizeReviewConcerns(currentReview.body) : [],
      note: typeof note === "string" ? note : "",
    });
    const requestComment = await createComment(owner, repo, issueNumber, token, {
      body: buildReviewFixRequestComment({
        text,
        headSha,
        key: Date.now().toString(16),
        posterMarker: posterMarker(user.githubLogin),
      }),
    });

    const enqueued = await enqueueForRoute({
      route,
      launchHost,
      repositoryFullName,
      issueNumber,
      userId: user.id,
    });
    if (!enqueued.ok) {
      // 依頼は残っているので、届かなかったことを同じ依頼に結び付けて残す（PR詳細が「中断」にする）
      await createComment(owner, repo, issueNumber, token, {
        body: buildReviewFixFailureComment({
          requestCommentId: requestComment.id,
          reason: enqueued.rejection,
          message: enqueued.message,
        }),
      }).catch((error) => console.error(`[review-fix-session] 失敗の記録を残せませんでした ${repositoryFullName}#${issueNumber}:`, error));
      return reject(enqueued.rejection, enqueued.message, enqueued.rejection === "already_queued" ? 409 : 400);
    }

    // 起動・再開は「セッションを復旧」と同じく`11.local`を付ける（無人実行との二重起動を防ぐ）。
    // **失敗しても起動自体は妨げない**（`useLocalSessionLaunch`と同じ扱い）
    if (route.kind !== "session") {
      await addIssueLabels(owner, repo, issueNumber, token, [LOCAL_LABEL_NAME]).catch((error) =>
        console.error(`[review-fix-session] ${LOCAL_LABEL_NAME}を付けられませんでした ${repositoryFullName}#${issueNumber}:`, error),
      );
    }

    return NextResponse.json(
      { ok: true, route, issueNumber, commentUrl: requestComment.html_url ?? null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    console.error(`[POST /api/pull-requests/review-fix-session] ${repositoryFullName}#${number}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}

function reject(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status, headers: { "Cache-Control": "no-store" } });
}

async function enqueueForRoute(params: {
  route: ReviewFixSessionRoute;
  launchHost: string | null;
  repositoryFullName: string;
  issueNumber: number;
  userId: string;
}): Promise<{ ok: true } | { ok: false; rejection: string; message: string }> {
  const { route } = params;
  if (route.kind === "session") {
    const result = await enqueueSessionControlJob({
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      hostName: route.host,
      kind: "INSTRUCTION",
      instruction: REVIEW_FIX_SESSION_INSTRUCTION,
      // 届いたこと（`succeeded`）を確かめてから確認待ちを外す（#2886と同じ扱い）
      recovery: true,
      requestedByUserId: params.userId,
    });
    return result.ok ? { ok: true } : { ok: false, rejection: result.rejection, message: result.message };
  }
  const result = await enqueueDispatchJob({
    repositoryFullName: params.repositoryFullName,
    issueNumber: params.issueNumber,
    hostName: route.kind === "resume" ? route.host : (params.launchHost ?? ""),
    // 再開は前回と同じエージェントで立てる。新規起動は既定（設定に従う）
    agent: route.kind === "resume" ? route.agent : undefined,
    requestedByUserId: params.userId,
  });
  return result.ok ? { ok: true } : { ok: false, rejection: result.rejection, message: result.message };
}

/** そのリポジトリを実行できるオンラインのホストが1台だけなら、その名前を返す */
async function pickLaunchHost(repositoryFullName: string): Promise<string | null> {
  const now = new Date();
  const hosts = await db.dispatchHost.findMany({ select: { name: true, lastSeenAt: true, repositories: true } });
  const candidates = hosts.filter(
    (host) =>
      isDispatchHostOnline(host.lastSeenAt, now) &&
      parseDispatchHostRepositories(host.repositories).includes(repositoryFullName),
  );
  return candidates.length === 1 ? candidates[0].name : null;
}
