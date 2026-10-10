# リリース前の統合検証と全体AIレビュー（#4212）

**いつ読むか**: develop→mainのリリースPR（`release-main/vX.Y.Z`）を本番へマージする前の検証・レビューの仕組みを触るとき。

個別PRのレビュー（develop向けPRの自動レビュー）に加えて、**固定したリリース内容そのもの**に対する検証を足す。
段階的に入れており、**現在入っているのはPR1（土台）だけ**。実行する経路はまだ無いため、強制は全リポジトリで無効。

## 3つの区分と責務

| 区分 | 何を見るか | 担当 | 状態 |
| --- | --- | --- | --- |
| 個別PRレビュー | develop向けPR単位の差分 | 既存の自動レビュー（#4092の「記録なし」判定を含む）。**置き換えない** | 既存 |
| 統合検証 | mainへ統合した状態のビルド・自動テスト | `kind=integration`（PR2で実行経路） | 記録と判定のみ |
| リリース全体レビュー | 差分全体の矛盾・退行・設定不足 | `kind=ai_review`（PR3で実行経路） | 記録と判定のみ |

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

認証は`POST /api/progress`と同じ共有シークレット。`action`は`request`（行を作る）・`report`（結果を記録。依頼の無い対象には書かない）・`status`（現在のSHAでのゲート判定）。

## 既存検証の棚卸し（重複実装しない）

- `ci.yml`: `lint-and-build`・`docs-sync-check`・`workflow-expression-length-check`（`scripts/ci/run-required-checks.mjs`）。リリースPRのheadに対するCIは、同じSHAなら統合検証の証跡として再利用する（PR2）
- Mac検証: `ios/scripts/remote-build-check.sh`（#3846・PR #4214）は署名なしビルドのみ。**ビルド成功を実機確認・TestFlight配布成功と混同しない。** 同じbase/head SHAに紐づけて接続する（PR2）

## 残作業

- PR2: 統合検証ジョブ（`DispatchJob`の新種別・poller）、既存CI証跡の再利用、iOSのMac検証の接続、リリースPR作成後の依頼ステップ
- PR3: 全体AIレビューの実行、リリース画面（PC・スマホ）の3区分表示、AIモデル画面への表示、修復導線への接続
- 手作業: 他リポジトリへの配布・必須チェック設定・代表例の運用検証（別Issueで追跡）
