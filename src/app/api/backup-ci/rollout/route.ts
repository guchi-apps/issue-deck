import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { BackupCiError } from "@/lib/backup-ci/github";
import { dispatchBackupCiRollout, inspectRollout, listRolloutRepositories } from "@/lib/backup-ci/rollout-service";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * バックアップCIの他リポジトリへの展開（#4308）。
 * - GET: 展開先に選べるリポジトリ一覧。`?repo=owner/name`を付けるとその1件の導入状態と不足項目
 * - POST: 選んだ1リポジトリへ導入・更新PRを作るワークフローを起動（自動マージはしない）
 */
export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const repo = request.nextUrl.searchParams.get("repo");
  try {
    if (!repo) return NextResponse.json({ repositories: await listRolloutRepositories(userId) });
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    return NextResponse.json({ detail: await inspectRollout(userId, repo) });
  } catch (error) {
    if (error instanceof BackupCiError) return NextResponse.json({ error: error.code, message: error.message }, { status: 404 });
    console.error("[backup-ci] 展開状況の取得に失敗しました:", error);
    return NextResponse.json({ error: "failed", message: "状態を取得できませんでした。時間をおいて再取得してください。" }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body: { repository?: unknown } = await request.json().catch(() => ({}));
  if (typeof body.repository !== "string" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(body.repository)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const result = await dispatchBackupCiRollout(userId, body.repository);
    if (!result.dispatched) return NextResponse.json(result, { status: result.reason === "running" ? 409 : 404 });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[backup-ci] 配布の起動に失敗しました:", error);
    return NextResponse.json(
      { error: "dispatch_failed", message: "配布を起動できませんでした（配布ワークフローが配布元のmainに無い、または権限不足の可能性があります）。" },
      { status: 502 },
    );
  }
}
