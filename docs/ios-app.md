# IssueDeckのiOSアプリ（全体設計）

**いつ読むか**: IssueDeckのiOSアプリ（#3845）の実装・配布・更新に関わるとき。子Issue #3846・#3847の実装前。

親Issue #3845は全体の契約と追跡を持つ。実装は子Issueで行い、このファイルは方針の正とする。実装が進んで事実が変わったら、子IssueのPR側でここを更新する。

## 目的と範囲

外出先のiPhoneでIssue・PR・実装進捗を確認し、不具合のスクリーンショットやURLからIssueを起案できるようにする。

| 子Issue | 内容 | 順序 |
| --- | --- | --- |
| #3846 | iOS基盤・認証・既存画面・TestFlight配布 | 先 |
| #3847 | 共有メニューから画像・URL・文章を起案へ取り込む | #3846の完了後 |

対象外: App Store一般公開、Web画面全面のネイティブ化、スマホ上でのXcodeビルド、承認操作や本番リリースの無人自動化。ウィジェット・Live Activities・ネイティブ通知・ショートカットは後続。

## 方式

**SwiftUI＋素のWKWebViewの薄い殻**とする。Morrow・Yoteiflow・Kurashioが同じ方式で、Capacitorは使わない。画面・認証・データは本番のWebとサーバーを正とし、ネイティブ側へ二重実装しない。

| 項目 | 方針 |
| --- | --- |
| iOSプロジェクトの置き場 | 本リポジトリの`ios/`（他アプリと同じ） |
| Bundle ID | `com.gucchii.issuedeck`（`com.gucchii.<アプリ名小文字>`の規約） |
| 署名 | Teamは他アプリと共用、Automaticのクラウド署名（ASC APIキー＋`-allowProvisioningUpdates`） |
| 認証コールバック | `issuedeck://auth-callback`（他アプリのスキームと衝突させない） |
| 名称・アイコン | IssueDeckの既存のものを使う |

再利用元は`morrow/ios/`（`NativeAuth.swift`・`WebViewModel.swift`・`ConnectionErrorView.swift`など）と、`ios/scripts/`・`ios-testflight*.yml`。

## 認証

現在の認証はSupabase AuthのGitHubプロバイダーで、GitHub APIの利用に`provider_token`が必須（`src/lib/supabase/github-oauth.ts`・`src/app/auth/callback/route.ts`）。Googleログインのアプリとは事情が違う。

- GitHubは埋め込みWebView内のOAuthを拒否し得るため、`ASWebAuthenticationSession`（エフェメラル）でログインする
- Morrowの方式を移植する: `/auth/native/start`（PKCEのchallenge）→ `/auth/callback?native=1`が60秒有効の一度限りのコードを`issuedeck://auth-callback?code=…`で返す → アプリが`/auth/native/consume`（code＋verifier）を呼んでCookieを得る
- 許可メール判定（`isEmailAllowed`）と`provider_token`・`refresh_token`の暗号化保存を迂回する新経路を作らない
- `src/lib/supabase/middleware.ts`の`publicPaths`へ`/auth/native/*`を足す。他の`/api/*`の認可は変えない
- ログアウトはアプリ単位。他アプリ・他端末のセッションを巻き込まない
- GitHub App秘密鍵・サーバー用トークン・DB接続情報はアプリへ同梱しない

## 更新と配布

**Webだけの更新とiOSバイナリの更新を区別する。**

| 変更の種類 | 反映 |
| --- | --- |
| Web・サーバー（`src/`など） | 本番デプロイ（`main`）で即時にアプリへも反映。TestFlightの再配布は不要 |
| `ios/`配下（Swift・設定・アイコン・共有拡張） | `ios/`に実質変更があるときだけTestFlightへ再配布する |

配布は他アプリと同じ流れにする。`deploy.yml`成功→`ios-testflight-trigger.yml`→`ios-testflight.yml`（macOSランナーで署名・アーカイブ・アップロード・ASCでの処理待ち・内部グループ配布）。ビルド番号は`run_number*100+run_attempt`、完了時にタグ`ios-testflight/<ビルド番号>`を打つ。認証情報は`ASC_KEY_ID`・`ASC_ISSUER_ID`・`ASC_KEY_P8`（1Passwordの`apps/AppStoreConnect`を共用）。

issue-deck自身の配布状況は、既存の他アプリと同じ経路で画面に出す。**ビルド成功と実際の配布成功を混同しない**。接続は**#3846で**`src/lib/webview-ios-repos.ts`（固定リスト）へissue-deck自身を追加し、完了タグは`ios-testflight/<ビルド番号>`の規約に揃える。判定は`src/lib/ios-testflight-status.ts`の6段階判定で行う。失敗の自動起票は`src/lib/ios-distribution-failure.ts`が受け持つ。詳細は[multi-agent/release.md](multi-agent/release.md)のiOS節。

本人の手作業（App Store Connectでのアプリ登録・初回の内部テスターグループ作成など）が残る場合は、`71.manual-step`の単独Issueとして切り出す。

## 既知の懸念

- WKWebViewではWeb Push（`public/sw.js`）が動かない可能性がある。ネイティブ通知は後続とし、初期範囲では扱わない
- キーボード・日本語入力・画面余白は実機で確認する（Webのsafe-area対応との両立を#3846で確認）

## 完了の判定と記録

PRのマージだけでは完了としない。次は子Issueのコメントに実機での確認結果を残す。

| 記録する項目 | 記録先 |
| --- | --- |
| TestFlight経由のインストール・起動、確認したビルド番号／バージョン | #3846 |
| ログイン成功・取消・失敗・権限不足、再起動後の復元、失効時の再ログイン | #3846 |
| 日本語入力・キーボード表示中の主要操作、通信不能時の再試行 | #3846 |
| 共有メニューから画像・URL・文章を起案できること | #3847 |
| Web/PWAに回帰が無いこと | #3846・#3847 |
