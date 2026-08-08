import type { FineGrainedToken as FineGrainedTokenRow } from "@prisma/client";

import type { FineGrainedToken, FineGrainedTokenInput } from "@/types/fine-grained-token";

export const FINE_GRAINED_TOKEN_NAME_MAX_LENGTH = 100;

// 有効期限までの残り日数がこの日数以下になったら「まもなく期限切れ」として警告する
export const FINE_GRAINED_TOKEN_EXPIRING_SOON_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export type FineGrainedTokenStatus = "expired" | "expiring-soon" | "active";

export function toFineGrainedToken(row: FineGrainedTokenRow): FineGrainedToken {
  return {
    id: row.id,
    name: row.name,
    expiresAt: row.expiresAt.toISOString(),
  };
}

// APIリクエストのボディ（JSON.parse直後のunknown値）を検証し、DB保存用の入力へ変換する。
// 不正な値は例外を投げず null にフォールバックし、呼び出し側でバリデーションエラーとして扱う。
export function parseFineGrainedTokenInput(payload: unknown): FineGrainedTokenInput | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > FINE_GRAINED_TOKEN_NAME_MAX_LENGTH) return null;

  if (typeof body.expiresAt !== "string") return null;
  const expiresAt = new Date(body.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return null;

  return { name, expiresAt: expiresAt.toISOString() };
}

export function getFineGrainedTokenStatus(
  expiresAt: string,
  nowMs: number,
): FineGrainedTokenStatus {
  const diffMs = new Date(expiresAt).getTime() - nowMs;
  if (diffMs <= 0) return "expired";
  if (diffMs <= FINE_GRAINED_TOKEN_EXPIRING_SOON_DAYS * DAY_MS) return "expiring-soon";
  return "active";
}

// 有効期限までの残り日数（切り上げ）。期限切れの場合は0以下になる
export function getFineGrainedTokenRemainingDays(expiresAt: string, nowMs: number): number {
  const diffMs = new Date(expiresAt).getTime() - nowMs;
  return Math.ceil(diffMs / DAY_MS);
}
