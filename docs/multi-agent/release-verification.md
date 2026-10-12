# リリース前の統合検証と全体AIレビュー（#4212）

**いつ読むか**: develop→mainのリリースPR（`release-main/vX.Y.Z`）を本番へマージする前の検証・レビューの仕組みを触るとき。

個別PRのレビュー（develop向けPRの自動レビュー）に加えて、**固定したリリース内容そのもの**に対する検証を足す。
段階的に入れた（PR1＝土台 #4219、PR2＝統合検証 #4237、PR3＝全体AIレビューと画面 #4238）。**強制（`enforced`）は運用検証が済むまで全リポジトリで無効**で、画面は表示のみ。

## 3つの区分と責務

| 区分 | 何を見るか | 担当 | 状態 |
| --- | --- | --- | --- |
| 個別PRレビュー | develop向けPR単位の差分 | 既存の自動レビュー（#4092の「記録なし」判定を含む）。**置き換えない** | 既存 |
| 統合検証 | mainへ統合した状態のビルド・自動テスト | `kind=integration`（PR2） | 実行経路あり |
| リリース全体レビュー | 差分全体の矛盾・退行・設定不足 | `kind=ai_review`（PR3） | 実行経路あり |

AIレビューはテスト実行の代わりにしない。個別レビューの判定を転記して「全体レビュー済み」にもしない。

## 記録（`ReleaseVerification`）

対象キーは**リポジトリ・PR番号・baseSha・headSha・種別**。main更新・head更新・作り直しでSHAが変われば別の行になり、
古い行は現在の対象に流用されない（判定側が「対象変更による無効」にする）。同じ対象への依頼は一意制約で重複しない。

状態は`not_run / waiting / running / passed / failed / needs_check / not_applicable`。
`passed`でも`unverifiedScope`（確認できなかった範囲）が空でなければ`needs_check`として扱い、通常の準備完了にしない。

## マージ判定（`src/lib/release-merge-gate.ts`）

画面とマージAPIが同じ純関数を使う。結果は`ready`／`needs_confirmation`／`blocked`／`not_enforced`。

- **`POST /api/issues/pull-request-merge`のゲートは、base=main・head=`release-main/v*`のPRにだけ掛ける。** develop向けPR・知見昇格PR等は従来どおり。
  マージ直前にGitHubからbase/headを取り直して記録のSHAと突き合わせ、`mergePullRequest`へexpectedHeadShaを渡す
- `blocked`（失敗・未実施・実行中・古い結果）は確認済みにできない。`needs_confirmation`だけが`acknowledgeVerification: true`で通れる（サーバーログに残す）
- **判定の完了待ち（#4354）。** 統合検証・全体レビューが`waiting`／`running`のあいだは、**`enforced`に関わらず**マージAPIが409（`release_verification_pending`）で止める。
  結果（失敗・要確認・古い結果）では止めず、記録が無い（依頼されていない）ものも待たない。報告が来ず待ちのまま止まった場合は`acknowledgeVerification: true`で上書きできる（サーバーログに残す）。判断は`evaluateReleaseVerificationWait`
- **「mainへマージ待ち」は検証が揃ってから出す（#4390）。** 判定の正は`src/lib/release-candidate-status.ts`の1か所で、
  ブランチ画面（畳んだ行・束の見出し・「手が要るもの／待てば進むもの」）、マージボタン、ヘッダーのリリース状況
  （`release-button-status.ts`の`isWaitingUserMerge`）、反映待ち件数・通知ベル（`release-pending-merges`）、本番マージ待ちPush
  （`release-merge-push.ts`）が同じ判定を通す。材料はPR一覧の`releaseChecks`（`fetchReleaseChecks`。DBのみ）で、
  **`enforced`でないリポジトリのリリースPRにも載せる**（完了待ちが強制の有無に依らないため。PR一覧の2枠だけは従来どおり強制時のみ）
  - 実行中・待機中 → 「リリース検証中」「リリース検証待ち」（待てば進む）。マージボタンは「検証の完了待ち」で無効（#4354と同条件）
  - 失敗／設定不足（`describeIntegrationSetupGap`）／要確認／対象変更で無効／未実施（強制時のみ）／取得不能 → 理由付きの問題（手が要る）。
    結果ではボタンを止めない（禁止・例外確認は既存ゲートのまま）
  - 見出しはPR一覧の更新周期に従う。検証の詳細枠（5秒間隔）が状態の変化を見つけたらブランチ画面の再取得を促して揃える
- **AIのLGTMだけで自動マージはしない。** 最終承認は従来どおり人
- 結果による強制は`src/lib/release-verification-config.ts`のリポジトリ別`enforced`で切り替える（上の完了待ちは対象外）。**検証の実行経路が配布されるまで`false`**（未配布を導入済みと扱わない）

### ゲートが及ばない経路

