/**
 * iOSアプリ（#3846）とサーバーで揃える定数。値を変えるときは `ios/IssueDeck/AppConfig.swift`
 * も直す（`ios/scripts/check-consistency.mjs` が照合する）。
 */

/** 認証シートの戻り先スキーム。 */
export const NATIVE_SCHEME = "issuedeck";

export const NATIVE_LOGIN_CALLBACK = `${NATIVE_SCHEME}://auth-callback`;

/** 認証シートから戻すときの失敗の種類（アプリはこの値で分岐する）。 */
export type NativeLoginError = "auth_failed" | "not_allowed";

export function nativeLoginErrorUrl(error: NativeLoginError): string {
  return `${NATIVE_LOGIN_CALLBACK}?error=${error}`;
}

export function nativeLoginCodeUrl(code: string): string {
  return `${NATIVE_LOGIN_CALLBACK}?code=${encodeURIComponent(code)}`;
}
