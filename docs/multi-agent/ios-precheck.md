# iOS事前検証（サブPCからMac miniへSSHで依頼する。#4138）

**いつ読むか**: XcodeのないサブPCで実装したiOSの変更を、レビュー前にMacでビルド・テストしたいとき。
iOS事前検証の対象リポジトリを増やすとき。`issue-deck/ios-precheck`のcommit statusの意味を知りたいとき。

## 何のためにあるか

サブPCにはXcodeが無いため、iOSアプリ（kurashio・yoteiflow・aide・morrowの`ios/`）のSwiftの
コンパイルエラーは、これまで**マージ後のTestFlight配布ワークフローで初めて**分かっていた。
同じネットワークで常時起動しているMac miniへSSHでビルド／自動テストを依頼し、実装後・レビュー前に
結果を受け取れるようにする。

配布用の`yoteiflow/ios/scripts/remote-upload-testflight.sh`とは別物で、こちらは**署名・アップロード・
ブランチ切り替えを一切しない**（対話用TTYも使わない）。

## 仕組み

```
サブPC（実装セッション）                         Mac mini
scripts/ios-precheck.sh run
  ├─ git archive <SHA> ──── ssh ──────────────▶ ~/.issue-deck/ios-precheck/jobs/<ジョブID>/
  │                                              ├─ src.tar → git get-tar-commit-id（検証したSHA）
  │                                              ├─ キュー待ち（~/.issue-deck/ios-precheck/lock）
  │                                              ├─ xcodebuild build / build-for-testing
  │                                              ├─ xcodebuild test-without-building
  │                                              └─ status.json・build.log・test.log・*.xcresult
  ├─ ssh … status <ジョブID>（15秒おき） ◀───────┘
  ├─ commit status `issue-deck/ios-precheck` をそのSHAへ付ける
  └─ 標準出力へ結果のJSON（下の「結果の契約」）
```

- 実体は2つ。依頼側の[`scripts/ios-precheck.sh`](../../scripts/ios-precheck.sh)と、Mac側の
  [`scripts/lib/ios-precheck-remote.sh`](../../scripts/lib/ios-precheck-remote.sh)。**Mac側はMacへ
  インストールしない。** 依頼のたびに内容のハッシュ付きの名前で送り込む（版の食い違いを作らない。
  走っているジョブが読んでいるファイルを上書きしないよう、名前を変えてmvで置く）
- **Macの普段の作業ツリー（`~/apps/<repo>`）に触れない。** ソースはサブPCの`git archive`をジョブ専用の
  ディレクトリへ展開し、DerivedData・xcresultもそこに置く。Mac側にGitHubの資格情報も要らない。
  終わったジョブはソースとDerivedDataだけを消し、ログ・xcresult・`status.json`は14日残す
- **検証したSHAはtarのヘッダから読み直す**（`verifiedSha`）。依頼した文字列を書き写すのではない
- **Mac単位で1件ずつ。** `mkdir`のロックを取れたジョブだけが走り、他は`queued`で待つ（macOSに
  `flock`は無い）。持ち主のPIDが死んでいるロックだけを外す。2時間待っても空かなければ`queue_timeout`
- **ジョブIDは`<repo名>-<SHA先頭12桁>-<種別>`。** 同じ依頼を再送しても1回しか走らず、2回目以降は
  今の状態を返す。やり直すときだけ`--retry`で別ID（末尾に`-r<時刻>`）にする
- **SSHが切れても止まらない。** Mac側はnohupで切り離して走り、依頼側は再接続して読み直す
- **止めるのは自分のジョブだけ。** 各xcodebuildを専用のプロセスグループで起こし、タイムアウト・中止の
  ときはそのグループIDへだけシグナルを送る。名前やコマンドラインで相手を選ばない
- **Mac側はmacOS標準のbash 3.2で動く。** 空配列の展開・連想配列などの書き方に注意する（ファイル冒頭）

## 使い方

対象リポジトリのworktreeで実行する（`--repo`・`--sha`を省くと、originとHEADから決める）。
**検証するのはコミットだけ**で、未コミットの変更は含まれない。commit statusを付けるため、先にpushしておく。

```bash
# ビルドだけ（設定のkindが既定）
~/apps/issue-deck/scripts/ios-precheck.sh run
# ビルド＋自動テスト
~/apps/issue-deck/scripts/ios-precheck.sh run --kind test
# 依頼だけして戻る → 後で再接続して待つ
~/apps/issue-deck/scripts/ios-precheck.sh run --no-wait
~/apps/issue-deck/scripts/ios-precheck.sh status --job <ジョブID> --wait
# 中止・ログ・環境確認・設定の確認
~/apps/issue-deck/scripts/ios-precheck.sh cancel --job <ジョブID>
~/apps/issue-deck/scripts/ios-precheck.sh log --job <ジョブID> --lines 120
~/apps/issue-deck/scripts/ios-precheck.sh doctor
~/apps/issue-deck/scripts/ios-precheck.sh config --repo guchi-apps/yoteiflow
```

