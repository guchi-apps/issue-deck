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

    /// 許可を求め、許可されたらAPNsへ登録する。拒否済みなら何もしない（設定アプリで変える）
    func requestAuthorizationAndRegister() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    fileprivate func didRegister(deviceToken data: Data) {
        deviceToken = data.map { String(format: "%02x", $0) }.joined()
        onDeviceToken?()
    }

    fileprivate func open(path: String) {
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
