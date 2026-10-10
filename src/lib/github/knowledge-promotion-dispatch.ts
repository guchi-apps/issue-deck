import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { checkPromotionCandidates } from "@/lib/github/knowledge-promotion-candidates";
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
 *
 * **起動前に、判定対象になりうる未処理の知見メモがあるかを確かめる**（#4211。AIは呼ばない）。
 * 無ければ起動せず、理由をログへ残す。確認そのものに失敗したときは「候補なし」と区別して
 * 失敗を記録し、取りこぼしを避けるため起動する（起動間隔の制限はそのまま効く）。
 * 省略した候補は処理済みにならず、毎日05:00 JSTのdocs側の日次回収が拾う。
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

/** 確認中に別の報告が来たときの二重確認を避ける */
let checking = false;

export type PromotionDispatchResult =
  | "dispatched"
  | "disabled"
  | "throttled"
  | "failed"
  /** 判定対象の候補が無いため起動しなかった */
  | "skipped";

export async function dispatchKnowledgePromotion(
  now: Date = new Date(),
): Promise<PromotionDispatchResult> {
  const intervalMinutes = promotionDispatchIntervalMinutes();
  if (intervalMinutes === 0) return "disabled";
  if (lastDispatchedAt !== null && now.getTime() - lastDispatchedAt < intervalMinutes * 60_000) {
    return "throttled";
  }
  if (checking) return "throttled";
  checking = true;
  try {
    return await checkAndDispatch(now);
  } finally {
    checking = false;
  }
}

async function checkAndDispatch(now: Date): Promise<PromotionDispatchResult> {
  try {
    const repository = await db.repository.findFirst({
      where: { fullName: KNOWLEDGE_DOCS_REPOSITORY, archived: false },
      include: { installation: true },
    });
    if (!repository) {
      console.warn(`[knowledge-promotion-dispatch] ${KNOWLEDGE_DOCS_REPOSITORY}のRepository行がありません`);
      lastDispatchedAt = now.getTime();
      return "failed";
    }
    const token = await getInstallationToken(repository.installation.installationId);

    const check = await checkPromotionCandidates(token, now);
    if (check.kind === "none") {
      // 起動しなかっただけなので間引きの時刻は進めない（直後に新しいメモが付けば次の報告で拾う）
      console.info(
        `[knowledge-promotion-dispatch] 起動を省略しました: reason=${check.reason} inspected=${check.inspected}（未処理は日次回収が拾います）`,
      );
      return "skipped";
    }
    if (check.kind === "failed") {
      console.error(`[knowledge-promotion-dispatch] 候補の確認に失敗しました（候補なしではありません。起動します）: ${check.message}`);
    } else {
      console.info(`[knowledge-promotion-dispatch] 候補あり: ${check.issues.join(", ")}`);
    }

    // 失敗しても間引く（Appの権限不足などで報告のたびに叩き続けない）
    lastDispatchedAt = now.getTime();
    const [owner, repo] = KNOWLEDGE_DOCS_REPOSITORY.split("/");
    await dispatchWorkflow(owner, repo, PROMOTION_WORKFLOW_FILE, repository.defaultBranch, {}, token);
    return "dispatched";
  } catch (error) {
    console.error("[knowledge-promotion-dispatch] 起動に失敗しました:", error);
    lastDispatchedAt = now.getTime();
    return "failed";
  }
}
