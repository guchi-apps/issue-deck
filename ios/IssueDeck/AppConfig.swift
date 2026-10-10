import Foundation

/// アプリ全体で使う定数。画面・機能はすべてWeb版（正本）にあり、アプリはそれを開く殻に徹する（#441）。
enum AppConfig {
    /// Web版のURL。開発サーバーへ向けるときもここだけを変える（ios/README.md）
    static let baseURL = URL(string: "https://issuedeck.gucchii.com/")!

    /// 認証シートの戻り先スキーム。サーバー側の `src/lib/native-auth/native-app.ts` の
    /// `NATIVE_SCHEME` と揃えること（`ios/scripts/check-consistency.mjs` が照合する）。
    /// Supabase・GitHubのリダイレクト先へは登録しない（サーバーの /auth/callback だけが返す）
    static let authCallbackScheme = "issuedeck"

    /// User-Agentの末尾に足す識別子（`IssueDeckIOS/1.0` の形）。サーバーログで見分けるためだけで、
    /// Web側の挙動はこの値で変えない。既定の `Mobile/…` は残したまま足す
    static var userAgentApplicationName: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        return "Mobile/15E148 IssueDeckIOS/\(version)"
    }

    /// このURLがアプリで開くべきWeb版の画面か（ホスト・スキーム・ポートまで一致）。
    /// 一致しないURLはWebViewへ読み込まず、Safari等で開く
    static func isAppURL(_ url: URL) -> Bool {
        url.scheme == baseURL.scheme && url.host == baseURL.host && url.port == baseURL.port
    }
}

/// WebViewの遷移のうち、アプリが横取りして認証シートで行うもの。
/// Web側のボタンは変えない。ログインボタンはクライアントのSupabaseが認可URL
/// （`<Supabaseのホスト>/auth/v1/authorize?provider=github&redirect_to=…`）へ遷移させるので、
/// その遷移だけを捕まえて認証シートへ渡す（GitHubは埋め込みWebView内のOAuthを拒み得る）
enum InterceptedRoute: Equatable {
    /// GitHubログイン。`next` は `redirect_to`（`/auth/callback?next=…`）から引き継ぐ
    case login(next: String?)

    static func classify(_ url: URL) -> InterceptedRoute? {
        guard !AppConfig.isAppURL(url), url.path == "/auth/v1/authorize" else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.first(where: { $0.name == "provider" })?.value == "github" else { return nil }
        let redirectTo = items.first(where: { $0.name == "redirect_to" })?.value
        let next = redirectTo
            .flatMap { URLComponents(string: $0)?.queryItems }?
            .first(where: { $0.name == "next" })?.value
        return .login(next: next)
    }
}
