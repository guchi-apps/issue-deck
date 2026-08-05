export const AUTO_RETRY_LIMIT_MIN = 0;
export const AUTO_RETRY_LIMIT_MAX = 10;

// APIリクエストのボディ（JSON.parse直後のunknown値）を検証し、DB保存用の値へ変換する。
// 不正な値は例外を投げず null にフォールバックし、呼び出し側でバリデーションエラーとして扱う。
export function parseAutoRetryLimit(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < AUTO_RETRY_LIMIT_MIN || value > AUTO_RETRY_LIMIT_MAX) return null;
  return value;
}
