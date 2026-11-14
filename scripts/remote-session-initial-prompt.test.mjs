import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// 最初の指示（#5405）。ランチャーを実際に走らせ、tmuxへ渡るコマンドを検証する。
// git・tmux・claudeは一時ディレクトリ上の本物のリポジトリと差し替えで用意する
const SESSION = 'issue-deck-remote-abcd1234';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-session-initial-prompt-test-'));
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const origin = join(dir, 'origin.git');
  mkdirSync(origin);
  git(origin, 'init', '--bare', '-b', 'develop');
  const repo = join(home, 'apps', 'issue-deck');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'develop');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', 'origin', 'develop');
  git(repo, 'remote', 'set-head', 'origin', 'develop');

  // tmuxは`new-session`の最後の引数（`bash -lc '<コマンド>'`）を本物のbashで実行し、
  // 差し替えたclaudeが受け取った引数を1行ずつ記録する（NULではなく改行区切りなので複数行の指示は崩れるが、
  // 先頭の1行と有無の判定には足りる）
  const tmuxLog = join(dir, 'tmux.log');
  writeFileSync(
    join(bin, 'tmux'),
    `#!/bin/bash\nif [[ "$1" == "new-session" ]]; then bash -c "\${@: -1}" >/dev/null 2>&1; exit 0; fi\nexit 1\n`,
  );
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/bash\nif [[ "$1" == "--help" ]]; then echo "--remote-control"; exit 0; fi\nprintf '%s\\0' "$@" >> "${tmuxLog}"\n`,
  );
  chmodSync(join(bin, 'tmux'), 0o755);
  chmodSync(join(bin, 'claude'), 0o755);
  return { dir, home, bin, tmuxLog };
}

function launch(ctx, env = {}) {
  const r = spawnSync('bash', ['scripts/start-remote-session.sh', 'guchi-apps', 'issue-deck', SESSION], {
    encoding: 'utf8',
    env: {
      PATH: `${ctx.bin}:${process.env.PATH}`,
      HOME: ctx.home,
      TMPDIR: ctx.dir,
      CLAUDE_PROJECTS_DIR: join(ctx.dir, 'projects'),
      ISSUE_DECK_SKIP_CLAUDE_TRUST_CHECK: '1',
      ...env,
    },
  });
  // claudeが受け取った引数列
  const argv = existsSync(ctx.tmuxLog) ? readFileSync(ctx.tmuxLog, 'utf8').split('\0').slice(0, -1) : [];
  return { status: r.status, stderr: r.stderr, argv };
}

function leftoverPromptFiles(ctx) {
  return readdirSync(ctx.dir).filter((name) => name.startsWith('issue-deck-remote-prompt.'));
}

// 会話のある転記を、起動で使われるworktreeパスの下へ置く（`--continue`の判定材料）
function seedTranscript(ctx) {
  const worktree = join(ctx.home, 'apps', 'issue-deck-worktrees', 'remote-abcd1234');
  const slug = worktree.replace(/[^A-Za-z0-9]/g, '-');
  const projects = join(ctx.dir, 'projects', slug);
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, 's.jsonl'), '{"type":"user","message":"hi"}\n');
}

it('指示が無ければ従来どおり（引数も一時ファイルも無い）', () => {
  const ctx = setup();
  try {
    const r = launch(ctx);
    expect(r.status).toBe(0);
    expect(r.argv).toContain('--remote-control');
    expect(r.argv).not.toContain('--');
    expect(leftoverPromptFiles(ctx)).toEqual([]);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

it('指示があれば`--`の後ろの1つの引数として、そのまま渡り、一時ファイルは読んだら消える', () => {
  const ctx = setup();
  try {
    const prompt = '-x 先頭がハイフンでも "引用符" と $(危険) と `bt` を含む\n複数行';
    const r = launch(ctx, { ISSUE_DECK_REMOTE_INITIAL_PROMPT: prompt });
    expect(r.status).toBe(0);
    expect(r.argv.slice(-2)).toEqual(['--', prompt]);
    expect(r.argv).not.toContain('--continue');
    expect(leftoverPromptFiles(ctx)).toEqual([]);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

it('2万字の指示もtmuxのコマンド長に影響されず渡る', () => {
  const ctx = setup();
  try {
    const prompt = 'あ'.repeat(20000);
    const r = launch(ctx, { ISSUE_DECK_REMOTE_INITIAL_PROMPT: prompt });
    expect(r.argv.at(-1)).toBe(prompt);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

it('会話のある転記が残っていても、指示つきは新しい会話で起こす（起こし直しで渡し直せる。#5318）', () => {
  const ctx = setup();
  try {
    launch(ctx); // worktreeを作る
    rmSync(ctx.tmuxLog, { force: true });
    seedTranscript(ctx);
    const withPrompt = launch(ctx, { ISSUE_DECK_REMOTE_INITIAL_PROMPT: '調べて' });
    expect(withPrompt.status).toBe(0);
    expect(withPrompt.argv).not.toContain('--continue');
    expect(withPrompt.argv.slice(-2)).toEqual(['--', '調べて']);
    rmSync(ctx.tmuxLog, { force: true });
    // 指示なし（再開）は従来どおり会話の続き
    const resume = launch(ctx);
    expect(resume.argv).toContain('--continue');
    expect(resume.argv).not.toContain('--');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

// pollerは受け取った指示を環境変数でランチャーへ渡し、URLが出ずに起こし直す2回目にも同じ値を渡す
it('pollerは起動と起こし直しの両方で指示をランチャーへ渡す（指示なしなら渡さない）', () => {
  const source = readFileSync('scripts/subpc-dispatch-poller.sh', 'utf8');
  const fn = source.match(/^run_remote_session_job\(\) \{[\s\S]*?^\}/m)[0];
  const run = (initialPrompt) => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-session-initial-prompt-poller-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'tmux'), '#!/bin/bash\nexit 0\n');
      chmodSync(join(bin, 'tmux'), 0o755);
      const log = join(dir, 'launches');
      const launcher = join(dir, 'launcher.sh');
      writeFileSync(launcher, `echo "prompt=[\${ISSUE_DECK_REMOTE_INITIAL_PROMPT-unset}]" >> "${log}"\n`);
      spawnSync(
        'bash',
        [
          '-c',
          `
set -euo pipefail
export PATH="${bin}:$PATH"
REMOTE_SESSION_LAUNCHER="${launcher}"; REMOTE_SESSION_MAX=3; REMOTE_SESSION_IDLE_ENDED_FILE="${dir}/none"
REMOTE_SESSION_URL_WAIT_SECONDS=3; REMOTE_SESSION_URL_RETRIES=1; LAUNCH_TIMEOUT=10; DRY_RUN=0
sleep() { :; }
report_job() { :; }
local_session_validate_target() { return 0; }
count_remote_sessions() { echo 0; }
ensure_tmux_server_scope() { :; }
session_transcript_remote_control_url() { return 1; }
${fn}
run_remote_session_job j1 REMOTE_SESSION guchi-apps issue-deck issue-deck-remote-abcd1234 auto ${JSON.stringify(initialPrompt)}
`,
        ],
        { encoding: 'utf8' },
      );
      return readFileSync(log, 'utf8').trim().split('\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  expect(run('調べて')).toEqual(['prompt=[調べて]', 'prompt=[調べて]']);
  expect(run('')).toEqual(['prompt=[unset]', 'prompt=[unset]']);
});
