import Combine
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// 共有メニューの「IssueDeck」（#3847・#4298）。受け取った画像・URL・文章を確認し、リポジトリを選んで
/// その場でIssueを作成する。認証はアプリ本体が発行してKeychain共有グループへ置いた専用セッション
/// （`ShareSession`）で、Cookie認証のWKWebViewには触れない。**共有しただけでは何も登録せず、
/// 「Issueを作成」を押した操作が登録の意思になる。** ログインが切れているときは素材を端末へ保存し、
/// ログイン後にアプリ本体が従来どおり起案画面へ取り込む
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
        model.onOpenURL = { [weak self] url in self?.open(url) }
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        Task { await model.load(items: items) }
    }

    /// 共有拡張からURLを開く。`extensionContext.open`は拡張の種類によって使えないため、レスポンダーチェーンのUIApplicationを使う
    private func open(_ url: URL) {
        var responder: UIResponder? = self
        while let current = responder {
            if let application = current as? UIApplication {
                application.open(url)
                return
            }
            responder = current.next
        }
    }
}

@MainActor
final class ShareModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready
        /// 作成中。画像のアップロードと作成の経過を文で示す
        case creating(String)
        case succeeded(ShareCreatedIssue)
        /// 作成されていない失敗。入力・選択・素材はそのまま再試行できる
        case failed(String)
        /// 作成できたか分からない。確認するまで作り直さない
        case unknownResult
        /// ログインが切れている。素材は保存して、ログイン後に続きから作れる
        case signedOut
    }

    @Published var phase: Phase = .loading
    @Published var title = ""
    @Published var bodyText = ""
    @Published var repositoryQuery = ""
    @Published var selectedRepository: String?
    @Published var isPickingRepository = false
    @Published private(set) var repositories: [ShareRepository] = []
    @Published private(set) var repositoriesError: String?
    @Published private(set) var images: [(Data, ShareImageKind)] = []
    /// 受け取れなかった素材の案内（形式・サイズ・枚数）
    @Published private(set) var warnings: [String] = []

    var onFinish: () -> Void = {}
    var onCancel: () -> Void = {}
    var onOpenURL: (URL) -> Void = { _ in }

    private var session: ShareSession?
    private var sharedText: String?
    private var sharedURLs: [String] = []
    /// 1回の作成操作を表す冪等キー。結果不明の確認・失敗後の再試行でも同じ値を使い、成功したら破棄する
    private var attemptKey = ShareModel.makeKey()
    /// アップロード済みの画像URL（画像の並び順）。再試行で同じ画像を何度も上げない
    private var uploadedURLs: [Int: String] = [:]

    private static func makeKey() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }

    var hasContent: Bool { !(images.isEmpty && sharedText == nil && sharedURLs.isEmpty) }

    /// 主操作が押せない理由。nilなら押せる
    var blockedReason: String? {
        if selectedRepository == nil { return "リポジトリを選ぶと作成できます" }
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty {
            return "タイトルか本文を入力してください"
        }
        return nil
    }

    var canCreate: Bool {
        switch phase {
        case .ready, .failed: return blockedReason == nil
        default: return false
        }
    }

    var filteredRepositories: [ShareRepository] {
        let query = repositoryQuery.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return repositories }
        return repositories.filter { $0.fullName.lowercased().contains(query) }
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
                    if !sharedURLs.contains(url.absoluteString) { sharedURLs.append(url.absoluteString) }
                } else {
                    unsupported += 1
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                if let value = await loadText(provider) {
                    if value.count > ShareConfig.maxTextLength {
                        warnings.append("文章が長すぎるため受け取れません（\(ShareConfig.maxTextLength)文字まで）")
                    } else {
                        sharedText = [sharedText, value].compactMap { $0 }.joined(separator: "\n\n")
                    }
                }
            } else {
                unsupported += 1
            }
        }
        if unsupported > 0 { warnings.append("\(unsupported)件は対応していない形式のため受け取りません（画像・URL・文章のみ）") }
        if tooLarge > 0 { warnings.append("\(tooLarge)枚は1枚\(ShareConfig.maxImageBytes / 1024 / 1024)MBを超えるため受け取りません") }
        if overLimit > 0 { warnings.append("画像は\(ShareConfig.maxImages)枚までです。\(overLimit)枚は受け取りません") }
        bodyText = ([sharedText] + sharedURLs.map { Optional($0) }).compactMap { $0 }.joined(separator: "\n\n")

        guard let session = ShareSessionStore.load() else { phase = .signedOut; return }
        self.session = session
        phase = .ready
        await loadRepositories()
    }

    func loadRepositories() async {
        guard let session else { return }
        repositoriesError = nil
        do {
            repositories = try await ShareAPI.repositories(token: session.token)
            if selectedRepository == nil,
               let last = ShareSessionStore.lastRepository(for: session.userId),
               repositories.contains(where: { $0.fullName == last && $0.disabledReason == nil }) {
                selectedRepository = last
            }
        } catch ShareAPIError.unauthorized {
            ShareSessionStore.clear()
            phase = .signedOut
        } catch ShareAPIError.rejected(let message) {
            repositoriesError = message
        } catch {
            repositoriesError = "リポジトリの一覧を取得できませんでした。通信を確かめてください"
        }
    }

    func select(_ repository: ShareRepository) {
        guard repository.disabledReason == nil else { return }
        selectedRepository = repository.fullName
        isPickingRepository = false
        repositoryQuery = ""
    }

    func removeImage(at index: Int) {
        guard images.indices.contains(index), case .ready = phase else { return }
        images.remove(at: index)
        // 画像の並びが変わるため、アップロード済みの対応を作り直す
        uploadedURLs = [:]
    }

    /// 「Issueを作成」。押した操作が登録の意思。作成中の再タップは受け付けない
    func create() {
        guard canCreate, let session, let repository = selectedRepository else { return }
        phase = .creating("準備しています")
        Task { await run(session: session, repository: repository) }
    }

    /// 結果不明のあとの確認。同じ冪等キーで再送し、作成済みならその結果が返り、未作成ならここで作られる
    func confirmUnknownResult() {
        guard phase == .unknownResult, let session, let repository = selectedRepository else { return }
        phase = .creating("作成済みか確認しています")
        Task { await run(session: session, repository: repository) }
    }

    private func run(session: ShareSession, repository: String) async {
        do {
            for index in images.indices where uploadedURLs[index] == nil {
                phase = .creating("画像をアップロード中（\(index + 1)/\(images.count)）")
                uploadedURLs[index] = try await ShareAPI.uploadImage(
                    token: session.token, data: images[index].0, kind: images[index].1
                )
            }
            phase = .creating("Issueを作成しています")
            var parts = [bodyText.trimmingCharacters(in: .whitespacesAndNewlines)].filter { !$0.isEmpty }
            let imageMarkdown = images.indices.compactMap { uploadedURLs[$0] }.map { "![image](\($0))" }
            if !imageMarkdown.isEmpty { parts.append(imageMarkdown.joined(separator: "\n\n")) }
            let issue = try await ShareAPI.createIssue(
                token: session.token, repositoryFullName: repository,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                body: parts.joined(separator: "\n\n"), key: attemptKey
            )
            ShareSessionStore.setLastRepository(repository, for: session.userId)
            // 成功が確認できたので、この操作の素材と鍵を手放す（ここまでは何も破棄していない）
            images = []
            uploadedURLs = [:]
            attemptKey = ShareModel.makeKey()
            phase = .succeeded(issue)
        } catch ShareAPIError.unauthorized {
            ShareSessionStore.clear()
            phase = .signedOut
        } catch ShareAPIError.unknownResult {
            phase = .unknownResult
        } catch ShareAPIError.rejected(let message) {
            phase = .failed(message)
        } catch {
            phase = .failed("通信できませんでした。通信を確かめてもう一度お試しください。入力と画像はそのまま残っています")
        }
    }

    /// ログインが切れているとき、または結果不明のまま閉じるとき、素材を端末へ保存して閉じる。
    /// アプリ本体が次に開かれたときに従来の起案画面へ取り込む（#3847）
    func saveDraftAndFinish() {
        do {
            try ShareDraftStore.save(.init(
                note: title.trimmingCharacters(in: .whitespacesAndNewlines),
                text: bodyText.isEmpty ? nil : bodyText, urls: [],
                images: images.map { (data: $0.0, kind: $0.1) },
                attemptKey: phase == .unknownResult ? attemptKey : nil
            ))
            onFinish()
        } catch {
            phase = .failed("保存できませんでした。もう一度お試しください")
        }
    }

    func openIssue() {
        if case .succeeded(let issue) = phase, let url = issue.githubURL { onOpenURL(url) }
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
            Group {
                switch model.phase {
                case .loading: ProgressView("読み込み中")
                case .creating(let step): CreatingView(step: step)
                case .succeeded(let issue): SucceededView(model: model, issue: issue)
                case .signedOut: SignedOutView(model: model)
                case .unknownResult: UnknownResultView(model: model)
                case .ready, .failed: FormView(model: model)
                }
            }
            .navigationTitle("IssueDeck")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .sheet(isPresented: $model.isPickingRepository) { RepositoryPicker(model: model) }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) { leadingButton }
        ToolbarItem(placement: .confirmationAction) { trailingButton }
    }

    @ViewBuilder
    private var leadingButton: some View {
        if case .creating = model.phase {
            Button("キャンセル") {}.disabled(true)
        } else if case .succeeded = model.phase {
            EmptyView()
        } else {
            Button("キャンセル") { model.onCancel() }
        }
    }

    @ViewBuilder
    private var trailingButton: some View {
        if case .succeeded = model.phase {
            Button("完了") { model.onFinish() }
        } else if case .ready = model.phase {
            Button("作成") { model.create() }.disabled(!model.canCreate)
        } else if case .failed = model.phase {
            Button("作成") { model.create() }.disabled(!model.canCreate)
        } else {
            EmptyView()
        }
    }
}

