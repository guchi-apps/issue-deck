import type { SharedToken as SharedTokenRow, SharedTokenUsage } from "@prisma/client";

import type { SharedToken, SharedTokenInput } from "@/types/shared-token";

export const SHARED_TOKEN_NAME_MAX_LENGTH = 100;
export const SHARED_TOKEN_VALUE_MAX_LENGTH = 16_384;
export const SHARED_TOKEN_DESCRIPTION_MAX_LENGTH = 1_000;
export const SHARED_TOKEN_SOURCE_REFERENCE_MAX_LENGTH = 500;
export const SHARED_TOKEN_CONSUMER_MAX_LENGTH = 100;

type SharedTokenWithUsages = SharedTokenRow & { usages: SharedTokenUsage[] };

function optionalText(value: unknown, maxLength: number): string | null | undefined {
  // 画面は空欄を null で送るため、undefined（キー省略）と同じく未入力として扱う（#3547）。
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= maxLength ? trimmed : undefined;
}

export function parseSharedTokenInput(payload: unknown): SharedTokenInput | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const value = typeof body.value === "string" ? body.value : "";
  const description = optionalText(body.description, SHARED_TOKEN_DESCRIPTION_MAX_LENGTH);
  const sourceReference = optionalText(body.sourceReference, SHARED_TOKEN_SOURCE_REFERENCE_MAX_LENGTH);
  if (
    !name ||
    name.length > SHARED_TOKEN_NAME_MAX_LENGTH ||
    !value ||
    value.length > SHARED_TOKEN_VALUE_MAX_LENGTH ||
    description === undefined ||
    sourceReference === undefined
  ) {
    return null;
  }
  return { name, value, description, sourceReference };
}

export function parseSharedTokenConsumer(value: string | null): string | null {
  if (!value) return null;
  const consumer = value.trim();
  return consumer && consumer.length <= SHARED_TOKEN_CONSUMER_MAX_LENGTH ? consumer : null;
}

export function toSharedToken(row: SharedTokenWithUsages): SharedToken {
  const usages = [...row.usages].sort((a, b) => b.usedAt.getTime() - a.usedAt.getTime());
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceReference: row.sourceReference,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: usages[0]?.usedAt.toISOString() ?? null,
    consumers: [...new Set(usages.map((usage) => usage.consumer))],
  };
}
