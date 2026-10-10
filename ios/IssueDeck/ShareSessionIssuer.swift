import Foundation
import WebKit

/// 共有画面（Share Extension）が使う専用セッションの発行・更新（#4298）。
///
/// 拡張はWKWebViewのCookieを読めないため、ログイン中のアプリ本体がWebViewの中から
/// `POST /api/share/token` を呼び、返った専用トークンをKeychain共有グループへ置く。
/// ページを読み終えるたびに呼ぶので、有効期限（30日）は使っている限り延び続ける。
/// 未ログイン（401）ならKeychainのセッションを消す（ログアウト・アカウント切替で拡張へ引き継がない）。
/// 発行はこの経路だけで、別アカウントへ切り替わった場合も端末識別子ごとに前のトークンはサーバーが失効させる
@MainActor
struct ShareSessionIssuer {
    let webView: WKWebView

    func refresh() async {
        guard let url = webView.url, AppConfig.isAppURL(url) else { return }
        let deviceId = ShareSessionStore.deviceId()
        let script = """
        const response = await fetch('/api/share/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ deviceId: deviceId })
        });
        if (!response.ok) { return { status: response.status }; }
        const body = await response.json();
        return { status: 200, token: body.token, expiresAt: body.expiresAt, userId: body.userId, login: body.login };
        """
        let value = try? await webView.callAsyncJavaScript(script, arguments: ["deviceId": deviceId], contentWorld: .page)
        guard let dictionary = value as? [String: Any], let status = dictionary["status"] as? Int else { return }
        switch status {
        case 200:
            guard let token = dictionary["token"] as? String,
                  let expires = dictionary["expiresAt"] as? String,
                  let expiresAt = ISO8601DateFormatter.withFractionalSeconds.date(from: expires) ?? ISO8601DateFormatter().date(from: expires),
                  let userId = dictionary["userId"] as? String
            else { return }
            ShareSessionStore.save(ShareSession(
                token: token, expiresAt: expiresAt, userId: userId,
                login: dictionary["login"] as? String ?? "", deviceId: deviceId
            ))
        case 401:
            ShareSessionStore.clear()
        default:
            // 一時的な失敗。いまあるセッションをそのまま使う
            break
        }
    }
}

private extension ISO8601DateFormatter {
    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