Claude Code・Codexのどちらも同じコマンドを打ち、同じJSONを受け取る。実行中のClaude Codeセッションは
画面のステップが「iOS検証中」（`IOS_VERIFYING`。`scripts/lib/session-step.sh`）になる。

終了コードは`0`＝成功、`1`＝検証失敗（ビルド・テスト）、`2`＝検証待ち、`64`＝使い方の誤り。

## 結果の契約

標準出力の最後の1行がJSON。**キーを変えるときは依頼側とMac側の両方と、このファイルを揃える。**

| キー | 中身 |
| --- | --- |
| `jobId` / `repository` / `kind` | ジョブID・`owner/repo`・`build`か`test` |
| `requestedSha` / `verifiedSha` | 依頼したSHA／Macが受け取ったtarから読み直したSHA |
| `state` | `queued`・`preparing`・`building`・`testing`（途中）／`succeeded`・`failed`・`waiting`（終わり） |
| `waitingReason` | `waiting`の理由（下の表） |
| `failedStage` | `prepare`・`build`・`test` |
| `message` | 日本語の1行 |
| `build` | `status`（`passed`・`failed`・`timeout`・`not_run`）と`exitCode` |
| `test` | `status`（`passed`・`failed`・`zero_tests`・`not_configured`・`not_requested`・`timeout`・`unknown`・`not_run`）・`exitCode`・`total`・`passed`・`failed`・`skipped` |
| `environment` | `xcode`（`xcodebuild -version`）・`simulator`（機種とruntime） |
| `submittedAt` / `startedAt` / `finishedAt` | UTCのISO文字列 |
| `artifacts` | Mac上のジョブディレクトリ・`build.log`・`test.log`・`build.xcresult`・`test.xcresult`のパス |
| `client.nextAction` | 次にどうするか（下の表） |
| `client.fixAttempts` / `maxFixAttempts` | このブランチで検証失敗になったSHAの数／上限（既定3） |
| `client.required` | 設定で必須検証にしているか |
| `client.resumeCommand` | 再接続するコマンド |

**成功にしないもの。** テスト未設定（`not_configured`）・テストを依頼していない（`not_requested`）は
`state`こそ`succeeded`だが、`test.status`でそれと分かり、`message`にも「自動テスト未設定」と出る。
テスト0件（`zero_tests`）は`failed`、終了コード0でも件数を読めないもの（`unknown`）は`waiting`にする。

### 検証待ちの理由と次の動作

| `waitingReason` | 意味 | `nextAction` |
| --- | --- | --- |
| `not_configured` | `scripts/ios-precheck.conf`に無い・設定の誤り | `not_configured` |
| `unreachable` / `auth` / `host_key` | 接続できない・SSH認証失敗・ホスト鍵の不一致 | `resolve_environment` |
| `environment` | 接続先が未設定、Simulator・Xcode・schemeが無いなど | `resolve_environment` |
| `transfer` | ソースの転送・展開の失敗、SHAの不一致 | `resolve_environment` |
| `timeout` | ビルド／テストが上限秒数で終わらなかった（そのジョブのプロセスだけを止めた） | `retry_or_report` |
| `interrupted` / `queue_timeout` | Mac側の実行が途中で消えた（再起動など）／キューが空かない | `retry_or_report` |
| `disconnected` / `wait_timeout` | 状態を取れなくなった／待つのを打ち切った（Mac側は走り続けている） | `resume` |
| `cancelled` | 中止した | `none` |

`nextAction`の意味: `proceed`＝先へ進む／`fix_and_recheck`＝ログを読んでソースを直し、新しいコミットで
再検証／`stop_fix_limit`＝修正の上限に達したので直すのをやめ、Issueコメントで人へ渡す／
`resolve_environment`＝**ソースを直さない**。理由を報告して人へ渡す／`retry_or_report`＝1回だけ
`--retry`し、再発したら報告／`resume`＝`client.resumeCommand`で再接続。

Macのビルドエラーのうち環境が原因のもの（Simulatorが無い・Xcodeが古い・schemeが無い・ディスク不足など。
Mac側の`ENVIRONMENT_ERROR_PATTERNS`）は`failed`ではなく`waiting`にする。実装担当がソースを直しに
行っても直らないため。

## commit status（`issue-deck/ios-precheck`）

依頼側は、検証したSHAへcommit statusを付ける（`--no-status`で付けない）。

