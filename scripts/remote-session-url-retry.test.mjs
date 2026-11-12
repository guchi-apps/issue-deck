import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const extractFrom = (path) => {
  const source = readFileSync(path, 'utf8');
  return (names) =>
    names.map((name) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))[0]).join('\n');
};
const extractPoller = extractFrom('scripts/subpc-dispatch-poller.sh');
const extractLauncher = extractFrom('scripts/start-remote-session.sh');

// URLが出るまでの起動回数を変えて、起動ジョブを走らせる。tmux・ランチャー・URLの取得は差し替える
function runLaunchJob({ urlAfterLaunches, retries }) {
  const dir = mkdtempSync(join(tmpdir(), 'remote-session-url-retry-test-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const tmuxLog = join(dir, 'tmux.log');
    writeFileSync(join(bin, 'tmux'), `#!/bin/bash\necho "$1" >> "${tmuxLog}"\nexit 0\n`);
    chmodSync(join(bin, 'tmux'), 0o755);
    const launches = join(dir, 'launches');
    const launcher = join(dir, 'launcher.sh');
    writeFileSync(launcher, `echo "$@" >> "${launches}"\n`);
    const r = spawnSync(
      'bash',
      [
        '-c',
        `
set -euo pipefail
export PATH="${bin}:$PATH"
REMOTE_SESSION_LAUNCHER="${launcher}"; REMOTE_SESSION_MAX=3; REMOTE_SESSION_IDLE_ENDED_FILE="${dir}/none"
REMOTE_SESSION_URL_WAIT_SECONDS=6; REMOTE_SESSION_URL_RETRIES=${retries}; LAUNCH_TIMEOUT=10; DRY_RUN=0
sleep() { :; }
report_job() { echo "report $2 $3 \${5:-}"; }
local_session_validate_target() { return 0; }
count_remote_sessions() { echo 0; }
ensure_tmux_server_scope() { :; }
session_transcript_remote_control_url() {
  local n; n="$(wc -l < "${launches}")"
  (( n >= ${urlAfterLaunches} )) && printf 'https://claude.ai/code/session_x' || return 1
}
${extractPoller(['run_remote_session_job'])}
run_remote_session_job j1 REMOTE_SESSION guchi-apps issue-deck issue-deck-remote-abcd1234 auto
`,
      ],
      { encoding: 'utf8' },
    );
    const launchCount = readFileSync(launches, 'utf8').trim().split('\n').length;
    const kills = readFileSync(tmuxLog, 'utf8').split('\n').filter((line) => line === 'kill-session').length;
    return { stdout: r.stdout, stderr: r.stderr, launchCount, kills };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it('URLがすぐ出れば起こし直さない（#5318）', () => {
  const r = runLaunchJob({ urlAfterLaunches: 1, retries: 2 });
  expect(r.stderr).toBe('');
  expect(r.launchCount).toBe(1);
  expect(r.kills).toBe(0);
  expect(r.stdout).toContain('report succeeded リモートセッション issue-deck-remote-abcd1234 を起動しました {"remoteControlUrl":"https://claude.ai/code/session_x"}');
});

it('URLが出なければtmuxだけ畳んで同じ名前で起こし直し、出たURLで成功を返す（#5318）', () => {
  const r = runLaunchJob({ urlAfterLaunches: 2, retries: 2 });
  expect(r.stderr).toBe('');
  expect(r.launchCount).toBe(2);
  expect(r.kills).toBe(1);
  expect(r.stdout).toContain('起こし直しています（1/2回目）');
  expect(r.stdout).toContain('{"remoteControlUrl":"https://claude.ai/code/session_x"}');
});

it('起こし直しの上限を使い切ったら、URL無しの成功として返す（#5318）', () => {
  const r = runLaunchJob({ urlAfterLaunches: 99, retries: 2 });
  expect(r.stderr).toBe('');
  expect(r.launchCount).toBe(3);
  expect(r.kills).toBe(2);
  expect(r.stdout).toContain('report succeeded リモートセッション issue-deck-remote-abcd1234 を起動しました（URLはまだ取れていません）');
});

it('ユーザーの発話がある転記だけを、続ける会話とみなす（#5318）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-session-conversation-test-'));
  try {
    const slug = join(dir, '-w-remote-abcd1234');
    mkdirSync(slug);
    writeFileSync(join(slug, 'meta.jsonl'), '{"type":"custom-title"}\n{"type":"permission-mode"}\n');
    const check = (path) =>
      spawnSync(
        'bash',
        ['-c', `${extractLauncher(['has_conversation_for'])}\nhas_conversation_for "${path}" && echo yes || echo no`],
        { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECTS_DIR: dir } },
      ).stdout.trim();
    expect(check('/w/remote-abcd1234')).toBe('no');
    expect(check('/w/remote-zzzz9999')).toBe('no');
    writeFileSync(join(slug, 'talk.jsonl'), '{"type":"user","message":{"content":"hi"}}\n');
    expect(check('/w/remote-abcd1234')).toBe('yes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
