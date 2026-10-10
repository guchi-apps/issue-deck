import Foundation
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
                note: input.note, text: input.text, urls: input.urls, imageFiles: files
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
