import Foundation
import Security
import UIKit

/// 共有メニュー（Share Extension）とアプリ本体で共有する、受け取った素材の「下書き」（#3847）。
///
/// 拡張はここへ保存するだけで、**Issueは作らない**（作成は利用者がアプリで確認してから行う）。
/// Cookie認証のWKWebViewへ拡張は触れないため、アップロードと起案画面への反映はアプリ本体が行う。
/// 保存先はApp Groupの端末内領域だけで、サーバーへは送らない。
enum ShareConfig {
    static let appGroupID = "group.com.gucchii.issuedeck"
    /// 1回の共有で受け取る画像の上限。起案画面から1枚ずつ貼れる運用に合わせた目安
    static let maxImages = 10
    /// 1枚あたりの上限。`POST /api/issues/images` の `MAX_FILE_SIZE`（10MB）と揃える
    static let maxImageBytes = 10 * 1024 * 1024
    /// 文章の上限（文字数）。長すぎる共有は切り詰めず、受け取れない旨を案内する
    static let maxTextLength = 20_000
    /// アプリ本体のURLスキーム（`Config/IssueDeck-Info.plist`・`AppConfig.authCallbackScheme`と同じ値）
    static let appURLScheme = "issuedeck"
    /// 下書きを端末に残す期間。取り込まれないまま残った素材はこの期間を過ぎると破棄する
    static let retention: TimeInterval = 7 * 24 * 60 * 60
}

/// アップロードAPIが受け付ける画像の種類（`EXTENSION_BY_CONTENT_TYPE` のうちSVGを除く）
enum ShareImageKind: String, Codable {
    case png, jpeg, gif, webp

    var mimeType: String { "image/\(rawValue)" }
    var fileExtension: String { self == .jpeg ? "jpg" : rawValue }

    /// 先頭バイトから種類を判定する（名乗りは信用しない）
    static func sniff(_ data: Data) -> ShareImageKind? {
        let b = [UInt8](data.prefix(12))
        if b.count >= 8, b[0] == 0x89, b[1] == 0x50, b[2] == 0x4E, b[3] == 0x47 { return .png }
        if b.count >= 3, b[0] == 0xFF, b[1] == 0xD8, b[2] == 0xFF { return .jpeg }
        if b.count >= 6, b[0] == 0x47, b[1] == 0x49, b[2] == 0x46, b[3] == 0x38 { return .gif }
        if b.count >= 12, b[0] == 0x52, b[1] == 0x49, b[2] == 0x46, b[3] == 0x46,
           b[8] == 0x57, b[9] == 0x45, b[10] == 0x42, b[11] == 0x50 { return .webp }
        return nil
    }
}

struct ShareDraft: Codable, Identifiable, Equatable {
    var id: String
    var createdAt: Date
    /// 共有した時点で最後にログインしていたユーザーのID。別ユーザーのアプリへ素材を渡さないための印。
    /// 一度もログインしていなければnilで、最初に取り込んだユーザーのものになる
    var ownerUserId: String?
    var note: String
    var text: String?
    var urls: [String]
    /// 下書きのフォルダ内の画像ファイル名（保存順）
    var imageFiles: [String]
    /// 結果不明のまま閉じられた作成の冪等キー（#4298）。印だけで、取り込み側の挙動は変えない
    var attemptKey: String?
}

enum ShareDraftStore {
    private static let lastUserKey = "lastAuthenticatedUserId"

    private static var defaults: UserDefaults? { UserDefaults(suiteName: ShareConfig.appGroupID) }

