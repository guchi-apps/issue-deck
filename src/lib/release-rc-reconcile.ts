import { reconcileRcFinalization, reconcileSuccessorWaiting } from "@/lib/release-finalize-run";
import { loadCandidateRow } from "@/lib/release-rc-run";

/**
 * 開始方式の再確認でも公開済み候補の追跡を進める（#4673）。マージ・承認・検証は起動しない。
 * 既存の照合が実際に段階を進めたときだけ続け、最大3巡で本番反映・稼働確認まで追う。
 * 検証待ち・失敗・取得不能で段階が変わらなければ、その候補をブロックしたまま返す。
 * レビュー段階も照合へ渡す。マージ済みなのに修正工程へ戻ってしまった候補（#4805）を本番反映の追跡へ戻すため
 * （条件に合わないレビュー段階の候補は、照合側がGitHubへ問い合わせずに返す）。
 */
export async function reconcileActiveRcPublication(ctx: { owner: string; repo: string; token: string }): Promise<void> {
  const activeKey = `${ctx.owner}/${ctx.repo}`;
  // 後続の確認を待つ候補（#4712）も、mainの今の稼働版で確かめ直す（候補の枠を持たないので下の照合では読まれない）
  await reconcileSuccessorWaiting(ctx);
  const candidate = await loadCandidateRow({ activeKey });
  if (!candidate) return;
  let row = candidate;
  for (let round = 0; round < 3; round++) {
    if (row.activeKey !== activeKey || !["review", "preparing", "awaiting_approval", "deploying", "verifying_production"].includes(row.phase)) return;
    await reconcileRcFinalization(ctx, row.id);
    const next = await loadCandidateRow({ id: row.id });
    if (!next || next.phase === row.phase) return;
    row = next;
  }
}
