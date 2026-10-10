# IssueDeck iOSアプリ

本番IssueDeck（`https://issuedeck.gucchii.com/`）をiPhoneの独立したアプリとして開くための、SwiftUI + WKWebView の薄い殻です（#3846）。
**Issue・PR・進捗・リリースなどの画面と認可はすべてWeb版（既存サーバー）が正本**で、ここには「Web版を開く・GitHubログインを認証シートで往復させる・通信できないときに再試行させる」ことしか書いていません。Web/PWA版の挙動は変えていません。方式・署名・配布手順は morrow・kurashio・YoteiFlow の `ios/` と同じ構成です（全体設計は [docs/ios-app.md](../docs/ios-app.md)）。

| 項目 | 値 |
|---|---|
| 表示名 | IssueDeck |
| Bundle ID | `com.gucchii.issuedeck` |
| 署名 | Automatic（Apple Developer Program のチーム `6AA3WFTR94`。kurashio・YoteiFlow・morrow と同じチーム） |
| 対応 | iPhone・縦向き・iOS 18以上 |
| 認証シートの戻り先 | `issuedeck://auth-callback` |
| 共有メニュー（Share Extension） | `ios/ShareExtension/`。Bundle ID `com.gucchii.issuedeck.ShareExtension`。App Group `group.com.gucchii.issuedeck`（下書きの受け渡し。方式は [docs/ios-app.md](../docs/ios-app.md)「共有メニューからの起案」） |
| Associated Domains / Push | 使わない（初版スコープ外） |

## 更新が要る場所

| 変えたもの | Web/PWA | iOSアプリ |
|---|---|---|
| 画面・機能・会話・サーバー（`src/`） | mainへマージ → 自動デプロイ | 何もしなくてよい（次に開いたとき新しい画面が出る） |
| アプリの殻（`ios/`） | 影響なし | Xcodeで入れ直す／TestFlightへ新しいビルドを上げる |

## ビルド方法（Mac + Xcode）

**subpc には Xcode が無い**ため、ビルド・実機確認はMacで行います。コミット前のコンパイル確認だけなら subpc から `ios/scripts/remote-build-check.sh`（作業ツリーの `ios/` をMacへ送り、署名なしで `xcodebuild`。署名・実機確認は含まない）。

1. Xcode 27系を使う（`project.pbxproj` は `objectVersion = 110`。古いXcodeでは開けない）
2. `open ios/IssueDeck.xcodeproj`
3. スキーム `IssueDeck`・実行先を自分のiPhoneにし、Signing & Capabilities の Team が Apple Developer Program のチームになっていることを確かめて ⌘R
4. 初回は iPhone の 設定 → プライバシーとセキュリティ → デベロッパモード をオンにし、設定 → 一般 → VPNとデバイス管理 で開発者証明書を信頼する

## TestFlight で配布する

**mainへのデプロイ後に、GitHub Actions（macOSランナー）が自動でTestFlightの内部テストへ配布します**（#448。YoteiFlow・kurashioと同じ方式）。Mac での手動アップロード（下記）は予備の経路です。TestFlight のビルドは90日で期限切れになるため、期限が近いときは `ios-testflight.yml` を手動実行します。

### 自動配布の流れ

`Deploy to Production`（main）成功 → `ios-testflight-trigger.yml` が `ios-testflight.yml` を起動 → 判定（`ios/scripts/ios-changes.mjs`）→ 署名・アーカイブ・書き出し・アップロード → 処理待ち・内部グループへ配布（`ios/scripts/asc-api.mjs`）→ 印のタグ `ios-testflight/<ビルド番号>` ＋ Signaly通知。