- `deploy-recovery-series-run.ts`の復旧PR自動マージ: 通常のリリースPRではなく、#4006の機械検証が別にある。対象外
- GitHub画面での直接マージ: このAPIを通らないので止められない。**必須チェックの設定で補う**（配布の手作業Issueで追跡し、未設定のリポジトリは「未導入」と明示する）

## API（`POST /api/dispatch/release-verify`）

認証は`POST /api/progress`と同じ共有シークレット。`action`は`request`（行を作り、統合検証のジョブも積む。#4237）・`report`（結果を記録。依頼の無い対象には書かない）・`status`（現在のSHAでのゲート判定）。

## 統合検証の実行（#4237・PR2）

- `request`を受けると`requestReleaseVerifyJob`（`src/lib/dispatch/release-verify-jobs.ts`）が`DispatchJob`（`RELEASE_VERIFY`）を積む。
  `activeKey`は`release_verify:owner/repo#PR@base:head:integration`。PR番号・base/head SHAは`PR_REVIEW`と同じ専用列で、`issueNumber`はPR番号の埋め草。
  対象が変わると古い待機中ジョブは取り消し、旧SHAの結果は`viewReleaseVerifications`が「対象変更による無効」にする
- **実行内容はサーバー設定が正。** `release-verification-config.ts`の`integrationCommands`（と`macBuildCheck`）をジョブ表示の`releaseVerify`としてpollerへ渡す。
  **コマンドの無い・対象外理由のあるリポジトリはジョブを積まず`not_applicable`（理由付き）で記録**する（他リポジトリへ`pnpm`前提を流用して誤った成功を出さない）
- サブPCのpoller（`DISPATCH_POLLER_VERSION=35`以降・`releaseVerify`を申告）が`scripts/run-release-verify.sh`をtmuxで起動する。
  mainの先端へリリースheadをマージした一時worktreeで、コマンドを順に実行する。競合・失敗は`failed`、完走は`passed`
- 既存CI（`ci.yml`のhead SHA成功）は証跡URLとして再利用するが、統合状態のビルド・テストの代わりにはしない。サマリは実施／未実施／対象外を行ごとに残す
- Mac検証: `ios/`に差分があるときだけ`ios/scripts/remote-build-check.sh`を実行する。差分なしは対象外、スクリプト無し・Mac未接続は**成功にせず`unverifiedScope`付きの`passed`（＝要確認）**
- 結果は`/api/dispatch/report`の`releaseVerification`として届き、記録先はジョブの対象で決まる（ランナーは別の対象へ書けない）。完走しても結果が無ければ`failed`
- リリースワークフロー（`reusable-release-develop-to-main.yml`）がPR作成直後に`request`を送る。ベストエフォートで、依頼できなくてもPR作成は止めない。**配布先へはタグを配るまで届かない**

## 全体AIレビューの実行（#4238・PR3）

- `request`は統合検証と並べて`requestReleaseReviewJob`（`src/lib/dispatch/release-review-jobs.ts`）も呼び、`DispatchJob`（`RELEASE_REVIEW`）を積む。
  `activeKey`は`release_review:owner/repo#PR@base:head`。積めない理由（能力ホスト無し・Codex未対応）は**`ai_review`を`failed`（理由付き）で記録**する
- **担当は`resolveReleaseReviewAssignee`（`src/lib/release-review-assignee.ts`）。** 設定の「アプリ内AI：原因診断・新規アプリ相談」（`appAiModelReasoning`）に従い、
  OpenAI系ならCodex、それ以外はClaude Code。AIモデル設定画面は同じ関数で実効担当を表示する。モデルは`DispatchJob.claudeModel`／`codexModel`に載り、結果の`agent`（`claude:opus`など）として記録される
- サブPCのpoller（`DISPATCH_POLLER_VERSION=36`以降・`releaseReview`を申告→`DispatchHost.releaseReviewCapable`）が`scripts/run-release-review.sh`をtmuxで起動する。
  `base...head`の差分を読み取り専用のAI（Claudeは`Read`・`Grep`・`Glob`のみ許可）へ渡す。**差分は予算（既定300KB）の範囲でファイル単位に詰め、載せられなかったファイルは確認できなかった範囲として報告する**
  （`totalFiles`・`reviewedFiles`はスクリプトが確定し、AIの自己申告に任せない）
- 結果の正規化（`src/lib/release-review-result.ts`）: **指摘が1件でもあれば`needs_check`、確認範囲が足りなければ未確認範囲つきの`passed`（判定側が理由付きの`needs_check`へ読み替える）。**
  AIが問題なしでも指摘・未確認が無い場合だけ`passed`。`failed`はレビューを完走できなかったときだけ。結果には対象SHA・担当AI・指摘・影響PR・影響ファイルを残す
- **AIのLGTMだけで自動マージはしない。** マージは従来どおり人で、`needs_confirmation`は理由付きで既存の明示確認フローへ渡る

## リリース画面の3区分

