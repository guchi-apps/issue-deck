import { GITHUB_API, githubFetch } from "@/lib/github/request";

/**
 * リリース履歴の項目チェック（#4374）が使う、GitHub Release本文の読み書き。
 *
 * **ETagのキャッシュを通さない**（`githubFetch`の素のGET）。書き換える前の本文が古いと、その間の
 * 手動編集を丸ごと上書きしてしまうため、書く直前に必ず最新を取り直す。
 */

export type ReleaseBodySnapshot = { id: number; body: string };

export type ReleaseBodyFetchResult =
  | { ok: true; release: ReleaseBodySnapshot }
  | { ok: false; reason: "not_found" | "permission_denied" | "github_error"; status: number };

export async function fetchReleaseBodyByTag(
  owner: string,
  repo: string,
  tagName: string,
  token: string,
): Promise<ReleaseBodyFetchResult> {
  const res = await githubFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tagName)}`,
    token,
  );
  if (res.status === 404) return { ok: false, reason: "not_found", status: 404 };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "permission_denied", status: res.status };
  }
  if (!res.ok) return { ok: false, reason: "github_error", status: res.status };
  const json: { id?: number; body?: string | null } = await res.json().catch(() => ({}));
  if (typeof json.id !== "number") return { ok: false, reason: "github_error", status: res.status };
  return { ok: true, release: { id: json.id, body: json.body ?? "" } };
}

export type ReleaseBodyUpdateResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "permission_denied" | "github_error"; status: number };

export async function updateReleaseBody(
  owner: string,
  repo: string,
  releaseId: number,
  body: string,
  token: string,
): Promise<ReleaseBodyUpdateResult> {
  const res = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/releases/${releaseId}`, token, {
    method: "PATCH",
    body: { body },
  });
  if (res.ok) return { ok: true };
  if (res.status === 404) return { ok: false, reason: "not_found", status: 404 };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "permission_denied", status: res.status };
  }
  return { ok: false, reason: "github_error", status: res.status };
}
