import type { QuickFilter as QuickFilterRow } from "@prisma/client";

import { NAV_VIEW_IDS } from "@/types/issue";
import type { QuickFilter, QuickFilterInput } from "@/types/quick-filter";

const STATE_FILTERS = ["all", "open", "closed"] as const;
const SORTS = ["updated", "created"] as const;

export const QUICK_FILTER_NAME_MAX_LENGTH = 50;

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function toQuickFilter(row: QuickFilterRow): QuickFilter {
  return {
    id: row.id,
    name: row.name,
    view: isOneOf(NAV_VIEW_IDS, row.view) ? row.view : "all",
    q: row.q,
    repo: row.repo,
    state: isOneOf(STATE_FILTERS, row.state) ? row.state : "open",
    labels: row.labels ? row.labels.split(",").filter(Boolean) : [],
    assignee: row.assignee,
    sort: isOneOf(SORTS, row.sort) ? row.sort : "created",
  };
}

// APIリクエストのボディ（JSON.parse直後のunknown値）を検証し、DB保存用の入力へ変換する。
// 不正な値は例外を投げず null にフォールバックし、呼び出し側でバリデーションエラーとして扱う。
export function parseQuickFilterInput(payload: unknown): QuickFilterInput | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > QUICK_FILTER_NAME_MAX_LENGTH) return null;

  if (!isOneOf(NAV_VIEW_IDS, body.view)) return null;
  if (!isOneOf(STATE_FILTERS, body.state)) return null;
  if (!isOneOf(SORTS, body.sort)) return null;
  if (typeof body.q !== "string") return null;
  if (body.repo !== null && typeof body.repo !== "string") return null;
  if (body.assignee !== null && typeof body.assignee !== "string") return null;
  if (!Array.isArray(body.labels) || !body.labels.every((label) => typeof label === "string")) {
    return null;
  }

  return {
    name,
    view: body.view,
    q: body.q,
    repo: body.repo,
    state: body.state,
    labels: body.labels,
    assignee: body.assignee,
    sort: body.sort,
  };
}
