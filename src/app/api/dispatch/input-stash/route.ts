import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName, parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import {
  INPUT_STASH_MAX_CHARS,
  stashExpiry,
  type InputStashView,
} from "@/lib/dispatch/input-stash";
import { previewModeGuard } from "@/lib/preview-mode";

async function canAccessRepository(userId: string, fullName: string): Promise<boolean> {
  const repo = await db.repository.findFirst({
    where: { fullName, installation: { userInstallations: { some: { userId } } } },
    select: { id: true },
  });
  return repo !== null;
}

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * 未送信入力の退避（#4383）。
 *
 * - `POST`: pollerが、入力欄から**完全に取得できた**未送信入力を保存する（`DISPATCH_SECRET`で認証）。
 *   `stashInput`を立てて積まれた追加指示のジョブ（確認ダイアログを通した操作）に対してだけ受け付け、
 *   `jobId`のunique制約で通信の再試行・二重送信を1件にする。**本文は応答にもログにも出さない。**
 * - `GET`: 画面が退避を確認・コピーするために読む（ログイン必須。期限切れは返す前に消す）
 * - `DELETE`: 画面から退避を削除する（ログイン必須）
 */
export async function POST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const jobId = typeof payload?.jobId === "string" && payload.jobId !== "" ? payload.jobId : null;
  const host = parseDispatchHostName(payload?.host);
  const content = typeof payload?.content === "string" ? payload.content : null;
  const tmuxSessionName =
    typeof payload?.tmuxSessionName === "string" ? payload.tmuxSessionName.slice(0, 191) : "";
  if (!jobId || !host || content === null || content === "" || !tmuxSessionName) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (content.length > INPUT_STASH_MAX_CHARS) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }

  const job = await db.dispatchJob.findUnique({ where: { id: jobId } });
  if (
    !job ||
    job.kind !== "INSTRUCTION" ||
    !job.stashInput ||
    job.targetHost !== host ||
    (job.status !== "CLAIMED" && job.status !== "RUNNING")
  ) {
    return NextResponse.json({ error: "not_allowed" }, { status: 403 });
  }

  const now = new Date();
  try {
    const stash = await db.sessionInputStash.create({
      data: {
        jobId,
        repositoryFullName: job.repositoryFullName,
        issueNumber: job.issueNumber,
        host,
        tmuxSessionName,
        content,
        charCount: [...content].length,
        requestedByUserId: job.requestedByUserId,
        expiresAt: stashExpiry(now),
      },
      select: { id: true },
    });
    return NextResponse.json({ ok: true, id: stash.id }, { headers: NO_STORE });
  } catch {
    // 再試行・二重送信（jobIdのunique違反）。**既に保存済みなら成功として返す**
    const existing = await db.sessionInputStash.findUnique({ where: { jobId }, select: { id: true } });
    if (existing) return NextResponse.json({ ok: true, id: existing.id, duplicate: true }, { headers: NO_STORE });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const target = parseDispatchTarget(
    request.nextUrl.searchParams.get("repository"),
    Number(request.nextUrl.searchParams.get("issue")),
  );
  if (!target) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  if (!(await canAccessRepository(userId, target.repositoryFullName))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const now = new Date();
  await db.sessionInputStash.deleteMany({ where: { expiresAt: { lt: now } } });
  const rows = await db.sessionInputStash.findMany({
    where: {
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      requestedByUserId: userId,
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const stashes: InputStashView[] = rows.map((r) => ({
    id: r.id,
    jobId: r.jobId,
    repositoryFullName: r.repositoryFullName,
    issueNumber: r.issueNumber,
    host: r.host,
    charCount: r.charCount,
    content: r.content,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
  return NextResponse.json({ stashes }, { headers: NO_STORE });
}

export async function DELETE(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  // 依頼者本人の行だけを、今もそのリポジトリへ権限がある場合に限って消す
  const row = await db.sessionInputStash.findFirst({
    where: { id, requestedByUserId: userId },
    select: { repositoryFullName: true },
  });
  if (!row || !(await canAccessRepository(userId, row.repositoryFullName))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await db.sessionInputStash.deleteMany({ where: { id, requestedByUserId: userId } });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
