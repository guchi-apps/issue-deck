import SwiftUI
import WidgetKit

/// ロック画面ウィジェット（#4890）。ClaudeとChatGPT（Codex）の週間枠を、使用量の塗りと
/// 週の経過を示す縦の目盛りで並べる。Web版「AI使用量」のメーター（`usage-meter.tsx`）と同じ読み方で、
/// 塗りが目盛りを越えた分（時間より速く使っている分）は斜線で示す。
/// ロック画面は白の濃淡だけで描かれるため、色ではなく濃淡と斜線で区別する
@main
struct UsageWidgetBundle: WidgetBundle {
    var body: some Widget {
        SubscriptionUsageWidget()
    }
}

struct SubscriptionUsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "SubscriptionUsage", provider: UsageProvider()) { entry in
            UsageWidgetRoot(entry: entry)
        }
        .configurationDisplayName("サブスク枠")
        .description("ClaudeとChatGPTの週間枠（Claudeは5時間枠も）が、経過に対してどこまで進んでいるかを表示します")
        .supportedFamilies([.accessoryRectangular, .systemSmall, .systemMedium, .systemLarge])
    }
}

struct UsageEntry: TimelineEntry {
    enum State: Equatable {
        case loaded(UsageSnapshot)
        /// 共有トークンが無い・失効した。アプリを開けば発行し直される
        case needsLogin
        /// 一度も取れておらず、いまも取れない
        case unavailable
    }

    var date: Date
    var state: State
}

struct UsageProvider: TimelineProvider {
    /// 次の取得を頼む間隔。実際の間隔はiOSが決める（目安）
    private static let refreshInterval: TimeInterval = 30 * 60
    /// 取得の間も目盛りを進めるため、この間隔でエントリを並べる
    private static let entryStep: TimeInterval = 10 * 60

    static let sample = UsageSnapshot(
        claude: UsageWindow(usedPercent: 38, resetsAt: (Date().timeIntervalSince1970 + 3 * 86_400) * 1000,
                            durationMs: 7 * 86_400_000, fetchedAt: Date().timeIntervalSince1970 * 1000, expired: false),
        claudeFiveHour: UsageWindow(usedPercent: 55, resetsAt: (Date().timeIntervalSince1970 + 2 * 3_600) * 1000,
                                    durationMs: 5 * 3_600_000, fetchedAt: Date().timeIntervalSince1970 * 1000, expired: false),
        chatgpt: UsageWindow(usedPercent: 21, resetsAt: (Date().timeIntervalSince1970 + 5 * 86_400) * 1000,
                             durationMs: 7 * 86_400_000, fetchedAt: Date().timeIntervalSince1970 * 1000, expired: false),
        generatedAt: Date().timeIntervalSince1970 * 1000
    )

    func placeholder(in context: Context) -> UsageEntry {
        UsageEntry(date: Date(), state: .loaded(Self.sample))
    }

    func getSnapshot(in context: Context, completion: @escaping (UsageEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        Task { completion(await Self.load(now: Date())) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UsageEntry>) -> Void) {
        Task {
            let now = Date()
            let entry = await Self.load(now: now)
            let count = Int(Self.refreshInterval / Self.entryStep)
            let entries = (0..<count).map { step in
                UsageEntry(date: now.addingTimeInterval(Double(step) * Self.entryStep), state: entry.state)
            }
            completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(Self.refreshInterval))))
        }
    }

    static func load(now: Date) async -> UsageEntry {
        guard let session = ShareSessionStore.load() else {
            UsageSnapshotCache.clear()
            return UsageEntry(date: now, state: .needsLogin)
        }
        do {
            let snapshot = try await UsageAPI.fetch(token: session.token)
            UsageSnapshotCache.save(snapshot)
            return UsageEntry(date: now, state: .loaded(snapshot))
        } catch ShareAPIError.unauthorized {
            UsageSnapshotCache.clear()
            return UsageEntry(date: now, state: .needsLogin)
        } catch {
            // 通信できないときは前回の値を出す（古ければ行ごと薄くなる）
            if let cached = UsageSnapshotCache.load() { return UsageEntry(date: now, state: .loaded(cached)) }
            return UsageEntry(date: now, state: .unavailable)
        }
    }
}

/// ロック画面は透過、ホーム画面は端末の外観に合わせた背景
struct UsageWidgetRoot: View {
    let entry: UsageEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        UsageWidgetView(entry: entry)
            .containerBackground(for: .widget) {
                if family == .accessoryRectangular { Color.clear } else { Color(.systemBackground) }
            }
            .widgetURL(UsageWidgetView.openURL)
    }
}

