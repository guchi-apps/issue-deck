import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
it('pollerの二重巡回をflockで防ぎ、実行枠に加算し、間隔とdry-runを守る', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ios-poller-test-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'node'), '#!/bin/bash\necho run >> "$TEST_DIR/calls"\nsleep 0.3\n', { mode: 0o755 });
    writeFileSync(join(bin, 'tmux'), '#!/bin/bash\necho app-issue-1\necho app-issue-2\n', { mode: 0o755 });
    const source = readFileSync('scripts/subpc-dispatch-poller.sh', 'utf8');
    const functions = ['ios_automation_state_dir', 'sweep_ios_prechecks', 'count_issue_sessions']
      .map(name => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))[0]).join('\n');
    const result = spawnSync('bash', ['-c', functions + `
DRY_RUN=0
SCRIPT_DIR="$TEST_DIR"
sweep_ios_prechecks
sweep_ios_prechecks
sleep 0.1
count_issue_sessions
wait
sweep_ios_prechecks
wait
DRY_RUN=1
ISSUE_DECK_IOS_SWEEP_INTERVAL_SECONDS=1
sweep_ios_prechecks
wait
count_issue_sessions
`], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_DIR: dir, ISSUE_DECK_IOS_AUTOMATION_STATE: join(dir, 'state') } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['3', '2']);
    expect(readFileSync(join(dir, 'calls'), 'utf8').trim()).toBe('run');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
