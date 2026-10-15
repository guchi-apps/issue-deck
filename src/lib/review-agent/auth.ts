import { createHash, randomBytes } from "node:crypto";

import type { ReviewAgentToken } from "@prisma/client";

import { db } from "@/lib/db";

/**
 * 外部エージェント向けの全体レビュー・修正API／MCP（#4588）の認証と監査。
 *
 * 実行ホスト用の共有シークレット（`PROGRESS_REPORT_SECRET`など）は外へ配らない前提で、**利用者・アクセスできるrepository・操作範囲**を
 * 持つ専用トークンで受ける。値は保存せずSHA-256のハッシュだけを持ち、期限と失効で止められる。
 *
 * 操作範囲は3つに分け、読み取りだけを渡せるようにする。`read`＝取得、`write`＝担当の取得/引き継ぎ/解放・一時停止・テストと独立レビューの報告、
 * `resume`＝一時停止の再開。**どの範囲も本番マージ・公開の承認は含まない。**
 */
export const REVIEW_AGENT_SCOPES = ["read", "write", "resume"] as const;
export type ReviewAgentScope = (typeof REVIEW_AGENT_SCOPES)[number];

export const REVIEW_AGENT_TOKEN_PREFIX = "ida_";
const MAX_TOKEN_DAYS = 365;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][\w.-]*\/(?!\.{1,2}$)[\w.-]+$/;

export function hashReviewAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type ReviewAgentPrincipal = {
  tokenId: string;
  userId: string;
  name: string;
  scopes: ReviewAgentScope[];
  repositories: string[];
};

export type ReviewAgentAuthResult =
  | { ok: true; principal: ReviewAgentPrincipal }
  | { ok: false; status: 401; code: "unauthorized" | "token_expired" | "token_revoked" };

export function parseScopes(raw: string): ReviewAgentScope[] {
  return raw.split(",").filter((s): s is ReviewAgentScope => (REVIEW_AGENT_SCOPES as readonly string[]).includes(s));
}

function parseRepositories(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === "string") : [];
}

/** `Authorization: Bearer ida_…`を検証する。読み取りだけでは`lastUsedAt`などを更新しない（副作用なし） */
export async function authenticateReviewAgent(authorizationHeader: string | null, now = new Date()): Promise<ReviewAgentAuthResult> {
  const prefix = "Bearer ";
  if (!authorizationHeader?.startsWith(prefix)) return { ok: false, status: 401, code: "unauthorized" };
  const value = authorizationHeader.slice(prefix.length).trim();
  if (!value.startsWith(REVIEW_AGENT_TOKEN_PREFIX) || value.length > 200) return { ok: false, status: 401, code: "unauthorized" };
  const row = await db.reviewAgentToken.findUnique({ where: { tokenHash: hashReviewAgentToken(value) } });
  if (!row) return { ok: false, status: 401, code: "unauthorized" };
  if (row.revokedAt) return { ok: false, status: 401, code: "token_revoked" };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, status: 401, code: "token_expired" };
  return { ok: true, principal: toPrincipal(row) };
}

function toPrincipal(row: ReviewAgentToken): ReviewAgentPrincipal {
  return { tokenId: row.id, userId: row.userId, name: row.name, scopes: parseScopes(row.scopes), repositories: parseRepositories(row.repositories) };
}

export type RepositoryAccess = { ok: true } | { ok: false; code: "repository_not_allowed" | "repository_not_found" };

/** トークンの許可リストに入っていて、かつ発行した利用者が今も連携しているrepositoryだけを通す（使うたびに再確認する） */
export async function authorizeRepository(principal: ReviewAgentPrincipal, repositoryFullName: string): Promise<RepositoryAccess> {
  if (!principal.repositories.includes(repositoryFullName)) return { ok: false, code: "repository_not_allowed" };
  const repository = await db.repository.findFirst({
    where: { fullName: repositoryFullName, installation: { userInstallations: { some: { userId: principal.userId } } } },
    select: { id: true },
  });
  return repository ? { ok: true } : { ok: false, code: "repository_not_found" };
}