    private static var rootURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ShareConfig.appGroupID)?
            .appendingPathComponent("ShareDrafts", isDirectory: true)
    }

    private static func folder(for id: String) -> URL? {
        rootURL?.appendingPathComponent(id, isDirectory: true)
    }

    /// 最後にログインを確認できたユーザーのID（アプリ本体が書き、拡張が読む）
    static var lastUserId: String? {
        get { defaults?.string(forKey: lastUserKey) }
        set { defaults?.set(newValue, forKey: lastUserKey) }
    }

    struct SaveInput {
        var note: String
        var text: String?
        var urls: [String]
        var images: [(data: Data, kind: ShareImageKind)]
        var attemptKey: String?
    }

    @discardableResult
    static func save(_ input: SaveInput) throws -> ShareDraft {
        guard let root = rootURL else { throw CocoaError(.fileNoSuchFile) }
        let id = UUID().uuidString
        let dir = root.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var files: [String] = []
        do {
            for (index, image) in input.images.enumerated() {
                let name = "image-\(index + 1).\(image.kind.fileExtension)"
                try image.data.write(to: dir.appendingPathComponent(name), options: .completeFileProtection)
                files.append(name)
            }
            let draft = ShareDraft(
                id: id, createdAt: Date(), ownerUserId: lastUserId,
                note: input.note, text: input.text, urls: input.urls, imageFiles: files,
                attemptKey: input.attemptKey
            )
            try JSONEncoder().encode(draft).write(
                to: dir.appendingPathComponent("draft.json"), options: .completeFileProtection
            )
            return draft
        } catch {
            // 途中で失敗した素材を残さない
            try? FileManager.default.removeItem(at: dir)
            throw error
        }
    }

    /// 古い順。期限切れ・壊れたものはここで破棄する
    static func list() -> [ShareDraft] {
        guard let root = rootURL,
              let entries = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        else { return [] }
        var drafts: [ShareDraft] = []
        for dir in entries {
            guard let data = try? Data(contentsOf: dir.appendingPathComponent("draft.json")),
                  let draft = try? JSONDecoder().decode(ShareDraft.self, from: data),
                  Date().timeIntervalSince(draft.createdAt) < ShareConfig.retention
            else {
                try? FileManager.default.removeItem(at: dir)
                continue
            }
            drafts.append(draft)
        }
        return drafts.sorted { $0.createdAt < $1.createdAt }
    }

    static func imageData(of draft: ShareDraft, file: String) -> Data? {
        guard let dir = folder(for: draft.id), !file.contains("/") else { return nil }
        return try? Data(contentsOf: dir.appendingPathComponent(file))
    }

    static func claim(_ draft: ShareDraft, for userId: String) {
        guard let dir = folder(for: draft.id) else { return }
        var claimed = draft
        claimed.ownerUserId = userId
        if let data = try? JSONEncoder().encode(claimed) {
            try? data.write(to: dir.appendingPathComponent("draft.json"), options: .completeFileProtection)
        }
    }

    static func delete(_ draft: ShareDraft) {
        guard let dir = folder(for: draft.id) else { return }
        try? FileManager.default.removeItem(at: dir)
    }
}

/// 共有された画像を、アップロードAPIが受け付ける形に整える。
/// HEIC等はJPEGへ変換し、10MBを超えるものは受け取らない（案内文を返す）
enum ShareImageNormalizer {
    enum Failure: Error, Equatable {
        case unsupported
        case tooLarge
    }

    static func normalize(_ data: Data) -> Result<(Data, ShareImageKind), Failure> {
        let candidate: (Data, ShareImageKind)
        if let kind = ShareImageKind.sniff(data) {
            candidate = (data, kind)
        } else if let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) {
            candidate = (jpeg, .jpeg)
        } else {
            return .failure(.unsupported)
        }
        guard candidate.0.count <= ShareConfig.maxImageBytes else { return .failure(.tooLarge) }
        return .success(candidate)
    }
}

// MARK: - 共有画面からの直接作成（#4298）

extension ShareConfig {
    /// サーバーのURL。`ios/IssueDeck/AppConfig.swift` の `baseURL` と揃えること
    /// （`ios/scripts/check-consistency.mjs` が照合する）。拡張はアプリ本体のターゲットを参照できないため複製している
    static let serverBaseURL = URL(string: "https://issuedeck.gucchii.com/")!
}