PC（リリースPR詳細）・スマホ（リリースシート）・**本番マージの確認ダイアログ**（#4277）で、同じコンポーネント
（`release-review-sections.tsx`の`ConnectedReleaseReviewSections`）が上から「全体レビュー／統合検証／個別PRレビュー」を並べる。
**並びは表示の優先順位で、実行順序や依存関係ではない。** 全体レビュー（AIによるリリース差分全体の確認）と統合検証（mainへ統合した状態の
ビルド・自動テスト。AIではない）は互いを代替せず、個別PRレビューは既存の「今回反映する内容」（`useReleaseChanges`）の集計で、
他の2区分の結果で置き換えない。凍結ブランチ（`release-main/*`）のリリースPRにだけ出す。

**PCのリリースPR詳細（本番PR詳細）だけは並べ方が違う**（#4428）。正式タイトルの後に「現在の状態と次の操作」→「現在候補の検証」
（6チェック＋3区分）→「今回リリースする変更」→修正履歴→既存のバッジ・本文・コメント（詳細・履歴）の順に置き、主操作
「本番公開へ進む」は既存の本番マージ確認を通る。部品は`release-pull-request-overview.tsx`で、要約・今回の変更・履歴は
`release-fix-panel.tsx`の`useReleaseFixOverview`と分割した部品を並べ替えて使う（判定は`describeFixOverview`のまま）。
修正→取り込み→再検証→公開の工程は修正系列があるときだけ出す。ブランチ画面は開いたリポジトリの先頭に「次のリリース」
カード（本番稼働中・次のバージョン・反映PR件数、状態・主操作・検証）を置き、束の見出しからは操作と検証を外し、作り直し履歴を流れ図の下へ移した。

- **形式**: どの区分も「見出し＋短い説明＋状態の1行」。閉じたままで状態・現在の工程・経過時間・指摘の有無と短い理由が読め、
  総評・指摘・実施内容・証跡・PR別の一覧は開いて読む。未実施・待機・取得失敗を緑や「問題なし」にしない
- **確認ダイアログ**: 旧「マージ前の確認」と「このリリースに含まれる変更」の独立した枠は出さず、「リリースの検証」1枚に
  まとめる。CI・コンフリクトは枠の末尾の1行（`buildCiConflictRows`）、変更一覧は個別PRレビューを開いた中。旧「Claudeのレビュー」行は
  個別PRレビューへ統合した（判定の材料は区分と同じ各PR本文）。旧世代のリリースPR（head=develop）は従来の表示のまま
- **取得**: `GET /api/repositories/release/verification`と`GET /api/repositories/release/changes`を部品自身が取り、待機・実行中は5秒間隔、
  取得に失敗しても間隔を空けて取り直す。「更新」で両方を取り直す。スマホのシートも同じ取得を使う

### 全体レビューの指摘と実行失敗の区別（#4300）

`ai_review`の**指摘（コードへの問題）**と**実行失敗（レビューを最後まで行えなかった）**は別物として扱う。

- 指摘: `findings`に重要度・概要・影響・根拠・推奨対応・ファイル／行・関連PRを持ち、画面は件数と最重要の題を閉じたまま、詳細を開いて出す。要修正は従来どおり「developへ入れて作り直す」
- 実行失敗: `state=failed`のとき、`findings.diagnostic`（`stage`・`cause`・`exitCode`・機密除去済み`excerpt`・対象base/head SHA）を持つ。画面は「レビュー未完了」と出し、失敗した工程・確認できた原因・次の操作・エラー抜粋（tmuxが無くても読める）を示す。**作り直しは勧めず、「全体レビューを再実行」が主導線**
- 原因（`cause`）は`launch_failed`（終了コード126/127・CLI無し）／`auth_failed`（ログに認証エラー表示）／`timeout`（124/137）／`parse_failed`／`target_missing`／`no_host`／`unknown`。**観測できた事実だけで決め、決められなければ`unknown`（原因未特定）**。126だけから権限問題などと断定しない
- 診断は対象SHA付きで保存し、現在のSHAと一致するものだけを表示する（旧実行の原因を現在の結果に見せない）。機密は実行側（`scripts/run-release-review.sh`の`diag_redact`）とサーバー（`redactDiagnosticText`）の両方で伏せ、末尾30行・2000文字までしか持たない。生ログ全文は出さない
- 再実行: `POST /api/repositories/release/review-rerun`。ガードは作り直しと同じ（`previewModeGuard`→`requireUserId`→リポジトリ所有確認）。対象はサーバーが今のリリースPRから解決し、クライアントのSHAは一致確認だけに使う。`activeKey`で実行中・待機中の二重起動を防ぎ、積めたときだけ`ai_review`を`waiting`へ戻して旧診断・指摘を消す

### 進捗（#4277）

結果（`ReleaseVerification`）とは別に、**現在の対象（base・head）の**最新ジョブ（`DispatchJob`）から進捗を作る
（`lib/release-verification-progress.ts`・`release-verification-load.ts`）。対象の違うジョブは見ないので、作り直す前のSHAの
工程・成功を現在の進捗に見せない。**進捗はゲートの判定に使わない**（記録が`waiting`でジョブが`RUNNING`なら表示だけ「実行中」）。

