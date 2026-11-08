import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// #5268: 重い巡回の途中・即時通知の直後にも枠外ジョブ（CHAT_TURN等）を取りに行く
const source = readFileSync('scripts/subpc-dispatch-poller.sh', 'utf8');
const extract = (names) =>
  names.map((name) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))[0]).join('\n');

const STUBS = `
api_call() { echo "claim" >>"$LOG"; API_RESPONSE_BODY='{"jobs":[{"id":"j1"}]}'; return 0; }
run_job() { echo "run_job" >>"$LOG"; }
exec_pending_self_update() { echo "exec" >>"$LOG"; }
HOST_NAME=subpc; FAST_POLL_INTERVAL=3; ANNOUNCE_ONLY=0; ONCE=0; DRY_RUN=0; SHUTDOWN=0
LAST_OUT_OF_BAND_CLAIM_AT=0
`;

function run(body) {
  const script = `${extract(['claim_out_of_band', 'claim_out_of_band_between_sweeps', 'wait_between_polls'])}
${STUBS}
${body}`;
  const dir = mkdtempSync(join(tmpdir(), 'oob-claim-test-'));
  try {
    const log = join(dir, 'log');
    spawnSync('bash', ['-c', `LOG=${log}; : >"$LOG"\n${script}`], { encoding: 'utf8' });
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it('重い巡回の途中では間隔を空けて取りに行き、自己更新の入れ替えはしない', () => {
  const log = run(`
claim_out_of_band_between_sweeps
claim_out_of_band_between_sweeps
echo "---" >>"$LOG"
LAST_OUT_OF_BAND_CLAIM_AT=$(( $(date +%s) - 3 ))
claim_out_of_band_between_sweeps
`);
  // 1回目は取りに行く。直後の2回目は間隔が足りず取りに行かない。3秒空けば再び取りに行く
  expect(log).toEqual(['claim', 'run_job', '---', 'claim', 'run_job']);
  expect(log).not.toContain('exec');
});

it('--once・申告だけ・軽い巡回の無効化では重い巡回の途中で取りに行かない', () => {
  expect(run('ONCE=1; claim_out_of_band_between_sweeps')).toEqual([]);
  expect(run('ANNOUNCE_ONLY=1; claim_out_of_band_between_sweeps')).toEqual([]);
  expect(run('FAST_POLL_INTERVAL=0; claim_out_of_band_between_sweeps')).toEqual([]);
});

it('待ち時間の軽い巡回は従来どおり自己更新の入れ替えまで行う', () => {
  expect(run('claim_out_of_band')).toEqual(['claim', 'run_job', 'exec']);
});

it('即時通知を受けたら、重い巡回へ戻る前に枠外ジョブを1回だけ取りに行く', () => {
  const log = run(`
POLL_INTERVAL=30
sleep_or_wake() { echo "woke" >>"$LOG"; return 0; }
report_live_session_usage() { :; }
wait_between_polls && echo "returned" >>"$LOG"
`);
  expect(log).toEqual(['woke', 'claim', 'run_job', 'exec', 'returned']);
});

it('重い巡回の途中で保留した自己更新の入れ替えは、巡が終わった直後にメインループが行う', () => {
  const loop = source.match(/^while \[\[ "\$SHUTDOWN" -eq 0 \]\]; do\n[\s\S]*?^done/m)[0];
  const afterRunOnce = loop.slice(loop.indexOf('run_once || true'));
  expect(afterRunOnce.indexOf('exec_pending_self_update')).toBeGreaterThan(0);
  expect(afterRunOnce.indexOf('exec_pending_self_update')).toBeLessThan(afterRunOnce.indexOf('wait_between_polls'));
});
