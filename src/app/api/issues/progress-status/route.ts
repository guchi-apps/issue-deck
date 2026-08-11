import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { reportProgressStatus } from "@/lib/github/report-progress";
import { parseProgressStatusKey } from "@/lib/issue-progress";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 画面の操作（「実装を開始」ボタン等）からProject Statusを動かすAPI（#991 Phase 3）。
 *
 * 中身は進捗報告API（`POST /api/progress`）と同じ`reportProgressStatus`だが、**認証が違う**。
 * あちらは無人実行向けの共有シークレット、こちらはログインセッション。ブラウザへ
 * `PROGRESS_REPORT_SECRET`を配らないために入口を分けている。
 *
 * リクエスト: `{ "repository": "owner/name", "issue": 123, "status": "implementation" }`
 *
 * **失敗しても呼び出し側は処理を止めない。** ボタンの本体は`@claude`コメントの投稿であり、
 * Statusはカンバンを即座に追従させるための付随的な書き込みにすぎない。Project未導入・
 * 未登録の環境でもボタンは従来どおり動く必要がある。
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("progress_report", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const repositoryFullName =
    typeof payload?.repository === "string" && payload.repository.includes("/")
      ? payload.repository
      : null;
  const issueNumber =
    Number.isInteger(payload?.issue) && payload.issue > 0 ? (payload.issue as number) : null;
  const status = parseProgressStatusKey(payload?.status);

  if (!repositoryFullName || issueNumber === null || !status) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // 共有シークレット経由（無人実行）と違い、こちらはログインユーザーが見えるリポジトリに限る
  const accessible = await db.repository.findFirst({
    where: {
      fullName: repositoryFullName,
      installation: { userInstallations: { some: { userId } } },
    },
    select: { id: true },
  });
  if (!accessible) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await reportProgressStatus({ repositoryFullName, issueNumber, status });
  return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}
