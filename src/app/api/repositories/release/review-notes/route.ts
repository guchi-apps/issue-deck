import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { previewModeGuard } from "@/lib/preview-mode";
import { loadDecisionContext } from "@/lib/release-review-decision-apply";
import { parseReviewNoteTarget, validateReviewNoteInput } from "@/lib/release-review-note";
import { saveReleaseReviewNote } from "@/lib/release-review-note-store";

/**
 * 全体レビューの未確認項目・候補全体に、承知した理由を判断メモとして1件追記する（#5252）。
 *
 * **メモは記録だけ。** AIの判定・ゲートの合否・公開承認・修正系列は変えない（このAPIはそれらの書き込みを持たない）。
 * ガードは判断API（`review-decisions`）と同じ: プレビュー→ログイン→リポジトリの所有確認→今のリリースPRの取り直しと
 * 画面のSHAの照合。確認項目へのメモは、今の結果で**未確認**の項目だけに付けられる。公開承認とは独立に書ける。
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("release_dispatch", () => handlePOST(request));
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max + 1) : null);

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const pullRequestNumber = payload?.pullRequestNumber;
  const sha = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{40,64}$/.test(v) ? v : null);
  const expectedBase = sha(payload?.baseSha);
  const expectedHead = sha(payload?.headSha);
  const target = parseReviewNoteTarget(payload?.target);
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    !Number.isInteger(pullRequestNumber) ||
    pullRequestNumber <= 0 ||
    !expectedBase ||
    !expectedHead ||
    !target
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const input = { body: str(payload?.body, 2000) ?? "", followUp: str(payload?.followUp, 300) };
  const invalid = validateReviewNoteInput(input);
  if (invalid) return NextResponse.json({ error: "invalid_note", ...invalid }, { status: 400 });

  const repoFullName = `${owner}/${repo}`;
  const repository = await db.repository.findFirst({
    where: { fullName: repoFullName, installation: { userInstallations: { some: { userId } } } },
    include: { installation: true },
  });
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const loaded = await loadDecisionContext({ owner, repo, token, pullRequestNumber, expectedBase, expectedHead, userId });
    if (!loaded.ok) return NextResponse.json(loaded.body, { status: loaded.status });
    const { ctx } = loaded;
    if (target.kind === "check") {
      const open = ctx.section.review?.checks.some((c) => c.id === target.checkId && c.status === "unconfirmed") ?? false;
      if (!open) {
        return NextResponse.json(
          { error: "check_not_unconfirmed", message: "この確認項目は今の結果で未確認ではありません。画面を更新してください" },
          { status: 409 },
        );
      }
    }
    const record = await saveReleaseReviewNote({
      scopeKey: ctx.scopeKey,
      repoFullName,
      target,
      body: input.body,
      followUp: input.followUp,
      prNumber: pullRequestNumber,
      baseSha: ctx.current.baseSha,
      headSha: ctx.current.headSha,
      userId,
    });
    return NextResponse.json({ ok: true, note: record }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[POST /api/repositories/release/review-notes] ${repoFullName}#${pullRequestNumber}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
