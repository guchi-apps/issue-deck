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

再利用元は`morrow/ios/`（#3846で`ios/`へ移植済み。Swiftは`ios/IssueDeck/`、手順は[ios/README.md](../ios/README.md)）（`NativeAuth.swift`・`WebViewModel.swift`・`ConnectionErrorView.swift`など）と、`ios/scripts/`・`ios-testflight*.yml`。

## 認証

現在の認証はSupabase AuthのGitHubプロバイダーで、GitHub APIの利用に`provider_token`が必須（`src/lib/supabase/github-oauth.ts`・`src/app/auth/callback/route.ts`）。Googleログインのアプリとは事情が違う。

- GitHubは埋め込みWebView内のOAuthを拒否し得るため、`ASWebAuthenticationSession`（エフェメラル）でログインする
- Morrowの方式を移植した（#3846）: `/auth/native/start`（GitHubプロバイダー・スコープ`repo user:email`はWeb版と同一、PKCEのchallenge）→ `/auth/callback?native=1`が既存の許可判定・GitHub本人確認・`provider_token`暗号化保存を通したあと60秒有効の一度限りのコードを`issuedeck://auth-callback?code=…`で返す（分岐は最後のリダイレクト先だけ）→ アプリが`/auth/native/consume`（code＋verifier）を呼んでCookieを得る。引き継ぎ用テーブルは`NativeAuthHandoff`で、暗号化の鍵は`GITHUB_USER_TOKEN_ENCRYPTION_KEY`から用途別に導出する（VAPID鍵は流用しない）
- Web側のログインボタンは変えない。クライアントのSupabaseが遷移する`…/auth/v1/authorize?provider=github`をアプリが捕まえて認証シートへ渡す（`ios/IssueDeck/AppConfig.swift`の`InterceptedRoute`）
- 許可メール判定（`isEmailAllowed`）と`provider_token`・`refresh_token`の暗号化保存を迂回する新経路を作らない
- `src/lib/supabase/middleware.ts`の`publicPaths`へ`/auth/native`を足した。他の`/api/*`の認可は変えない
- ログアウトはアプリ単位。他アプリ・他端末のセッションを巻き込まない
- GitHub App秘密鍵・サーバー用トークン・DB接続情報はアプリへ同梱しない

## 共有メニューからの起案（#3847・#4298）

> **#4298で、拡張がその場でIssueを作成できるようになった**（次節「共有画面からの直接作成」）。以下の「下書き→本体で作成」は、ログインが切れているときと結果不明のまま閉じたときの退避経路として残している。

写真・Safari・他アプリの共有メニューに「IssueDeck」（Share Extension。`ios/ShareExtension/`）が出る。**拡張は素材を端末内の「下書き」に保存するだけで、Issueは作らない。** WKWebViewのCookie認証は拡張から読めず、トークンを拡張へ持たせると認証面のリスクが増えるため、確認・アップロード・作成はアプリ本体（既存のWeb起案画面）で行う。拡張から本体を強制起動する前提は置かず、次にアプリを開いたとき（前面化・ページ読込完了・ログイン後）に取り込む。

