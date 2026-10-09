import { describe, it, expect, vi } from 'vitest';
import { eligible, repairEligible, processPullRequest } from './lib/ios-precheck-automation.mjs';
const repo = 'guchi-apps/yoteiflow';
const sha = 'a'.repeat(40);
const pr = () => ({ state: 'open', draft: false, mergeable: true, base: { ref: 'develop' }, head: { ref: 'issue-1197', sha, repo: { full_name: repo } } });
const failed = { state: 'failed', requestedSha: sha, verifiedSha: sha, failedStage: 'build' };
function fixture(result = failed) {
  return { readPr: vi.fn().mockResolvedValue(pr()), status: vi.fn(), busy: vi.fn().mockResolvedValue(false),
    verify: vi.fn().mockResolvedValue(result), repair: vi.fn().mockResolvedValue(true), save: vi.fn(), report: vi.fn() };
}
describe('iOS事前検証の自動巡回', () => {
  it('バンプPRも対象、draft/fork/main/確認待ちは対象外', () => {
    const p = pr(); p.head.ref = 'release/v4.16.2'; expect(eligible(p, repo)).toBe(true);
    for (const other of [{ ...p, draft: true }, { ...p, base: { ref: 'main' } },
      { ...p, head: { ...p.head, repo: { full_name: 'other/fork' } } },
      { ...p, state: 'closed' }, { ...p, labels: [{ name: '00.check-user' }] }]) {
      expect(eligible(other, repo)).toBe(false);
    }
  });
  it.each(['workflow-tag/v48', 'release/next', 'dependabot/npm/package', 'fix/custom'])('Issueなしの%sも最新SHAを実際に検証する', async ref => {
    const p = pr(); p.head.ref = ref;
    expect(eligible(p, repo)).toBe(true);
    expect(repairEligible(p, repo)).toBe(false);
    const io = fixture({ ...failed, state: 'succeeded' });
    io.readPr.mockResolvedValue(p);
    expect(await processPullRequest(io, repo, 1202, {})).toBe('success');
    expect(io.verify).toHaveBeenCalledWith(repo, sha);
    expect(io.report).toHaveBeenCalledWith(repo, sha, 'success', undefined);
    expect(io.repair).not.toHaveBeenCalled();
  });
  it('配布PRのビルド失敗を成功扱いせず、自動修正pushも行わない', async () => {
    const p = pr(); p.head.ref = 'workflow-tag/v48';
    const io = fixture(); io.readPr.mockResolvedValue(p);
    expect(await processPullRequest(io, repo, 1202, {})).toBe('blocked');
    expect(io.save).toHaveBeenLastCalledWith({ blockedSha: sha, reason: 'repair_not_allowed' });
    expect(io.report).toHaveBeenCalledWith(repo, sha, 'failure', expect.any(String));
    expect(io.repair).not.toHaveBeenCalled();
  });
  it.each(['issue-1197', 'release/v4.16.2'])('%sの自動修正範囲は維持する', ref => {
    const p = pr(); p.head.ref = ref;
    expect(repairEligible(p, repo)).toBe(true);
  });
  it('成功済みSHAを再実行しない', async () => {
    const io = fixture(); io.status.mockResolvedValue('success');
    expect(await processPullRequest(io, repo, 1, {})).toBe('success');
    expect(io.verify).not.toHaveBeenCalled();
  });
  it('検証成功は同一SHAだけに報告する', async () => {
    const io = fixture({ ...failed, state: 'succeeded' });
    expect(await processPullRequest(io, repo, 1, {})).toBe('success');
    expect(io.report).toHaveBeenCalledWith(repo, sha, 'success', undefined);
    expect(io.repair).not.toHaveBeenCalled();
  });
  it('SHA不一致の結果を採用しない', async () => {
    const io = fixture({ ...failed, verifiedSha: 'b'.repeat(40), state: 'succeeded' });
    expect(await processPullRequest(io, repo, 1, {})).toBe('blocked');
    expect(io.repair).not.toHaveBeenCalled();
  });
  it('ビルド失敗で修正を起動し、回数を先に保存する', async () => {
    const io = fixture();
    expect(await processPullRequest(io, repo, 1, {})).toBe('repaired');
    expect(io.save).toHaveBeenNthCalledWith(1, { fixes: 1, repairingSha: sha });
    expect(io.save.mock.invocationCallOrder[0]).toBeLessThan(io.repair.mock.invocationCallOrder[0]);
    expect(io.report).not.toHaveBeenCalledWith(repo, sha, 'success', expect.anything());
  });
  it('検証中に更新されたPRは修正しない', async () => {
    const io = fixture(); const newer = pr(); newer.head.sha = 'b'.repeat(40);
    io.readPr.mockResolvedValueOnce(pr()).mockResolvedValueOnce(newer);
    expect(await processPullRequest(io, repo, 1, {})).toBe('stale');
    expect(io.repair).not.toHaveBeenCalled();
  });
  it.each([{ fixes: 3 }, { fixes: 1, repairingSha: sha }, { blockedSha: sha }])('上限・中断・停止状態を再起動後も尊重する %j', async state => {
    const io = fixture(); expect(await processPullRequest(io, repo, 1, state)).toBe('blocked');
    expect(io.repair).not.toHaveBeenCalled();
  });
  it('SSH切断は次巡に同一SHAのジョブへ再接続する', async () => {
    const io = fixture({ ...failed, state: 'waiting', waitingReason: 'disconnected' });
    expect(await processPullRequest(io, repo, 1, {})).toBe('waiting');
    expect(io.save).not.toHaveBeenCalled(); expect(io.repair).not.toHaveBeenCalled();
  });
  it('環境障害ではコード修正しない', async () => {
    const io = fixture({ ...failed, failedStage: 'prepare' });
    expect(await processPullRequest(io, repo, 1, {})).toBe('blocked');
    expect(io.repair).not.toHaveBeenCalled();
  });
  it('他の実装中・停止中は検証も開始しない', async () => {
    const io = fixture(); io.busy.mockResolvedValue(true);
    expect(await processPullRequest(io, repo, 1, {})).toBe('busy'); expect(io.verify).not.toHaveBeenCalled();
  });
  it('修正不能なら停止する', async () => {
    const io = fixture(); io.repair.mockResolvedValue(false);
    expect(await processPullRequest(io, repo, 1, {})).toBe('blocked');
    expect(io.save).toHaveBeenLastCalledWith({ fixes: 1, repairingSha: sha, blockedSha: sha, reason: 'repair_failed' });
  });
});
