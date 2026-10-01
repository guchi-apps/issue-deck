const DEFAULT_REDIRECT_PATH = "/dashboard";

/**
 * ログイン後の遷移先として渡された値（`callbackUrl`・`next`）が、同一オリジン内のパスかを判定する。
 * `${origin}${next}`のように連結される値は、`@evil.example/x`や`.evil.example`で別ホストへ
 * 向けられるため、`/`で始まり、`//`・`/\`（ブラウザが`//`と同じに扱う）で始まらないものだけを通す。
 * 外れた値・空の値は`/dashboard`へ倒す。
 */
export function toSafeRedirectPath(value: string | null | undefined): string {
  if (!value) return DEFAULT_REDIRECT_PATH;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return DEFAULT_REDIRECT_PATH;
  }
  return value;
}
