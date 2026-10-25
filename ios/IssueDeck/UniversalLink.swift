import Foundation

/// IssueDeckのHTTPSリンク（Universal Links。#5035）から、アプリ内で開く詳細のパスを取り出す。
/// 受け取った文字列はそのまま使わず、ホストと形を確かめたうえで**数字のIDからパスを組み立て直す**
/// （任意のパス・クエリを通さない）。対応するリンクの形はサーバーのAASA
/// （`src/lib/ios-universal-links.ts`）と揃える。
enum UniversalLink {
    /// 対応するリンクならアプリ内パスを返す。対象外（他ホスト・他のパス・IDが数字でない）はnil
    static func appPath(for url: URL) -> String? {
        guard url.scheme == "https", AppConfig.isAppURL(url), url.path == "/dashboard",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }

        func value(_ name: String) -> String? {
            items.first(where: { $0.name == name })?.value
        }
        func isID(_ s: String?) -> String? {
            guard let s, !s.isEmpty, s.count <= 20, s.allSatisfy(\.isASCII), s.allSatisfy(\.isNumber) else { return nil }
            return s
        }

        switch value("mscreen") {
        case "issue-detail":
            guard let id = isID(value("missue")) ?? isID(value("issue")) else { return nil }
            return "/dashboard?issue=\(id)&mscreen=issue-detail&missue=\(id)"
        case "pull-requests":
            guard let id = isID(value("pr")) else { return nil }
            return "/dashboard?pane=pull-requests&pr=\(id)&mscreen=pull-requests"
        case "release-history":
            return "/dashboard?pane=releases&mscreen=release-history"
        default:
            return nil
        }
    }
}
