import Combine
import Network
import SwiftUI
import UIKit
import WebKit

/// Web版を開く WKWebView と、その読み込み状態を持つ。
final class WebViewModel: NSObject, ObservableObject {
    @Published private(set) var failure: LoadFailure?
    @Published private(set) var isRetrying = false
    /// 共有メニューから受け取った素材の取り込み状況（#3847）
    @Published private(set) var shareImport: ShareImportState = .idle
    private var isImportingShare = false

    let webView: WKWebView

    private let auth = NativeAuth()
    private let pathMonitor = NWPathMonitor()
    private var isNetworkAvailable = true
    private var hasStarted = false
    /// 最後に開こうとしたメインフレームのURL。読み込みに失敗すると `webView.url` は
    /// 直前に表示できていた画面のままなので、再試行はこちらを開き直す
    private var lastRequestedURL: URL?

    override init() {
        let configuration = WKWebViewConfiguration()
        // Cookie・localStorage（Supabaseのセッション）を端末に残し、再起動後もログインを保つ
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = AppConfig.userAgentApplicationName

        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // 読み込み前の一瞬に白い面が出ないよう、ヘッダーと同じ色を下地にする
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "HeaderBand")
        webView.scrollView.backgroundColor = UIColor(named: "HeaderBand")
        // 下端は`ignoresSafeArea`でWebViewごと広げている。既定の`.automatic`だと下の安全領域ぶんが
        // 内側余白になってWebのレイアウト高さが縮み、フッターの下に空きが出る（#4258）。
        // 上端はSwiftUI側がステータスバーの下から始めているので、`.never`でも影響しない
        webView.scrollView.contentInsetAdjustmentBehavior = .never

        // ネイティブ通知（#4250）。トークンが届いたら登録し、通知のタップは該当画面を開く
        PushCenter.shared.onDeviceToken = { [weak self] in self?.registerPushToken() }
        PushCenter.shared.onOpenPath = { [weak self] in self?.loadAppPath($0) }
    }

    deinit {
        pathMonitor.cancel()
    }

    func startIfNeeded() {
        guard !hasStarted else { return }
        hasStarted = true

        pathMonitor.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            DispatchQueue.main.async { self?.networkChanged(available: available) }
        }
        pathMonitor.start(queue: .main)
        load(AppConfig.baseURL)
    }

    func retry() {
        isRetrying = true
        load(lastRequestedURL ?? AppConfig.baseURL)
    }

    /// 共有メニューの下書きを取り込む。前面に出たとき・ページを読み終えたとき・ログイン後に呼ぶ。
    /// 同時に2つは走らせない（同じ素材を二重にアップロードしない）
    func importSharedDrafts() {
        guard !isImportingShare else { return }
        isImportingShare = true
        Task { @MainActor in
            defer { isImportingShare = false }
            let importer = ShareImporter(webView: webView)
            if !ShareDraftStore.list().isEmpty { shareImport = .importing }
            switch await importer.run(openPath: { [weak self] in self?.loadAppPath($0) }) {
            case .imported, .nothingToDo:
                shareImport = .idle
            case .waitingForLogin(let count):
                shareImport = .waitingForLogin(count: count)
            case .failed(let message):
                shareImport = .failed(message: message)
            }
        }
    }

    /// 端末トークンをサーバーへ登録する。ログインCookieはWebViewの中にしか無いので、
    /// WebViewの中から`fetch`する。未ログイン（401）なら登録せず、次にページを読み終えたとき再試行する。
    /// 同じトークンの再登録は上書きなので、毎回呼んでよい
    func registerPushToken() {
        guard let token = PushCenter.shared.deviceToken, failure == nil else { return }
        Task { @MainActor in
            _ = try? await webView.callAsyncJavaScript(
                """
                await fetch('/api/notifications/apns', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'same-origin',
                  body: JSON.stringify({ deviceToken: token })
                });
                """,
                arguments: ["token": token],
                contentWorld: .page
            )
        }
    }

    /// 取り込めない素材を利用者が破棄する
    func discardSharedDrafts() {
        ShareDraftStore.list().forEach(ShareDraftStore.delete)
        shareImport = .idle
    }

    private func load(_ url: URL) {
        lastRequestedURL = url
        webView.load(URLRequest(url: url))
    }

    /// アプリ内の相対パスを開く（絶対URL・他オリジンは無視して起動画面へ）
    private func loadAppPath(_ path: String) {
        guard let url = URL(string: path, relativeTo: AppConfig.baseURL)?.absoluteURL, AppConfig.isAppURL(url) else {
            load(AppConfig.baseURL)
            return
        }
        load(url)
    }

    private func networkChanged(available: Bool) {
        let recovered = available && !isNetworkAvailable
        isNetworkAvailable = available
        if recovered, failure == .offline { retry() }
    }

    private func fail(with error: Error) {
        let nsError = error as NSError
        // 別の読み込みに置き換わった・レスポンスを見て自分で止めた（5xx）場合は失敗扱いにしない
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain", nsError.code == 102 { return }

        isRetrying = false
        let offlineCodes: Set<Int> = [
            NSURLErrorNotConnectedToInternet,
            NSURLErrorNetworkConnectionLost,
            NSURLErrorDataNotAllowed,
            NSURLErrorInternationalRoamingOff,
        ]
        if !isNetworkAvailable || (nsError.domain == NSURLErrorDomain && offlineCodes.contains(nsError.code)) {
            failure = .offline
        } else {
            failure = .server(status: nil)
        }
    }

    private func openExternally(_ url: URL) {
        UIApplication.shared.open(url)
    }
}

