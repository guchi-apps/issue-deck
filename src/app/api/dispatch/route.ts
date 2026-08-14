import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { parseDispatchHostName, parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import { enqueueDispatchJob, listDispatchState } from "@/lib/dispatch/jobs";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * サブPCへのディスパッチ（#1179）の、画面側から使う入口。
 *
 * 方式はpull型で、ここはジョブを**置くだけ**。サブPCのpollerが
 * `POST /api/dispatch/claim`で取りに来る（VPSがtailnetに参加しておらず、Tailscale SSHに
 * forced commandが無いためpush型は採れない。#1176）。
 *
 * 認証はSupabaseのログインセッション。サブPC側の3本（claim・report・hosts）だけが
 * 共有シークレット認証で、そちらとは値も経路も分けている。
 */

/**
 * ディスパッチの状態一式（ホストの申告・未完了ジョブ・直近の終了ジョブ・同時実行数）。
 * #1180の起動先選択と状態表示がこれを読む。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const state = await listDispatchState();
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
}

/**
 * ジョブを積む。
 *
 * **実行できない組み合わせは積む前に弾き、理由を本文で返す**（「ディスパッチ前に弾く」。
 * #1179のコメント）。無言で失敗すると、無人実行では何も起きないまま終わってしまう。
 */
export async function POST(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const target = parseDispatchTarget(payload?.repository, payload?.issue);
  const hostName = parseDispatchHostName(payload?.host);
  if (!target || !hostName) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await enqueueDispatchJob({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    hostName,
    requestedByUserId: userId,
  });

  if (!result.ok) {
    // 既にジョブがある場合だけ409。それ以外は「今は投げられない」なので400で理由を返す
    const status = result.rejection === "already_queued" ? 409 : 400;
    return NextResponse.json(
      { error: result.rejection, message: result.message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ok: true, job: result.job },
    { headers: { "Cache-Control": "no-store" } },
  );
}