private struct FormView: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        Form {
            if case .failed(let message) = model.phase {
                Section { Text(message).font(.footnote).foregroundStyle(.red) }
            }
            Section("リポジトリ") {
                Button {
                    model.isPickingRepository = true
                } label: {
                    HStack {
                        Text(model.selectedRepository ?? "選択してください")
                            .foregroundStyle(model.selectedRepository == nil ? .secondary : .primary)
                        Spacer()
                        Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let error = model.repositoriesError {
                    Text(error).font(.footnote).foregroundStyle(.orange)
                }
            }
            Section("タイトル") {
                TextField("空欄でOK（作成後に自動で記入）", text: $model.title, axis: .vertical).lineLimit(1...3)
            }
            Section("本文") {
                TextField("本文", text: $model.bodyText, axis: .vertical).lineLimit(4...10)
            }
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
                                        .overlay(alignment: .topTrailing) {
                                            Button { model.removeImage(at: index) } label: {
                                                Image(systemName: "xmark.circle.fill").foregroundStyle(.white, .black.opacity(0.6))
                                            }
                                            .padding(4)
                                        }
                                }
                            }
                        }
                    }
                }
            }
            if !model.warnings.isEmpty {
                Section { ForEach(model.warnings, id: \.self) { Text($0).font(.footnote).foregroundStyle(.orange) } }
            }
            Section {
                if let reason = model.blockedReason {
                    Text(reason).font(.footnote).foregroundStyle(.secondary)
                } else {
                    Text("「作成」を押すまでIssueは作られません。").font(.footnote).foregroundStyle(.secondary)
                }
                Button("Issueを作成") { model.create() }.disabled(!model.canCreate).fontWeight(.semibold)
            }
        }
    }
}