struct UsageWidgetView: View {
    /// タップでアプリの「AI使用量」を開く（`ios/IssueDeck/IssueDeckApp.swift`の`onOpenURL`が受ける）
    static let openURL = URL(string: "\(ShareConfig.appURLScheme)://usage")!

    let entry: UsageEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch entry.state {
        case .loaded(let snapshot):
            if family == .accessoryRectangular {
                lockScreen(snapshot)
            } else {
                HomeUsageView(snapshot: snapshot, now: entry.date, family: family)
            }
        case .needsLogin:
            message("IssueDeckを開くと表示されます")
        case .unavailable:
            message("利用状況を取得できません")
        }
    }

    private func lockScreen(_ snapshot: UsageSnapshot) -> some View {
        Group {
            VStack(alignment: .leading, spacing: 6) {
                UsageRow(name: "Claude", window: snapshot.claude, fiveHour: snapshot.claudeFiveHour, now: entry.date)
                UsageRow(name: "ChatGPT", window: snapshot.chatgpt, now: entry.date)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
    }

    private func message(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("サブスク枠").font(.system(size: 12, weight: .semibold))
            Text(text).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

struct UsageRow: View {
    let name: String
    let window: UsageWindow?
    /// 指定があれば、週間バーの上に5時間枠のバー（グラフだけ）を足す
    var fiveHour: UsageWindow?
    let now: Date

    /// リセット後・未取得は使用率が分からない
    private var used: Double? {
        guard let window, !window.expired else { return nil }
        return window.usedPercent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(name).font(.system(size: 12, weight: .semibold))
                if let reset = window?.resetText(at: now) {
                    Text(reset).font(.system(size: 10)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Text(used.map { "\(Int($0.rounded()))%" } ?? "—")
                    .font(.system(size: 12, weight: .bold))
                    .monospacedDigit()
            }
            if let fiveHour {
                let live = fiveHour.expired ? nil : fiveHour.usedPercent
                PaceBar(used: live, elapsed: fiveHour.expired ? nil : fiveHour.elapsedPercent(at: now), height: 9)
                    .opacity(fiveHour.isStale(at: now) ? 0.5 : 1)
            }
            PaceBar(used: used, elapsed: window?.elapsedPercent(at: now))
        }
        .lineLimit(1)
        .opacity(window.map { $0.isStale(at: now) } ?? true ? 0.5 : 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        guard let window, let used else { return "\(name) 週間枠 取得できていません" }
        let five = fiveHour.flatMap { $0.expired ? nil : "5時間枠 使用\(Int($0.usedPercent.rounded()))% " } ?? ""
        let elapsed = Int(window.elapsedPercent(at: now).rounded())
        return "\(name) \(five)週間枠 使用\(Int(used.rounded()))% 経過\(elapsed)% \(window.resetText(at: now) ?? "")でリセット"
    }
}

/// ホーム画面（小・中・大）の表示。ロック画面と同じバーの読み方で、サイズに応じて文字を足す
struct HomeUsageView: View {
    let snapshot: UsageSnapshot
    let now: Date
    let family: WidgetFamily

    private var detailed: Bool { family != .systemSmall }

    var body: some View {
        VStack(alignment: .leading, spacing: family == .systemLarge ? 16 : 8) {
            if family == .systemLarge {
                HStack {
                    Text("サブスク枠").font(.system(size: 15, weight: .semibold))
                    Spacer()
                    Text(now, style: .time).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            if family == .systemLarge {
                HomeRow(title: "Claude 5時間枠", window: snapshot.claudeFiveHour, now: now, detailed: true)
                HomeRow(title: "Claude 週間枠", window: snapshot.claude, now: now, detailed: true)
                HomeRow(title: "ChatGPT 週間枠", window: snapshot.chatgpt, now: now, detailed: true)
                Spacer(minLength: 0)
                Text("塗り＝使用率／縦線＝枠の経過／斜線＝時間より速く使った分／薄い表示＝古い値")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
            } else {
                HomeGroupRow(name: "Claude", week: snapshot.claude, five: snapshot.claudeFiveHour, now: now, detailed: detailed)
                HomeGroupRow(name: "ChatGPT", week: snapshot.chatgpt, five: nil, now: now, detailed: detailed)
            }
        }
        .lineLimit(1)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// 小・中: 1サービス分（5時間枠があれば上に足す）
struct HomeGroupRow: View {
    let name: String
    let week: UsageWindow?
    let five: UsageWindow?
    let now: Date
    let detailed: Bool

    private func used(_ w: UsageWindow?) -> Double? {
        guard let w, !w.expired else { return nil }
        return w.usedPercent
    }
    private func pct(_ w: UsageWindow?) -> String { used(w).map { "\(Int($0.rounded()))%" } ?? "—" }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(name).font(.system(size: 13, weight: .semibold))
                if let five, detailed {
                    Text("5時間枠 \(pct(five))" + (five.resetText(at: now).map { "・\($0)" } ?? ""))
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                } else if let reset = week?.resetText(at: now) {
                    Text(reset).font(.system(size: 10)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Text(detailed ? "週 \(pct(week))" : pct(week))
                    .font(.system(size: 13, weight: .bold)).monospacedDigit()
            }
            if let five {
                PaceBar(used: used(five), elapsed: five.expired ? nil : five.elapsedPercent(at: now), height: 13)
                    .opacity(five.isStale(at: now) ? 0.5 : 1)
            }
            PaceBar(used: used(week), elapsed: week?.elapsedPercent(at: now), height: 13)
                .opacity(week.map { $0.isStale(at: now) } ?? true ? 0.5 : 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name) 週間枠 使用\(pct(week))")
    }
}

/// 大: 1枠ごとに見出し・使用率・バー
struct HomeRow: View {
    let title: String
    let window: UsageWindow?
    let now: Date
    let detailed: Bool

    private var used: Double? {
        guard let window, !window.expired else { return nil }
        return window.usedPercent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(title).font(.system(size: 13, weight: .semibold))
                if let reset = window?.resetText(at: now) {
                    Text(reset).font(.system(size: 10)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Text(used.map { "\(Int($0.rounded()))%" } ?? "—")
                    .font(.system(size: 15, weight: .bold)).monospacedDigit()
            }
            PaceBar(used: used, elapsed: window.flatMap { $0.expired ? nil : $0.elapsedPercent(at: now) }, height: 16)
        }
        .opacity(window.map { $0.isStale(at: now) } ?? true ? 0.5 : 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title) 使用\(used.map { "\(Int($0.rounded()))%" } ?? "不明")")
    }
}

/// 使用量の塗り＋経過の目盛り。目盛りを越えた分は斜線
struct PaceBar: View {
    let used: Double?
    let elapsed: Double?
    var height: CGFloat = 13

    var body: some View {
        Canvas { context, size in
            let bar = CGRect(x: 0, y: 2, width: size.width, height: size.height - 4)
            let track = Path(roundedRect: bar, cornerRadius: bar.height / 2)
            context.fill(track, with: .color(.primary.opacity(0.25)))

            let x = { (percent: Double) in bar.width * min(100, max(0, percent)) / 100 }
            if let used {
                var layer = context
                layer.clip(to: track)
                let paced = elapsed.map { min(used, $0) } ?? used
                layer.fill(Path(CGRect(x: 0, y: bar.minY, width: x(paced), height: bar.height)), with: .color(.primary))
                if let elapsed, used > elapsed {
                    let over = CGRect(x: x(elapsed), y: bar.minY, width: x(used) - x(elapsed), height: bar.height)
                    layer.fill(Path(over), with: .color(.primary.opacity(0.4)))
                    layer.clip(to: Path(over))
                    var stripes = Path()
                    var stripeX = over.minX - bar.height
                    while stripeX < over.maxX {
                        stripes.move(to: CGPoint(x: stripeX, y: bar.maxY))
                        stripes.addLine(to: CGPoint(x: stripeX + bar.height, y: bar.minY))
                        stripeX += 4
                    }
                    layer.stroke(stripes, with: .color(.primary), lineWidth: 1.5)
                }
            }

            // 経過の目盛り。塗りと同じ濃さなので、両脇を抜いて塗りの上でも見えるようにする
            if let elapsed {
                let tickX = min(max(x(elapsed), 1), size.width - 1)
                var cut = context
                cut.blendMode = .clear
                cut.fill(Path(CGRect(x: tickX - 2, y: bar.minY, width: 4, height: bar.height)), with: .color(.black))
                context.fill(Path(roundedRect: CGRect(x: tickX - 1, y: 0, width: 2, height: size.height), cornerRadius: 1),
                             with: .color(.primary))
            }
        }
        .frame(height: height)
    }
}