- **工程**: 実行側（`run-release-verify.sh`・`run-release-review.sh`）が`running`報告に`progress: { step, plan, index, command?, files? }`を載せ、
  `/api/dispatch/report`がジョブの種別に合う工程名だけを通して`DispatchJob.progress`へ保存する。統合検証は準備→統合→検証コマンド
  （文字列からinstall＝依存関係取得・test＝テスト・build＝ビルド、他は「検証コマンド」）→Mac検証、全体レビューは準備→差分取得→AIレビュー→結果整理。
  生存報告は別プロセスなので、現在の工程はファイル（`scripts/lib/release-progress.sh`）経由で渡す
- **待機理由**: `QUEUED`は実行先の`lastSeenAt`でオフライン／順番待ち、`CLAIMED`は起動準備中。ホストの記録が無ければ「未取得」と出し推測しない
- **停止**: 最後の報告から`DISPATCH_HEARTBEAT_TIMEOUT_MS`（10分）を過ぎたら「応答なし」にしてアニメーションを止める。取り消し・
  結果なしの終了は「中断」
- **出さないもの**: 百分率・残り時間（総量が分からない工程に経過時間から割合を当てない）、出力・ログ。終了後の「確認した範囲」は実行中の進捗と別に出す

**修正導線**: リリースブランチは直接書き換えない。指摘が出たら、developへ修正を入れてから既存の「修正を入れて作り直す」（`release-rebuild`・#3014）へ進み、
作り直しで変わったbase/head SHAに対して統合検証・全体レビューをやり直す（古いSHAの結果は「古い結果」になり流用されない）。CI失敗・コンフリクトは従来どおり`reusable-claude-pr-repair`の修復ボタン。
**手動で作り直す代わりに、画面から修正Issueを起案して作り直しまで自動で進める経路が次節の修正系列（#4317）。**

## PRの6チェック表示とMac検証の独立記録（#4366）

PR詳細・PR一覧・ブランチ画面・本番マージ確認の一覧は、同じ6項目を同じ順で出す（`src/lib/pull-request-merge-checks.ts`・`src/components/dashboard/pull-request-merge-checks.tsx`）: **CI／コードレビュー／コンフリクト／全体レビュー／統合検証／Mac検証**。#4305の5項目にあった計画レビューはPRのチェックに含めない（Issue側の計画レビューは別機能として残る）。

- **個別PRの項目**（CI・コード・コンフリクト）は`PullRequestSummary`（本番マージ一覧は`ReleaseChangePullRequest`）から作る。headが進んだレビュー判定は「無効」、取れなかったものは「取得不可」で、成功へ倒さない。
- **共通結果の項目**（全体・統合・Mac）はリリース候補（base=main・head=`release-main/v*`のopenなPR）の結果。`GET /api/repositories/release/candidates`が候補ごとのコミット範囲に含まれるPR番号と検証要約を返し、`src/lib/release-candidate-checks.ts`が対象を決める。**含む候補が無ければ「リリース未作成」の理由付き未実施**で、無関係な最新候補の結果は使わない。複数候補に含まれるときは新しい候補が既定で、詳細から選べる。判定対象は常に候補PR・head SHAを添える。表示のために検証は起動しない（読むだけ）。
- **Mac検証は統合検証とは別の記録**。`ReleaseVerification`表へ`kind="mac"`で保存する（`src/lib/release-mac-verification.ts`。`kind`は文字列列でマイグレーション不要）。**マージゲートの種別（`RELEASE_VERIFICATION_KINDS`）には入れない表示専用**で、ゲート・待ち判定・依頼時の行作成は変わらない。ゲートへ入れるかは#4365と整合させて別途決める。
  - 統合検証ジョブ（`scripts/run-release-verify.sh`）が、結果JSONに`mac`（`state`・`summary`・`unverifiedScope`）を足して報告し、`applyReleaseVerifyReport`が統合検証とは別に記録する。**統合検証側の判定（Mac未接続の要確認・Mac失敗のfailed）は従来どおり**変えない。
  - 状態: 成功／失敗／実行中（統合検証の現在工程がMac）／対象外（`ios/`に差分なし、またはMac検証の設定が無いリポジトリ）／設定不足（スクリプト無し・Mac未接続）／未実施（記録なし。統合検証が先に失敗した場合や、`mac`を送らない旧版のランナーもここ）／古い結果（対象のSHAが違う記録）。**未実施を成功や対象外へ置き換えない。**

## 修正系列：起案から修正候補の再検証まで（#4317）

全体レビューの指摘・統合検証の失敗から**修正Issueを起案**し、修正PRのdevelop取り込み→候補の作り直し→新しいSHAでの再検証を追跡する。
**終点は「検証済み候補の準備完了（本番承認待ち）」。mainへのマージとデプロイは従来どおり人が承認する。**
記録は`ReleaseFixSeries`（修正Issue1件につき1行）。判断は純関数`src/lib/release-fix-series.ts`、外部操作は`src/lib/release-fix-series-run.ts`、画面は`release-fix-panel.tsx`。