/// 共有画面（拡張）がサーバーを呼ぶための専用セッション。アプリ本体がログイン中に発行し、
/// Keychain共有グループへ置く。**この値で呼べるのは `/api/share/*` と画像アップロードだけ**で、
/// アプリのログインCookieや他のAPIには届かない。ログアウト・アカウント切替・期限切れで使えなくなる
struct ShareSession: Codable, Equatable {
    var token: String
    var expiresAt: Date
    /// 発行時のログインユーザー（Supabase側のID）。別ユーザーへ引き継がないための印
    var userId: String
    var login: String
    /// 端末ごとの識別子。再発行で同じ端末の古いトークンをサーバーが失効させる
    var deviceId: String

    var isExpired: Bool { expiresAt <= Date() }
}

enum ShareSessionStore {
    private static let service = "com.gucchii.issuedeck.share-session"
    private static let lastRepositoryKey = "lastShareRepository"

    private static var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    /// 有効なセッション。期限切れ・壊れたものはnil
    static func load() -> ShareSession? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let session = try? decoder.decode(ShareSession.self, from: data),
              !session.isExpired
        else { return nil }
        return session
    }

    /// 端末識別子は期限切れ後も使い回すので、期限を見ずに読む
    static func deviceId() -> String {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
           let data = result as? Data,
           let session = try? decoder.decode(ShareSession.self, from: data) {
            return session.deviceId
        }
        return UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }

    static func save(_ session: ShareSession) {
        guard let data = try? encoder.encode(session) else { return }
        SecItemDelete(baseQuery as CFDictionary)
        var add = baseQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    static func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    /// 最後に選んだリポジトリ。ユーザーごとに覚え、別ユーザーへは出さない
    static func lastRepository(for userId: String) -> String? {
        UserDefaults(suiteName: ShareConfig.appGroupID)?.string(forKey: "\(lastRepositoryKey).\(userId)")
    }

    static func setLastRepository(_ fullName: String, for userId: String) {
        UserDefaults(suiteName: ShareConfig.appGroupID)?.set(fullName, forKey: "\(lastRepositoryKey).\(userId)")
    }
}

struct ShareRepository: Decodable, Identifiable, Equatable {
    var fullName: String
    var `private`: Bool
    /// nilなら選べる。理由があるときは選べない
    var disabledReason: String?

    var id: String { fullName }
}

struct ShareCreatedIssue: Equatable {
    var repositoryFullName: String
    var number: Int
    var title: String
    /// IssueDeck上のIssue識別子（`GET /api/issues`の`id`）。アプリ本体のIssue詳細を開くのに使う
    var id: String

    /// アプリ本体のIssue詳細を開くURL（`ios/IssueDeck/IssueDeckApp.swift`の`onOpenURL`が受ける）
    var appURL: URL? {
        var components = URLComponents()
        components.scheme = ShareConfig.appURLScheme
        components.host = "issue"
        components.queryItems = [URLQueryItem(name: "id", value: id)]
        return components.url
    }
}

enum ShareAPIError: Error, Equatable {
    /// ログインが切れている（トークンの失効・期限切れ）。素材は残して再ログインを案内する
    case unauthorized
    /// 通信できなかった（リクエストはサーバーへ届いていない）
    case network
    /// サーバーが断った（理由つき）。作成されていない
    case rejected(String)
    /// 作成できたか分からない。同じ冪等キーで確認するまで再作成しない
    case unknownResult
}

/// 共有画面からのサーバー呼び出し。素材は1枚ずつ送り、全件をメモリへ複製しない
enum ShareAPI {
    private static func request(_ path: String, token: String, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: ShareConfig.serverBaseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 30
        return request
    }

    private static func errorMessage(_ data: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
    }

