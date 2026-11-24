import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import {
  AUTO_APPROVAL_WAIT_LABEL,
  buildAutoApprovalRequestKey,
  decideAutoApproval,
  type AutoApprovalWait,
} from "@/lib/release-auto-approval";
import { requestRcFinalize } from "@/lib/release-finalize-run";
import { loadRcOverview } from "@/lib/release-rc-run";

/**
 * RCの公開承認の自動化（#5629）の巡回。判断は純関数`decideAutoApproval`、承認の作成は既存の`requestRcFinalize`
 * （人が押したときと同じ経路。押した時点のhead・mainの先端・合格した契約が全て一致するときだけ受け付ける）。
 *
 * - 設定（`AppSetting.releaseAutoApprovalEnabled`）がOFFなら何もしない（候補も読まない）
 * - 承認者は候補の作成者。要求キーは`auto-`始まりで、人が押した承認と区別できる
 * - 同じ候補・同じheadへの再送は`requestRcFinalize`が既存の結果を返すので、公開準備を二重に作らない
 */

const ATTEMPT_INTERVAL_MS = 2 * 60 * 1000;
/** 候補ごとの直近の試行時刻。GitHubの読み取りを巡回のたびに繰り返さないための間引き（プロセス内のみ） */
const lastAttemptAt = new Map<string, number>();

export type AutoApprovalSweepAction = { candidateId: string; repositoryFullName: string; action: "approved" | "waiting" | "failed"; detail?: string };

export async function readReleaseAutoApprovalEnabled(): Promise<boolean> {
  const row = await db.appSetting.findUnique({ where: { id: 1 }, select: { releaseAutoApprovalEnabled: true } });
  return row?.releaseAutoApprovalEnabled ?? false;
}

export async function runReleaseAutoApprovalSweep(now: Date = new Date()): Promise<{ scanned: number; actions: AutoApprovalSweepAction[] }> {
  if (!(await readReleaseAutoApprovalEnabled())) return { scanned: 0, actions: [] };
  const candidates = await db.releaseCandidate.findMany({
    where: { activeKey: { not: null }, phase: "review", currentRevision: { gt: 0 } },
    select: { id: true, repositoryFullName: true, createdByUserId: true },
  });
  const actions: AutoApprovalSweepAction[] = [];
  for (const candidate of candidates) {
    const last = lastAttemptAt.get(candidate.id);
    if (last !== undefined && now.getTime() - last < ATTEMPT_INTERVAL_MS) continue;
    lastAttemptAt.set(candidate.id, now.getTime());
    try {
      const action = await attempt(candidate);
      if (action) actions.push(action);
    } catch (error) {
      // 1本の障害で他の候補を止めない。次の巡回で再評価する
      console.error("[runReleaseAutoApprovalSweep]", candidate.repositoryFullName, candidate.id, error);
    }
  }
  return { scanned: candidates.length, actions };
}

async function attempt(candidate: { id: string; repositoryFullName: string; createdByUserId: string | null }): Promise<AutoApprovalSweepAction | null> {
  // 承認者にできる作成者が分からない候補は代行しない（人が押す）
  if (!candidate.createdByUserId) return null;
  const repository = await db.repository.findFirst({ where: { fullName: candidate.repositoryFullName }, include: { installation: true } });
  if (!repository) return null;
  const token = await getInstallationToken(repository.installation.installationId);
  const owner = repository.ownerLogin;
  const repo = repository.name;

  const overview = await loadRcOverview({ owner, repo, token });
  const view = overview.candidate;
  if (!view || view.id !== candidate.id || view.prNumber === null) return null;
  const contract = view.finalizeContract;

  let reviewAgent: string | null = null;
  let labels: string[] = [];
  if (contract) {
    const review = await db.releaseVerification.findFirst({
      where: { repoFullName: candidate.repositoryFullName, prNumber: contract.prNumber, baseSha: contract.baseSha, headSha: contract.headSha, kind: "ai_review" },
      select: { agent: true },
    });
    reviewAgent = review?.agent ?? null;
    const pull = await fetchPullRequest(owner, repo, contract.prNumber, token);
    labels = (pull.labels ?? []).map((label: { name?: string }) => label.name ?? "");
  }

  const decision = decideAutoApproval({ enabled: true, phase: view.phase, contract, reviewAgent, labels });
  if (!decision.approve) return waiting(candidate, decision.wait);
  if (!contract) return null;

  const result = await requestRcFinalize({
    owner,
    repo,
    token,
    userId: candidate.createdByUserId,
    candidateId: candidate.id,
    expectedHeadSha: contract.headSha,
    bumpKind: null,
    requestKey: buildAutoApprovalRequestKey(candidate.id, contract.headSha),
    approvePublish: true,
  });
  if (result.ok) {
    console.info("[release-auto-approval] 公開承認を自動で出しました", candidate.repositoryFullName, candidate.id, contract.headSha);
    return { candidateId: candidate.id, repositoryFullName: candidate.repositoryFullName, action: "approved" };
  }
  return { candidateId: candidate.id, repositoryFullName: candidate.repositoryFullName, action: "failed", detail: `${result.error}${"message" in result && result.message ? `: ${result.message}` : ""}` };
}

function waiting(candidate: { id: string; repositoryFullName: string }, wait: AutoApprovalWait): AutoApprovalSweepAction {
  return { candidateId: candidate.id, repositoryFullName: candidate.repositoryFullName, action: "waiting", detail: AUTO_APPROVAL_WAIT_LABEL[wait] };
}
