import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { createReviewAgentToken, listReviewAgentTokens, listSelectableRepositories, revokeReviewAgentToken, updateReviewAgentTokenRepositories } from "@/lib/review-agent/auth";

/**
 * 外部エージェント向けAPI/MCPのトークン（#4588）の一覧・発行・失効。**ログインした利用者本人だけ**が自分のトークンを扱う。
 * 発行時の値は応答に1度だけ返す（保存はハッシュのみ）。許可するrepositoryは自分が連携しているものに限る。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [tokens, availableRepositories] = await Promise.all([listReviewAgentTokens(userId), listSelectableRepositories(userId)]);
  return NextResponse.json({ tokens, availableRepositories }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const result = await createReviewAgentToken({
    userId,
    name: typeof body?.name === "string" ? body.name : "",
    scopes: Array.isArray(body?.scopes) ? body.scopes.filter((s: unknown): s is string => typeof s === "string") : [],
    repositories: Array.isArray(body?.repositories) ? body.repositories.filter((s: unknown): s is string => typeof s === "string") : [],
    expiresInDays: typeof body?.expiresInDays === "number" ? body.expiresInDays : 30,
  });
  if (!result.ok) return NextResponse.json({ error: result.code, message: result.message }, { status: result.code === "repository_not_found" ? 404 : 400 });
  return NextResponse.json({ id: result.id, token: result.token, tokenPrefix: result.tokenPrefix, expiresAt: result.expiresAt.toISOString() }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

/** 発行済みトークンの許可repositoryの差し替え（#4739）。トークンの値は変わらず、応答にも出さない */
export async function PATCH(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (typeof body?.id !== "string") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const repositories = Array.isArray(body?.repositories) ? body.repositories.filter((s: unknown): s is string => typeof s === "string") : [];
  const result = await updateReviewAgentTokenRepositories(userId, body.id, repositories);
  if (!result.ok) return NextResponse.json({ error: result.code, message: result.message }, { status: result.code === "invalid_request" ? 400 : 404 });
  return NextResponse.json({ repositories: result.repositories, added: result.added, removed: result.removed }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  return (await revokeReviewAgentToken(userId, id))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "not_found" }, { status: 404 });
}
