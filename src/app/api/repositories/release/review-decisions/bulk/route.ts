import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { previewModeGuard } from "@/lib/preview-mode";
import { RELEASE_REVIEW_BULK_FALLBACK_REASON, RELEASE_REVIEW_BULK_MAX_ITEMS } from "@/lib/release-review-bulk";
import { RELEASE_REVIEW_DECISION_KINDS, validateDecisionInput, type ReleaseReviewDecisionKind } from "@/lib/release-review-decision";
import { applyReleaseReviewDecision, loadDecisionContext, type DecisionInput } from "@/lib/release-review-decision-apply";

/**
 * 全体レビューの指摘を、表で確かめた判断のとおりにまとめて確定する（#5138）。画面の「おまかせで公開承認まで進める」が、
 * 「修正を自動で続ける」の開始より先に呼ぶ。**判断の保存だけではマージしない・修正を始めない**（開始は画面が続けて
 * `POST /api/repositories/release/completion`を呼ぶ）。
 *
 * - ガード・1件ごとの検証は1件ずつのAPI（`../route.ts`）と同じ関数（`release-review-decision-apply.ts`）を通す
 * - 撤回と既存Issueへの関連付けは受け付けない（一括で行うのは推奨どおりの確定と、推奨が無い止める指摘の安全側だけ）
 * - `fallback: true`の項目は「今回直す」に限り、推奨を持たない。理由はサーバーの固定文で、出どころは`fallback`
 * - 1件ずつ「Issue作成→保存」の順で進め、途中で失敗しても確定済みの分は残す。結果は項目ごとに返す。
 *   候補が更新されていた（`release_pr_changed`）ら何も保存せず409で返す
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("release_dispatch", () => handlePOST(request));
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
const sha = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{40,64}$/.test(v) ? v : null);

/** 項目1件を読む。形が違えばnull（全体を400にする） */
function parseItem(raw: unknown): DecisionInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const findingId = typeof item.findingId === "string" && /^R-[0-9a-f]{6}$/.test(item.findingId) ? item.findingId : null;
  const decision = (RELEASE_REVIEW_DECISION_KINDS as readonly string[]).includes(item.decision as string)
    ? (item.decision as ReleaseReviewDecisionKind)
    : null;
  const expectedDecisionId = item.expectedDecisionId === null ? null : typeof item.expectedDecisionId === "string" ? item.expectedDecisionId : undefined;
  const recommendationId =
    item.recommendationId === undefined || item.recommendationId === null
      ? null
      : typeof item.recommendationId === "string" && /^[a-z0-9]{1,40}$/.test(item.recommendationId)
        ? item.recommendationId
        : undefined;
  if (!findingId || !decision || expectedDecisionId === undefined || recommendationId === undefined) return null;
  const fallback = item.fallback === true;
  if (fallback) {
    // 安全側は「今回直す」だけで、推奨は持たない
    if (decision !== "fix_now" || recommendationId !== null) return null;
    return {
      findingId,
      decision,
      reason: RELEASE_REVIEW_BULK_FALLBACK_REASON,
      impact: null,
      scope: null,
      timing: null,
      followUp: null,
      expectedDecisionId,
      recommendationId: null,
      reasonSourceOverride: "fallback",
    };
  }
  // 推奨どおりの確定だけを受ける。推奨の無い項目は安全側（fallback）で送る
  if (recommendationId === null) return null;
  const rawFollowUp = item.followUp as { kind?: unknown; title?: unknown } | null | undefined;
  const followUp = rawFollowUp?.kind === "create" ? { kind: "create" as const, title: str(rawFollowUp.title, 200) ?? "" } : null;
  return {
    findingId,
    decision,
    reason: str(item.reason, 2000) ?? "",
    impact: str(item.impact, 2000),
    scope: str(item.scope, 2000),
    timing: str(item.timing, 500),
    followUp,
    expectedDecisionId,
    recommendationId,
  };
}

type ItemResult = { findingId: string; ok: true } | { findingId: string; ok: false; error: string; message: string | null };

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const pullRequestNumber = payload?.pullRequestNumber;
  const expectedBase = sha(payload?.baseSha);
  const expectedHead = sha(payload?.headSha);
  const rawItems: unknown = payload?.items;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    !Number.isInteger(pullRequestNumber) ||
    pullRequestNumber <= 0 ||
    !expectedBase ||
    !expectedHead ||
    !Array.isArray(rawItems) ||
    rawItems.length === 0 ||
    rawItems.length > RELEASE_REVIEW_BULK_MAX_ITEMS
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const items = rawItems.map(parseItem);
  if (items.some((item) => item === null)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const inputs = items as DecisionInput[];
  if (new Set(inputs.map((i) => i.findingId)).size !== inputs.length) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  for (const input of inputs) {
    const invalid = validateDecisionInput(input);
    if (invalid) return NextResponse.json({ error: "invalid_decision", findingId: input.findingId, ...invalid }, { status: 400 });
  }

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
    const results: ItemResult[] = [];
    for (const input of inputs) {
      try {
        const applied = await applyReleaseReviewDecision(loaded.ctx, input);
        results.push(
          applied.ok
            ? { findingId: input.findingId, ok: true }
            : {
                findingId: input.findingId,
                ok: false,
                error: String(applied.body.error ?? "failed"),
                message: typeof applied.body.message === "string" ? applied.body.message : null,
              },
        );
      } catch (error) {
        // 1件の失敗（Issue作成の失敗など）で残りを諦めない。確定済みの分は残る
        console.error(`[POST /api/repositories/release/review-decisions/bulk] ${repoFullName}#${pullRequestNumber} ${input.findingId}:`, error);
        results.push({ findingId: input.findingId, ok: false, error: "github_api_error", message: githubApiErrorMessage(error) });
      }
    }
    const failed = results.filter((r) => !r.ok).length;
    return NextResponse.json({ ok: failed === 0, results, failed }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[POST /api/repositories/release/review-decisions/bulk] ${repoFullName}#${pullRequestNumber}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