| 項目 | 方針 |
| --- | --- |
| 受け取る素材 | 画像（最大10枚。PNG/JPEG/GIF/WebP、HEIC等はJPEGへ変換）・URL・文章。動画・任意ファイルは対象外 |
| 上限 | 1枚10MB（`POST /api/issues/images`の`MAX_FILE_SIZE`と`ios/scripts/check-consistency.mjs`で照合）、文章20,000文字。超過・未対応は共有シートで案内し受け取らない |
| 保管 | App Group `group.com.gucchii.issuedeck`の端末内（`ShareDrafts/<id>/`、ファイル保護つき）。サーバーへは取り込むまで送らない |
| 取り込み | アプリがWebViewの中で画像を`/api/issues/images`へアップロードし、既存の別ウィンドウ起案の受け渡し（localStorage `issue-create-handoff`）へ本文（メモ・文章・URL・`![image](URL)`）を書いて`/issues/new`を開く。リポジトリ・タイトル・本文・画像の確認／除外は既存画面のまま。起案画面を開いている間は次の素材を入れない |
| 認証失効 | 素材は端末に残し、バナーで「ログインすると続きから取り込めます」と案内。ログイン後に自動で再開 |
| 保持・破棄 | 取り込み完了で削除。取り込めないまま7日で自動破棄。バナーの「破棄」で手動削除。共有の取消（キャンセル）では保存しない |
| アカウント切替 | 下書きは共有時の最終ログインユーザー（`GET /api/account`のID）を所有者として持つ。別ユーザーでログインしたアプリは、所有者が違う下書きを取り込まずに破棄する |
| 重複作成の防止 | `POST /api/issues`が冪等キー（`idempotencyKey`）を受け取る。GitHubへ作成する前に予約し、同じキーの再送は作成済みの結果を返す。予約済みで結果が不明なときは409（`create_in_progress`）で「確認中」と案内し、再作成しない。確実に失敗したときだけ予約を外す。キーは起案フォームのフックが、成功するまで同じ内容の再送で使い回す（Webの起案も同じ） |

署名: 拡張のBundle IDは`com.gucchii.issuedeck.ShareExtension`、両ターゲットにApp Group entitlement（`ios/Config/`）。初回の配布でApp Group／拡張のApp IDが未登録で署名に失敗した場合は、Developerサイトでの登録（手作業）が要る。

### 共有画面からの直接作成（#4298）

共有画面でリポジトリを選び、タイトル（空欄可）・本文・画像を確認して「Issueを作成」まで完了する。**共有しただけでは登録せず、作成ボタンの操作が登録の意思。**

| 項目 | 方針 |
| --- | --- |
| 認証 | 本体がログイン中にWebView内から`POST /api/share/token`（Cookie認証）で専用トークンを発行し、Keychain共有グループ（`$(AppIdentifierPrefix)com.gucchii.issuedeck.share`）へ置く。拡張はこのトークンで呼ぶ。GitHub App秘密鍵・サーバー用トークンは同梱しない |
| トークン | `idsh_`＋256bitランダム。DBは`ShareToken`にSHA-256のみ保存。有効30日で、ページを読み終えるたびに再発行（端末識別子`deviceId`単位で前のトークンは失効。ユーザーが替わっても同じ）。Webのログアウトで`DELETE /api/share/token`が全端末分を失効。アプリは未ログイン（401）を検知してKeychainを消す |
| 使える範囲 | `GET /api/share/repositories`・`POST /api/share/issues`・`POST /api/issues/images`だけ。他の`/api/*`はCookieしか通らない。失効・期限切れ・形式違いは401 |
| 認可 | 検証のたびに許可判定（`decideAccess`。`ShareToken.emailVerified`は発行時の値）を通し、許可リストから外れた利用者は発行済みトークンでも401。リポジトリは利用者の連携リポジトリ（アーカイブ除く）に限り、「Issue作成の対象外」は403。サーバーで毎回検証する |
| 重複防止 | 冪等キーは必須（`POST /api/issues`と同じ予約方式）。キーは1回の作成操作で固定し、連打・再試行・結果不明の確認で使い回す。作成中は主操作を押せない。結果不明（通信断・409・502）は「作成済みか確認する」で同じキーを再送し、二重に作らない |
| タイトル自動記入 | 空欄なら仮タイトル（本文の先頭行／URLだけなら`共有: <ホスト>`）で作り、応答後にサーバーが`generateIssueSuggestion`で書き換える。AI未設定・失敗は仮タイトルのまま（作成は成功扱い） |
| 失敗 | 通信・添付・サーバー拒否では入力・選択・素材を保持して再試行できる。画像は1枚ずつ上げ、上げ済みは再試行で上げ直さない |
| 保存・破棄 | 作成が成功するまで素材を破棄しない。成功したら拡張内の素材を手放し、下書きは作らない（従来の自動取り込みで二重登録されない）。ログイン切れ・結果不明で閉じるときだけ、利用者が「内容を保存して閉じる」を押した場合に下書きとして保存する。キャンセルでは何も保存・登録しない |
| アカウント切替 | リポジトリの記憶は利用者ごと。Keychainのセッションは別ユーザーのログインで置き換わり、前のトークンはサーバー側で失効する |
| 既知の制約 | 「Issueを開く」はGitHubのIssueを開く（本体の詳細へ直接開くにはURLスキームの登録が要るため未対応）。結果不明のまま保存した下書きを本体で取り込むと、作成済みのIssueと重複し得るため、取り込み画面で確認する |

