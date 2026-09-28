import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { previewModeGuard } from "@/lib/preview-mode";
import {
  addRedirectUrl,
  listRedirectUrls,
  parseRedirectUrlInput,
  removeRedirectUrl,
  replaceRedirectUrl,
  SupabaseManagementApiError,
} from "@/lib/supabase/management-api";
import { isSupabaseManagementApiConfigured } from "@/lib/supabase/config";

/**
 * 設定画面「フリート運用」のSupabase Redirect URLs区画が読み書きする受け口（#3568）。
 *
 * 対象URLは`/`や`:`を含み本番のApache経由ではパスセグメント化できないため、
 * PATCH・DELETEともパスではなくリクエストボディで識別する（`fine-grained-tokens/[id]`とは異なる形）。
 */

function errorResponse(error: unknown, fallbackMessage: string) {
  if (error instanceof SupabaseManagementApiError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return NextResponse.json({ error: fallbackMessage }, { status: 502 });
}

export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isSupabaseManagementApiConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  try {
    const redirectUrls = await listRedirectUrls();
    return NextResponse.json({ redirectUrls });
  } catch (error) {
    return errorResponse(error, "一覧の取得に失敗しました");
  }
}

export async function POST(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isSupabaseManagementApiConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  const url = parseRedirectUrlInput((payload as { url?: unknown } | null)?.url);
  if (!url) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const redirectUrls = await addRedirectUrl(url);
    return NextResponse.json({ redirectUrls });
  } catch (error) {
    return errorResponse(error, "追加に失敗しました");
  }
}

export async function PATCH(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isSupabaseManagementApiConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  const body = payload as { oldUrl?: unknown; newUrl?: unknown } | null;
  const oldUrl = parseRedirectUrlInput(body?.oldUrl);
  const newUrl = parseRedirectUrlInput(body?.newUrl);
  if (!oldUrl || !newUrl) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const redirectUrls = await replaceRedirectUrl(oldUrl, newUrl);
    return NextResponse.json({ redirectUrls });
  } catch (error) {
    return errorResponse(error, "更新に失敗しました");
  }
}

export async function DELETE(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isSupabaseManagementApiConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const payload = await request.json().catch(() => null);
  const url = parseRedirectUrlInput((payload as { url?: unknown } | null)?.url);
  if (!url) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const redirectUrls = await removeRedirectUrl(url);
    return NextResponse.json({ redirectUrls });
  } catch (error) {
    return errorResponse(error, "削除に失敗しました");
  }
}
