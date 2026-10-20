import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// #4881: 「セッション終了」の確認ダイアログへ未コミットの件数を運ぶ関数と、
// 閉じた後にiOS事前検証の巡回を前倒しさせる関数を、pollerから切り出して確かめる
const source = readFileSync('scripts/subpc-dispatch-poller.sh', 'utf8');
const extract = names => names
  .map(name => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))[0]).join('\n');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

it('worktreeの未コミットの件数を数え、package-lock.jsonだけの変更とworktree不明は区別する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-close-test-'));
  try {
    const worktree = join(dir, 'wt');
    mkdirSync(worktree);
    git(worktree, 'init', '-q');
    writeFileSync(join(worktree, 'package-lock.json'), '{}\n');
    writeFileSync(join(worktree, 'a.txt'), 'a\n');
    git(worktree, 'add', '.');
    git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
    const script = extract(['session_worktree_changes_json']) + `
session_state_descriptor_file() { [[ "$1" == known ]] && printf '%s' "$TEST_DIR/descriptor"; }
session_state_field() { printf '%s' "$TEST_WORKTREE"; }
printf 'clean=%s\\n' "$(session_worktree_changes_json known)"
printf '{"x":1}\\n' > "$TEST_WORKTREE/package-lock.json"
printf 'lock=%s\\n' "$(session_worktree_changes_json known)"
printf 'b\\n' >> "$TEST_WORKTREE/a.txt"; printf 'n\\n' > "$TEST_WORKTREE/new.txt"
printf 'dirty=%s\\n' "$(session_worktree_changes_json known)"
printf 'unknown=%s\\n' "$(session_worktree_changes_json other)"
`;
    writeFileSync(join(dir, 'descriptor'), '');
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8', env: { ...process.env, TEST_DIR: dir, TEST_WORKTREE: worktree },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['clean=0', 'lock=0', 'dirty=3', 'unknown=null']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('閉じた後は最後に巡回した時刻を消し、次の巡で間隔を待たずにiOS事前検証を見直させる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-close-test-'));
  try {
    const state = join(dir, 'state');
    mkdirSync(state);
    writeFileSync(join(state, 'last-sweep'), String(Math.floor(Date.now() / 1000)));
    const script = extract(['ios_automation_state_dir', 'request_ios_precheck_resweep']) + `
request_ios_precheck_resweep
request_ios_precheck_resweep
`;
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8', env: { ...process.env, ISSUE_DECK_IOS_AUTOMATION_STATE: state },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(state, 'last-sweep'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