- **起案**（`POST /api/repositories/release/fix-series` `action=create`）: 全体レビューの指摘は複数選択して**1件のIssueにまとめる**（共通原因を分割しない）。
  根拠は**サーバーが現在のSHAの記録から読み直す**（クライアントの内容は信用しない）。機密は`redactDiagnosticText`で除去し、元リリースPR・base/head SHA・種別・関連PR・修正後の検証条件をIssue本文へ引き継ぐ。
  本文先頭の`<!-- issue-deck-release-fix:<鍵> -->`が目印
- **二重起案の防止**: 鍵は「リポジトリ・リリースPR・base/head SHA・種別・指摘」から決め、進行中の系列は`activeKey`のユニーク制約で1本に絞る。同じ対象は既存の系列（Issue・修正PR・進捗）を返す。同時起案に負けたIssueは閉じる
- **区別**: 全体レビューの実行障害（`failed`）は起案しない（再実行が主導線）。統合検証の失敗は文面から実行障害（終了コード126/127・接続失敗・Mac/ホスト無しなど）と見分け、疑わしいときは再実行を先に勧める。**利用者が明示（「コードの修正として起案する」）したときだけ起案する**。仕様判断が要るときは判断内容を必須にし、`21.plan-required`を付けて**計画の承認を省かない**
- **取り込み**: 修正PRのマージは**既存の自動レビュー・マージ機構**が行い、系列は`issue-<番号>`ブランチのdevelop向けPRを観測するだけ（GitHubの保護は外さない）。修正PRがマージされずに閉じたら理由付きで止める
- **作り直し**: 同じリリースPRに結び付いた系列が**全部**マージ済みになったら後継候補を作る。**PRを選んだ作り直し（#4335）に対応したリポジトリでは、画面の手動選択と同じ`requestSelectiveRebuild`（`release-rebuild-selection-run.ts`）で、修正PR（＋確認済みの`acceptedExtraPrs`）だけを元の候補へ足す**。未対応のリポジトリは従来の`release-rebuild`（閉じてdevelopの最新で作り直す）。`rebuildClaimedAt`の条件付き更新と、作り直し依頼の`activeKey`で二重の作り直しを防ぐ
- **混入の防止**: 選んだ作り直しでは、選んでいないdevelopの変更は入らないので判断待ちにしない（下記「PRを選んだ作り直し」）。未対応のリポジトリだけ、**修正PR以外の変更が入っていたら自動では作り直さず、PR番号を示して`awaiting_decision`（判断待ち）で止める**。「無関係な変更も含めて作り直す」で確認した番号だけを`acceptedExtraPrs`に記録する
- **再検証**: 後継候補を検出したら`reverifying`。新しいbase/headの統合検証・全体レビューがどちらも成功したときだけ`ready`（本番承認待ち）。失敗・要確認は`stopped`にし、後継候補から再度起案すると**同じ系列の次の世代**になる（上限3世代・同一指摘の再発は理由付きで拒否）。後継候補がさらに更新・取消・マージされたら`superseded`にして誤った候補を追わない
- **巡回**: `scripts/subpc-dispatch-poller.sh`の`sweep_release_fix_series`（`DISPATCH_POLLER_VERSION=37`）が`POST /api/repositories/release/fix-series/sweep`を呼ぶ。進行はすべてDBの行にあり、再起動しても続きから進む。止まった・判断待ちのときは修正Issueへ理由をコメントし`00.check-user`＋`01.check-blocked`を付ける
- **画面**: 全体レビューの指摘・統合検証の失敗の下に「修正Issueを作成」、検証区分の下に「この候補への修正の進捗」（Issue作成→計画・実装→PR検証→develop取り込み→候補作り直し→再検証→本番承認待ちの現在地・関連リンク・停止理由・各SHA）。PC・スマホ共通の部品

## 修正の内部確認：1セッション内で往復し、修正PRを1件にまとめる（#4410）

修正Issueのセッション内で「実装 → 独立レビュー → 修正 → テスト」を繰り返し、**内部確認が完了してから**develop向けの修正PRを1件作る。
レビューのたびに修正Issue・PR・リリース候補が世代をまたいで増えるのを避ける。対象はリリース修正系列（`ReleaseFixSeries.internalReview=true`の系列。旧い系列は従来どおり）で、通常Issueの実装フローは変えない。