署名: 両ターゲットに`keychain-access-groups`を足した。自動署名で通る想定だが、TestFlightのビルドで署名エラーが出た場合はDeveloperサイトでの確認（手作業）が要る。

## ネイティブ通知（#4250）

既存のPush通知（確認待ち・リリース関連）を、iOSアプリへAPNsで届ける。**送信の呼び出し側は変えず**、送信口`sendPushNotification`（`src/lib/notifications/push.ts`）が宛先で振り分ける。

| 項目 | 方針 |
| --- | --- |
| 宛先の保存 | `PushSubscription`へ`endpoint = "apns:<端末トークン>"`で相乗り（`p256dh`・`auth`は空）。登録・解除は`POST/DELETE /api/notifications/apns`（ログイン必須・トークンは16進のみ）。設定画面の一覧・ミュート・解除はそのまま効く |
| 端末側 | `ios/IssueDeck/PushNotifications.swift`が許可要求とトークン取得、タップ時の遷移を持つ。トークンはログインCookieのあるWebViewの中から`fetch`で登録し、ページを読み終えるたびに（未ログインなら無視されるので）再試行する。前面でもバナーを出す |
| 送信 | `src/lib/notifications/apns.ts`。Node標準の`http2`・`crypto`でトークン方式（ES256のJWT。50分キャッシュ）。`apns-topic`は`com.gucchii.issuedeck` |
| 設定（サーバーの`.env`。secrets-manifestには載せない） | `APNS_KEY_P8`（`.p8`のPEM。改行は`\n`可）・`APNS_KEY_ID`・`APNS_TEAM_ID`・`APNS_ENVIRONMENT`（`production`が既定／Xcode実機デバッグは`sandbox`）。揃っていなければAPNsへは送らない |
| 失効 | 410と`Unregistered`だけ行を削除。`BadDeviceToken`は環境の取り違えでも出るため削除せず失敗として記録する |

`isPushConfigured()`はVAPIDまたはAPNsのどちらかが設定済みで真。Apple Developerでの鍵発行・App IDのPush Notifications有効化・`.env`への登録は本人の手作業（`71.manual-step`）。

### 設定 > 通知からのオン・オフ（#4275）

アプリ内（UAに`IssueDeckIOS`）の通知欄はWeb Push（`usePushSubscription`）ではなく、`src/hooks/use-native-push.ts`が状態を決める。Swift側の窓口はWebViewModelの`issueDeckPush`メッセージハンドラ（`status`／`enable`／`disable`／`openSettings`。アプリ自身のメインフレームからだけ受け付ける）。

| 項目 | 方針 |
| --- | --- |
| 状態 | 純関数`describeNativePushState`（`src/lib/native-push.ts`）。許可・受信設定・端末トークン・サーバーの`endpointKey`（`apns:<token>`）がそろったときだけ「オン」。トークンはあるのにサーバーに無ければ「失効」、取れていなければ「確認中」 |
| 受信設定 | `UserDefaults`の`pushReceivingEnabled`（既定オン）。**オフの間は起動時の許可要求・トークン登録・ページ読み込み後の再登録をしない**。オフのときはページ読み込みのたびに、サーバーに残った登録の解除（DELETE）を再試行する（最後のトークンは`pushLastDeviceToken`に残す） |
| 拒否済み | OSの許可は変えず、「iPhoneの設定を開く」だけを出す。前面復帰時にSwiftが`issue-deck:native-push-refresh`を投げ、状態を取り直す |
| テスト通知 | `POST /api/notifications/test`に`endpointKey`を渡すと、その端末だけに送る（省略時は従来どおり全購読） |

