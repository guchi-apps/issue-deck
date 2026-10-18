import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import {
  enqueueRemoteSession,
  enqueueRemoteSessionKill,
  listRemoteSessions,
} from "@/lib/dispatch/remote-session";
import { findRepositoryByFullName } from "@/lib/github/issue-create-service";
import { parseRepositoryFullName } from "@/lib/local-session";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * リモートセッション（#4743）の画面側の入口。リポジトリだけを指定してサブPCにClaude Codeの
 * セッションを立て、Claude Codeアプリで開くためのURLを返す。会話そのものはClaude Codeアプリ側。
 *
 * ジョブはpull型で**置くだけ**（`/api/dispatch`と同じ）。起動の結果とURLは、pollerの報告
 * （`/api/dispatch/report`）とホスト申告（`/api/dispatch/hosts`）が`RemoteSession`へ写す。
 */

const NO_STORE = { "Cache-Control": "no-store" };

/** セッション一覧・起動できるホスト・上限 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const state = await listRemoteSessions(userId);
  return NextResponse.json(state, { headers: NO_STORE });
}

/** 起動する。本文は`{ repositoryFullName: "owner/repo" }` */
export async function POST(request: NextRequest) {
  const blocked = previewModeGuard();
  if (blocked) return blocked;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const repository =
    typeof payload?.repositoryFullName === "string"
      ? parseRepositoryFullName(payload.repositoryFullName)
      : null;
  if (!repository) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const fullName = `${repository.owner}/${repository.repo}`;
  // 利用者がインストール連携しているリポジトリだけを起動できる
  if (!(await findRepositoryByFullName(userId, fullName))) {
    return NextResponse.json({ error: "forbidden", message: "このリポジトリはリモートセッションを起動できません。" }, { status: 403, headers: NO_STORE });
  }

  const result = await enqueueRemoteSession({
    repositoryFullName: fullName,
    requestedByUserId: userId,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.rejection, message: result.message },
      { status: 409, headers: NO_STORE },
    );
  }
  return NextResponse.json({ ok: true, session: result.session }, { status: 201, headers: NO_STORE });
}

/** 終了する。`?id=<RemoteSessionのid>` */
export async function DELETE(request: NextRequest) {
  const blocked = previewModeGuard();
  if (blocked) return blocked;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const result = await enqueueRemoteSessionKill({ id, requestedByUserId: userId });
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result.reason, message: result.message }, { status, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
