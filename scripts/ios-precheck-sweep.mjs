#!/usr/bin/env node
// サブPC専用。pollerからflock付きで起動する。Macの検証は既存のios-precheck.shが所有する。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTEXT, processPullRequest } from './lib/ios-precheck-automation.mjs';
import { listOpenPullRequests } from './lib/ios-precheck-pr-list.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const root = process.env.ISSUE_DECK_IOS_AUTOMATION_STATE
  ?? join(process.env.XDG_STATE_HOME ?? join(process.env.HOME, '.local/state'), 'issue-deck/ios-automation');
mkdirSync(root, { recursive: true, mode: 0o700 });
const config = process.env.ISSUE_DECK_IOS_PRECHECK_CONFIG ?? join(scripts, 'ios-precheck.conf');
const check = join(scripts, 'ios-precheck.sh');
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (r.error || r.status !== 0) throw new Error(`${command} failed (${r.status ?? 'timeout'})`);
  return r.stdout;
}
function gh(path, ...args) { return JSON.parse(run('gh', ['api', path, ...args])); }
function readPr(repository, number) { return gh(`repos/${repository}/pulls/${number}`); }
function readState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function save(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
function localRepo(repository) {
  return run('bash', ['-c', 'source "$1/lib/local-repo-resolve.sh"; local_repo_resolve_path "$2"', '_', scripts, repository]).trim();
}
function busy(pr) {
  // 古いサーバーで停止設定を読めない場合も、新しい修復を開始しない。
  const appUrl = run('bash', ['-c', 'source "$1/lib/review-usage.sh"; _review_usage_env_value APP_BASE_URL', '_', scripts]).trim();
  if (!appUrl) return true;
  const settings = JSON.parse(run('curl', ['-fsS', '--max-time', '15', `${appUrl.replace(/\/$/, '')}/api/settings/claude-model`]));
  const pauseKey = `${settings.aiExecutionProvider}DispatchPauseReason`;
  if (!(pauseKey in settings) || settings[pauseKey] !== null) return true;
  const sessions = spawnSync('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_dead}'], { encoding: 'utf8', timeout: 10_000 });
  if (sessions.error || ![0, 1].includes(sessions.status)) return true;
  const name = pr.head.repo.full_name.split('/')[1];
  const issue = /^issue-([0-9]+)$/.exec(pr.head.ref)?.[1];
  return (sessions.stdout ?? '').split('\n').some(line => {
    const [session, dead] = line.split('\t');
    return dead === '0' && (issue ? session === `${name}-issue-${issue}` || session === `${name}-review-fix-${issue}` : session.startsWith(`${name}-`));
  });
}
const repositories = [...readFileSync(config, 'utf8').matchAll(/^\[([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\]\s*$/gm)].map(m => m[1]);
for (const repository of repositories) {
  try {
    const settings = JSON.parse(run('bash', [check, 'config', '--repo', repository]));
    if (!settings.configured || !settings.required) continue;
    const repoDir = localRepo(repository);
    // 全ページを取得。設定済みの同一repo・develop向けだけを後段で検証する。
    const prs = listOpenPullRequests(gh, repository);
    for (const pr of prs) {
      const stateFile = join(root, `${repository.replace('/', '--')}-${pr.number}.json`);
      try {
        const io = {
          readPr,
          busy,
          status: (repo, sha) => gh(`repos/${repo}/commits/${sha}/status`).statuses.find(s => s.context === CONTEXT)?.state,
          save: value => save(stateFile, value),
          report: (repo, sha, state, message) => gh(`repos/${repo}/statuses/${sha}`, '-X', 'POST', '-f', `state=${state}`, '-f', `context=${CONTEXT}`, '-f', `description=${[...(message ?? 'iOS事前検証')].slice(0, 139).join('')}`),
          verify: (repo, sha) => {
            // FETCH_HEADは他セッションと共用しない。検証は常に指定SHAを読む。
            run('git', ['-C', repoDir, 'fetch', '--no-write-fetch-head', 'origin', sha]);
            const r = spawnSync('bash', [check, 'run', '--repo', repo, '--sha', sha, '--repo-dir', repoDir], {
              encoding: 'utf8', timeout: 3_900_000, maxBuffer: 8 * 1024 * 1024,
            });
            if (r.error || ![0, 1, 2].includes(r.status)) throw new Error('iOS検証の実行に失敗しました');
            return JSON.parse(r.stdout.trim().split('\n').at(-1));
          },
          repair: (current, result) => {
            const resultFile = join(root, `${repository.replace('/', '--')}-${pr.number}-result.json`);
            save(resultFile, result);
            const r = spawnSync('bash', [join(scripts, 'ios-precheck-repair.sh'), repository, String(pr.number), current.head.sha, resultFile], {
              encoding: 'utf8', timeout: 2_100_000, maxBuffer: 8 * 1024 * 1024,
            });
            writeFileSync(join(root, `${repository.replace('/', '--')}-${pr.number}-repair.log`), `${r.stdout ?? ''}\n${r.stderr ?? ''}`, { mode: 0o600 });
            return !r.error && r.status === 0;
          },
        };
        const outcome = await processPullRequest(io, repository, pr.number, readState(stateFile));
        console.log(`${repository}#${pr.number}: ${outcome}`);
      } catch (error) { console.error(`${repository}#${pr.number}: ${error.message}`); }
    }
  } catch (error) { console.error(`${repository}: ${error.message}`); }
}