| 結果 | status |
| --- | --- |
| 依頼した・キュー待ち・ビルド中・テスト中 | `pending`（「iOS検証待ち」「iOS検証: ビルド中」など） |
| `waiting`（接続不可・環境不足・タイムアウト・切断など） | `pending`（理由付き）。**成功にも失敗にもしない** |
| `failed` | `failure` |
| `succeeded` | `success`（テスト未設定ならそう書く） |

statusはコミットに付くので、**修正をpushした新しいSHAには前の成功が引き継がれない。** 古いSHAの
成功を最新変更の成功として扱わないための仕組みはこれだけで足りる。

### 必須検証

設定で`required=true`にした対象は、**対象リポジトリの`develop`の必須チェックに`issue-deck/ios-precheck`を
加える**ことで自動マージを止める。`claude-review-develop.yml`の自動マージは`gh pr merge --auto`で、必須
チェックが揃うまでマージしないため、未実施（statusが無い）・失敗・検証待ち・古いSHAの成功のどれでも
進まず、最新SHAで`success`が付いた時点で通常の流れへ戻る。issue-deck側のワークフローは変えていない。

- 必須チェックに足すときは**Appを指定しない**（statusはユーザー本人のトークンで付くため）
- GitHub ActionsからはMacへ届かないため、サブPCのpollerが必須対象のPRを巡回し、最新SHAをMacへ依頼する（#4186）。pollerが停止中は手動の`ios-precheck.sh run`も使える
- `required=false`の間は、statusは付くがマージは止めない（表示と記録だけ）
- 既存のレビュー承認・本番リリースの手順は変えない

## 導入手順

1. **Mac側**: リモートログイン（SSH）を有効にし、Xcodeを入れて一度起動しライセンスに同意する。
   使うSimulatorのruntimeを入れる（`xcrun simctl list devices available`に機種が出ること）。
   `python3`（Xcodeに同梱）と`perl`があること。**GUIセッションは、Simulatorでのビルドと単体テストには
   要らない**（UIテストを実行する場合はログイン中であることを別途確かめる）
