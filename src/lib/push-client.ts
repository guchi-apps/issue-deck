/**
 * ブラウザ側のPush通知（#838）まわりの判定と小物。**DOMを触るがReactには依存しない**ので、
 * 判定だけを単体テストできるように切り出してある。
 */

/** 画面が取りうる状態。**「押せない」で終わらせず、次に何をすればよいかを出す**ための区分 */
export type PushAvailability =
  /** Service Worker・Push API・Notificationが揃っている */
  | "available"
  /**
   * iOSで、ホーム画面に追加せずSafariのタブから開いている。
   * iOSはstandalone起動のときしかWeb Pushを許さない（iOS 16.4以降）
   */
  | "needs-standalone"
  /** そもそもPushに対応していないブラウザ */
  | "unsupported";

/**
 * この端末でPush通知を登録できるか。
 *
 * iOSの分岐を`unsupported`と分けているのは、**ユーザーができることが違う**から。
 * ホーム画面に追加すれば受け取れるのに「対応していません」と出すと、諦めさせてしまう。
 *
 * iOS 16.4以降のSafariはタブで開いていても`PushManager`自体は存在する
 * （`serviceWorker`も同様）。実際に`subscribe()`を呼ぶと失敗するため、
 * **standaloneかどうかで先に分ける**。
 */
export function detectPushAvailability(win: Window = window): PushAvailability {
  const hasApi =
    "serviceWorker" in win.navigator && "PushManager" in win && "Notification" in win;
  if (isIosLike(win) && !isStandalone(win)) return "needs-standalone";
  return hasApi ? "available" : "unsupported";
}

/** iOS・iPadOSか。iPadOSはMacintoshを名乗るため、タッチの有無も見る */
function isIosLike(win: Window): boolean {
  const ua = win.navigator.userAgent;
  if (/iPhone|iPod|iPad/.test(ua)) return true;
  return /Macintosh/.test(ua) && win.navigator.maxTouchPoints > 1;
}

/** ホーム画面のアイコンから開いているか */
function isStandalone(win: Window): boolean {
  if (win.matchMedia?.("(display-mode: standalone)").matches) return true;
  // iOS Safari独自。標準の`display-mode`が効かない版がまだある
  return (win.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * VAPIDの公開鍵（base64url）を`applicationServerKey`が要求する形へ変換する。
 * `atob`がbase64urlを受け付けないため、標準のbase64へ直してから使う。
 *
 * 戻り値を`ArrayBuffer`にしているのは型の都合。`Uint8Array`の`buffer`は
 * `SharedArrayBuffer`でもありうるという扱いになっており、`BufferSource`へ渡せない。
 */
export function urlBase64ToArrayBuffer(base64UrlString: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64UrlString.length % 4)) % 4);
  const base64 = (base64UrlString + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return buffer;
}

/**
 * 宛先URLの一意キー（サーバー側の`pushEndpointKey`と同じSHA-256）。
 * 端末の一覧で「この端末」を見分けるためだけに使う。
 */
export async function pushEndpointKeyInBrowser(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * `navigator.userAgent`から端末名を作る。**厳密な判別はしない**——一覧で自分の端末を
 * 見分けられればよく、当てにいくほど当たらなくなる。
 */
export function describePushDevice(userAgent: string | null): string {
  if (!userAgent) return "不明な端末";
  const os = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Mac OS X/.test(userAgent)
            ? "Mac"
            : /Linux/.test(userAgent)
              ? "Linux"
              : null;
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : null;
  if (os && browser) return `${browser} / ${os}`;
  return os ?? browser ?? "不明な端末";
}