- **配るのは `ios/IssueDeck/`・`ios/IssueDeck.xcodeproj/` に実質的な変更があるときだけ**（README・scripts・版番号の行だけの差分は数えない）。Webだけの更新ではビルドしない。比べる相手は最後に配布し終えたタグ。タグが無い初回は必ず配る
- 判定だけ見たいときは Actions →「iOS TestFlight」→ Run workflow で `dry_run` にチェック。sha を指定すればそのコミット（main上のもの）を配る
- iOSの失敗はWebのデプロイとは別のrunで赤くなる（Webの本番反映は済んでいる）。失敗した run は「Re-run failed jobs」か同じ shaで手動実行し直す（アップロード済みのビルドは二重に上げない）
- ビルド番号は `run_number*100+run_attempt`。署名はクラウド署名（APIキー＋`-allowProvisioningUpdates`）。使い捨てランナーで作られた Development 証明書は署名の前後で失効させる（溜まると上限に達する）
- CIの書き出しは `ios/scripts/ExportOptions.plist`（`destination=export`。IPAを書き出してから `altool` で上げる）。手動経路は `ios/ExportOptions.plist`（`destination=upload`）
- `develop`→`main` のPRには、`ios/` に配布物の変更があると `ios-rebuild-notice.yml` がコメントで知らせる
- 内部グループが複数あるときは repository variable `TESTFLIGHT_GROUP` にグループ名を入れる

### 自動配布の初期設定（手作業）

1. 下記「初回だけ」の App Store Connect のアプリ登録と内部グループ作成
2. GitHub の secret `ASC_KEY_ID`・`ASC_ISSUER_ID`・`ASC_KEY_P8`（`.github/secrets-manifest.tsv` に行がある。値は 1Password の `apps/AppStoreConnect`）。個人アカウントで `scripts/sync-github-secrets.sh --dry-run` → 本実行（またはActionsの Sync Secrets）
3. 未登録のままでも Web のデプロイは失敗せず、iOS配布のジョブだけが認証エラーで止まる
4. APIキーが失効したら、App Store Connect で新しいキーを作って 1Password を更新し、同期し直す

### 手動で上げる（予備）

**この経路のビルドとアップロードは Mac でしかできません。**

| 項目 | 値・運用 |
|---|---|
| App Store Connect のアプリ | 名前 `IssueDeck`・Bundle ID `com.gucchii.issuedeck`・チーム `6AA3WFTR94`（初回だけ手作業） |
| 輸出コンプライアンス | `INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO`（標準のHTTPS通信のみ） |
| アイコン | `AppIcon.appiconset` の1024px（アルファ無し）。`public/icon.svg`（承認済みのMマーク）から書き出したもの |
| 版番号（`MARKETING_VERSION`） | `package.json` の `version` と揃える。`pnpm version`（リリースの版上げ）が `package.json` の `scripts.version` から `sync-version.mjs` を実行して同じコミットへ含める。手動でも `node ios/scripts/sync-version.mjs`（冪等）。自動配布はずれていると止まる |
| ビルド番号（`CURRENT_PROJECT_VERSION`） | アップロードのたびに増える必要がある。自動配布は run 番号から決める。手動スクリプトが Archive 時に日時（`YYYYMMDDHHMM`）で上書きする（`IOS_BUILD_NUMBER` で固定も可） |

### 初回だけ（手作業・本人の操作）

