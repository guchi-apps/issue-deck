import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

it('pollerは起床ファイルで待ちを打ち切り、最小間隔を守り、対象外の経路では反応しない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-poller-test-'));
  try {
    const source = readFileSync('scripts/subpc-dispatch-poller.sh', 'utf8');
    const functions = ['consume_wake', 'sleep_or_wake']
      .map((name) => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))[0]).join('\n');
    const wake = join(dir, 'wake');
    const script = `
${functions}
SHUTDOWN=0; ANNOUNCE_ONLY=0; DRY_RUN=0; WAKE_FILE="${wake}"; WAKE_MIN_GAP_SECONDS=5
LAST_RUN_ONCE_END=0
sleep_or_wake 1 && echo "none-woke" || echo "timeout-ok"
date +%s%3N > "$WAKE_FILE"
sleep_or_wake 3 && echo "woke-ok" || echo "woke-missed"
[[ -f "$WAKE_FILE" ]] && echo "file-left" || echo "file-removed"
LAST_RUN_ONCE_END=$(date +%s)
date +%s%3N > "$WAKE_FILE"
consume_wake && echo "gap-ignored-bad" || echo "gap-kept-ok"
[[ -f "$WAKE_FILE" ]] && echo "kept" || echo "lost"
LAST_RUN_ONCE_END=0; DRY_RUN=1
consume_wake && echo "dry-bad" || echo "dry-ok"
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    const out = r.stdout.split('\n');
    expect(out).toContain('timeout-ok');
    expect(out).toContain('woke-ok');
    expect(out).toContain('file-removed');
    expect(out).toContain('gap-kept-ok');
    expect(out).toContain('kept');
    expect(out).toContain('dry-ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