- **担当**: 実装は修正Issueのセッション。独立レビューは同じセッションが`Agent`ツールで呼ぶ**読み取り専用の別エージェント**（Claude Code標準の通信機構）。実装担当は合否を決めず、レビューの指摘と検証結果を報告APIへ書き写す。`tmux send-keys`・常駐の監督役は使わない
- **作業場所**: 元候補（凍結ブランチ）を一時worktreeへ取得し、修正を重ねた状態で確認する。developの最新は混ぜず、内部の往復では候補の作り直し・バージョン更新をしない（手順は修正Issue本文の「内部確認」節。`internalReviewSection`）
- **記録**（`ReleaseFixInternalRound`・`ReleaseFixFinding`）: 論理セッションは**リポジトリ＋修正Issue番号**で、再検証の失敗で世代が進んでも指摘・往復を引き継ぐ。指摘はサーバーが`F-001`から採番し、解消は根拠つき、再発は`reopenCount`で数える。中断・再起動しても同じ記録から再開する
- **報告API**（`POST /api/dispatch/release-fix-internal`、`scripts/report-release-fix-round.sh`）: `review`・`test`・`status`。認証は共有シークレット。**対象のSHAは受け取らず、サーバーが`issue-<番号>`ブランチのHEADから取り直す**。進行中の内部確認つき系列に結び付かない報告・整合しない報告（`pass`なのに未解決が残るなど）は記録しない
- **完了判定**（`evaluateInternalGate`）: 最新の往復で、独立レビューの実施・未解決指摘0件・必要テストの合格が**同じ対象SHA**に対してそろっているときだけ。レビューやテストの後に内容が変わると古い合格は使われない
- **PR作成**: `scripts/create-release-fix-pr.sh`が完了判定・push済みの内容との一致・開いているPRの有無を確かめ、満たさなければ作らない（再実行でも重複しない）
- **強制は取り込みの手前**: GitHub側のPR作成そのものはサーバーから止められない。そこで巡回（`sweepGroup`）が修正PRのhead SHAで同じ判定をし、**未完了または確認した内容と違うPRは候補の作り直しへ進めず`awaiting_decision`にする**（`decideReleaseFix`の`internalHold`）。確認が完了すれば次の巡回で自動的に進む
- **止める条件**（`decideInternalStop`）: 往復5回・経過120分・同一指摘の再発2回・未解決が減らない往復が2回続く。通常の指摘だけでは止めず、止めるときはIssueへ理由と必要な判断を残して`00.check-user`＋`01.check-blocked`を付ける（一度だけ）。判断が要る仕様変更・権限不足・外部作業は、セッションがIssueコメントで相談する
- **最終検証で追加修正が出たとき**: 元のPRはすでにマージ済みで足せない。既存の世代（`generation+1`）を使い、**同じ修正Issue・同じ`issue-<番号>`ブランチ・引き継いだ内部確認の記録**へ戻して追加PRを1件作る（Issueへ理由を記録。新しいIssueは作らない。Issueが閉じているときだけ新規）。前の世代が使ったPRは次の世代の修正PRとして拾わない
- **画面**: 修正パネルの現在状態の下に「内部確認」欄（レビュー・テストの状態、未解決指摘、往復と経過時間の消費。`ReleaseFixInternalReview`）
- **PR取り込み後**: 選択的取り込み・候補再構築・最終候補のSHAでの再検証・GitHub CI・本番マージを人が行う点は従来のまま

## リリース完了まで進める：候補の失敗から本番稼働確認まで（#4480）

リリース候補の失敗（全体レビューの指摘・統合検証の失敗）から、**一度の開始で修正・候補の作り直し・再チェック・
（許可した範囲の）本番マージ・deploy・稼働確認までを同じ論理系列が続ける**。記録は`ReleaseCompletionRun`
（世代ごとの`ReleaseFixSeries`を束ねる親）。判断は純関数`src/lib/release-completion.ts`、外部操作は
`src/lib/release-completion-run.ts`、画面は`release-completion-panel.tsx`（修正パネルの要約帯に入る。PC・スマホ共通）。

- **開始**（`POST /api/repositories/release/completion`）: 範囲は「チェック通過まで」（`until_ready`）か
  「本番反映・稼働確認まで」（`until_production`）を**開始者が必ず選ぶ**（省略不可）。開始できるのは、現在のSHAの
  検証に問題があるか修正系列の記録がある候補だけ（問題の無い候補は通常のリリース）。同じリポジトリで1本だけ
  （`activeKey`）。期限は24時間で延ばさない。開始者・範囲・期限は行に残し、本番マージの権限はこの記録だけで判定する
- **役割分担**: 世代の進行（修正PRの観測・候補の作り直し・再検証）は従来どおり`runReleaseFixSweep`が持つ。
  完了系列の巡回（`runReleaseCompletionSweep`）は**`ReleaseFixSeries`の状態を書き換えず**、次だけを行う
  - 修正Issueの起動（`enqueueDispatchJob`。同じ世代は1回だけ。起動から3時間修正PRが現れなければ止める）
  - 再検証で指摘・失敗が残った停止から、次の世代を起案する（`createReleaseFixSeries`。同じ修正Issueへ戻す既存の流れ・上限3世代・同一指摘の再発拒否をそのまま使う）
  - 修正系列が作り直した後継の候補へ追従する
  - 全部合格したら、`until_ready`は本番承認待ち、`until_production`は`decideCompletionMerge`で本番マージ（`release.md`「リリース完了系列に限り…」）
  - 本番反映後のdeploy追跡・稼働SHAの確認（#4007の`decideDeployRecoveryRelease`）。人がマージした場合も同じく追跡する
  - deployが再実行も失敗したら、本番復旧系列（`DeployRecoverySeries`）へ引き継ぎ（範囲は`until_production`なら`fix_until_main`）、その完了で系列も完了にする
