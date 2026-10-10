import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { parseDependencyWaitInput } from "@/lib/dispatch/dependency-wait";
import {
  cancelDependencyWait,
  findLegacyHoldCandidate,
  recheckDependencyWait,
  registerDependencyWait,
} from "@/lib/dispatch/dependency-wait-run";
import { parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { fetchCommentsForIssue } from "@/lib/github/issues-api";
import { parseRepositoryFullName } from "@/lib/local-session";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 画面からの依存待ちの操作（#4321）。ログインセッションで認証する。
 *
 * - `recheck`: 依存先の状態を取り直して判断する（条件が成立していれば、そのまま再開まで進む）
 * - `resume`: 「作業を再開」。人の確認が要る条件（実環境の検証など）を人が引き受ける操作で、
 *   **機械で判断できる未成立の条件が残っているときは再開しない**
 * - `cancel`: 待ちを解除する
 * - `register`: 既存の保留（保留コメントと`11.local`だけが残るもの）を、人が依存先と条件を
 *   確定して登録する。自由文の推定だけでは登録しない
 *
 * 送る文面はサーバーが組み立てる固定の1行で、呼び出し側は本文を指定できない。
 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const action = payload?.action;
  try {
    if (action === "register") {
      const target = parseDispatchTarget(payload?.repository, payload?.issue);
      const input = parseDependencyWaitInput(payload);
      if (!target || !input) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
      const wait = await registerDependencyWait({ ...target, ...input, source: "manual" });
      return NextResponse.json({ wait }, { headers: { "Cache-Control": "no-store" } });
    }
    const id = typeof payload?.id === "string" ? payload.id : "";
    if (!id || (action !== "recheck" && action !== "resume" && action !== "cancel")) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const wait =
      action === "cancel"
        ? await cancelDependencyWait(id)
        : await recheckDependencyWait(id, { resume: action === "resume", userId });
    if (!wait) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ wait }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[POST /api/dispatch/dependency-wait]", error);
    return NextResponse.json({ error: "failed", message: "依存待ちの操作に失敗しました" }, { status: 500 });
  }
}

/** 既存の保留の依存先候補（`?repository=owner/repo&issue=番号`）。登録・再開はしない */
export async function GET(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const repository = request.nextUrl.searchParams.get("repository");
  const issue = Number(request.nextUrl.searchParams.get("issue"));
  const target = parseDispatchTarget(repository, issue);
  const parsed = target ? parseRepositoryFullName(target.repositoryFullName) : null;
  if (!target || !parsed) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  try {
    const token = await resolveInstallationToken(target.repositoryFullName);
    if (!token) return NextResponse.json({ candidate: null });
    const comments = await fetchCommentsForIssue(parsed.owner, parsed.repo, target.issueNumber, token);
    const candidate = await findLegacyHoldCandidate({
      ...target,
      commentBodies: comments.map((c) => c.body ?? ""),
    });
    return NextResponse.json({ candidate }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[GET /api/dispatch/dependency-wait]", error);
    return NextResponse.json({ candidate: null });
  }
}
