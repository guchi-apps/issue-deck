import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { registerManualIosFailureIssue } from "@/lib/github/ios-distribution-failure-register";
import { previewModeGuard } from "@/lib/preview-mode";
import { getWebviewIosRepository } from "@/lib/webview-ios-repos";

/**
 * 画面の「修正Issueを起案」から起票したIssueを、iOS配布失敗の追跡Issueとして登録する（#3784）。
 * 登録した後の二重起票の抑止・書き足し・自動クローズは巡回が行う。
 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const runId = payload?.runId;
  const runUrl = payload?.runUrl;
  const issueNumber = payload?.issueNumber;
  const failedStage = typeof payload?.failedStage === "string" ? payload.failedStage : null;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof runUrl !== "string" ||
    !Number.isInteger(runId) ||
    !Number.isInteger(issueNumber) ||
    issueNumber <= 0
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const fullName = `${owner}/${repo}`;
  // 対象は固定リストのリポジトリだけ（別リポジトリの番号を巡回が閉じないよう、起票先と一致させる）
  if (!getWebviewIosRepository(fullName)) {
    return NextResponse.json({ error: "unsupported_repository" }, { status: 400 });
  }
  const repository = await db.repository.findFirst({
    where: { fullName, installation: { userInstallations: { some: { userId } } } },
    select: { fullName: true },
  });
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await registerManualIosFailureIssue({
    repositoryFullName: repository.fullName,
    runId,
    runUrl,
    failedStage,
    issueNumber,
  });
  if (result.kind === "already_tracked") {
    return NextResponse.json({ error: "already_tracked", issueNumber: result.issueNumber }, { status: 409 });
  }
  return NextResponse.json({ ok: true, issueNumber: result.issueNumber });
}
