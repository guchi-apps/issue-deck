// PRの最新HEADだけを検証する。IOを注入し、SHA変更・再起動・修正上限をテストできる形にする。
export const CONTEXT = 'issue-deck/ios-precheck';
export function eligible(pr, repository) {
  return pr.state === 'open' && !pr.draft && pr.base?.ref === 'develop'
    && pr.head?.repo?.full_name === repository
    && typeof pr.head.ref === 'string' && pr.head.ref.length > 0
    && /^[a-f0-9]{40}$/.test(pr.head.sha)
    && !(pr.labels ?? []).some(l => l.name === '00.check-user');
}

// 検証する権限と、AIにコード変更・pushを許す範囲を混同しない。
export function repairEligible(pr, repository) {
  return eligible(pr, repository)
    && /^(issue-[1-9][0-9]*|release\/v[0-9]+\.[0-9]+\.[0-9]+)$/.test(pr.head.ref);
}

export async function processPullRequest(io, repository, number, state, maxFixes = 3) {
  const pr = await io.readPr(repository, number);
  if (!eligible(pr, repository) || pr.mergeable !== true) return 'skip';
  const sha = pr.head.sha;
  const status = await io.status(repository, sha);
  if (status === 'success') {
    await io.save({ fixes: 0 });
    return 'success';
  }
  if (state.blockedSha === sha) return 'blocked';
  // 実装セッションと修復が競合しないよう、ビルドだけの場合も次の巡回へ回す。
  if (await io.busy(pr)) return 'busy';
  const result = await io.verify(repository, sha);
  if (result.requestedSha !== sha || (result.verifiedSha && result.verifiedSha !== sha)) {
    await io.save({ ...state, blockedSha: sha, reason: 'sha_mismatch' });
    await io.report(repository, sha, 'failure', 'iOS事前検証: 検証SHAが一致しません');
    return 'blocked';
  }
  if (result.state === 'succeeded' && result.verifiedSha === sha) {
    // 検証コマンドのstatus投稿が失敗した場合も、次の巡回で同じジョブの結果を再送する。
    await io.report(repository, sha, 'success', result.message);
    await io.save({ fixes: 0 });
    return 'success';
  }
  if (result.state !== 'failed') {
    // SSH切断・待ち時間切れは同一ジョブへ再接続。環境異常は修復せず人へ渡す。
    if (['disconnected', 'wait_timeout'].includes(result.waitingReason)
      || ['queued', 'preparing', 'building', 'testing'].includes(result.state)) return 'waiting';
    await io.save({ ...state, blockedSha: sha, reason: result.waitingReason ?? 'invalid_result' });
    await io.report(repository, sha, 'pending', `iOS検証待ち: ${result.message ?? '結果を確認してください'}`);
    return 'blocked';
  }
  if (result.verifiedSha !== sha || !['build', 'test'].includes(result.failedStage)) {
    await io.save({ ...state, blockedSha: sha, reason: result.failedStage ?? 'environment' });
    await io.report(repository, sha, 'failure', 'iOS検証の環境障害: ログを確認してください');
    return 'blocked';
  }
  const current = await io.readPr(repository, number);
  if (!eligible(current, repository) || current.head.sha !== sha) return 'stale';
  if (!repairEligible(current, repository)) {
    await io.save({ ...state, blockedSha: sha, reason: 'repair_not_allowed' });
    await io.report(repository, sha, 'failure', 'iOS検証失敗: このPRは自動修正対象外です。ログを確認してください');
    return 'blocked';
  }
  if (await io.busy(current)) return 'busy';
  const fixes = state.fixes ?? 0;
  if (fixes >= maxFixes || state.repairingSha === sha) {
    await io.save({ ...state, blockedSha: sha, reason: 'fix_limit_or_interrupted' });
    await io.report(repository, sha, 'failure', 'iOS検証失敗: 自動修正上限または中断。手動確認が必要です');
    return 'blocked';
  }
  // 起動前に回数を永続化。再起動で同じ失敗を無制限に修正しない。
  const next = { fixes: fixes + 1, repairingSha: sha };
  await io.save(next);
  await io.report(repository, sha, 'pending', `iOS検証失敗を自動修正中（${fixes + 1}/${maxFixes}）`);
  const repaired = await io.repair(current, result);
  if (!repaired) {
    await io.save({ ...next, blockedSha: sha, reason: 'repair_failed' });
    await io.report(repository, sha, 'failure', 'iOS検証失敗: 自動修正を停止しました。サブPCのログを確認してください');
    return 'blocked';
  }
  // 次巡で新しいHEADを取り直してMacで検証する。古い成功を転記しない。
  await io.save({ fixes: fixes + 1 });
  return 'repaired';
}
