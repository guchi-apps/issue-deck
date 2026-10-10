import Foundation
import WebKit

/// 共有メニューから受け取った下書きを、アプリ本体で起案画面へ取り込む（#3847）。
///
/// 認証はWKWebViewのCookieだけなので、画像のアップロードはWebViewの中の `fetch` で行い、
/// 既存の `POST /api/issues/images`（上限・形式の検査つき）をそのまま使う。取り込んだ内容は
/// 既存の「別ウィンドウ起案」の受け渡し（localStorageの `issue-create-handoff`）へ書いて
/// `/issues/new` を開く。**Issueの作成は起案画面での利用者の操作だけ**で、ここでは作らない。
enum ShareImportState: Equatable {
    case idle
    /// ログインが切れている／未ログイン。素材は端末に残してあり、ログイン後に再開する
    case waitingForLogin(count: Int)
    case importing
    case failed(message: String)
}

enum ShareImportResult {
    /// 取り込めた。開く先のパス
    case imported
    case nothingToDo
    case waitingForLogin(count: Int)
    case failed(String)
}

@MainActor
struct ShareImporter {
    let webView: WKWebView

    /// 取り込みを1件進める。複数あるときは古い順に1件ずつ（呼び出し側が繰り返す）
    func run(openPath: (String) -> Void) async -> ShareImportResult {
        let drafts = ShareDraftStore.list()
        guard !drafts.isEmpty else { return .nothingToDo }
        // 認証の確認はアプリのWebページの中でしかできない（Cookieがそこにある）
        guard let url = webView.url, AppConfig.isAppURL(url) else { return .waitingForLogin(count: drafts.count) }
        // 起案画面を開いている間は次の素材を入れない（書いている途中の内容を上書きしない）。
        // 残りは起案画面を離れたあとに取り込む
        if url.path == "/issues/new" { return .nothingToDo }

        guard let userId = await currentUserId() else { return .waitingForLogin(count: drafts.count) }
        ShareDraftStore.lastUserId = userId

        // 別のアカウントで共有された素材は、今のアカウントへ渡さず破棄する
        var mine: [ShareDraft] = []
        for draft in drafts {
            if let owner = draft.ownerUserId, owner != userId {
                ShareDraftStore.delete(draft)
            } else {
                if draft.ownerUserId == nil { ShareDraftStore.claim(draft, for: userId) }
                mine.append(draft)
            }
        }
        guard let draft = mine.first else { return .nothingToDo }

        var imageURLs: [String] = []
        for file in draft.imageFiles {
            guard let data = ShareDraftStore.imageData(of: draft, file: file) else { continue }
            switch await upload(data) {
            case .success(let url): imageURLs.append(url)
            case .failure(.unauthorized): return .waitingForLogin(count: mine.count)
            case .failure(.rejected(let message)): return .failed(message)
            }
        }

        guard await storeHandoff(body: Self.composeBody(draft: draft, imageURLs: imageURLs)) else {
            return .failed("起案画面へ取り込めませんでした。もう一度お試しください")
        }
        // 起案画面へ渡し終えてから消す（途中で失敗すれば素材は残り、再試行できる）
        ShareDraftStore.delete(draft)
        openPath("/issues/new")
        return .imported
    }

    static func composeBody(draft: ShareDraft, imageURLs: [String]) -> String {
        var parts: [String] = []
        if !draft.note.isEmpty { parts.append(draft.note) }
        if let text = draft.text, !text.isEmpty { parts.append(text) }
        if !draft.urls.isEmpty { parts.append(draft.urls.joined(separator: "\n")) }
        if !imageURLs.isEmpty { parts.append(imageURLs.map { "![image](\($0))" }.joined(separator: "\n\n")) }
        return parts.joined(separator: "\n\n")
    }

    private enum UploadFailure: Error {
        case unauthorized
        case rejected(String)
    }

    private func currentUserId() async -> String? {
        let script = """
        const response = await fetch('/api/account', { credentials: 'same-origin' });
        if (!response.ok) { return { status: response.status }; }
        const body = await response.json();
        return { status: 200, id: body.id };
        """
        let value = try? await webView.callAsyncJavaScript(script, arguments: [:], contentWorld: .page)
        let dictionary = value as? [String: Any]
        guard dictionary?["status"] as? Int == 200 else { return nil }
        return dictionary?["id"] as? String
    }

    private func upload(_ data: Data) async -> Result<String, UploadFailure> {
        guard let kind = ShareImageKind.sniff(data) else { return .failure(.rejected("対応していない形式の画像です")) }
        guard data.count <= ShareConfig.maxImageBytes else { return .failure(.rejected("画像が大きすぎます（10MBまで）")) }
        let script = """
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: mime }), name);
        const response = await fetch('/api/issues/images', { method: 'POST', body: form, credentials: 'same-origin' });
        if (!response.ok) { return { status: response.status }; }
        const body = await response.json();
        return { status: 200, url: body.url };
        """
        let value = try? await webView.callAsyncJavaScript(
            script,
            arguments: ["b64": data.base64EncodedString(), "mime": kind.mimeType, "name": "shared.\(kind.fileExtension)"],
            contentWorld: .page
        )
        let dictionary = value as? [String: Any]
        switch dictionary?["status"] as? Int {
        case 200:
            if let url = dictionary?["url"] as? String { return .success(url) }
            return .failure(.rejected("画像のアップロードに失敗しました"))
        case 401: return .failure(.unauthorized)
        case 413: return .failure(.rejected("画像が大きすぎます（10MBまで）"))
        case 415: return .failure(.rejected("対応していない形式の画像です"))
        default: return .failure(.rejected("画像のアップロードに失敗しました。通信を確かめてもう一度お試しください"))
        }
    }

    private func storeHandoff(body: String) async -> Bool {
        let script = """
        const handoff = { kind: 'issue', repositoryFullName: '', title: '', body: body, selectedLabels: [],
          assignee: null, bodyPrefix: null, savedAt: Date.now() };
        window.localStorage.setItem('issue-create-handoff', JSON.stringify(handoff));
        return true;
        """
        let value = try? await webView.callAsyncJavaScript(script, arguments: ["body": body], contentWorld: .page)
        return value as? Bool == true
    }
}
