import { NextResponse, type NextRequest } from "next/server";

import { toAccessSubject } from "@/lib/access/client";
import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { previewModeGuard } from "@/lib/preview-mode";
import { createClient } from "@/lib/supabase/server";
import { issueShareTokenValue, parseDeviceId, SHARE_TOKEN_TTL_MS } from "@/lib/share-token/token";

/**
 * iOS共有画面用トークンの発行・失効（#4298）。**ログインCookieで呼ぶ（アプリ本体のWebViewだけ）。**
 *
 * - POST: 端末ごとに1本だけ有効にする（同じ`deviceId`の古いトークンは失効）。値はこの応答でしか返さない
 * - DELETE: ログアウト・アカウント切替で、その利用者のトークンを失効する（`deviceId`省略で全端末）
 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const deviceId = parseDeviceId(payload?.deviceId);
  if (!deviceId) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  // 検証のたびの許可判定（`authenticateShareToken`）に使う、メール確認済みの値を残す
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const emailVerified = data.user ? toAccessSubject(data.user).emailVerified : false;

  const { value, hash } = issueShareTokenValue();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SHARE_TOKEN_TTL_MS);
  // 端末単位で失効させる（ユーザーを問わない）。アカウントを切り替えても前のユーザーのトークンを残さない
  await db.shareToken.updateMany({
    where: { deviceId, revokedAt: null },
    data: { revokedAt: now },
  });
  await db.shareToken.create({ data: { userId: user.id, deviceId, tokenHash: hash, emailVerified, expiresAt } });
  // 期限切れ・失効済みの古い行を掃除する（失敗しても発行は成功させる）
  await db.shareToken
    .deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: new Date(now.getTime() - 7 * 86_400_000) } }] } })
    .catch(() => undefined);

  return NextResponse.json(
    { token: value, expiresAt: expiresAt.toISOString(), userId: user.supabaseUserId, login: user.githubLogin },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const deviceId = payload?.deviceId === undefined ? null : parseDeviceId(payload.deviceId);
  if (payload?.deviceId !== undefined && !deviceId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  await db.shareToken.updateMany({
    where: { userId: user.id, revokedAt: null, ...(deviceId ? { deviceId } : {}) },
    data: { revokedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