この変更は`ios/`に及ぶため、TestFlightの再配布後に実機で確認する。

## 更新と配布

**Webだけの更新とiOSバイナリの更新を区別する。**

| 変更の種類 | 反映 |
| --- | --- |
| Web・サーバー（`src/`など） | 本番デプロイ（`main`）で即時にアプリへも反映。TestFlightの再配布は不要 |
| `ios/`配下（Swift・設定・アイコン・共有拡張） | `ios/`に実質変更があるときだけTestFlightへ再配布する |

配布は他アプリと同じ流れにする。`deploy.yml`成功→`ios-testflight-trigger.yml`→`ios-testflight.yml`（macOSランナーで署名・アーカイブ・アップロード・ASCでの処理待ち・内部グループ配布）。ビルド番号は`run_number*100+run_attempt`、完了時にタグ`ios-testflight/<ビルド番号>`を打つ。認証情報は`ASC_KEY_ID`・`ASC_ISSUER_ID`・`ASC_KEY_P8`（1Passwordの`apps/AppStoreConnect`を共用）。

issue-deck自身の配布状況は、既存の他アプリと同じ経路で画面に出す。**ビルド成功と実際の配布成功を混同しない**。接続は**#3846で**`src/lib/webview-ios-repos.ts`（固定リスト）へissue-deck自身を追加済みで、完了タグは`ios-testflight/<ビルド番号>`の規約に揃える。判定は`src/lib/ios-testflight-status.ts`の6段階判定で行う。失敗の自動起票は`src/lib/ios-distribution-failure.ts`が受け持つ。詳細は[multi-agent/release.md](multi-agent/release.md)のiOS節。

本人の手作業（App Store Connectでのアプリ登録・初回の内部テスターグループ作成など）が残る場合は、`71.manual-step`の単独Issueとして切り出す。

## 既知の懸念

- WKWebViewではWeb Push（`public/sw.js`）が動かない。ネイティブ通知は「ネイティブ通知（#4250）」のとおりAPNsで受け取る
- キーボード・日本語入力・画面余白は実機で確認する（Webのsafe-area対応との両立を#3846で確認）
- WebViewは下端まで広げており、`contentInsetAdjustmentBehavior`が既定のままだと下の安全領域ぶんだけWebのレイアウト高さが縮み、フッター下に空きが出る（#4258）。`.never`にしてPWAと同じ下端までの描画に揃えている。実機（TestFlight）で確認する
- iPad対応（#4283）: 以前は対応端末がiPhoneのみ（`TARGETED_DEVICE_FAMILY = 1`）だったため、iPadでは互換モードのスマホ縦画面（幅約393px）で動いていた。アプリ本体・ShareExtensionとも`1,2`にし、iPadの向きは縦・横すべてを許可している（iPhoneは縦のまま）。iPadの横向き（幅1180px）はWebの`md:`・`lg:`の既存レスポンシブでPC相当の配置になる。Xcodeがsubpcに無いため、iPadでの見た目と回転は実機（TestFlight）で確認する

## 完了の判定と記録

PRのマージだけでは完了としない。次は子Issueのコメントに実機での確認結果を残す。

| 記録する項目 | 記録先 |
| --- | --- |
| TestFlight経由のインストール・起動、確認したビルド番号／バージョン | #3846 |
| ログイン成功・取消・失敗・権限不足、再起動後の復元、失効時の再ログイン | #3846 |
| 日本語入力・キーボード表示中の主要操作、通信不能時の再試行 | #3846 |
| 共有メニューから画像・URL・文章を起案できること | #3847 |
| Web/PWAに回帰が無いこと | #3846・#3847 |

## Macでのビルド確認（#3846）

subpcにXcodeは無いが、Tailscale SSHでMac（`guchimac-mini`）へ入れる。`ios/scripts/remote-build-check.sh`は作業ツリーの`ios/`をMacへ送り、共有スキーム`IssueDeck`を署名なしの`xcodebuild`（iOS Simulator向け）でビルドする。コンパイルが通るかの確認用で、署名・TestFlight・実機の挙動は確かめない（実機の項目は上の表のとおり本人が確認する）。
