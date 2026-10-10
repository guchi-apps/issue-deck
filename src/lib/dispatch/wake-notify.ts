import { createHmac } from "node:crypto";

/**
 * ジョブ保存直後にサブPCへ「キューを見に行け」と知らせる（#4200）。
 *
 * **起床を早めるだけの追加改善で、pull方式は変えない。** 通知は本文を持たず、受け手
 * （`scripts/dispatch-wake-receiver.mjs`）は起床ファイルを更新するだけ。取得・認証・ホスト能力・
 * 実行枠の判定は従来どおり`claim`が行う。失敗しても握りつぶし、ジョブの保存や呼び出し元を
 * 失敗させない（取りこぼしは定期巡回が回収する）。
 *
 * 通知先は環境変数`DISPATCH_WAKE_TARGETS`（`ホスト名=http://tailnetのアドレス:ポート`のカンマ区切り）
 * で**ホスト単位**に持つ。未設定・対象外のホストには何も送らない（Macなどは行を足すだけで増やせる）。
 * アドレスは構成情報なのでログにもエラーにも出さない。
 */

const WAKE_PATH = "/wake";
const WAKE_TIMEOUT_MS = 2_000;
/** 同じホストへの通知をまとめる時間。この間に積まれたジョブは1回の通知で足りる */
export const WAKE_COALESCE_MS = 200;

/** 受け手（`scripts/lib/dispatch-wake-protocol.mjs`）と同じ手順。食い違わないことはテストで確かめる */
export function signWake(secret: string, hostName: string, timestampMs: number): string {
  const key = createHmac("sha256", secret).update("issue-deck-wake-v1").digest();
  return createHmac("sha256", key).update(`${hostName}.${timestampMs}`).digest("hex");
}

export function parseWakeTargets(raw: string | undefined): Map<string, string> {
  const targets = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const index = entry.indexOf("=");
    if (index <= 0) continue;
    const host = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    try {
      const url = new URL(value);
      // tailnet内（WireGuardで暗号化済み）の素のHTTPだけ。資格情報・パス・クエリ付きは拒否する
      if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) continue;
      if (url.pathname !== "/" ) continue;
      targets.set(host, url.origin);
    } catch {
      continue;
    }
  }
  return targets;
}

const pending = new Set<string>();

export async function sendWake(hostName: string, now: () => number = Date.now): Promise<boolean> {
  const secret = process.env.DISPATCH_SECRET;
  const origin = parseWakeTargets(process.env.DISPATCH_WAKE_TARGETS).get(hostName);
  if (!secret || !origin) return false;
  const timestamp = now();
  try {
    const res = await fetch(`${origin}${WAKE_PATH}`, {
      method: "POST",
      headers: {
        "x-wake-timestamp": String(timestamp),
        "x-wake-signature": signWake(secret, hostName, timestamp),
      },
      signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** ジョブをDBへ保存した直後に呼ぶ。待たずに返り、失敗は誰にも伝えない */
export function notifyDispatchHostWake(hostName: string): void {
  if (!process.env.DISPATCH_WAKE_TARGETS || pending.has(hostName)) return;
  pending.add(hostName);
  const timer = setTimeout(() => {
    pending.delete(hostName);
    void sendWake(hostName).then((ok) => {
      if (!ok) console.warn(`ジョブ即時通知を送れませんでした（ホスト ${hostName}）。定期巡回で回収されます。`);
    });
  }, WAKE_COALESCE_MS);
  timer.unref?.();
}
