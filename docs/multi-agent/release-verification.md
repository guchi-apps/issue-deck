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
- **AIのLGTMだけで自動マージはしない。** 最終承認は従来どおり人
- 強制は`src/lib/release-verification-config.ts`のリポジトリ別`enforced`で切り替える。**検証の実行経路が配布されるまで`false`**（未配布を導入済みと扱わない）

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

PC（リリースPR詳細。`GET /api/repositories/release/verification`）とスマホ（リリースシート。`GET /api/repositories/release`の`releasePullRequest.verification`）で
同じコンポーネント（`release-review-sections.tsx`）が「個別PRレビュー／統合検証／全体レビュー」を並べる。個別PRレビューは既存の「今回反映する内容」（`useReleaseChanges`）の集計で、
他の2区分の結果で置き換えない。凍結ブランチ（`release-main/*`）のリリースPRにだけ出す。

**修正導線**: リリースブランチは直接書き換えない。指摘が出たら、developへ修正を入れてから既存の「修正を入れて作り直す」（`release-rebuild`・#3014）へ進み、
作り直しで変わったbase/head SHAに対して統合検証・全体レビューをやり直す（古いSHAの結果は「古い結果」になり流用されない）。CI失敗・コンフリクトは従来どおり`reusable-claude-pr-repair`の修復ボタン。

## 既存検証の棚卸し（重複実装しない）

- `ci.yml`: `lint-and-build`・`docs-sync-check`・`workflow-expression-length-check`（`scripts/ci/run-required-checks.mjs`）。リリースPRのheadに対するCIは、同じSHAなら統合検証の証跡として再利用する（PR2で実装済み）
- Mac検証: `ios/scripts/remote-build-check.sh`（#3846・PR #4214）は署名なしビルドのみ。**ビルド成功を実機確認・TestFlight配布成功と混同しない。** 同じbase/head SHAに紐づけて接続済み（PR2）

## 残作業

- PR2（#4237）・PR3（#4238）: 完了。`enforced`はまだ`false`のまま（運用検証後に別途有効化）
- 手作業: 他リポジトリへの配布・必須チェック設定・代表例の運用検証（別Issueで追跡）