    static func repositories(token: String) async throws -> [ShareRepository] {
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await URLSession.shared.data(for: request("api/share/repositories", token: token)) }
        catch { throw ShareAPIError.network }
        switch (response as? HTTPURLResponse)?.statusCode {
        case 200:
            struct Body: Decodable { var repositories: [ShareRepository] }
            guard let body = try? JSONDecoder().decode(Body.self, from: data) else {
                throw ShareAPIError.rejected("リポジトリの一覧を読み取れませんでした")
            }
            return body.repositories
        case 401: throw ShareAPIError.unauthorized
        default: throw ShareAPIError.rejected("リポジトリの一覧を取得できませんでした")
        }
    }

    /// 画像を1枚アップロードして、本文へ貼るURLを返す
    static func uploadImage(token: String, data: Data, kind: ShareImageKind) async throws -> String {
        let boundary = "issuedeck-\(UUID().uuidString)"
        var urlRequest = request("api/issues/images", token: token, method: "POST")
        urlRequest.timeoutInterval = 120
        urlRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var form = Data()
        form.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"shared.\(kind.fileExtension)\"\r\nContent-Type: \(kind.mimeType)\r\n\r\n".utf8))
        form.append(data)
        form.append(Data("\r\n--\(boundary)--\r\n".utf8))
        urlRequest.httpBody = form

        let (body, response): (Data, URLResponse)
        do { (body, response) = try await URLSession.shared.data(for: urlRequest) }
        catch { throw ShareAPIError.network }
        switch (response as? HTTPURLResponse)?.statusCode {
        case 200:
            guard let url = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["url"] as? String else {
                throw ShareAPIError.rejected("画像のアップロードに失敗しました")
            }
            return url
        case 401: throw ShareAPIError.unauthorized
        case 413: throw ShareAPIError.rejected("画像が大きすぎます（10MBまで）")
        case 415: throw ShareAPIError.rejected("対応していない形式の画像です")
        default: throw ShareAPIError.rejected("画像のアップロードに失敗しました。通信を確かめてもう一度お試しください")
        }
    }

    /// Issueを作る。`key`は1回の作成操作ごとに固定し、再送・確認に同じ値を使う
    static func createIssue(
        token: String, repositoryFullName: String, title: String, body: String, key: String
    ) async throws -> ShareCreatedIssue {
        var urlRequest = request("api/share/issues", token: token, method: "POST")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try? JSONSerialization.data(withJSONObject: [
            "repositoryFullName": repositoryFullName, "title": title, "body": body, "idempotencyKey": key,
        ])

        let (data, response): (Data, URLResponse)
        do { (data, response) = try await URLSession.shared.data(for: urlRequest) }
        catch let error as URLError where [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed].contains(error.code) {
            // 送信前に落ちている。作られていない
            throw ShareAPIError.network
        } catch {
            // 送ったあとに切れた可能性がある。結果不明として扱う
            throw ShareAPIError.unknownResult
        }
        switch (response as? HTTPURLResponse)?.statusCode {
        case 200:
            guard let issue = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["issue"] as? [String: Any],
                  let number = issue["number"] as? Int,
                  let repository = issue["repositoryFullName"] as? String
            else { throw ShareAPIError.unknownResult }
            return ShareCreatedIssue(
                repositoryFullName: repository, number: number, title: issue["title"] as? String ?? title,
                id: (issue["id"] as? String) ?? (issue["id"] as? Int).map(String.init) ?? ""
            )
        case 401: throw ShareAPIError.unauthorized
        case 409, 502: throw ShareAPIError.unknownResult
        case 403 where errorMessage(data) == "repository_excluded":
            throw ShareAPIError.rejected("このリポジトリはIssue作成の対象外に設定されています")
        case 404: throw ShareAPIError.rejected("このリポジトリへIssueを作成する権限がありません")
        case 400: throw ShareAPIError.rejected("内容を確認してください（本文かタイトルが必要です）")
        default: throw ShareAPIError.rejected("Issueを作成できませんでした。もう一度お試しください")
        }
    }
}
