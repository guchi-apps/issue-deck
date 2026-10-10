#!/usr/bin/env node
// サブPCからTailscale・SSH経由でVPSのissue-deckのメモリを計測する（#4256）。読み取り専用。
//
//   node scripts/vps-memory-probe.mjs --once [--post]
//   node scripts/vps-memory-probe.mjs --duration 600 --interval 30 [--post]
//
// 常時実行はしない（timer・serviceを作らない）。連続計測は`--duration`で必ず終わる。
// 結果はJSON Linesで標準出力へ出す。`--post`を付けるとissue-deckへも送る
// （`~/.config/issue-deck/dispatch.env`の`APP_BASE_URL`・`DISPATCH_SECRET`。値は出力しない）。
// 詳細: docs/vps-memory-probe.md
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  REMOTE_SCRIPT, parseRemoteOutput, classifySshFailure, pickProcess, buildSample, readNodeArgsFromConfig,
} from './lib/vps-memory-probe-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_DURATION_SEC = 3600;
const MIN_INTERVAL_SEC = 10;
const SSH_TIMEOUT_SEC = 20;

function parseArgs(argv) {
  const o = { once: false, duration: 0, interval: 30, post: false, host: process.env.VPS_MEMORY_SSH_HOST || 'vps' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') o.once = true;
    else if (a === '--post') o.post = true;
    else if (a === '--duration') o.duration = Number(argv[++i]);
    else if (a === '--interval') o.interval = Number(argv[++i]);
    else if (a === '--host') o.host = argv[++i];
    else if (a === '--next-version') o.nextVersion = argv[++i];
    else { console.error(`不明な引数: ${a}`); process.exit(2); }
  }
  if (o.once === (o.duration > 0)) { console.error('--once か --duration のどちらか一方を指定してください'); process.exit(2); }
  if (!(o.duration >= 0) || o.duration > MAX_DURATION_SEC) { console.error(`--duration は ${MAX_DURATION_SEC} 秒以下`); process.exit(2); }
  if (!(o.interval >= MIN_INTERVAL_SEC)) { console.error(`--interval は ${MIN_INTERVAL_SEC} 秒以上（VPSへの負荷を抑えるため）`); process.exit(2); }
  return o;
}

function runSsh(host) {
  return new Promise((resolve) => {
    const child = spawn('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, `timeout ${SSH_TIMEOUT_SEC - 5} sh -s`,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, SSH_TIMEOUT_SEC * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: 255, stdout: '', stderr: String(e.message), timedOut: false }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 255, stdout: out, stderr: err, timedOut }); });
    child.stdin.end(REMOTE_SCRIPT);
  });
}

const STATE_FILE = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'issue-deck/vps-memory-probe.json');
function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s)); } catch { /* 保存できなくても計測は続ける */ } }

function nextVersionFromRepo() {
  try { return JSON.parse(readFileSync(join(ROOT, 'node_modules/next/package.json'), 'utf8')).version; } catch { return undefined; }
}

function dispatchEnv() {
  const file = process.env.ISSUE_DECK_DISPATCH_ENV || join(homedir(), '.config/issue-deck/dispatch.env');
  const v = {};
  try {
    for (const l of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(l.trim());
      if (m) v[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 無ければ未設定として扱う */ }
  return v;
}

async function post(samples, env) {
  if (!env.APP_BASE_URL || !env.DISPATCH_SECRET) return 'APP_BASE_URL・DISPATCH_SECRETが見つかりません';
  try {
    const res = await fetch(`${env.APP_BASE_URL.replace(/\/$/, '')}/api/integrations/vps-memory/samples`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.DISPATCH_SECRET}` },
      body: JSON.stringify({ samples }),
      signal: AbortSignal.timeout(15000),
    });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (e) { return String(e.message); }
}

async function sampleOnce(opts, nodeArgs, state) {
  const sampledAt = new Date().toISOString();
  const r = await runSsh(opts.host);
  if (r.timedOut || r.exitCode !== 0) {
    return { sampledAt, status: 'unavailable', reason: classifySshFailure(r), host: null };
  }
  const parsed = parseRemoteOutput(r.stdout);
  if (parsed.nowEpoch === null) return { sampledAt, status: 'unavailable', reason: 'parse_error', host: null };
  const pick = pickProcess(parsed.procs, { nextVersion: opts.nextVersion, previousKey: state.segmentKey });
  const sample = buildSample({ sampledAt, parsed, pick, nodeArgs });
  if (sample.segmentKey) state.segmentKey = sample.segmentKey;
  return sample;
}

const opts = parseArgs(process.argv.slice(2));
opts.nextVersion ||= nextVersionFromRepo();
let nodeArgs = null;
try { nodeArgs = readNodeArgsFromConfig(readFileSync(join(ROOT, 'deploy/ecosystem.config.js'), 'utf8')); } catch { /* null */ }
const env = opts.post ? dispatchEnv() : {};
const state = loadState();
const deadline = Date.now() + opts.duration * 1000;
const runId = `${new Date().toISOString()}`;
let failedPost = 0;
for (;;) {
  const sample = { ...(await sampleOnce(opts, nodeArgs, state)), runId, mode: opts.once ? 'once' : 'continuous' };
  console.log(JSON.stringify(sample));
  saveState(state);
  if (opts.post) {
    const err = await post([sample], env);
    if (err) { failedPost++; console.error(`送信できませんでした: ${err}`); }
  }
  if (opts.once || Date.now() + opts.interval * 1000 > deadline) break;
  await new Promise((r) => setTimeout(r, opts.interval * 1000));
}
process.exit(failedPost > 0 ? 3 : 0);
