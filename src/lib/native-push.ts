/**
 * iOSアプリ（WKWebView。#4250）のネイティブ通知を、設定の通知欄から扱うための橋渡し（#4275）。
 *
 * アプリ内ではWeb Push（Service Worker）が動かないので、通知欄は**ネイティブの許可状態・
 * この端末の受信設定・サーバーの登録**から状態を決める。Swift側の窓口は
 * `ios/IssueDeck/WebViewModel.swift`の`issueDeckPush`メッセージハンドラ。
 */

/** `ios/IssueDeck/AppConfig.swift`の`userAgentApplicationName`と揃える */
const NATIVE_APP_USER_AGENT_MARKER = "IssueDeckIOS";

/** アプリが前面へ戻ったとき・設定アプリから戻ったときにSwift側が投げる合図 */
export const NATIVE_PUSH_REFRESH_EVENT = "issue-deck:native-push-refresh";

export type NativePushPermission = "notDetermined" | "denied" | "authorized";

export type NativePushStatus = {
  permission: NativePushPermission;
  /** この端末で受け取る設定か（利用者のオン・オフ。OSの許可とは別） */
  enabled: boolean;
  /** APNsの端末トークン。まだ取れていなければnull */
  token: string | null;
};

export type NativePushActionResult = NativePushStatus & {
  /** サーバーへの登録・解除まで済んだか。falseなら再試行できる */
  serverOk: boolean;
};

export type NativePushState =
  /** ネイティブの状態、またはサーバーの登録一覧をまだ取れていない */
  | "checking"
  | "on"
  | "off"
  /** OSの通知が拒否されている。iPhoneの設定でしか直せない */
  | "denied"
  /** 受け取る設定で許可もあるが、端末トークンがまだ無い（登録中・登録失敗） */
  | "registering"
  /** 端末トークンはあるのにサーバーに行が無い（送信時の失効で消えた）。登録し直しが要る */
  | "expired";

type NativePushHandler = {
  postMessage(message: { action: string }): Promise<unknown>;
};

type WebKitWindow = Window & {
  webkit?: { messageHandlers?: { issueDeckPush?: NativePushHandler } };
};

export function isNativeApp(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return userAgent.includes(NATIVE_APP_USER_AGENT_MARKER);
}

function handler(): NativePushHandler | null {
  if (typeof window === "undefined") return null;
  return (window as WebKitWindow).webkit?.messageHandlers?.issueDeckPush ?? null;
}

async function call<T>(action: "status" | "enable" | "disable" | "openSettings"): Promise<T> {
  const target = handler();
  if (!target) throw new Error("アプリ本体と通信できませんでした。アプリを更新してください");
  return (await target.postMessage({ action })) as T;
}

export const nativePushBridge = {
  status: () => call<NativePushStatus>("status"),
  enable: () => call<NativePushActionResult>("enable"),
  disable: () => call<NativePushActionResult>("disable"),
  openSettings: () => call<void>("openSettings"),
};

/**
 * この端末の状態。**「オン」と言い切れるのは、許可・受信設定・登録が全部そろったときだけ**。
 * 判断材料が足りないものをオンにもオフにも倒さない。
 */
export function describeNativePushState(input: {
  status: NativePushStatus | null;
  /** サーバーが持っている`endpointKey`の一覧。未取得はnull */
  serverEndpointKeys: readonly string[] | null;
  /** 端末トークンから作った`endpointKey`。トークンが無ければnull */
  tokenEndpointKey: string | null;
}): NativePushState {
  const { status } = input;
  if (!status) return "checking";
  if (status.permission === "denied") return "denied";
  if (!status.enabled || status.permission === "notDetermined") return "off";
  if (status.token === null) return "registering";
  if (input.serverEndpointKeys === null || input.tokenEndpointKey === null) return "checking";
  return input.serverEndpointKeys.includes(input.tokenEndpointKey) ? "on" : "expired";
}
