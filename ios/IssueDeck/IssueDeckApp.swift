import SwiftUI

@main
struct IssueDeckApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @StateObject private var model = WebViewModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            // ステータスバーの部分はWebのヘッダーと同じ色で塗る。WebViewはステータスバーの
            // 下から始めるので、スクロールした内容が上端へ潜らない
            Color("HeaderBand").ignoresSafeArea()

            WebViewContainer(webView: model.webView)
                .ignoresSafeArea(edges: .bottom)

            if model.shareImport != .idle {
                VStack {
                    ShareImportBanner(state: model.shareImport, retry: model.importSharedDrafts, discard: model.discardSharedDrafts)
                    Spacer()
                }
            }

            if let failure = model.failure {
                ConnectionErrorView(failure: failure, isRetrying: model.isRetrying, retry: model.retry)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.failure)
        .onAppear { model.startIfNeeded() }
        .onChange(of: scenePhase) { _, phase in
            // 別アプリへ行っているあいだに回線が戻っていることがある
            if phase == .active, model.failure != nil { model.retry() }
            // 共有メニューから受け取った素材があれば取り込む（#3847）
            if phase == .active { model.importSharedDrafts() }
            // 設定アプリでの許可変更を、通知欄へ反映させる（#4275）
            if phase == .active { model.notifyPushStateChanged() }
        }
    }
}

/// 共有メニューから受け取った素材の取り込み状況。素材は端末に残っており、失敗しても失われない
struct ShareImportBanner: View {
    let state: ShareImportState
    let retry: () -> Void
    let discard: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            switch state {
            case .idle:
                EmptyView()
            case .importing:
                ProgressView()
                Text("共有した内容を取り込んでいます").font(.footnote)
            case .waitingForLogin(let count):
                Text("共有した内容が\(count)件あります。ログインすると続きから取り込めます").font(.footnote)
                Spacer(minLength: 0)
                Button("破棄", role: .destructive, action: discard)
            case .failed(let message):
                Text(message).font(.footnote)
                Spacer(minLength: 0)
                Button("再試行", action: retry)
                Button("破棄", role: .destructive, action: discard)
            }
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 12)
        .padding(.top, 4)
    }
}