1. [App Store Connect](https://appstoreconnect.apple.com/) → マイApp → 「+」→ 新規App。プラットフォーム iOS・名前 IssueDeck・プライマリ言語 日本語・Bundle ID `com.gucchii.issuedeck`・SKU は任意（例 `issuedeck`）。Bundle ID が候補に出ない場合は Developer サイトの Identifiers で `com.gucchii.issuedeck` を先に登録する
2. App Store Connect API キーは**新しく作らず共用**する（APIキーはチーム単位）。1Password の `apps/AppStoreConnect` の `key-id`・`issuer-id`・`key-p8` を `ios/asc.env.tpl` が参照している
3. TestFlight →「内部テスト」にグループを作り、自分を追加
4. サーバー側の確認（下記「Supabase側の設定」）

### ビルドを上げるたび（subpc から1コマンド）

**Web側が main へデプロイされた後に**、`main` から上げます。

```bash
node ios/scripts/sync-version.mjs          # 版番号を package.json に揃える（差分があればコミットしてmainへ）
ios/scripts/remote-upload-testflight.sh    # Mac で main を取り込み、TestFlight へ上げる
```

- Mac 側の前提: チェックアウトが `$HOME/apps/issue-deck` にある（別の場所なら `MAC_REPO_DIR='$HOME/x'`）・Xcode・1Password CLI（`op`）にサインイン済み・ログインキーチェーンが開いている
- `MAC_HOST`（既定 `guchimac-mini`）・`MAC_REPO_DIR`・`IOS_BRANCH`・`IOS_SKIP_PULL=1`・`IOS_BUILD_NUMBER` を環境変数で上書きできる。作業ツリーに未コミットの変更があると中止する
- Mac の前にいるなら `op run --env-file=ios/asc.env.tpl -- ios/scripts/upload-testflight.sh`
- スクリプトは `check-consistency.mjs` → `xcodebuild archive` → `xcodebuild -exportArchive`（App Store Connect へ直接アップロード）を順に実行し、**どれかが失敗したらそこで止まる**。**終了コードをパイプで隠さないこと**（`| tee` 等を付けない）。成功と表示されるのはアップロードまで通った場合だけ
- **subpc からは実行結果を確かめられない**。初回は Mac で1回通して確かめる

## 開発環境と本番の切り替え

`IssueDeck/AppConfig.swift` の `baseURL` だけを変えます。LAN IP の `http://` のままでは Supabase Auth のリダイレクトが戻れないため、sslip.io や tailnet のホスト名を使います。**戻すのを忘れてコミットしないこと**（`node ios/scripts/check-consistency.mjs` と `pnpm test:unit` が本番URLかを確かめます）。

## Supabase側の設定

**新しく登録するURLは不要**な設計です。認証シートが開くのは Web版の `/auth/native/start` で、Supabase・GitHub に返るのは既存の `https://issuedeck.gucchii.com/auth/callback` だけです。`issuedeck://` へ戻すのはサーバーで、許可リストには登録しません。

ただし戻り先が `/auth/callback?native=1&challenge=…&next=…` とクエリ付きになります。Supabase の Redirect URLs が完全一致だけだと弾かれる可能性があるため、**実機で最初のログインが通るかを確かめてください**。通らなければ `https://issuedeck.gucchii.com/auth/callback**` のようにワイルドカードを足します（共有Supabaseプロジェクトの設定）。

## 仕組み

### GitHubログイン（認証シート → 引き継ぎコード → WebView）

`ASWebAuthenticationSession` と `WKWebView` は Cookie を共有しません。IssueDeck のログインは `@supabase/ssr` の Cookie セッションなので、次の方式でWebViewへ引き継ぎます。**認証シートは毎回エフェメラル**（Safariの既存ログインに触れない代わりに、毎回GitHubの入力が要る）。GitHubは埋め込みWebView内のOAuthを拒み得るため、認証画面だけをシートへ出します。

1. Web の `/login` の「GitHubで始める」（クライアントのSupabaseが `…/auth/v1/authorize?provider=github` へ遷移させる）を、アプリが捕まえてWebView内では開かない。**Web側のボタンは変えない**
2. アプリが PKCE の `verifier`（乱数）と `challenge`（S256）を作り、認証シートで `/auth/native/start?challenge=…&next=…` を開く
3. GitHub → Supabase → サーバーの `/auth/callback?native=1&…`。**許可判定（`isUserAllowed`）・GitHub本人確認・`provider_token` の暗号化保存は Web版と同じ箇所**で行い、許可外は `issuedeck://auth-callback?error=not_allowed`
4. サーバーはセッションのトークンを暗号化して60秒だけDBへ置き（鍵は `GITHUB_USER_TOKEN_ENCRYPTION_KEY` から用途別に導出）、**トークンではなく一度限りのコード**だけを `issuedeck://auth-callback?code=…` で返す
5. アプリはWebViewの中から `POST /auth/native/consume`（本文に `code` と `verifier`）を呼び、通常の Supabase SSR Cookie を受け取ってから `next` を開く（ここでも許可判定を再確認する）

使用済み・期限切れ・別用途・verifier不一致のコードはすべて同じ拒否。トークンは、URL・アプリのログ・Swiftのコードのどこにも出ません。コードは `verifier` が無ければ消費できないので、他のアプリが `issuedeck://` を横取りしてもログインできません。取消はそのままログイン画面に残り、失敗（`auth_failed`）は「ログインの完了処理に失敗しました」、許可外は「このアカウントではログインできません」を `/login` に出して、もう一度ログインを試せます。

### ログアウト・セッション失効

ログアウトは Web の画面操作のまま（クライアントの `signOut({ scope: "local" })`）で、このアプリのセッションだけを終わらせます。共有Supabaseの他アプリ・他端末はログアウトされません。許可リストから外れたアカウントやセッション失効は、middlewareが `/login` へ戻します。ログイン状態は WKWebView の既定データストアに残り、再起動しても維持されます。

### 外部リンク・通信失敗・ダイアログ

- IssueDeckと同一オリジン（スキーム・ホスト・ポート）だけをWebView内で開き、他はSafariで開く（`AppConfig.isAppURL`）
- 通信できない・5xx のときは `ConnectionErrorView` が理由と「再読み込み」を出す。回線が戻れば自動で読み直す
- `alert` / `confirm` は `WKUIDelegate` で実装（無いと確認が常に「キャンセル」になる）

### 通知・オフライン表示について

WKWebView では Web Push（`public/sw.js`）も Service Worker も使えない可能性が高く、ネイティブ通知は後続です。通信できないときは PWA の保存済み画面の代わりに再試行の画面を出します。

## 初回登録（本人の操作）と確認

手作業の一覧は単独の `71.manual-step` Issue（#3846 から参照）に切り出しています。要点は次のとおりです。

1. App Store Connect でアプリ登録（名前 IssueDeck・Bundle ID `com.gucchii.issuedeck`）と内部グループの作成
2. GitHub の secret `ASC_*` の同期（`scripts/sync-github-secrets.sh --repo guchi-apps/issue-deck`）
3. Mac の `~/apps/issue-deck` へチェックアウト（手動アップロード・「ビルド方法」の `open` に使う）
4. 実機で初回ログイン（Supabase の Redirect URLs にクエリ付きの戻り先が通るか）

## 配布結果の見方・失敗したとき

- 配布状態は issue-deck の画面（ブランチ／リリース画面のiOS配布欄。`ios-testflight.yml` の段階と、完了タグ `ios-testflight/<ビルド番号>` の有無で判定）で見る。**ビルド成功と配布成功は別**で、内部グループへ割り当て終えてタグが付いて初めて配布済み
- 失敗は Actions の「iOS TestFlight」の run で、どの段階（判定・署名・ビルド・アップロード・処理待ち・配布）かを確かめ、「Re-run failed jobs」か同じ sha で手動実行する。失敗はissue-deckが自動でIssueに起票する
- Webだけの更新ではTestFlightは動かない。`ios/` に実質的な変更があったリリースだけが配られる

## 実機確認（本人がMacとiPhoneで行う。未実施）

PRのマージとTestFlight確認は別です。**この表が埋まるまで #3846 の完了条件は満たしたことになりません。**

| 項目 | 結果（ビルド番号・バージョン） |
|---|---|
| TestFlight経由でインストールし、IssueDeckの名称・アイコンで起動する | 未確認 |
| GitHubログイン成功／取消／失敗／許可外アカウント（権限のないデータは出ない） | 未確認 |
| Issue・PR一覧／詳細・進捗・ブランチ／リリース画面が表示され、起案・コメントがWebにも反映される | 未確認 |
| 完全終了して開き直してもログインが復元される／失効時に再ログインへ誘導される／アプリ単位でログアウトできる | 未確認 |
| 日本語入力・変換確定・キーボード表示中の主要操作（入力欄・確認ボタンが隠れない） | 未確認 |
| 機内モード等の通信不能時に再試行できる | 未確認 |
| Web/PWAに回帰が無い | 未確認 |
