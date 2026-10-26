import Foundation

/// ロック画面ウィジェット（#4890）が描く、ClaudeとChatGPT（Codex）の週間枠。`GET /api/share/usage` の応答の形
/// （`src/lib/widget-usage.ts` の `WidgetUsageResponse`）。時刻はすべてepoch ms
struct UsageSnapshot: Codable, Equatable {
    var claude: UsageWindow?
    /// Claudeの5時間枠。古いキャッシュ・旧サーバーには無い
    var claudeFiveHour: UsageWindow?
    var chatgpt: UsageWindow?
    var generatedAt: Double
}

struct UsageWindow: Codable, Equatable {
    /// 使用率(0-100)
    var usedPercent: Double
    var resetsAt: Double
    /// 枠の長さ。開始時刻は `resetsAt - durationMs`
    var durationMs: Double
    /// 値を観測した時刻
    var fetchedAt: Double
    /// リセット時刻を過ぎている。リセット後の使用量は分からないので、使用率は出さない
    var expired: Bool

    /// この時間より古い値は薄く出す
    static let staleAfter: TimeInterval = 2 * 60 * 60

    var resetDate: Date { Date(timeIntervalSince1970: resetsAt / 1000) }

    /// 枠の経過(0-100)。次の取得までの間も目盛りを進めるため、サーバーではなくここで「いま」から計算する
    func elapsedPercent(at now: Date) -> Double {
        guard durationMs > 0 else { return 0 }
        let start = resetsAt - durationMs
        return min(100, max(0, (now.timeIntervalSince1970 * 1000 - start) / durationMs * 100))
    }

    func isStale(at now: Date) -> Bool {
        expired || now.timeIntervalSince1970 * 1000 - fetchedAt > Self.staleAfter * 1000
    }

    /// 「あと3日」「あと14時間」。過ぎていればnil
    func resetText(at now: Date) -> String? {
        let seconds = resetDate.timeIntervalSince(now)
        guard seconds > 0 else { return nil }
        let hours = Int(seconds / 3600)
        if hours >= 24 { return "あと\(hours / 24)日" }
        if hours >= 1 { return "あと\(hours)時間" }
        return "あと\(max(1, Int(seconds / 60)))分"
    }
}

/// 最後に取れた値。通信できなかったときに、空欄ではなく前回の値（古さに応じて薄く）を出すため、App Groupへ置く
enum UsageSnapshotCache {
    private static let key = "lockScreenUsageSnapshot"

    static func load() -> UsageSnapshot? {
        guard let data = UserDefaults(suiteName: ShareConfig.appGroupID)?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(UsageSnapshot.self, from: data)
    }

    static func save(_ snapshot: UsageSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        UserDefaults(suiteName: ShareConfig.appGroupID)?.set(data, forKey: key)
    }

    static func clear() {
        UserDefaults(suiteName: ShareConfig.appGroupID)?.removeObject(forKey: key)
    }
}

enum UsageAPI {
    /// 共有トークン（`ShareSession`）で呼ぶ。ウィジェットはアプリのログインCookieを持たないため
    static func fetch(token: String) async throws -> UsageSnapshot {
        var request = URLRequest(url: ShareConfig.serverBaseURL.appendingPathComponent("api/share/usage"))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await URLSession.shared.data(for: request) }
        catch { throw ShareAPIError.network }
        switch (response as? HTTPURLResponse)?.statusCode {
        case 200:
            guard let snapshot = try? JSONDecoder().decode(UsageSnapshot.self, from: data) else {
                throw ShareAPIError.rejected("利用状況を読み取れませんでした")
            }
            return snapshot
        case 401: throw ShareAPIError.unauthorized
        default: throw ShareAPIError.rejected("利用状況を取得できませんでした")
        }
    }
}