- **区別**: 統合検証の失敗が実行障害（`classifyIntegrationFailure`）、全体レビューの失敗に指摘が無い（実行障害）ときは
  修正Issueを作らず止める。設定不足（Mac検証の`needs_setup`など）も止める。#4452の経路（選んだ修正での作り直し・
  履歴だけの差の反映）は修正系列がそのまま使い、「修正PRを足せない」停止は修正系列の再評価を待つ（理由を表示）
- **排他・冪等**: 巡回は`lastSweepAt`の条件付き更新で実行権を取る。二重起案は`ReleaseFixSeries.activeKey`、二重起動は
  `DispatchJob.activeKey`、二重マージは状態の条件付き更新とHEAD指定のマージが防ぐ。巡回は`hostName`を持つ
  `POST /api/repositories/deploy-recovery-series/sweep`に相乗りする（pollerは変更なし）
- **上限・停止**: 期限・費用上限（修正Issueのセッションの`SessionUsage.costUsd`合計。既定$30。API換算の目安）に
  達したら新しい起動・起案・マージをせず止める。停止（`DELETE`）後は巡回の対象から外れ、引き継いだ本番復旧も止める。
  止まったときは修正Issue（無ければ候補のPR）へ理由をコメントし、修正Issueに`00.check-user`＋`01.check-blocked`を付ける
- **画面**: 6段階（原因を調査中／修正とレビュー中／修正後のチェック中／本番へ反映中／稼働確認中／完了）の現在位置、
  世代・費用・許可範囲、原因・残り・操作の要否、詳細（修正Issue・修正PR・候補の変遷・対象SHA・承認）

## PRを選んだ作り直し（#4335）

「修正を入れて作り直す」は、元の候補（`release-main/vX.Y.Z`のhead）へ**選んだPRのdevelopへのマージ差分だけ**を
`cherry-pick -m 1`で足した状態からバンプする。以前はdevelopの最新を丸ごと取り込んでいたため、元の候補の後に入った
無関係な変更まで混ざっていた。GitHubのmerge APIで祖先ごと取り込む方式は、選んだ差分だけになる保証が無いので採らない。

- **画面**（`release-rebuild-button.tsx`・`release-rebuild-selection-list.tsx`。PC・スマホ共通）: 元の候補の後にdevelopへ入ったPRと
  当該リリースの修正PR（未マージを含む）を、番号・題・関連Issue・マージ／CIの状態つきで並べ、複数選べる。**既定は当該リリースの
  修正系列の修正PRだけ**で、無関係なPRは選ばない。未マージ・取り込み済みは理由を添えて選べない（developのレビュー・マージを省かない）。
  押す前に「追加される範囲」を出す
- **検証**（`release-rebuild-selection.ts`・`-run.ts`）: PR番号だけでなく、マージ済みか・base=developか・バンプPRでないか・
  マージコミットが選んだ時点と同じか・元の候補に既に含まれていないかを確かめ、元の候補のPR番号とheadと一緒に
  `rebuild_selection` inputとしてworkflowへ渡す。同じ元の候補（番号＋head）への起動は`ReleaseRebuildRequest.activeKey`で1本に絞る
- **workflow**（`reusable-release-develop-to-main.yml`の状態判定）: 元の候補が今も同じheadで開いているかを確かめ直し、PRを
  developへ入った順に当てる。マージコミットの件名がそのPRのものでなければ、既に元の候補にあれば、当てて競合すれば止める。
  競合したときは、元の候補の後に同じファイルを触ったPRを「先に必要な可能性があるPR」として示す。**選択は自動では広げない**。
  当てた結果の差分のファイルが、選んだPRのマージ差分の範囲に収まることも確かめる
- **後継の候補とバンプPRを分ける**: 「元の候補＋選んだPR＋版の書き換え」を後継の候補として`release-candidate/v新版`に置き、
  developへのバンプPRには**版の書き換えだけ**を当てる（候補ごとdevelopへマージすると、選んだPRの後にdevelopで同じ行を直した
  PRがあったとき衝突する）。バンプPR本文の`<!-- issue-deck-rebuild-candidate:<SHA> -->`から、マージで起きるrunが凍結点を
  この候補にする。**元の候補は後継のリリースPRを作れてから閉じる**（`<!-- issue-deck-rebuild-origin:#N -->`）ので、途中で失敗しても
  元の候補は残り、失敗の記録に選択が残る（リリース画面の「再開」は、同じ選択を現在の状態で検証し直してから起動する）
