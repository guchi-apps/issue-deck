import { db } from "@/lib/db";
import { mergePullRequest } from "@/lib/github/actions-api";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  decidePromotionMerge,
  promotionMergeIntervalMinutes,
} from "@/lib/github/knowledge-promotion-merge";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import { KNOWLEDGE_DOCS_REPOSITORY, PROMOTION_BRANCH_PREFIX } from "@/lib/knowledge-promotion-pr";

/**
 * 共通知識の反映PR（`guchi-apps/docs`の`knowledge/promote-*`）を自動でマージする巡回（#3645）。
 *
 * 以前は「共通知識」画面の「マージする」ボタンで人がマージしていた（#2950）。格上げ判定
 * （`guchi-apps/docs`の`promote-knowledge.yml`）が承認したものだけがPRになるため、人の関門を
 * 外して判定に任せる。**マージ可能（`mergeable_state`が`clean`）と確かめられたPRだけ**を
 * マージし、チェック待ち・失敗・コンフリクト・判定不能は見送って次の巡回で見直す。
 *
 * 呼ぶのはpoller（`POST /api/knowledge/promotion-merge-sweep`）。間隔の判定はここで持つ。
 */

export type PromotionMergeResult = {
  swept: boolean;
  disabled: boolean;
  merged: number[];
  /** チェック待ち・判定待ちで見送った（次の巡回で見直す） */
  pending: number[];
  /** マージできない状態で見送った */
  blocked: number[];
  failed: number[];
};

function emptyResult(overrides: Partial<PromotionMergeResult> = {}): PromotionMergeResult {
  return { swept: false, disabled: false, merged: [], pending: [], blocked: [], failed: [], ...overrides };
}

/** プロセス内だけの最終巡回時刻。再起動で忘れても「1回余分に巡回する」だけで冪等 */
let lastSweptAt: number | null = null;

export function resetPromotionMergeIntervalForTest(): void {
  lastSweptAt = null;
}

type PullSummary = { number: number; head: { ref: string } };
type PullDetail = { draft?: boolean; mergeable_state?: string | null };

async function getJson<T>(url: string, token: string): Promise<T> {
  const res = await githubFetch(url, token);
  if (!res.ok) throw new Error(`GitHub API request failed: ${res.status} ${url}`);
  return (await res.json()) as T;
}

export async function runPromotionMergeSweep(
  options: { force?: boolean; now?: Date } = {},
): Promise<PromotionMergeResult> {
  const now = options.now ?? new Date();
  const intervalMinutes = promotionMergeIntervalMinutes();
  if (intervalMinutes === 0) return emptyResult({ disabled: true });
  if (
    !options.force &&
    lastSweptAt !== null &&
    now.getTime() - lastSweptAt < intervalMinutes * 60_000
  ) {
    return emptyResult();
  }
  lastSweptAt = now.getTime();

  const repository = await db.repository.findFirst({
    where: { fullName: KNOWLEDGE_DOCS_REPOSITORY, archived: false },
    include: { installation: true },
  });
  if (!repository) return emptyResult({ swept: true });

  const result = emptyResult({ swept: true });
  const token = await getInstallationToken(repository.installation.installationId);
  const base = `${GITHUB_API}/repos/${KNOWLEDGE_DOCS_REPOSITORY}/pulls`;

  const open = await getJson<PullSummary[]>(`${base}?state=open&per_page=100`, token);
  for (const pull of open.filter((p) => p.head.ref.startsWith(PROMOTION_BRANCH_PREFIX))) {
    try {
      const detail = await getJson<PullDetail>(`${base}/${pull.number}`, token);
      const decision = decidePromotionMerge(detail);
      if (decision === "skip_pending") result.pending.push(pull.number);
      else if (decision === "skip_blocked") result.blocked.push(pull.number);
      else {
        await mergePullRequest("guchi-apps", "docs", pull.number, token);
        result.merged.push(pull.number);
      }
    } catch (error) {
      // 1件の失敗で巡回を止めない。次の巡回で拾い直せる
      console.error(`[knowledge-promotion-merge] #${pull.number}:`, error);
      result.failed.push(pull.number);
    }
  }
  return result;
}
