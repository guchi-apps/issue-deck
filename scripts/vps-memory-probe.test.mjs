import { describe, it, expect } from 'vitest';
import {
  parseRemoteOutput, classifySshFailure, pickProcess, buildSample, readNodeArgsFromConfig,
} from './lib/vps-memory-probe-core.mjs';

const remote = [
  'now=1760000000', 'clk_tck=100', 'btime=1750000000',
  'memtotal=4000000', 'memavailable=900000', 'swaptotal=2000000', 'swapfree=1600000',
  'proc pid=100 title=next-server_(v16.2.12) start_ticks=500000 rss_kb=600000 hwm_kb=700000 threads=15 etimes=3000',
  'proc pid=200 title=next-server_(v16.3.3) start_ticks=600000 rss_kb=300000 hwm_kb=310000 threads=12 etimes=2000',
].join('\n');

describe('parseRemoteOutput', () => {
  it('ホストとプロセスを構造化し、版をタイトルから取る', () => {
    const p = parseRemoteOutput(remote);
    expect(p.host).toEqual({ memTotalKb: 4000000, memAvailableKb: 900000, swapTotalKb: 2000000, swapFreeKb: 1600000 });
    expect(p.procs.map((x) => [x.pid, x.nextVersion, x.rssKb])).toEqual([[100, '16.2.12', 600000], [200, '16.3.3', 300000]]);
  });
  it('読めなかった値は0でなくnullになる', () => {
    const p = parseRemoteOutput('now=1\nproc pid=1 title=next-server_(v1.0.0) start_ticks= rss_kb= hwm_kb= threads= etimes=');
    expect(p.procs[0]).toMatchObject({ rssKb: null, hwmKb: null, startTicks: null });
  });
});

describe('classifySshFailure', () => {
  it('タイムアウト・権限不足・接続失敗を分ける', () => {
    expect(classifySshFailure({ exitCode: 255, timedOut: true })).toBe('timeout');
    expect(classifySshFailure({ exitCode: 255, stderr: 'Permission denied (publickey).' })).toBe('permission_denied');
    expect(classifySshFailure({ exitCode: 255, stderr: 'Could not resolve hostname' })).toBe('ssh_failed');
    expect(classifySshFailure({ exitCode: 1 })).toBe('remote_failed');
  });
});

describe('pickProcess', () => {
  const procs = parseRemoteOutput(remote).procs;
  it('版が一意に一致するプロセスを選ぶ', () => {
    expect(pickProcess(procs, { nextVersion: '16.2.12' }).proc.pid).toBe(100);
  });
  it('他アプリと版が重なって絞れないときは選ばない（ピークを混ぜない）', () => {
    const dup = [...procs, { ...procs[0], pid: 300, startTicks: 1 }];
    expect(pickProcess(dup, { nextVersion: '16.2.12' })).toMatchObject({ reason: 'ambiguous_process', candidates: 2 });
  });
  it('前回のプロセスが生きていれば版が重なっても追い続ける', () => {
    const dup = [...procs, { ...procs[0], pid: 300, startTicks: 1 }];
    expect(pickProcess(dup, { nextVersion: '16.2.12', previousKey: '100-500000' }).proc.pid).toBe(100);
  });
  it('一致なしは取得不可', () => {
    expect(pickProcess(procs, { nextVersion: '9.9.9' }).reason).toBe('process_not_found');
  });
});

describe('buildSample', () => {
  const parsed = parseRemoteOutput(remote);
  it('PID・区間キー・起動時刻つきのokサンプルを作り、取れない項目を理由つきで明示する', () => {
    const pick = pickProcess(parsed.procs, { nextVersion: '16.2.12' });
    const s = buildSample({ sampledAt: 'T', parsed, pick, nodeArgs: { value: 'a', source: 'repo-config' } });
    expect(s).toMatchObject({ status: 'ok', pid: 100, segmentKey: '100-500000', rssKb: 600000, hwmKb: 700000 });
    expect(s.startedAt).toBe(new Date((1750000000 + 5000) * 1000).toISOString());
    expect(s.unavailableFields).toEqual({ heap: 'permission', pm2Restarts: 'permission', smapsTop: 'permission' });
  });
  it('RSSが読めない部分欠測はpartial', () => {
    const p = { ...parsed, procs: [{ ...parsed.procs[0], rssKb: null }] };
    expect(buildSample({ sampledAt: 'T', parsed: p, pick: { proc: { ...p.procs[0], segmentKey: '100-500000' } } }).status).toBe('partial');
  });
  it('プロセスが選べなければ0を作らずunavailable', () => {
    const s = buildSample({ sampledAt: 'T', parsed, pick: { reason: 'ambiguous_process', candidates: 2 } });
    expect(s).toMatchObject({ status: 'unavailable', reason: 'ambiguous_process' });
    expect(s.rssKb).toBeUndefined();
  });
});

it('node_argsをリポジトリ設定から読む', () => {
  expect(readNodeArgsFromConfig('node_args: "--max-old-space-size=256",')).toEqual({ value: '--max-old-space-size=256', source: 'repo-config' });
  expect(readNodeArgsFromConfig('')).toBeNull();
});