- 後継の候補のSHAで統合検証・全体レビューが走り直す（旧SHAの成功は流用しない）。本番mainへのマージは従来どおり人が承認する
- **未対応のcaller**（配布先の旧タグ）には選択を出さず、従来の作り直しだけにする（`releaseCallerSupportsSelection`がdevelopのcallerに
  `rebuild_selection`があるかを読む）。新規アプリの雛形（`src/lib/new-app/scaffold-workflows.ts`）は最初から対応している

## 全リポジトリへの展開と導入台帳（#4365）

**宣言はコード、状態は導出。** `release-verification-config.ts`が正本で、`RELEASE_VERIFICATION_REPOS`（検証コマンド・技術構成・前提不足`setupGaps`・Mac検証の有無と配布状況）と
`RELEASE_VERIFICATION_EXCLUSIONS`（アーカイブ・本番リリース経路なしの**根拠付き**対象外）を持つ。導入状態は`release-rollout.ts`が宣言と
`ReleaseVerification`・`DispatchHost`の申告から導く（新規テーブルは無い）。画面は設定＞フリート運用の「リリース検証の導入状況」（`GET /api/repositories/release/rollout`）。

状態（上ほど優先）: 対象外／未導入（管理対象なのに台帳が無い）／設定不足／配布待ち（実行できるホストの申告が無い・poller未対応）／検証待ち／検証済み（必須化待ち）／必須化済み。

- **設定不足を対象外にしない。** `not_applicable`はゲートで合格扱いになるため、根拠のある対象外（`RELEASE_VERIFICATION_EXCLUSIONS`・`integrationNotApplicableReason`）だけに使う。
  台帳に無い・コマンドが空・`setupGaps`がある場合、統合検証の依頼は**`failed`（理由付き）を記録してジョブを積まない**（`describeIntegrationSetupGap`）
- **Mac検証の前提**（`ios/scripts/remote-build-check.sh`の配布）は`describeMacSetupGap`。Linuxの統合検証は止めないが、導入状態は設定不足で、`enforced`にもできない（テストが守る）
- **`enforced`を立てる条件**: 設定不足が無く、実リリース候補で統合検証・全体レビューが合格し、ホストが申告している。1リポジトリずつ立て、全対象が揃うまで#4365は完了にしない

### 新規リポジトリを足すとき

1. 本番リリース経路（develop→main）があるか確認する。無ければ`RELEASE_VERIFICATION_EXCLUSIONS`へ**理由付きで**足す
2. 有るなら、そのリポジトリの`ci.yml`に合わせて`RELEASE_VERIFICATION_REPOS`へ宣言する（`integrationCommands`は各々単独の`bash -c`。pnpmの流用をしない。DB・環境変数が要るなら`setupGaps`へ書く。iOSがあれば`macBuildCheck`と`ios/scripts/remote-build-check.sh`の配布）
3. サブPCの`DispatchHost`にリポジトリを申告させ、poller（`releaseVerify`・`releaseReview`対応版）を更新する
4. 次のリリース候補で実走させて合格を確認し、`enforced: true`にする。台帳へ載せ忘れた管理対象は、導入状況の一覧に「未導入」として出る

## 既存検証の棚卸し（重複実装しない）

- `ci.yml`: `lint-and-build`・`docs-sync-check`・`workflow-expression-length-check`（`scripts/ci/run-required-checks.mjs`）。リリースPRのheadに対するCIは、同じSHAなら統合検証の証跡として再利用する（PR2で実装済み）
- Mac検証: `ios/scripts/remote-build-check.sh`（#3846・PR #4214）は署名なしビルドのみ。**ビルド成功を実機確認・TestFlight配布成功と混同しない。** 同じbase/head SHAに紐づけて接続済み（PR2）

## 残作業

- PR2（#4237）・PR3（#4238）: 完了。`enforced`はまだ`false`のまま（運用検証後に別途有効化）
- 修正系列（#4317）: 実行障害の統合検証の再実行導線、PC/スマホの実機確認（修正だけを選んで適用する仕組みは#4335で実装）
- 手作業: 他リポジトリへの配布・必須チェック設定・代表例の運用検証（別Issueで追跡）

## 統合ビルドの検証用環境（#4331）

IssueDeckの `pnpm run build:ci` / `pnpm build:ci` は、更新済みサブPCの
`run-required-checks.mjs --group lint-and-build --check build` を統合worktree内で実行する。
ビルド用envは通常CIと同じ `ci/required-checks.json` の `build.env` が正本で、
ビルド子プロセスだけへ適用する。本番用の秘密鍵や `.env` はコピーしない。
テスト・報告処理・他リポジトリのコマンドは従来どおりで、この設定を適用しない。
検査IDが欠落・重複した場合は終了コード2、ビルド失敗は1となり統合検証を失敗にする。

配布はdevelopへマージ後にサブPCの「更新して再起動」で行う。サーバーの本番反映や
リリース候補の作り直しを待たず、既存候補を再実行できる。実行対象は要求された
base/headの統合状態のまま、通常CIのビルド定義は更新済み実行側から読む。
この成功は本番認証の疎通確認やMac検証の成功を意味しない。
