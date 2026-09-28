/**
 * Supabase Management API（Redirect URLsの自動管理。#3568）の薄いラッパー。
 *
 * 共有Supabaseプロジェクトの Auth > URL Configuration の Redirect URLs（`uri_allow_list`）を
 * ダッシュボードを開かずに一覧・追加・置換・削除する。サーバー専用（`SUPABASE_MANAGEMENT_API_TOKEN`
 * を使うため、呼び出しはAPI Route等のサーバーサイドに限る）。
 *
 * **一覧はキャッシュしない。** 追加・置換・削除のたびに最新の`uri_allow_list`を読み直してから
 * 書き込む。他経路（Supabaseダッシュボードでの直接編集、他アプリの立ち上げ・終了）での変更が
 * 割り込んでいても、古い一覧のまま上書きしないため。
 */

const MANAGEMENT_API_BASE = "https://api.supabase.com/v1";

export class SupabaseManagementApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SupabaseManagementApiError";
  }
}

function projectRef(): string {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const match = /^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/.exec(url);
  if (!match) {
    throw new SupabaseManagementApiError(
      500,
      "NEXT_PUBLIC_SUPABASE_URLからプロジェクトrefを取得できません",
    );
  }
  return match[1];
}

function managementApiToken(): string {
  const token = (process.env.SUPABASE_MANAGEMENT_API_TOKEN ?? "").trim();
  if (!token) {
    throw new SupabaseManagementApiError(500, "SUPABASE_MANAGEMENT_API_TOKENが未設定です");
  }
  return token;
}

/** 値そのものは例外メッセージにも含めない（トークン・登録済みURLを画面やログへ漏らさないため） */
async function authConfigRequest(method: "GET" | "PATCH", body?: string): Promise<unknown> {
  const ref = projectRef();
  const token = managementApiToken();

  const res = await fetch(`${MANAGEMENT_API_BASE}/projects/${ref}/config/auth`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!res.ok) {
    throw new SupabaseManagementApiError(
      res.status,
      `Supabase Management APIの呼び出しに失敗しました (${res.status})`,
    );
  }

  return res.json();
}

export const REDIRECT_URL_MAX_LENGTH = 500;

/**
 * APIリクエストのボディ（JSON.parse直後のunknown値）を検証する。不正な値はnullへ落とす。
 *
 * `uri_allow_list`はカンマ区切りでエンコードされる（`writeAllowList`）ため、カンマを含む値を
 * 1件として受け付けると実質的に複数URLとして登録されてしまう（レビュー指摘）。
 */
export function parseRedirectUrlInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > REDIRECT_URL_MAX_LENGTH) return null;
  if (trimmed.includes(",")) return null;
  if (!/^https?:\/\//.test(trimmed)) return null;
  return trimmed;
}

function parseAllowList(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

async function currentAllowList(): Promise<string[]> {
  const config = await authConfigRequest("GET");
  const uriAllowList = (config as { uri_allow_list?: unknown } | null)?.uri_allow_list;
  return parseAllowList(uriAllowList);
}

async function writeAllowList(urls: string[]): Promise<string[]> {
  await authConfigRequest("PATCH", JSON.stringify({ uri_allow_list: urls.join(",") }));
  return urls;
}

export async function listRedirectUrls(): Promise<string[]> {
  return currentAllowList();
}

export async function addRedirectUrl(url: string): Promise<string[]> {
  const current = await currentAllowList();
  if (current.includes(url)) {
    throw new SupabaseManagementApiError(409, "既に登録されています");
  }
  return writeAllowList([...current, url]);
}

/** `oldUrl`が現在の一覧に無ければ404相当。他経路で既に変更された可能性があるため呼び出し側は一覧を再取得する */
export async function replaceRedirectUrl(oldUrl: string, newUrl: string): Promise<string[]> {
  const current = await currentAllowList();
  if (!current.includes(oldUrl)) {
    throw new SupabaseManagementApiError(404, "対象のURLが見つかりません");
  }
  if (oldUrl !== newUrl && current.includes(newUrl)) {
    throw new SupabaseManagementApiError(409, "変更後のURLは既に登録されています");
  }
  return writeAllowList(current.map((url) => (url === oldUrl ? newUrl : url)));
}

/** 対象が既に無い場合は「消したい状態と一致している」として何もせず現在の一覧を返す（冪等） */
export async function removeRedirectUrl(url: string): Promise<string[]> {
  const current = await currentAllowList();
  if (!current.includes(url)) {
    return current;
  }
  return writeAllowList(current.filter((existing) => existing !== url));
}
