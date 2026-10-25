import type { SharedToken as SharedTokenRow, SharedTokenUsage } from "@prisma/client";

import type { SharedToken, SharedTokenInput } from "@/types/shared-token";

export const SHARED_TOKEN_NAME_MAX_LENGTH = 100;
export const SHARED_TOKEN_VALUE_MAX_LENGTH = 16_384;
export const SHARED_TOKEN_DESCRIPTION_MAX_LENGTH = 1_000;
export const SHARED_TOKEN_SOURCE_REFERENCE_MAX_LENGTH = 500;
export const SHARED_TOKEN_CONSUMER_MAX_LENGTH = 100;
/** 1トークンに登録できる想定利用元の数 */
export const SHARED_TOKEN_EXPECTED_CONSUMERS_MAX = 20;

/** 一覧の表示に要る利用記録の要約（利用元ごとの最終利用日時）。全行は読まない（#4165） */
export type SharedTokenUsageSummary = Pick<SharedTokenUsage, "consumer" | "usedAt">;

type SharedTokenWithUsages = SharedTokenRow & { usages: SharedTokenUsageSummary[] };

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
  // value 省略（キー無し・null）はサーバーでの自動生成を意味する（#4121）。空文字は不正として弾く。
  const rawValue = body.value;
  const value = rawValue === undefined || rawValue === null ? null : typeof rawValue === "string" ? rawValue : undefined;
  const description = optionalText(body.description, SHARED_TOKEN_DESCRIPTION_MAX_LENGTH);
  const sourceReference = optionalText(body.sourceReference, SHARED_TOKEN_SOURCE_REFERENCE_MAX_LENGTH);
  if (
    !name ||
    name.length > SHARED_TOKEN_NAME_MAX_LENGTH ||
    value === undefined ||
    (value !== null && (!value || value.length > SHARED_TOKEN_VALUE_MAX_LENGTH)) ||
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

/**
 * 外部APIから書き込める利用元を限定するトークン名（#4164）。
 * issue-deck自身のログイン判定（StatusHub判定API）に使うトークンは、誤った値で上書きされると
 * 全員拒否になり、直す設定画面もログインの後ろにあるため画面から戻せない。
 * StatusHubの再発行経路（#3786）の利用元だけに書き込みを許す。
 */
const PROTECTED_TOKEN_WRITERS: Readonly<Record<string, readonly string[]>> = {
  ISSUE_DECK_ACCESS_APP_TOKEN: ["status-hub", "statushub", "ops-dashboard"],
};

/** この利用元が、そのトークン名へPOST/PUTで書き込んでよいか。 */
export function canWriteSharedToken(name: string, consumer: string): boolean {
  const writers = PROTECTED_TOKEN_WRITERS[name];
  return !writers || writers.includes(consumer.toLowerCase());
}

/**
 * 想定利用元の入力（配列、またはカンマ・空白区切りの文字列）を、小文字・重複なしの配列へ正規化する（#4998）。
 * 不正なら undefined。空配列は「未設定（検知の対象外）」を意味する。
 */
export function parseExpectedConsumers(value: unknown): string[] | undefined {
  const items = typeof value === "string" ? value.split(/[\s,、]+/) : Array.isArray(value) ? value : null;
  if (!items || !items.every((item) => typeof item === "string")) return undefined;
  const consumers = [...new Set(items.map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (consumers.length > SHARED_TOKEN_EXPECTED_CONSUMERS_MAX) return undefined;
  return consumers.every((consumer) => consumer.length <= SHARED_TOKEN_CONSUMER_MAX_LENGTH) ? consumers : undefined;
}

/** DBのJSON列から想定利用元を読む。壊れた値・未設定は空配列（検知の対象外）として扱う */
export function readExpectedConsumers(value: unknown): string[] {
  return parseExpectedConsumers(value ?? []) ?? [];
}

/**
 * 想定外の利用元か（#4998）。想定利用元が未設定のトークンは段階的に広げる前提で検知しない。
 * 利用元は自己申告なので大文字小文字の違いは同じ利用元として扱う。
 */
export function isUnexpectedConsumer(expectedConsumers: readonly string[], consumer: string): boolean {
  return expectedConsumers.length > 0 && !expectedConsumers.includes(consumer.trim().toLowerCase());
}

export function toSharedToken(row: SharedTokenWithUsages): SharedToken {
  const usages = [...row.usages].sort((a, b) => b.usedAt.getTime() - a.usedAt.getTime());
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceReference: row.sourceReference,
    expectedConsumers: readExpectedConsumers(row.expectedConsumers),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: usages[0]?.usedAt.toISOString() ?? null,
    consumers: [...new Set(usages.map((usage) => usage.consumer))],
  };
}
