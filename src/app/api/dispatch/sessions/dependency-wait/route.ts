import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDependencyWaitInput } from "@/lib/dispatch/dependency-wait";
import { registerDependencyWait } from "@/lib/dispatch/dependency-wait-run";
import { parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 実装セッション自身が「依存先を待って保留する」ことを報告する受け口（#4321）。
 *
 * 送るのは`scripts/report-dependency-wait.sh`（Claude Code・Codex共通）。**自由文の最終回答や
 * コメントだけで保留を終えない**ための構造化された報告で、依存先（リポジトリ付き）・再開条件・
 * 短い日本語の理由が揃わなければ受け付けない（推定で補わない）。登録時に依存先の現在の状態を
 * 確認し、成立済みならそのまま再開まで進む。
 *
 * 認証は`/sessions/*`の他の受け口と同じ共有シークレット（`DISPATCH_SECRET`）。
 */
export async function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const target = parseDispatchTarget(payload?.repository, payload?.issue);
  const input = parseDependencyWaitInput(payload);
  if (!target || !input) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  try {
    const wait = await registerDependencyWait({ ...target, ...input, source: "session" });
    return NextResponse.json({ ok: true, wait }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[POST /api/dispatch/sessions/dependency-wait]", error);
    return NextResponse.json({ error: "register_failed" }, { status: 500 });
  }
}
