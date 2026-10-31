import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { previewModeGuard } from "@/lib/preview-mode";
import { parseReleaseReviewDecisionAction, validateDecisionInput } from "@/lib/release-review-decision";
import { applyReleaseReviewDecision, countActiveReviewFixSeries, loadDecisionContext } from "@/lib/release-review-decision-apply";

/**
 * 全体レビューの指摘1件に、ユーザーの判断（今回直す／公開後に対応する／今回は見送る／採用しない／撤回）を
 * 記録する（#4657）。**判断の保存だけではマージしない・修正Issueも作らない。**
 *
 * - ガードは再実行（`review-rerun`）と同じ: プレビュー→ログイン→リポジトリの所有確認→今のリリースPRの再取得
 * - 対象（base・head）はサーバーが今のPRから解決し、クライアントのSHAは一致確認だけに使う（古い画面からは409）
 * - 指摘は今の結果に載っているIDだけを受け付ける（見ていない・古い結果の指摘に判断を付けない）
 * - 同時判断は`expectedDecisionId`（画面が見ていた最新の判断）で止め、黙って上書きしない（409 `decision_conflict`）
 * - 公開後対応の関連Issueは、既存の番号（存在を確認）か、この操作で明示的に作るものだけ。見送りには作らない
 * - 外部エージェント用のAPI（review-agent）にはこの書き込み口を作らない。採否はユーザーが決める
 * - AIの推奨（#4676）を見て判断したときは`recommendationId`を受け取り、推奨の写しと理由の出どころを判断と一緒に残す。
 *   推奨は今の対象（base・head）・同じ指摘のものだけを受け付け、別の対象の推奨なら409で止める
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("release_dispatch", () => handlePOST(request));
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);

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
  const findingId = typeof payload?.findingId === "string" && /^R-[0-9a-f]{6}$/.test(payload.findingId) ? payload.findingId : null;
  const decision = parseReleaseReviewDecisionAction(payload?.decision);
  const expectedDecisionId =
    payload?.expectedDecisionId === null ? null : typeof payload?.expectedDecisionId === "string" ? payload.expectedDecisionId : undefined;
  const recommendationId =
    payload?.recommendationId === undefined || payload?.recommendationId === null
      ? null
      : typeof payload.recommendationId === "string" && /^[a-z0-9]{1,40}$/.test(payload.recommendationId)
        ? payload.recommendationId
        : undefined;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    !Number.isInteger(pullRequestNumber) ||
    pullRequestNumber <= 0 ||
    !expectedBase ||
    !expectedHead ||
    !findingId ||
    !decision ||
    expectedDecisionId === undefined ||
    recommendationId === undefined
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const rawFollowUp = payload?.followUp;
  const followUpInput =
    rawFollowUp?.kind === "existing" && Number.isInteger(rawFollowUp.number) && rawFollowUp.number > 0
      ? { kind: "existing" as const, number: rawFollowUp.number as number }
      : rawFollowUp?.kind === "create"
        ? { kind: "create" as const, title: str(rawFollowUp.title, 200) ?? "" }
        : null;
  const input = {
    decision,
    reason: str(payload?.reason, 2000) ?? "",
    impact: str(payload?.impact, 2000),
    scope: str(payload?.scope, 2000),
    timing: str(payload?.timing, 500),
    followUp: followUpInput,
  };
  const invalid = validateDecisionInput(input);
  if (invalid) return NextResponse.json({ error: "invalid_decision", ...invalid }, { status: 400 });

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
    const applied = await applyReleaseReviewDecision(loaded.ctx, { ...input, findingId, expectedDecisionId, recommendationId });
    if (!applied.ok) return NextResponse.json(applied.body, { status: applied.status });
    const activeSeries = await countActiveReviewFixSeries(loaded.ctx);
    return NextResponse.json(
      {
        ok: true,
        decision: applied.record,
        // 稼働中の修正系列がある場合、実行中のセッション・取り込み済みの修正PRは止まらない。今後の追加修正・候補更新だけが判断に従う
        activeFixSeries: activeSeries,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error(`[POST /api/repositories/release/review-decisions] ${repoFullName}#${pullRequestNumber}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
