import { createHash } from "node:crypto";

/**
 * 自前のAPIの応答へ付けるETag（#3387）。
 *
 * 10秒おきに取り直す一覧（`GET /api/issues`）は、ほとんどの周回で内容が変わらない。
 * 内容のハッシュをETagにして`If-None-Match`と一致すれば304を返せば、変化の無い周回では
 * 本文を送らずに済む。
 *
 * **`If-None-Match`は画面側が自分で付け、304は画面側が自分で読む。** ブラウザのHTTP
 * キャッシュに任せると304が200に読み替えられて手元の再描画を省けず、304に添えた
 * ヘッダー（取得時刻）がキャッシュ済みの応答へ反映されるかもブラウザ次第になるため。
 *
 * 弱いETag（`W/`）にするのは、Next.jsのgzip圧縮で本文のバイト列が変わっても意味は同じため。
 */
export function buildWeakEtag(value: unknown): string {
  const hash = createHash("sha1").update(JSON.stringify(value)).digest("base64url");
  return `W/"${hash}"`;
}

/**
 * `If-None-Match`がETagに一致するか。複数並び（`a, b`）と`*`、弱い比較（`W/`の有無を
 * 無視する）に対応する。
 */
export function matchesIfNoneMatch(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const opaque = stripWeak(etag);
  return ifNoneMatch
    .split(",")
    .map((tag) => tag.trim())
    .some((tag) => tag === "*" || stripWeak(tag) === opaque);
}

function stripWeak(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}
