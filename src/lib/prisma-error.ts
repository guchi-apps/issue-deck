/**
 * Prismaのエラーコードを判定するヘルパー。
 *
 * **型に依存せずコードだけを見る**——`PrismaClientKnownRequestError`を`instanceof`で
 * 判定すると、生成物の版が変わったときに静かに外れる（外れると、握り潰すつもりだった
 * 競合がそのまま500になる）。
 */

/** Prismaのユニーク制約違反（`P2002`）か。 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