// MARK: - 認証シートとの往復（ログイン）

extension WebViewModel {
    /// WebViewが横取りした遷移を、認証シートで行う。Web側のリンクは素の `<a>` のまま
    fileprivate func handle(_ route: InterceptedRoute) {
        switch route {
        case .login(let next):
            startLogin(next: next)
        }
    }

    /// GitHubログイン。認証シートで `/auth/native/start` を開き、GitHub → Supabase → サーバーの
    /// `/auth/callback` と進んで、`issuedeck://auth-callback?code=<引き継ぎコード>` で戻る。
    /// コードは一度限り・60秒で、ここで持つ `verifier` が無ければ消費できない
    private func startLogin(next: String?) {
        let pkce = PKCEPair()
        var components = URLComponents(
            url: AppConfig.baseURL.appending(path: "auth/native/start"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "challenge", value: pkce.challenge)]
        if let next { components?.queryItems?.append(URLQueryItem(name: "next", value: next)) }
        guard let url = components?.url else { return }

        auth.start(url: url) { [weak self] result in
            guard let self else { return }
            switch result {
            case .callback(let callbackURL):
                Task { await self.finishLogin(callbackURL: callbackURL, verifier: pkce.verifier) }
            case .failed:
                self.loadAppPath("/login?error=callback_failed")
            case .cancelled:
                break
            }
        }
    }

    private func finishLogin(callbackURL: URL, verifier: String) async {
        guard
            callbackURL.scheme == AppConfig.authCallbackScheme,
            callbackURL.host == "auth-callback",
            let items = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems
        else {
            loadAppPath("/login?error=callback_failed")
            return
        }

        if items.first(where: { $0.name == "error" })?.value == "not_allowed" {
            loadAppPath("/login?error=not_allowed")
            return
        }
        guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            loadAppPath("/login?error=callback_failed")
            return
        }

        // WebViewの中（ログインCookieが届く側）で消費する。コードとverifierはURLではなく本文で送る
        let script = """
        const response = await fetch('/auth/native/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ code: code, verifier: verifier })
        });
        if (!response.ok) { return { status: response.status }; }
        const body = await response.json();
        return { status: response.status, next: body.next };
        """
        let value = try? await webView.callAsyncJavaScript(
            script,
            arguments: ["code": code, "verifier": verifier],
            contentWorld: .page
        )
        let dictionary = value as? [String: Any]
        let status = dictionary?["status"] as? Int

        if status == 200, let next = dictionary?["next"] as? String {
            loadAppPath(next)
        } else if status == 403 {
            loadAppPath("/login?error=not_allowed")
        } else {
            loadAppPath("/login?error=callback_failed")
        }
    }
}

// MARK: - 読み込み

extension WebViewModel: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }

        if ["about", "blob", "data"].contains(url.scheme ?? "") { return .allow }

        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true

        // ログインの開始は、WebViewの中では行わず認証シートへ渡す
        if isMainFrame, let route = InterceptedRoute.classify(url) {
            handle(route)
            return .cancel
        }

        if AppConfig.isAppURL(url) {
            if isMainFrame { lastRequestedURL = url }
            return .allow
        }
        // 埋め込み（iframe）はそのまま。画面ごと他のサイトへ移るものはSafari等で開く
        if !isMainFrame { return .allow }
        openExternally(url)
        return .cancel
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse
    ) async -> WKNavigationResponsePolicy {
        // Apache の 502/503（バックエンドの再起動中など）を、素のエラーページのまま見せない
        if navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse,
           response.statusCode >= 500 {
            isRetrying = false
            failure = .server(status: response.statusCode)
            return .cancel
        }
        return .allow
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isRetrying = false
        failure = nil
        // ログイン後の画面を読み終えたとき、待っていた共有の素材を取り込む
        importSharedDrafts()
        // ログインが済んでいれば端末トークンを登録する（未ログインなら何も起きない）
        registerPushToken()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(with: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(with: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // メモリ不足などでWebの描画プロセスが落ちると、白い画面のまま戻らない
        load(lastRequestedURL ?? AppConfig.baseURL)
    }
}

// MARK: - 新しいウインドウ・ダイアログ

extension WebViewModel: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        // target="_blank" のリンク。アプリの画面なら同じWebViewで、外部ならSafari等で開く
        if let url = navigationAction.request.url {
            if let route = InterceptedRoute.classify(url) {
                handle(route)
            } else if AppConfig.isAppURL(url) {
                load(url)
            } else {
                openExternally(url)
            }
        }
        return nil
    }

    /// `window.confirm()`（削除の確認など）。UIDelegateで実装しないと常に false が返り、実行できない
    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo
    ) async -> Bool {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "キャンセル", style: .cancel) { _ in continuation.resume(returning: false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume(returning: true) })
            guard present(alert) else { return continuation.resume(returning: false) }
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo
    ) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume() })
            guard present(alert) else { return continuation.resume() }
        }
    }

    private func present(_ controller: UIViewController) -> Bool {
        guard var top = webView.window?.rootViewController else { return false }
        while let presented = top.presentedViewController { top = presented }
        top.present(controller, animated: true)
        return true
    }
}

/// SwiftUI に WKWebView を置くための入れ物。WebView 本体は WebViewModel が持ち続ける
struct WebViewContainer: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
