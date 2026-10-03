import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { dispatchWorkflow } from "@/lib/github/workflow-dispatch";
import type { ProgressStatusKey } from "@/lib/issue-progress";
import { KNOWLEDGE_DOCS_REPOSITORY } from "@/lib/knowledge-promotion-pr";

/**
 * 共通知識の格上げ判定（`guchi-apps/docs`の`promote-knowledge.yml`）を都度起動する（#3814）。
 *
 * 判定は日次cron（毎日05:00 JST）だけだと、失敗の知見が反映される前に別リポジトリで同じ失敗を
 * しうる。実装がdevelopへ入った・Issueがcloseされた時点（＝判定の対象になる条件、
 * docs/shared-knowledge.md 9.2）で起動する。**日次cronは取りこぼしの回収として残す。**
 *
 * 起動は`workflow_dispatch`だけで、判定・PR作成はdocs側が行う。docs側のconcurrencyが同時実行を
 * 1本に絞り、未マージの反映PRがあれば判定を見送る（docs#126）ので、ここは連続発火を
 * 間引くだけでよい。失敗しても進捗報告を止めない（呼び出し側は結果を使わない）。
 */

export const PROMOTION_DISPATCH_DEFAULT_INTERVAL_MINUTES = 10;
const PROMOTION_WORKFLOW_FILE = "promote-knowledge.yml";

/** 起動の契機にする進捗。知見メモの判定対象（実装がマージ済み・Issueがclose）に入る遷移 */
const TRIGGER_STATUSES: readonly ProgressStatusKey[] = ["develop", "done", "closed"];

export function isPromotionTriggerStatus(status: ProgressStatusKey): boolean {
  return TRIGGER_STATUSES.includes(status);
}

/** 起動の最小間隔（分）。数値でなければ既定値。**0未満は既定、0は「間引かない」ではなく無効** */
export function promotionDispatchIntervalMinutes(
  raw: string | undefined = process.env.KNOWLEDGE_PROMOTION_DISPATCH_INTERVAL_MINUTES,
): number {
  if (raw === undefined || raw.trim() === "") return PROMOTION_DISPATCH_DEFAULT_INTERVAL_MINUTES;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return PROMOTION_DISPATCH_DEFAULT_INTERVAL_MINUTES;
  return value;
}

/** プロセス内だけの最終起動時刻。再起動で忘れても「1回余分に起動する」だけで冪等 */
let lastDispatchedAt: number | null = null;

export function resetPromotionDispatchForTest(): void {
  lastDispatchedAt = null;
}

export type PromotionDispatchResult = "dispatched" | "disabled" | "throttled" | "failed";

export async function dispatchKnowledgePromotion(
  now: Date = new Date(),
): Promise<PromotionDispatchResult> {
  const intervalMinutes = promotionDispatchIntervalMinutes();
  if (intervalMinutes === 0) return "disabled";
  if (lastDispatchedAt !== null && now.getTime() - lastDispatchedAt < intervalMinutes * 60_000) {
    return "throttled";
  }
  // 失敗しても間引く（Appの権限不足などで報告のたびに叩き続けない）
  lastDispatchedAt = now.getTime();

  try {
    const repository = await db.repository.findFirst({
      where: { fullName: KNOWLEDGE_DOCS_REPOSITORY, archived: false },
      include: { installation: true },
    });
    if (!repository) {
      console.warn(`[knowledge-promotion-dispatch] ${KNOWLEDGE_DOCS_REPOSITORY}のRepository行がありません`);
      return "failed";
    }
    const token = await getInstallationToken(repository.installation.installationId);
    const [owner, repo] = KNOWLEDGE_DOCS_REPOSITORY.split("/");
    await dispatchWorkflow(owner, repo, PROMOTION_WORKFLOW_FILE, repository.defaultBranch, {}, token);
    return "dispatched";
  } catch (error) {
    console.error("[knowledge-promotion-dispatch] 起動に失敗しました:", error);
    return "failed";
  }
}
