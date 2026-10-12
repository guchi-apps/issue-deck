import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { requestPullRequestFix, type FixRequestFailure } from "@/lib/github/pull-request-fix-request-service";
import { findRepositoryForUser } from "@/lib/github/pull-request-repair-service";
import { previewModeGuard } from "@/lib/preview-mode";

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("pull_request_fix_request", () => handlePOST(request));
}

/** 方針の上限。長文は依頼コメントを読みにくくするだけなので、ここで切る */
const MAX_INSTRUCTION_LENGTH = 4000;

/** 利用者が方針を書かなかったときに渡す依頼文。判断が要る点を推測で直させない */
const DEFAULT_REVIEW_FIX_INSTRUCTION =
  "このPRの最新HEADに対する自動レビューの指摘（要確認・要修正）を読み、コードで直せるものは直してください。";

const FAILURE_STATUS: Record<FixRequestFailure["error"], number> = {
  not_found: 404,
  not_open: 409,
  no_linked_issue: 409,
  head_moved: 409,
  body_moved: 409,
  repair_in_progress: 409,
  local_session: 409,
  issue_closed: 409,
  reauth_required: 409,
  github_error: 502,
};

/**
 * PR詳細の対応パネルから、レビュー指摘への修正を同じPRへ依頼する（#4482）。
 *
 * 本体はIssueDeck Chatと共用の`requestPullRequestFix`（#4045）。紐づくIssueへ利用者本人の
 * トークンで`@claude`コメントを書き、既存のdispatchが同じブランチを直してpushする（CI・再レビューは
 * pushを契機にいつもどおり走る）。新しいIssue・PRは作らない。画面が見たHEADから進んでいたら中断し、
 * 同じHEAD・同じ方針の再送は投稿済みの依頼を返す（二重依頼にしない）。
 */
async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body: { owner?: string; repo?: string; number?: number; headSha?: string; instruction?: string } =
    await request.json().catch(() => ({}));
  const { owner, repo, number, headSha } = body;
  if (!owner || !repo || !number || Number.isNaN(Number(number)) || !headSha || !/^[0-9a-f]{7,40}$/.test(headSha)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const policy = typeof body.instruction === "string" ? body.instruction.trim() : "";
  if (policy.length > MAX_INSTRUCTION_LENGTH) {
    return NextResponse.json(
      { error: "invalid_request", message: `方針は${MAX_INSTRUCTION_LENGTH}文字以内で書いてください。` },
      { status: 400 },
    );
  }

  const [repository, user] = await Promise.all([
    findRepositoryForUser(userId, owner, repo),
    db.user.findUnique({
      where: { id: userId },
      select: { id: true, githubAccessToken: true, githubRefreshToken: true },
    }),
  ]);
  if (!repository || !user) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const instruction = policy
    ? `${DEFAULT_REVIEW_FIX_INSTRUCTION}\n\n利用者の方針:\n${policy}`
    : DEFAULT_REVIEW_FIX_INSTRUCTION;
  const result = await requestPullRequestFix(user, repository, {
    owner,
    repo,
    number: Number(number),
    expectedHeadSha: headSha,
    instruction,
    source: "pull-request-detail",
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, message: result.message }, { status: FAILURE_STATUS[result.error] });
  }
  return NextResponse.json({
    ok: true,
    duplicate: result.duplicate,
    commentUrl: result.commentUrl,
    issueNumber: result.issueNumber,
    headSha: result.headSha,
  });
}
