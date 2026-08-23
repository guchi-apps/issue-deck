/**
 * 画面から届いた立ち上げの決めごとを、扱える形へ落とす（#2188）。
 *
 * **知らない値は既定へ倒さず、全体を`null`（不正な要求）にする。** ここは実際に
 * リポジトリを作る経路なので、「種別が読めなかったので`next-db`にした」のような
 * 黙った補正をすると、押した人が見た画面と違うものが作られる。
 *
 * 純粋関数なのでテストできる。
 */

import {
  NEW_APP_KINDS,
  emptyNewAppSpec,
  type NewAppAuth,
  type NewAppKind,
  type NewAppSpec,
  type NewAppUrlMode,
} from "@/lib/new-app/spec";

const KINDS = new Set<NewAppKind>(NEW_APP_KINDS);
const AUTHS = new Set<NewAppAuth>(["none", "supabase-google", "fastapi-google"]);
const URL_MODES = new Set<NewAppUrlMode>(["subdomain", "path"]);

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > maxLength ? null : trimmed;
}

export function parseNewAppSpec(value: unknown): NewAppSpec | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const displayName = text(raw.displayName, 120);
  const repositoryName = text(raw.repositoryName, 80);
  const summary = text(raw.summary, 300);
  const subdomain = text(raw.subdomain, 60);
  const basePath = text(raw.basePath, 60);
  if (displayName === null || repositoryName === null || summary === null) return null;
  if (subdomain === null || basePath === null) return null;

  if (raw.visibility !== "public" && raw.visibility !== "private") return null;
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind as NewAppKind)) return null;
  if (typeof raw.urlMode !== "string" || !URL_MODES.has(raw.urlMode as NewAppUrlMode)) return null;
  if (typeof raw.auth !== "string" || !AUTHS.has(raw.auth as NewAppAuth)) return null;
  if (typeof raw.multiAgent !== "boolean") return null;

  let port: number | null = null;
  if (raw.port !== null && raw.port !== undefined) {
    if (typeof raw.port !== "number" || !Number.isInteger(raw.port)) return null;
    port = raw.port;
  }

  const databaseName = raw.databaseName === null || raw.databaseName === undefined
    ? null
    : text(raw.databaseName, 64);
  if (databaseName === null && raw.databaseName !== null && raw.databaseName !== undefined) {
    return null;
  }

  return {
    ...emptyNewAppSpec(),
    displayName,
    repositoryName,
    visibility: raw.visibility,
    summary,
    kind: raw.kind as NewAppKind,
    urlMode: raw.urlMode as NewAppUrlMode,
    subdomain,
    basePath,
    port,
    databaseName: databaseName || null,
    auth: raw.auth as NewAppAuth,
    multiAgent: raw.multiAgent,
  };
}
