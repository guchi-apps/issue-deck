import type { EpicPlanRegistrar } from "@/lib/epic-draft/create";

/**
 * 実行計画の登録（#4535）への接続点。**登録できない間は完了にしない**ため、未接続なら失敗を返す。
 * #4535のdevelopマージ後に、`src/lib/execution-plan/register.ts`の登録関数へつなぐ。
 */
export function getEpicPlanRegistrar(userId: string): EpicPlanRegistrar {
  void userId;
  return async () => ({ ok: false, message: "実行計画の登録が利用できません（#4535の共通計画登録が未接続です）" });
}
