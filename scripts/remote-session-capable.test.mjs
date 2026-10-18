import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

it('claudeの実体が変わったときだけclaude --helpを実行し、消えたら記録を使わずfalseを申告する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-session-capable-test-'));
  try {
    const source = readFileSync('scripts/subpc-dispatch-poller.sh', 'utf8');
    const functions = ['refresh_remote_session_capable', 'remote_session_capable']
      .map((name) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))[0]).join('\n');
    const bin = join(dir, 'bin');
    const claude = join(bin, 'claude');
    const count = join(dir, 'count');
    const launcher = join(dir, 'launcher.sh');
    writeFileSync(launcher, '');
    const writeClaude = (help, mtime) => {
      writeFileSync(claude, `#!/bin/bash\necho x >> "${count}"\necho "${help}"\n`);
      chmodSync(claude, 0o755);
      utimesSync(claude, mtime, mtime);
    };
    spawnSync('mkdir', ['-p', bin]);
    writeClaude('usage', 1000);
    writeFileSync(count, '');
    const script = `
${functions}
REMOTE_SESSION_LAUNCHER="${launcher}"; REMOTE_SESSION_CAPABLE="false"; REMOTE_SESSION_CLAUDE_KEY=""
export PATH="${bin}:$PATH"
runs() { wc -l < "${count}" | tr -d ' '; }
refresh_remote_session_capable; echo "first=$(remote_session_capable) runs=$(runs)"
refresh_remote_session_capable; refresh_remote_session_capable
echo "same=$(remote_session_capable) runs=$(runs)"
printf '#!/bin/bash\\necho x >> "${count}"\\necho "--remote-control"\\n' > "${claude}"; touch -d @2000 "${claude}"
refresh_remote_session_capable; echo "updated=$(remote_session_capable) runs=$(runs)"
REMOTE_SESSION_LAUNCHER="${dir}/missing"
refresh_remote_session_capable; echo "nolauncher=$(remote_session_capable) runs=$(runs)"
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    const out = r.stdout.split('\n');
    expect(out).toContain('first=false runs=1');
    expect(out).toContain('same=false runs=1');
    expect(out).toContain('updated=true runs=2');
    expect(out).toContain('nolauncher=false runs=2');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
