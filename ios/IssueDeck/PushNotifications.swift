import UIKit
import UserNotifications

/// ネイティブ通知（APNs。#4250）の受け口。通知の許可・端末トークンの取得・タップ時の遷移だけを持つ。
/// 送る中身と宛先の管理はサーバー（`/api/notifications/apns`・`src/lib/notifications/apns.ts`）が正。
final class PushCenter {
    static let shared = PushCenter()

    /// APNsから受け取った端末トークン（16進）。ログイン前は登録できないため、ここへ持っておく
    private(set) var deviceToken: String?
    /// 通知のタップで開くパス。起動直後はWebViewModelが準備できていないので、受け取るまで保持する
    private var pendingPath: String?

    var onDeviceToken: (() -> Void)?
    var onOpenPath: ((String) -> Void)? {
        didSet { flushPendingPath() }
    }

    private static let receivingEnabledKey = "pushReceivingEnabled"
    private static let lastTokenKey = "pushLastDeviceToken"

    /// この端末で通知を受け取る設定か（#4275）。OSの許可とは別の、利用者のオン・オフ。
    /// 既定はオン（従来の挙動）。**オフの間は、起動・ページ読み込み・トークン再取得のどの経路でも
    /// 登録しない**ので、再読み込みや再起動で勝手にオンへ戻らない
    var isReceivingEnabled: Bool {
        get { UserDefaults.standard.object(forKey: Self.receivingEnabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: Self.receivingEnabledKey) }
    }

    /// 最後に受け取ったトークン。オフのまま再起動してもサーバーの登録を解除し直せるよう残す
    var knownToken: String? { deviceToken ?? UserDefaults.standard.string(forKey: Self.lastTokenKey) }

    private var tokenWaiters: [CheckedContinuation<String?, Never>] = []

    /// 許可を求め、許可されたらAPNsへ登録する。拒否済み・受信オフなら何もしない（設定アプリで変える）
    func requestAuthorizationAndRegister() {
        guard isReceivingEnabled else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    /// "notDetermined" / "denied" / "authorized"。仮許可・一時許可も受け取れる状態として扱う
    func authorizationState() async -> String {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        default: return "authorized"
        }
    }

    /// 受信をオンにする。未選択なら許可を求め、許可されればAPNsへ登録してトークンを待つ。
    /// 拒否済みならOSの許可は変えず、現在の状態をそのまま返す
    @MainActor
    func enable() async {
        isReceivingEnabled = true
        let center = UNUserNotificationCenter.current()
        if await authorizationState() == "notDetermined" {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
        guard await authorizationState() == "authorized" else { return }
        UIApplication.shared.registerForRemoteNotifications()
        _ = await waitForToken(timeout: 10)
    }

    /// 受信をオフにする。サーバー側の解除は呼び出し側が行う
    func disable() {
        isReceivingEnabled = false
    }

    private func waitForToken(timeout: TimeInterval) async -> String? {
        await withCheckedContinuation { continuation in
            tokenWaiters.append(continuation)
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.resumeWaiters(with: self?.deviceToken)
            }
        }
    }

    private func resumeWaiters(with token: String?) {
        let waiters = tokenWaiters
        tokenWaiters = []
        waiters.forEach { $0.resume(returning: token) }
    }

    fileprivate func didRegister(deviceToken data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        UserDefaults.standard.set(token, forKey: Self.lastTokenKey)
        resumeWaiters(with: token)
        onDeviceToken?()
    }

    func open(path: String) {
        pendingPath = path
        flushPendingPath()
    }

    private func flushPendingPath() {
        guard let path = pendingPath, let handler = onOpenPath else { return }
        pendingPath = nil
        handler(path)
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        PushCenter.shared.requestAuthorizationAndRegister()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushCenter.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // シミュレータや権限未設定では失敗する。次回起動でやり直すだけなので握る
    }

    /// 前面にいるときもバナーを出す（Web Pushの通知と同じく、開いていても知らせる）
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        if let path = response.notification.request.content.userInfo["url"] as? String {
            await MainActor.run { PushCenter.shared.open(path: path) }
        }
    }
}