2. **サブPC側**: 鍵で非対話に入れることを確かめる（パスワードを聞かれたら失敗する設定で走る）。
   ```bash
   ssh -o BatchMode=yes -o StrictHostKeyChecking=yes <ssh先> 'xcodebuild -version'
   ```
   **ホスト鍵は`StrictHostKeyChecking=yes`で照合する。** 初回は`ssh-keyscan`の結果をMac側の
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`と突き合わせてから`known_hosts`へ入れる
3. **サブPC側**: 接続先を書く（このリポジトリはPUBLICなので、ホスト名をリポジトリに置かない）。
   ```bash
   printf 'IOS_PRECHECK_HOST=%s\n' '<ssh先>' > ~/.config/issue-deck/ios-precheck.env
   ```
4. 対象リポジトリを[`scripts/ios-precheck.conf`](../../scripts/ios-precheck.conf)へ足す
   （project/workspace・scheme・Simulator・テストの有無・既定の種別・必須か）。schemeが共有されて
   いない（`xcshareddata/xcschemes`が無い）プロジェクトでも、xcodebuildが自動生成するschemeで
   ビルドできる。テストTargetがあるならschemeを共有にしておく
5. `ios-precheck.sh doctor`で環境を、`ios-precheck.sh run`で1回ビルドを通す
6. 必須にする場合は、上の「必須検証」のとおり対象リポジトリの必須チェックを足してから`required=true`

## 対象外・未確認のまま残るもの

- TestFlightへのアップロード・本番デプロイ・実機へのインストール・証明書の変更はしない
  （`CODE_SIGNING_ALLOWED=NO`でSimulator向けにだけビルドする）
- 実機依存の機能（HealthKit・プッシュ通知・Live Activity・他社アプリからの共有など）は検証できない。
  UIテストは、そのアプリにテストが用意された範囲に限る
- **WebViewで包んだアプリは、ネイティブ側のビルドしか確かめていない。** WebViewが本番のページを
  表示しても、そのコミットのWeb側の変更を確認したことにはならない
- GitHub Actionsのセルフホストランナー化は対象外

## 実接続の記録

2026-10-07、yoteiflow（Xcode 27.0・iPhone 17 / iOS 27.0 Simulator）で実施した。

| 依頼 | 結果 |
| --- | --- |
| `develop`の先端（`bbb6a128b3cb`）を`build` | `succeeded`。64ファイルのSwiftCompileを経て`** BUILD SUCCEEDED **`（約17秒） |
| 意図的に型エラーを入れたコミット（`0f6dbdee3022`。サブPCの一時クローンのみ・未push） | `failed`／`failedStage=build`／終了コード65。`WebViewModel.swift:763:29: error: cannot convert value of type 'String' to specified type 'Int'`を抜粋して返し、`nextAction=fix_and_recheck` |
| その修正コミット（`bec59357e06d`） | `succeeded`。`verifiedSha`が修正コミットと一致 |

いずれもMacの`~/apps/yoteiflow`は依頼前と同じブランチ・未コミット変更なしのままだった。最初の依頼は
Mac側スクリプトがbash 3.2の空配列展開で落ち、依頼側は`interrupted`（成功にも失敗にもしない）として
返した。直したうえで`--retry`で別ジョブとして再実行している。

## 残っていること

- Issue詳細・PR欄での状態と検証SHAの表示（#4140。いまはセッションのステップ「iOS検証中」と、GitHub上のcommit statusで見る）
- yoteiflowは`required=true`にした（#4141。無人実行のPRもサブPCの自動巡回が検証する）。**yoteiflowの`develop`の必須チェックへ`issue-deck/ios-precheck`を足す設定変更は人が行う**。足すまでは自動マージを止めない
- yoteiflowへのテストTargetの追加（guchi-apps/yoteiflow#1159）。追加されるまでは「ビルド成功・自動テスト未設定」になる
- kurashio・aide・morrowは未設定（`scripts/ios-precheck.conf`へ足し、1回`run`を通してから使う）


## PR更新後の自動検証・修復（#4186）

サブPCのpollerは、通常ジョブの払い出しがなく、起動枠・メモリに余裕があるとき、既定5分間隔で
`scripts/ios-precheck-sweep.mjs`を別プロセスで起動する。専用flockを検証・修復終了まで保持し、
再起動でも二重起動しない。稼働中はローカルの同時実行数に1本として数える。運用するpollerホストは1台にする。

- 設定済みかつ`required=true`の同一リポジトリにある、非draftの`issue-N`または`release/vX.Y.Z` → `develop`が対象。
  コンフリクト・判定中・PRの`00.check-user`・実装セッション稼働中は次巡へ回す。forkとmain向けは対象外。
- 最新HEADの`issue-deck/ios-precheck`が成功済みならスキップ。未検証・失敗は既存コマンドへ渡す。
  決定的なジョブIDを再利用するため、SSH切断や待ち時間切れの後も同じMacジョブの結果へ再接続する。
- ビルド／テスト失敗は、共通のAI実行プロバイダーとワークフロー用モデル設定で隔離worktreeの修復を起動する。
  修正対象は`ios/`以下のSwiftファイルのみ。依存・Xcode設定・仕様変更が必要なら人へ渡す。
  最大3回まで試し、commit/pushはラッパーが所有する。push直前にもPRのHEADを照合し、通常pushのみを使う。
- 修正後の新SHAは次の巡回でMac検証する。古いSHAの成功を新SHAへ転記しない。
- 環境障害、修正不能、上限、中断した修正は停止する。共通設定のエージェント一時停止中も新規起動しない。
  設定APIが旧版で停止状態を取得できない場合も起動しない。

状態は最新SHAのcommit statusに「検証中」「自動修正中」「成功」「手動確認が必要」などを出す。
詳細な停止理由・試行回数は`~/.local/state/issue-deck/ios-automation/<owner>--<repo>-<PR番号>.json`、
巡回ログは同ディレクトリの`sweep.log`、修正ログは`<owner>--<repo>-<PR番号>-repair.log`に残る。
`ISSUE_DECK_IOS_AUTOMATION_STATE`で配置先を変更できる。ログにはソースの抜粋が含まれるため公開しない。

導入には、この変更を含むサーバーの公開と、サブPCのissue-deckチェックアウト更新・poller再起動が必要。
MacのSSH・Xcode・gh認証・対象リポジトリの`local-repos.conf`・選択されたAI CLIの認証は既存のものを使う。
新しい依存パッケージやMac用常駐サービスは不要。`ISSUE_DECK_IOS_SWEEP_INTERVAL_SECONDS=0`で新規巡回を停止できる
（既に動いている検証・修復は終了まで続く）。

停止からの復旧は、原因を解消し、まず手動`run --retry`で同じSHAの成功を確認するか、修正コミットをpushする。
同じSHAの手動成功も次巡が認識する。修正上限を明示的にリセットする場合は、巡回を停止して実行が終わってから
対象PRの状態JSONだけを退避し、巡回を再開する。全PRの状態を一括削除しない。

リリースバンプの競合はサーバーの既存conflict-sweepが`claude-pr-repair.yml`へ渡す。
PRラベル`00.check-user`を尊重し、自動試行はPRあたり1回に制限する。未解消なら既存の手動修復ボタンから再開する。
通常のissueブランチの経路・main向けPRの手動操作・マージ条件は変えない。

自動化の検証はモックを使うテストとローカルgitで行う。実際のサブPC→Mac→修復AIの無人往復は導入後に確認する。