export type AuditEntry = {
  principal: ReviewAgentPrincipal | null;
  tool: string;
  repositoryFullName?: string | null;
  issueNumber?: number | null;
  outcome: "ok" | "rejected" | "denied";
  errorCode?: string | null;
};

/** 監査の記録。失敗しても操作は止めない（記録先の障害で報告を失わない） */
export async function recordReviewAgentAudit(entry: AuditEntry): Promise<void> {
  await db.reviewAgentAuditLog
    .create({
      data: {
        tokenId: entry.principal?.tokenId ?? null,
        userId: entry.principal?.userId ?? null,
        tool: entry.tool.slice(0, 64),
        repositoryFullName: entry.repositoryFullName ?? null,
        issueNumber: entry.issueNumber ?? null,
        outcome: entry.outcome,
        errorCode: entry.errorCode?.slice(0, 64) ?? null,
      },
    })
    .catch((error) => console.error("[review-agent] 監査の記録に失敗しました", error));
}

export type CreateTokenInput = { userId: string; name: string; scopes: string[]; repositories: string[]; expiresInDays: number };
export type CreateTokenResult =
  | { ok: true; token: string; id: string; tokenPrefix: string; expiresAt: Date }
  | { ok: false; code: "invalid_request" | "repository_not_found"; message: string };

/** トークンの発行。値は応答に1度だけ返し、保存はハッシュのみ。許可するrepositoryは発行者が連携しているものに限る */
export async function createReviewAgentToken(input: CreateTokenInput, now = new Date()): Promise<CreateTokenResult> {
  const name = input.name.trim().slice(0, 120);
  const scopes = [...new Set(input.scopes)].filter((s): s is ReviewAgentScope => (REVIEW_AGENT_SCOPES as readonly string[]).includes(s));
  const repositories = [...new Set(input.repositories)];
  if (!name || scopes.length === 0 || scopes.length !== new Set(input.scopes).size) return { ok: false, code: "invalid_request", message: "名前と操作範囲（read・write・resume）が必要です" };
  if (repositories.length === 0 || repositories.length > 50 || repositories.some((r) => !REPOSITORY_PATTERN.test(r))) {
    return { ok: false, code: "invalid_request", message: "アクセスさせるrepositoryを owner/name の形で1〜50件指定してください（全許可はできません）" };
  }
  if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > MAX_TOKEN_DAYS) {
    return { ok: false, code: "invalid_request", message: `有効期間は1〜${MAX_TOKEN_DAYS}日で指定してください` };
  }
  const owned = await db.repository.findMany({
    where: { fullName: { in: repositories }, installation: { userInstallations: { some: { userId: input.userId } } } },
    select: { fullName: true },
  });
  const missing = repositories.filter((r) => !owned.some((o) => o.fullName === r));
  if (missing.length > 0) return { ok: false, code: "repository_not_found", message: `連携していないrepositoryがあります: ${missing.join(", ")}` };

  const token = `${REVIEW_AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(now.getTime() + input.expiresInDays * 86_400_000);
  const row = await db.reviewAgentToken.create({
    data: {
      userId: input.userId,
      name,
      tokenHash: hashReviewAgentToken(token),
      tokenPrefix: token.slice(0, 8),
      scopes: scopes.join(","),
      repositories,
      expiresAt,
    },
  });
  return { ok: true, token, id: row.id, tokenPrefix: row.tokenPrefix, expiresAt };
}

export async function revokeReviewAgentToken(userId: string, id: string, now = new Date()): Promise<boolean> {
  const result = await db.reviewAgentToken.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: now } });
  return result.count > 0;
}

export async function listReviewAgentTokens(userId: string) {
  const rows = await db.reviewAgentToken.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: parseScopes(row.scopes),
    repositories: parseRepositories(row.repositories),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}
