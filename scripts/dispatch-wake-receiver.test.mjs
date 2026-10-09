import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signWake } from './lib/dispatch-wake-protocol.mjs';

it('受信サービスは署名が正しい通知だけで起床ファイルを更新し、全インターフェース待ち受けは拒否する', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-test-'));
  const wakeFile = join(dir, 'wake');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, DISPATCH_SECRET: 's3cret', DISPATCH_HOST_NAME: 'subpc', WAKE_LISTEN_ADDR: '127.0.0.1', WAKE_LISTEN_PORT: String(port), DISPATCH_WAKE_FILE: wakeFile };
  const bad = spawn('node', ['scripts/dispatch-wake-receiver.mjs'], { env: { ...env, WAKE_LISTEN_ADDR: '0.0.0.0' } });
  expect(await new Promise((r) => bad.on('exit', r))).toBe(1);
  const child = spawn('node', ['scripts/dispatch-wake-receiver.mjs'], { env });
  try {
    await new Promise((r) => child.stdout.on('data', r));
    const url = `http://127.0.0.1:${port}/wake`;
    const ts = Date.now();
    const post = (headers, path = '/wake') => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers });
    expect((await post({ 'x-wake-timestamp': String(ts), 'x-wake-signature': 'a'.repeat(64) })).status).toBe(401);
    expect(existsSync(wakeFile)).toBe(false);
    expect((await post({}, '/other')).status).toBe(404);
    expect((await fetch(url)).status).toBe(404);
    expect((await post({ 'x-wake-timestamp': String(ts), 'x-wake-signature': signWake('s3cret', 'mac', ts) })).status).toBe(401);
    expect((await post({ 'x-wake-timestamp': String(ts), 'x-wake-signature': signWake('s3cret', 'subpc', ts) })).status).toBe(204);
    expect(readFileSync(wakeFile, 'utf8').trim()).toBe(String(ts));
  } finally {
    child.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});
