import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, utimesSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync('scripts/subpc-dispatch-poller.sh', 'utf8');
const extract = (names) =>
  names.map((name) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))[0]).join('\n');

it('「更新して再起動」は同じclaimで受け取った残りのジョブを処理してから入れ替わる（#4871）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-update-defer-test-'));
  try {
    const script = join(dir, 'poller.sh');
    writeFileSync(
      script,
      `#!/bin/bash
set -euo pipefail
if [[ -n "\${REEXEC:-}" ]]; then echo "reexec"; exit 0; fi
export REEXEC=1
CHECKOUT_DIR="${dir}"; POLLER_ARGV=(); SELF_UPDATE_EXEC_PENDING=0; ONCE=0
self_update_pull() { echo "a b"; }
report_job() { echo "report $1 $2"; }
${extract(['run_self_update_job', 'exec_pending_self_update'])}
run_job() { if [[ "$1" == "SELF_UPDATE" ]]; then run_self_update_job j1; else echo "ran $1"; fi; }
while IFS= read -r job; do run_job "$job"; done < <(printf 'SELF_UPDATE\\nREMOTE_SESSION_KILL\\nLAUNCH\\n')
exec_pending_self_update
echo "not reached"
`,
    );
    chmodSync(script, 0o755);
    const r = spawnSync('bash', [script], { encoding: 'utf8' });
    const out = r.stdout.trim().split('\n');
    expect(out).toContain('report j1 succeeded');
    expect(out.indexOf('ran REMOTE_SESSION_KILL')).toBeGreaterThan(out.indexOf('report j1 succeeded'));
    expect(out).toContain('ran LAUNCH');
    expect(out[out.length - 1]).toBe('reexec');
    expect(out).not.toContain('not reached');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('無操作が閾値を超えたリモートセッションだけを畳み、申告用に名前を記録する（#4871）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-session-idle-test-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const now = Math.floor(Date.now() / 1000);
    // 起動から4時間・転記の更新が1時間前（残す）／起動から4時間・転記なし（畳む）／実装セッション（対象外）
    writeFileSync(
      join(bin, 'tmux'),
      `#!/bin/bash\nprintf 'issue-deck-remote-active01\\t${now - 14400}\\ncar-care-remote-idle0001\\t${now - 14400}\\nissue-deck-issue-12\\t${now - 99999}\\n'\n`,
    );
    chmodSync(join(bin, 'tmux'), 0o755);
    const transcript = join(dir, 'active.jsonl');
    writeFileSync(transcript, '{}');
    utimesSync(transcript, now - 3600, now - 3600);
    const launcher = join(dir, 'launcher.sh');
    const log = join(dir, 'launcher.log');
    writeFileSync(launcher, `echo "$@" >> "${log}"\n`);
    const ended = join(dir, 'state', 'idle-ended');
    const r = spawnSync(
      'bash',
      [
        '-c',
        `
set -euo pipefail
export PATH="${bin}:$PATH"
REMOTE_SESSION_IDLE_MINUTES=180; REMOTE_SESSION_LAUNCHER="${launcher}"; REMOTE_SESSION_IDLE_ENDED_FILE="${ended}"
session_transcript_path() { [[ "$1" == "issue-deck-remote-active01" ]] && printf '%s' "${transcript}"; return 0; }
${extract(['reap_idle_remote_sessions', 'remote_session_idle_ended_json'])}
reap_idle_remote_sessions
echo "json=$(remote_session_idle_ended_json)"
REMOTE_SESSION_IDLE_MINUTES=0; reap_idle_remote_sessions; echo "disabled-ok"
`,
      ],
      { encoding: 'utf8' },
    );
    expect(r.stderr).toBe('');
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['--kill-name car-care-remote-idle0001']);
    expect(r.stdout).toContain('json=["car-care-remote-idle0001"]');
    expect(r.stdout).toContain('disabled-ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
