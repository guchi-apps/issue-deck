import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// #5656: 起動したセッションを、次の巡回を待たずにその巡の終わりで報告する。
// 報告は巡の冒頭（取得より前）にしか無く、立てただけだと約1分セッションが画面に出ず、
// 「起動しました」なのに開始ボタンが出し直されて起動していないように見えていた
const source = readFileSync('scripts/subpc-dispatch-poller.sh', 'utf8');
const extract = (names) =>
  names.map((name) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))[0]).join('\n');

function run(runJobBody) {
  const script = `${extract(['run_claimed_jobs'])}
report_sessions() { echo "report" >>"$LOG"; return 1; }
run_job() { echo "run_job" >>"$LOG"; ${runJobBody}; }
run_claimed_jobs '{"jobs":[{"id":"j1"},{"id":"j2"}]}'
echo "done" >>"$LOG"
`;
  const dir = mkdtempSync(join(tmpdir(), 'launch-report-test-'));
  try {
    const log = join(dir, 'log');
    spawnSync('bash', ['-c', `set -euo pipefail; LOG=${log}; : >"$LOG"\n${script}`], { encoding: 'utf8' });
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it('セッションを起動できた巡では、ジョブをすべて処理した後に1回だけ報告し直す', () => {
  // 報告の失敗（return 1）で巡回を止めない
  expect(run('SESSION_LAUNCHED_IN_SWEEP=1')).toEqual(['run_job', 'run_job', 'report', 'done']);
});

it('何も起動しなかった巡では報告し直さない', () => {
  expect(run(':')).toEqual(['run_job', 'run_job', 'done']);
});

it('起動に成功したとき（launch_and_reportの成功分岐）に印を立てる', () => {
  const body = extract(['launch_and_report']);
  const succeeded = body.indexOf('report_job "$job_id" succeeded');
  const failed = body.indexOf('report_job "$job_id" failed', succeeded);
  const flag = body.indexOf('SESSION_LAUNCHED_IN_SWEEP=1', succeeded);
  expect(succeeded).toBeGreaterThan(-1);
  expect(flag).toBeGreaterThan(succeeded);
  expect(flag).toBeLessThan(failed);
});