private struct RepositoryPicker: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.filteredRepositories) { repository in
                    Button { model.select(repository) } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(repository.fullName)
                                if let reason = repository.disabledReason {
                                    Text(reason).font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if repository.fullName == model.selectedRepository { Image(systemName: "checkmark") }
                        }
                    }
                    .disabled(repository.disabledReason != nil)
                }
                if model.filteredRepositories.isEmpty {
                    Text(model.repositories.isEmpty ? "Issueを作成できるリポジトリがありません" : "一致するリポジトリがありません")
                        .foregroundStyle(.secondary)
                }
            }
            .searchable(text: $model.repositoryQuery, prompt: "検索")
            .navigationTitle("リポジトリを選択")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { model.isPickingRepository = false } } }
        }
    }
}

private struct CreatingView: View {
    let step: String

    var body: some View {
        VStack(spacing: 12) {
            ProgressView().controlSize(.large)
            Text("作成しています").font(.title3.bold())
            Text(step).font(.footnote).foregroundStyle(.secondary)
        }
    }
}

private struct SucceededView: View {
    @ObservedObject var model: ShareModel
    let issue: ShareCreatedIssue

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 48)).foregroundStyle(.green)
            Text("Issueを作成しました").font(.title3.bold())
            Text("\(issue.repositoryFullName) #\(issue.number)").font(.subheadline.monospaced())
            if let url = issue.githubURL {
                Text(url.absoluteString).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            Text("タイトルが空欄の場合は、自動で記入されます").font(.caption).foregroundStyle(.secondary)
            Button("Issueを開く") { model.openIssue() }.buttonStyle(.borderedProminent)
        }
        .padding()
    }
}

private struct UnknownResultView: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "questionmark.circle.fill").font(.system(size: 44)).foregroundStyle(.orange)
            Text("作成できたか確認できませんでした").font(.title3.bold())
            Text("通信が途中で切れました。作成済みの可能性があるため、作り直す前に確認してください。確認しても二重には作られません。")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("作成済みか確認する") { model.confirmUnknownResult() }.buttonStyle(.borderedProminent)
            Button("内容を保存して閉じる") { model.saveDraftAndFinish() }
        }
        .padding()
    }
}

private struct SignedOutView: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "person.crop.circle.badge.exclamationmark").font(.system(size: 44)).foregroundStyle(.orange)
            Text("ログインが切れています").font(.title3.bold())
            Text("IssueDeckアプリを開いてログインしてください。内容を保存して閉じると、ログイン後に続きから作成できます。")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("内容を保存して閉じる") { model.saveDraftAndFinish() }
                .buttonStyle(.borderedProminent).disabled(!model.hasContent)
        }
        .padding()
    }
}
