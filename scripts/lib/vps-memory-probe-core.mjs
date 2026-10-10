// VPSメモリ計測（#4256）の純粋な部分。SSHやHTTPは`scripts/vps-memory-probe.mjs`が持つ。
//
// 方針: 読み取り専用。環境変数・コマンドライン引数の値は読まない（`/proc/<pid>/environ`は開かない）。
// **取得できなかった値は0や空にせず、null＋理由で返す**（正常値と取りこぼしを区別するため）。

/** 計測対象の`next-server`はプロセスタイトルが`next-server (vX.Y.Z)`に書き換えられている */
export const PROCESS_COMM = 'next-server';

/**
 * VPS側で実行するスクリプト（標準入力で`sh -s`へ渡す）。`/proc`と`pgrep`だけを使い、sudoは使わない。
 * 出力は`key=value`の行。`proc`行は1プロセス1行。
 */
export const REMOTE_SCRIPT = String.raw`
echo "now=$(date +%s)"
echo "clk_tck=$(getconf CLK_TCK)"
echo "btime=$(awk '/^btime/{print $2}' /proc/stat)"
awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/{printf "%s=%s\n", tolower(substr($1,1,length($1)-1)), $2}' /proc/meminfo
for pid in $(pgrep -f "^${PROCESS_COMM}"); do
  title=$(ps -o args= -p "$pid" 2>/dev/null | tr -d '\n' | tr ' ' '_')
  start=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}')
  rss=$(awk '/^VmRSS:/{print $2}' "/proc/$pid/status" 2>/dev/null)
  hwm=$(awk '/^VmHWM:/{print $2}' "/proc/$pid/status" 2>/dev/null)
  thr=$(awk '/^Threads:/{print $2}' "/proc/$pid/status" 2>/dev/null)
  et=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
  echo "proc pid=$pid title=$title start_ticks=$start rss_kb=$rss hwm_kb=$hwm threads=$thr etimes=$et"
done
`.replaceAll('${PROCESS_COMM}', PROCESS_COMM);

const num = (v) => (v !== undefined && v !== '' && /^\d+$/.test(v) ? Number(v) : null);

/** `REMOTE_SCRIPT`の出力を構造化する。想定外の行は無視する */
export function parseRemoteOutput(text) {
  const kv = {};
  const procs = [];
  for (const line of String(text).split('\n')) {
    if (line.startsWith('proc ')) {
      const p = {};
      for (const part of line.slice(5).split(' ')) {
        const i = part.indexOf('=');
        if (i > 0) p[part.slice(0, i)] = part.slice(i + 1);
      }
      const m = /\(v?([0-9][^)]*)\)/.exec((p.title ?? '').replaceAll('_', ' '));
      procs.push({
        pid: num(p.pid),
        nextVersion: m ? m[1] : null,
        startTicks: num(p.start_ticks),
        rssKb: num(p.rss_kb),
        hwmKb: num(p.hwm_kb),
        threads: num(p.threads),
        uptimeSec: num(p.etimes),
      });
      continue;
    }
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const host = {
    memTotalKb: num(kv.memtotal),
    memAvailableKb: num(kv.memavailable),
    swapTotalKb: num(kv.swaptotal),
    swapFreeKb: num(kv.swapfree),
  };
  return { nowEpoch: num(kv.now), clkTck: num(kv.clk_tck), btime: num(kv.btime), host, procs };
}

/** SSHの失敗を理由コードへ分ける。0やnullへ置き換えず、呼び出し側が「取得不可」として扱う */
export function classifySshFailure({ exitCode, stderr = '', timedOut = false }) {
  if (timedOut) return 'timeout';
  if (/permission denied|publickey|authentication/i.test(stderr)) return 'permission_denied';
  if (exitCode === 255) return 'ssh_failed';
  return 'remote_failed';
}

/**
 * issue-deckのプロセスを選ぶ。VPSには複数の`next-server`が常駐し、PM2の実行ユーザー（github-user）の
 * プロセスはcwd・fdが読めないため、権限なしでは確定できない。
 * 優先順: 前回選んだプロセスがまだ同じ区間で生きていればそれ → `next`の版が一致するプロセスが1つならそれ。
 * **複数に絞れないときは選ばない**（他アプリのピークを混ぜないため）。
 */
export function pickProcess(procs, { nextVersion, previousKey } = {}) {
  const withKey = procs.map((p) => ({ ...p, segmentKey: p.pid !== null && p.startTicks !== null ? `${p.pid}-${p.startTicks}` : null }));
  if (previousKey) {
    const same = withKey.find((p) => p.segmentKey === previousKey);
    if (same) return { proc: same };
  }
  const matches = withKey.filter((p) => nextVersion && p.nextVersion === nextVersion);
  if (matches.length === 1) return { proc: matches[0] };
  if (matches.length === 0) return { reason: 'process_not_found', candidates: withKey.length };
  return { reason: 'ambiguous_process', candidates: matches.length };
}

/** 保存・送信する1サンプル。`sampledAt`はサブPCで採取した時刻 */
export function buildSample({ sampledAt, parsed, pick, nodeArgs }) {
  const base = { sampledAt, host: parsed.host };
  if (!pick.proc) return { ...base, status: 'unavailable', reason: pick.reason, candidates: pick.candidates };
  const p = pick.proc;
  const startedAt = parsed.btime !== null && parsed.clkTck && p.startTicks !== null
    ? new Date((parsed.btime + p.startTicks / parsed.clkTck) * 1000).toISOString()
    : null;
  const complete = p.rssKb !== null && p.hwmKb !== null;
  return {
    ...base,
    status: complete ? 'ok' : 'partial',
    reason: complete ? undefined : 'proc_unreadable',
    pid: p.pid,
    segmentKey: p.segmentKey,
    startedAt,
    rssKb: p.rssKb,
    hwmKb: p.hwmKb,
    threads: p.threads,
    uptimeSec: p.uptimeSec,
    nodeArgs,
    // 権限なしでは取れない項目。0にせず理由つきで明示する（sudoers整備後に取得する。#4256）
    unavailableFields: { heap: 'permission', pm2Restarts: 'permission', smapsTop: 'permission' },
  };
}

/** `deploy/ecosystem.config.js`の`node_args`を取り出す（実プロセスのcmdlineはタイトルが書き換わり読めないため、リポジトリを正とする） */
export function readNodeArgsFromConfig(configText) {
  const m = /node_args:\s*"([^"]*)"/.exec(configText);
  return m ? { value: m[1], source: 'repo-config' } : null;
}
