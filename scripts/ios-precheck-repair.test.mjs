import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(mode = 'fix') {
  const dir = mkdtempSync(join(tmpdir(), 'ios-repair-test-')); dirs.push(dir);
  const scripts = join(dir, 'scripts'), bin = join(dir, 'bin'), repoDir = join(dir, 'repo');
  mkdirSync(join(scripts, 'lib'), { recursive: true }); mkdirSync(bin); mkdirSync(repoDir);
  copyFileSync(resolve('scripts/ios-precheck-repair.sh'), join(scripts, 'ios-precheck-repair.sh'));
  for (const name of ['local-repo-resolve', 'agent-cli', 'review-usage']) {
    copyFileSync(resolve(`scripts/lib/${name}.sh`), join(scripts, 'lib', `${name}.sh`));
  }
  const git = (...args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'issue-1'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  mkdirSync(join(repoDir, 'ios')); writeFileSync(join(repoDir, 'ios', 'Sample.swift'), 'broken\n');
  git('add', '.'); git('commit', '-m', 'base');
  const sha = git('rev-parse', 'HEAD');
  execFileSync('git', ['clone', '--bare', repoDir, join(dir, 'remote.git')], { stdio: 'ignore' });
  git('remote', 'add', 'origin', join(dir, 'remote.git'));
  // 元のcheckoutにある未コミット変更を触らないことも確認する。
  writeFileSync(join(repoDir, 'ios', 'Sample.swift'), 'user editing\n');
  writeFileSync(join(dir, 'repos.conf'), `guchi-apps/yoteiflow ${repoDir}\n`);
  const target = { state: 'open', draft: false, base: { ref: 'develop' }, head: { ref: 'issue-1', sha, repo: { full_name: 'guchi-apps/yoteiflow' } }, labels: [] };
  writeFileSync(join(dir, 'target.json'), JSON.stringify(target));
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ state: 'failed', requestedSha: sha, verifiedSha: sha, failedStage: 'build', jobId: 'test-build' }));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ aiExecutionProvider: 'claude', workflowClaudeModel: 'auto', claudeDispatchPauseReason: mode === 'paused' ? 'manual' : null }));
  const script = (path, body) => writeFileSync(path, '#!/usr/bin/env bash\nset -eu\n' + body, { mode: 0o755 });
  script(join(scripts, 'ios-precheck.sh'), 'echo "Sample.swift: error: missing member"\n');
  script(join(bin, 'gh'), 'cat "$TEST_ROOT/target.json"\n');
  script(join(bin, 'curl'), 'cat "$TEST_ROOT/settings.json"\n');
  script(join(bin, 'claude'), `cat >/dev/null
printf 'fixed\\n' > ios/Sample.swift
if [[ "$TEST_MODE" == outside ]]; then echo unsafe > package.json; fi
if [[ "$TEST_MODE" == stale ]]; then jq '.head.sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' "$TEST_ROOT/target.json" > "$TEST_ROOT/new.json"; mv "$TEST_ROOT/new.json" "$TEST_ROOT/target.json"; fi
echo done
`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, APP_BASE_URL: 'https://example.invalid', ISSUE_DECK_LOCAL_REPOS_CONFIG: join(dir, 'repos.conf'), TEST_ROOT: dir, TEST_MODE: mode };
  return { dir, git, sha, run: () => spawnSync('bash', [join(scripts, 'ios-precheck-repair.sh'), 'guchi-apps/yoteiflow', '1', sha, join(dir, 'result.json')], { env, encoding: 'utf8', timeout: 15000 }) };
}
describe('iOS修復ラッパー（実git・AIとAPIはモック）', () => {
  it('隔離worktreeのSwift修正だけを通常pushし、元checkoutを保持する', () => {
    const f = setup(); const result = f.run(); 
    expect(result.status, result.stderr).toBe(0);
    expect(f.git('show', 'origin/issue-1:ios/Sample.swift')).toBe('fixed');
    expect(f.git('rev-parse', 'HEAD')).toBe(f.sha);
    expect(f.git('diff')).toContain('user editing');
    expect(f.git('worktree', 'list', '--porcelain').match(/worktree /g)).toHaveLength(1);
  });
  it.each(['outside', 'stale', 'paused'])('%sの場合はpushしない', mode => {
    const f = setup(mode); expect(f.run().status).not.toBe(0);
    expect(f.git('ls-remote', 'origin', 'refs/heads/issue-1').split(/\s/)[0]).toBe(f.sha);
    expect(f.git('diff')).toContain('user editing');
  });
});
