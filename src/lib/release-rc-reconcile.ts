import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { reconcileRcFinalization, reconcileSuccessorWaiting } from "@/lib/release-finalize-run";
import { loadCandidateRow } from "@/lib/release-rc-run";

type Ctx = { owner: string; repo: string; token: string };

const RECONCILABLE_PHASES = ["review", "preparing", "awaiting_approval", "deploying", "verifying_production"];
/** 段階が変わる限り続ける巡の上限。承認待ち→本番反映→稼働確認→完了の3段を1回で進められる数 */
const MAX_ROUNDS = 3;

/**
 * 1候補を、段階が変わる限り最大3巡まで既存の照合（`reconcileRcFinalization`）に掛ける。
 * 照合は1回で1段しか進めないことがある（承認待ち→本番反映の遷移の後、稼働確認は次の呼び出しで見る）ため、
 * 段階が変わったら続けて呼ぶ。検証待ち・失敗・取得不能で段階が変わらなければそこで返す。
 * `activeKey`を渡すと、完了で枠を空けた後に別の候補へ乗り換えない
 */
export async function reconcileRcUntilSettled(ctx: Ctx, candidateId: string, activeKey?: string): Promise<void> {
  await settle(ctx, await loadCandidateRow({ id: candidateId }), activeKey);
}

type Row = { id: string; phase: string; activeKey: string | null };

async function settle(ctx: Ctx, first: Row | null, activeKey?: string): Promise<void> {
  let row = first;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (!row || (activeKey !== undefined && row.activeKey !== activeKey) || !RECONCILABLE_PHASES.includes(row.phase)) return;
    await reconcileRcFinalization(ctx, row.id);
    const next = await loadCandidateRow({ id: row.id });
    if (!next || next.phase === row.phase) return;
    row = next;
  }
}

/**
 * 開始方式の再確認でも公開済み候補の追跡を進める（#4673）。マージ・承認・検証は起動しない。
 * 既存の照合が実際に段階を進めたときだけ続け、最大3巡で本番反映・稼働確認まで追う。
 * 検証待ち・失敗・取得不能で段階が変わらなければ、その候補をブロックしたまま返す。
 * レビュー段階も照合へ渡す。マージ済みなのに修正工程へ戻ってしまった候補（#4805）を本番反映の追跡へ戻すため
 * （条件に合わないレビュー段階の候補は、照合側がGitHubへ問い合わせずに返す）。
 */
export async function reconcileActiveRcPublication(ctx: Ctx): Promise<void> {
  const activeKey = `${ctx.owner}/${ctx.repo}`;
  // 後続の確認を待つ候補（#4712）も、mainの今の稼働版で確かめ直す（候補の枠を持たないので下の照合では読まれない）
  await reconcileSuccessorWaiting(ctx);
  await settle(ctx, await loadCandidateRow({ activeKey }), activeKey);
}

/** 同じ候補の稼働版を観測する間隔。pollerの巡回ごとにGitHubへ問い合わせないよう間引く */
export const RC_PRODUCTION_SWEEP_INTERVAL_MS = 60_000;

/**
 * mainへ出た後の候補（本番反映中・稼働確認中）を巡回で照合する（#5404）。
 *
 * 以前は稼働確認を進めるのがリリース完了系列の巡回・画面の読み込み・開始方式の再確認だけだった。系列は
 * デプロイの成功を見た時点で閉じるため、同じ巡回で候補が本番反映へ進んだだけだと、その後は誰も
 * 稼働確認を呼ばず候補が`deploying`のまま残り、次の候補も始められなかった。人が手でマージした候補も同じ。
 * ここは系列の有無に関わらず、枠を持つ本番反映中の候補を既存の照合へ渡すだけで、判定は`advanceProduction`が持つ。
 * 直近に観測した候補（`ReleaseProductionCheck.lastObservedAt`）は間引く
 */
export async function runRcProductionSweep(params: { now?: Date } = {}): Promise<{ scanned: number; reconciled: number }> {
  const now = params.now ?? new Date();
  const rows = await db.releaseCandidate.findMany({
    where: { phase: { in: ["deploying", "verifying_production"] }, activeKey: { not: null } },
    select: { id: true, repositoryFullName: true },
  });
  let reconciled = 0;
  for (const row of rows) {
    try {
      const check = await db.releaseProductionCheck.findUnique({ where: { candidateId: row.id }, select: { lastObservedAt: true } });
      if (check?.lastObservedAt && now.getTime() - check.lastObservedAt.getTime() < RC_PRODUCTION_SWEEP_INTERVAL_MS) continue;
      const repository = await db.repository.findFirst({ where: { fullName: row.repositoryFullName }, include: { installation: true } });
      if (!repository) continue;
      const [owner, repo] = row.repositoryFullName.split("/");
      const ctx: Ctx = { owner, repo, token: await getInstallationToken(repository.installation.installationId) };
      await reconcileRcUntilSettled(ctx, row.id, row.repositoryFullName);
      reconciled++;
    } catch (error) {
      // 1候補の障害で他の候補を止めない。次の巡回で再評価する
      console.error("[runRcProductionSweep]", row.repositoryFullName, row.id, error);
    }
  }
  return { scanned: rows.length, reconciled };
}
