import { NextResponse, type NextRequest } from "next/server";

import { isValidDefinitionId, isValidProjectSlug, saveBackupCiSetting } from "@/lib/backup-ci/service";
import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * バックアップCI（#4065）のリポジトリ別設定を保存する。APIトークンとWebhookの署名鍵はここで
 * 受け取らない（環境変数で持つ。docs/backup-ci.md「初期設定」）。
 */
export async function PUT(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body: {
    owner?: unknown;
    repo?: unknown;
    enabled?: unknown;
    circleciProjectSlug?: unknown;
    circleciDefinitionId?: unknown;
  } = await request.json().catch(() => ({}));
  if (typeof body.owner !== "string" || typeof body.repo !== "string" || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const slug = typeof body.circleciProjectSlug === "string" ? body.circleciProjectSlug.trim() : "";
  const definitionId = typeof body.circleciDefinitionId === "string" ? body.circleciDefinitionId.trim() : "";
  if (slug && !isValidProjectSlug(slug)) {
    return NextResponse.json(
      { error: "invalid_project_slug", message: "プロジェクトスラッグは circleci/<org-id>/<project-id> の形で入力してください。" },
      { status: 400 },
    );
  }
  if (definitionId && !isValidDefinitionId(definitionId)) {
    return NextResponse.json(
      { error: "invalid_definition_id", message: "パイプライン定義IDの形式が正しくありません。" },
      { status: 400 },
    );
  }
  if (body.enabled && (!slug || !definitionId)) {
    return NextResponse.json(
      { error: "incomplete", message: "有効にするには、プロジェクトスラッグとパイプライン定義IDの両方が必要です。" },
      { status: 400 },
    );
  }

  const repository = await db.repository.findFirst({
    where: {
      fullName: `${body.owner}/${body.repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    select: { fullName: true },
  });
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const setting = await saveBackupCiSetting({
    repositoryFullName: repository.fullName,
    enabled: body.enabled,
    circleciProjectSlug: slug || null,
    circleciDefinitionId: definitionId || null,
    userId,
  });
  return NextResponse.json({
    ok: true,
    setting: {
      enabled: setting.enabled,
      circleciProjectSlug: setting.circleciProjectSlug,
      circleciDefinitionId: setting.circleciDefinitionId,
    },
  });
}
