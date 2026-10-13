import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { detectBodyMismatch } from "@/lib/execution-plan/body";
import { getPlanView, savePlan } from "@/lib/execution-plan/register";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { fetchIssueBody } from "@/lib/github/issues-api";
import { parseRepositoryFullName } from "@/lib/local-session";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 親子Issueの実行計画（#4535。仕様は docs/execution-plan.md）。
 *
 * 認証は「ログイン中の本人」か`Bearer DISPATCH_SECRET`（サブPCのセッション・外部エージェント）。
 * Bearerを付けたのに不一致なら401、`DISPATCH_SECRET`が未設定なら503（設定漏れと区別する）。
 * 計画を持たない親は404で、**計画が無いことを「依存なし」と解釈しない**（本文のみのEpicは従来どおり）。
 */
async function authorize(request: NextRequest): Promise<{ author: string } | NextResponse> {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const result = authorizeDispatch(authorization);
    if (result === "ok") return { author: "dispatch" };
    return NextResponse.json({ error: result === "not_configured" ? "not_configured" : "unauthorized" }, {
      status: result === "not_configured" ? 503 : 401,
    });
  }
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return { author: userId };
}

function parseParent(repository: unknown, issue: unknown) {
  if (typeof repository !== "string" || !parseRepositoryFullName(repository)) return null;
  const number = typeof issue === "string" ? Number(issue) : issue;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return null;
  return { repository, number };
}

export async function GET(request: NextRequest) {
  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;
  const params = request.nextUrl.searchParams;
  const parent = parseParent(params.get("repository"), params.get("issue"));
  if (!parent) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const versionParam = params.get("version");
  const version = versionParam ? Number(versionParam) : undefined;
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const view = await getPlanView(parent, version);
  if (!view) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let bodyMismatch: unknown = undefined;
  if (params.get("checkBody") === "1") {
    const parsed = parseRepositoryFullName(parent.repository);
    try {
      const token = await resolveInstallationToken(parent.repository);
      const body = token && parsed ? await fetchIssueBody(parsed.owner, parsed.repo, parent.number, token) : null;
      bodyMismatch =
        body === null
          ? { error: "本文を取得できませんでした。一致しているとは判断しません" }
          : detectBodyMismatch(body, view.plan, view.currentVersion);
    } catch (error) {
      bodyMismatch = { error: error instanceof Error ? error.message : "本文の取得に失敗しました" };
    }
  }
  return NextResponse.json({ ...view, bodyMismatch }, { headers: { "Cache-Control": "no-store" } });
}

async function write(request: NextRequest, mode: "create" | "update") {
  const guard = previewModeGuard();
  if (guard) return guard;
  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;
  const payload = await request.json().catch(() => null);
  const parent = parseParent(payload?.repository, payload?.issue);
  if (!parent || typeof payload?.changeNote !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (mode === "update" && typeof payload.expectedVersion !== "number") {
    return NextResponse.json(
      { error: "invalid_request", errors: [{ path: "expectedVersion", message: "更新には直前に読んだ版（expectedVersion）が必要です" }] },
      { status: 400 },
    );
  }
  const result = await savePlan({
    parent,
    payload: payload.plan,
    author: auth.author,
    changeNote: payload.changeNote,
    expectedVersion: mode === "update" ? payload.expectedVersion : undefined,
    confirmRemove: Array.isArray(payload.confirmRemove)
      ? payload.confirmRemove.filter((v: unknown): v is string => typeof v === "string")
      : [],
  });
  if (!result.ok) return NextResponse.json({ error: "invalid_plan", errors: result.errors }, { status: result.status });
  return NextResponse.json(
    { ...result.view, diff: result.diff, warnings: result.warnings },
    { status: mode === "create" ? 201 : 200, headers: { "Cache-Control": "no-store" } },
  );
}

export const POST = (request: NextRequest) => write(request, "create");
export const PATCH = (request: NextRequest) => write(request, "update");
