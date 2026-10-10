import Combine
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// 共有メニューの「IssueDeck」（#3847）。受け取った画像・URL・文章を端末内の下書きへ保存するだけで、
/// Issueは作らない。確認・編集・作成はアプリ本体で行う（Cookie認証のWKWebViewへ拡張は触れないため）。
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        model.onFinish = { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
        model.onCancel = { [weak self] in
            self?.extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
        }
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        Task { await model.load(items: items) }
    }
}

@MainActor
final class ShareModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready
        case saving
        case saved
        case failed(String)
    }

    @Published var phase: Phase = .loading
    @Published var note = ""
    @Published private(set) var images: [(Data, ShareImageKind)] = []
    @Published private(set) var text: String?
    @Published private(set) var urls: [String] = []
    /// 受け取れなかった素材の案内（形式・サイズ・枚数）
    @Published private(set) var warnings: [String] = []

    var onFinish: () -> Void = {}
    var onCancel: () -> Void = {}

    var canSave: Bool {
        let hasContent = !(images.isEmpty && text == nil && urls.isEmpty)
        if case .failed = phase { return hasContent }
        return phase == .ready && hasContent
    }

    func load(items: [NSExtensionItem]) async {
        var unsupported = 0
        var tooLarge = 0
        var overLimit = 0
        for provider in items.flatMap({ $0.attachments ?? [] }) {
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                guard images.count < ShareConfig.maxImages else { overLimit += 1; continue }
                guard let data = await loadData(provider, type: UTType.image) else { unsupported += 1; continue }
                switch ShareImageNormalizer.normalize(data) {
                case .success(let image): images.append(image)
                case .failure(.tooLarge): tooLarge += 1
                case .failure(.unsupported): unsupported += 1
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                if let url = await loadURL(provider), url.scheme == "http" || url.scheme == "https" {
                    if !urls.contains(url.absoluteString) { urls.append(url.absoluteString) }
                } else {
                    unsupported += 1
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                if let value = await loadText(provider) {
                    if value.count > ShareConfig.maxTextLength {
                        warnings.append("文章が長すぎるため受け取れません（\(ShareConfig.maxTextLength)文字まで）")
                    } else {
                        text = [text, value].compactMap { $0 }.joined(separator: "\n\n")
                    }
                }
            } else {
                unsupported += 1
            }
        }
        if unsupported > 0 { warnings.append("\(unsupported)件は対応していない形式のため受け取りません（画像・URL・文章のみ）") }
        if tooLarge > 0 { warnings.append("\(tooLarge)枚は1枚\(ShareConfig.maxImageBytes / 1024 / 1024)MBを超えるため受け取りません") }
        if overLimit > 0 { warnings.append("画像は\(ShareConfig.maxImages)枚までです。\(overLimit)枚は受け取りません") }
        phase = .ready
    }

    func save() {
        guard canSave else { return }
        phase = .saving
        do {
            try ShareDraftStore.save(.init(
                note: note.trimmingCharacters(in: .whitespacesAndNewlines),
                text: text, urls: urls,
                images: images.map { (data: $0.0, kind: $0.1) }
            ))
            phase = .saved
            Task {
                try? await Task.sleep(nanoseconds: 700_000_000)
                onFinish()
            }
        } catch {
            // 素材は拡張の中に残っているので、そのまま再試行できる
            phase = .failed("保存できませんでした。もう一度お試しください")
        }
    }

    private func loadData(_ provider: NSItemProvider, type: UTType) async -> Data? {
        await withCheckedContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }

    private func loadURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                continuation.resume(returning: url)
            }
        }
    }

    private func loadText(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: NSString.self) { value, _ in
                continuation.resume(returning: (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
    }
}

struct ShareView: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        NavigationStack {
            Form {
                if !model.images.isEmpty {
                    Section("画像（\(model.images.count)枚）") {
                        ScrollView(.horizontal) {
                            HStack {
                                ForEach(model.images.indices, id: \.self) { index in
                                    if let image = UIImage(data: model.images[index].0) {
                                        Image(uiImage: image)
                                            .resizable().scaledToFill()
                                            .frame(width: 84, height: 112).clipped()
                                            .clipShape(RoundedRectangle(cornerRadius: 8))
                                    }
                                }
                            }
                        }
                    }
                }
                if !model.urls.isEmpty {
                    Section("URL") { ForEach(model.urls, id: \.self) { Text($0).font(.footnote).lineLimit(2) } }
                }
                if let text = model.text {
                    Section("文章") { Text(text).font(.footnote).lineLimit(6) }
                }
                Section("メモ（任意）") { TextField("気づいたこと", text: $model.note, axis: .vertical).lineLimit(2...5) }
                if !model.warnings.isEmpty {
                    Section { ForEach(model.warnings, id: \.self) { Text($0).font(.footnote).foregroundStyle(.orange) } }
                }
                Section {
                    switch model.phase {
                    case .loading: ProgressView("読み込み中")
                    case .saving: ProgressView("保存中")
                    case .saved: Label("保存しました。IssueDeckアプリを開いて確認してください", systemImage: "checkmark.circle")
                    case .failed(let message): Text(message).foregroundStyle(.red)
                    case .ready:
                        if model.images.isEmpty && model.text == nil && model.urls.isEmpty {
                            Text("受け取れる内容がありません（画像・URL・文章のみ対応）").foregroundStyle(.secondary)
                        } else {
                            Text("この時点ではIssueは作成されません。アプリで内容を確認してから作成します。")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("IssueDeck")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { model.onCancel() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("下書きに保存") { model.save() }.disabled(!model.canSave)
                }
            }
        }
    }
}
