import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress } from "node:dns";
import https from "node:https";
import { isIP } from "node:net";

/**
 * 利用者が登録したURLをサーバーから取りに行くときの、内部ネットワークへの到達（SSRF）対策（#4719）。
 * URLの文字列検査だけでは、公開ホスト名を内部アドレスへ解決させる手口（DNS）を防げないため、
 * **接続に使う名前解決の結果そのもの**を検査する。検査と接続が同じ解決結果を使うので、
 * 検査後に解決先を差し替えるDNS rebindingも成立しない。
 */

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

// [先頭アドレス, プレフィックス長]。公開インターネットではないIPv4の範囲
const NON_PUBLIC_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // unspecified・このネットワーク
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT（tailnetもここ）
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local（クラウドのメタデータ169.254.169.254を含む）
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETFプロトコル割り当て
  ["192.0.2.0", 24], // 文書用
  ["192.88.99.0", 24], // 6to4リレー（廃止）
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // ベンチマーク
  ["198.51.100.0", 24], // 文書用
  ["203.0.113.0", 24], // 文書用
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // 予約済み・broadcast
];

function isNonPublicIpv4(ip: string): boolean {
  const n = ipv4ToNumber(ip);
  if (n === null) return true; // 解釈できないものは公開として扱わない
  return NON_PUBLIC_IPV4.some(([base, bits]) => {
    const b = ipv4ToNumber(base)!;
    const size = 2 ** (32 - bits);
    return Math.floor(n / size) === Math.floor(b / size);
  });
}

/** IPv6を8個の16bit値へ展開する。`::`の省略と末尾のIPv4表記（::ffff:1.2.3.4）に対応 */
function expandIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToNumber(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const values = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return values.some(Number.isNaN) ? null : values;
}

const embeddedIpv4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isNonPublicIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (g === null) return true;
  const allZeroUntil = (end: number) => g.slice(0, end).every((v) => v === 0);
  if (allZeroUntil(7) && g[7] <= 1) return true; // ::（unspecified）・::1（loopback）
  if (allZeroUntil(5) && g[5] === 0xffff) return isNonPublicIpv4(embeddedIpv4(g[6], g[7])); // ::ffff:a.b.c.d（IPv4射影）
  if (allZeroUntil(6)) return true; // ::a.b.c.d（互換アドレス・廃止）
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((v) => v === 0)) return isNonPublicIpv4(embeddedIpv4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isNonPublicIpv4(embeddedIpv4(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local（廃止）
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 文書用
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard
  return false;
}

/** 公開インターネット上のアドレスか。IPでない文字列・解釈できない文字列はfalse */
export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isNonPublicIpv4(address);
  if (family === 6) return !isNonPublicIpv6(address);
  return false;
}

/** 解決結果のすべてが公開アドレスのときだけ許可する。1つでも内部があれば、混在でも拒否する */
export function assertPublicAddresses(addresses: ReadonlyArray<{ address: string }>): void {
  if (addresses.length === 0) throw new Error("名前を解決できません");
  const blocked = addresses.find((a) => !isPublicIpAddress(a.address));
  if (blocked) throw new Error("非公開アドレスへ解決されるため接続しません");
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/** 接続に使う名前解決。結果を検査してから返すので、検査と接続の間に解決先が変わらない */
export function publicOnlyLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: LookupCallback,
  resolver: typeof dnsLookup = dnsLookup,
): void {
  resolver(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
    if (err) return callback(err);
    try {
      assertPublicAddresses(addresses);
    } catch (error) {
      return callback(Object.assign(new Error((error as Error).message), { code: "EBLOCKEDADDR" }));
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

export type PublicFetchResult = { httpStatus: number; body: string };

/**
 * 公開アドレスにだけ接続するGET。https限定・リダイレクトは追わない・本文は上限まで。
 * IPアドレス直書きのホストは名前解決を通らないため、ここで拒否する
 */
export function fetchPublicHttps(url: string, options: { timeoutMs: number; bodyLimit: number; lookup?: typeof publicOnlyLookup }): Promise<PublicFetchResult> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (error) {
      return reject(error);
    }
    if (parsed.protocol !== "https:") return reject(new Error("httpsのみ対応しています"));
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0) return reject(new Error("IPアドレスへは接続しません"));
    const lookup = options.lookup ?? publicOnlyLookup;
    const req = https.request(
      parsed,
      { method: "GET", headers: { accept: "application/json" }, lookup: (h, o, cb) => lookup(h, o as { all?: boolean; family?: number }, cb as LookupCallback), timeout: options.timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= options.bodyLimit) chunks.push(chunk);
          else {
            chunks.push(chunk.subarray(0, chunk.length - (size - options.bodyLimit)));
            res.destroy();
          }
        });
        const finish = () => resolve({ httpStatus: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("タイムアウト")));
    req.on("error", reject);
    req.end();
  });
}
