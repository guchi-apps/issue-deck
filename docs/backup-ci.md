# バックアップCI（GitHub Actions障害時のCircleCI）

いつ読むか: GitHub Actionsのジョブが開始されない・止まっていて、develop向けPRの検証を続けたいとき。
バックアップCIの設定・必須チェックの移行・ロールバックを触るとき。

起点: #4065。**初期導入の対象は`guchi-apps/issue-deck`のdevelop向けPRだけ**（main向け・リリース・
本番デプロイの代替、他リポジトリへの展開、障害の自動判定・自動切替は対象外）。

## 1. 全体像

```
通常時:  PR ──push──▶ GitHub Actions（ci.yml）──▶ lint-and-build 等 ──▶ 必須チェック
障害時:  PR詳細「バックアップCIで実行」──▶ issue-deck ──CircleCI API──▶ CircleCI（.circleci/config.yml）
                                              ▲   完了Webhook／pollerの巡回で照合        │
                                              └──────────── 結果（ci-result.json）◀──────┘
                                              └──▶ commit status `issue-deck/ci-gate`
```

- **検査の中身は1か所**（[`ci/required-checks.json`](../ci/required-checks.json)）。Actionsはジョブごとに
  `node scripts/ci/run-required-checks.mjs --group <ジョブ名>`、CircleCIは`--all`で同じ定義を実行する。
  lint・型チェック・単体テスト・ビルドに加え、SQL引用符・ドキュメント同期・workflow権限/構文・
  ローカル起動契約・テンプレート同期・CI定義同期まで含む。通知だけのジョブ（`workflow-drift-notice`・
  `notify`）は定義に入れない
- 定義とワークフローのずれは`scripts/ci/check-ci-definition-sync.mjs`（必須検査の1つ）が落とす。
  **ci.ymlへ直接検査ステップを足すと、このチェックが失敗する**
- 状態の正本はissue-deckの`BackupCiRun`（`prisma/schema.prisma`）。起動時にPRのhead/base SHA・baseの
  検査定義のダイジェスト・開始者を記録し、完了時にCircleCIの結果をこの記録と突き合わせる
- コードは`src/lib/backup-ci/`（`state.ts`が判定の純関数、`service.ts`が起動・回収・発行、
  `circleci-client.ts`がAPI）、画面は`src/components/dashboard/pull-request-backup-ci.tsx`

## 2. 安全のための約束（変えるときは#4065を読み直す）

| 約束 | どこで守っているか |
|---|---|
| 通常のpush/PRでCircleCIは走らない | `.circleci/config.yml`のワークフローは`backup_ci`パラメータが真のときだけ。CircleCIプロジェクトにpush/PRのトリガーを作らない（4章） |
| PR内の変更で検査を省けない・手順を変えられない | 起動時に`config.branch`へPRのbase（develop）を渡す。ランナーと定義は`base_sha`の版を`git show`で取り出して使う。issue-deckは結果のダイジェストをbaseの定義と照合する |
| headだけの検査で代用しない | baseへheadを`--no-ff`でマージした結果を検査し、検査したコミットの親が`[base, head]`であることを確かめる |
| 起動後に先端が動いても取り違えない | ブランチ名ではなく要求したSHAを`git fetch`して検査する。完了時にPRの現在のhead/baseと比べ、違えば`superseded` |
| head/baseが更新されたら合格を流用しない | 巡回（約30秒ごと。合格は3分おき）が合格済みの実行もPRと照合し、変わっていれば無効にして共通チェックを`pending`へ戻す |
| 不明・timeout・キャンセル・検査欠落を成功にしない | `evaluateBackupCiResult`・`decideCiGateFromBackupRun`。90分で`unverifiable` |
| 応答不明の起動要求を再送しない | `trigger_unknown`で止める。利用者がCircleCIの画面で確かめてから再実行する |
| 二重に採用しない | 未完了の実行はPRごとに1件（`activeKey`の一意制約）。共通チェックはPRで最新の試行からしか発行しない |
| 偽のWebhookで合格を作れない | `circleci-signature`をHMAC-SHA256で検証。本文の状態は使わず、APIで照合し直す。イベントIDで重複排除（`CircleciWebhookDelivery`） |
| テスト環境へ権限を渡さない | CircleCIプロジェクトにContext・環境変数を設定しない。検査はプレースホルダ値で動く。マージ・共通チェックの発行はissue-deckのGitHub Appだけが行う |

## 3. 画面

PR詳細（develop向けの未マージPR）の「バックアップCI（GitHub Actions障害時）」。

- 1行目は**元のGitHub Actionsの状態**（ジョブ未開始／待機中・実行中／成功／失敗）。共通チェックとは
  別に出し、Actionsの履歴は消さない
- 2行目がCircleCIの最新の実行（`CircleCIで代替実行中`／`バックアップCI成功`／`失敗`／`結果確認不能`／
  `PRが更新されたため無効`）。ログはCircleCIのワークフロー画面へのリンク
- 開くと、head/base・検査したコミット・検査定義の版・共通チェックの発行状況・検査ごとの結果と、
  「バックアップCIで実行」ボタン（押すと対象のリポジトリ・PR・コミット・実行先を確認してから起動）
- 未設定・権限不足・無料枠不足など起動できない理由は、その場に必要な操作と一緒に出る
- 共通チェックが出ているPRでは、PR一覧・詳細のCIバッジは`issue-deck/ci-gate`の状態で決まる
  （止まったActionsのジョブが残っていても「実行中」のままにならない。`src/lib/github/check-rollup.ts`）

## 4. 初期設定（1回だけ）

人の作業が要る。進め方は手作業Issue #4115 で追跡する。

1. **CircleCIのプロジェクト**: CircleCIのOrganizationへ`guchi-apps/issue-deck`を**GitHub App連携**で
   追加する。**トリガー（push・PR）は作らない**、または作られたものを削除する。パイプライン定義は
   `.circleci/config.yml`を指すものを1つだけ作り、そのIDを控える
   - OAuth連携のプロジェクトはpushのたびにパイプラインが作られる（ワークフローは`when`で0件になるが、
     画面に空のパイプラインが並ぶ）。GitHub App連携を使う
   - Project Settings > Environment Variables・Contextsは**空のまま**にする
2. **APIトークン**: CircleCIのPersonal API Token（またはProject API Tokenで`/pipeline/run`が通るもの）を
   発行し、1Password `op://apps/issue-deck/circleci-api-token` に保存する。サーバーの環境変数
   `CIRCLECI_API_TOKEN`として配る（`.github/secrets-manifest.tsv`へ行を足し、`scripts/sync-github-secrets.sh`）
3. **Webhook**: Project Settings > Webhooksで`https://<issue-deckのホスト>/api/webhooks/circleci`、
   イベントは`workflow-completed`。署名鍵はランダム値（`scripts/provision-secret.sh --generate hex32`）を
   `CIRCLECI_WEBHOOK_SECRET`として1Passwordとサーバーへ配り、CircleCIの画面にも同じ値を入れる。
   **Webhookが無くても結果はpollerの巡回で回収できる**（遅れるだけ）
4. **GitHub Appの権限**: issue-deckのGitHub Appへ**Commit statuses: Read and write**を足し、Organizationで
   承認する（未承認だと共通チェックの発行が403になり、画面に`publish_failed:403`と出る）
5. **issue-deckの設定**: PR詳細のバックアップCI欄「このリポジトリのバックアップCI設定」で、有効化・
   プロジェクトスラッグ（`circleci/<org-id>/<project-id>`）・パイプライン定義IDを保存する
6. **試験**: 7章の定期確認を1回行う

### 無料枠の制約

- CircleCI Freeプランは月ごとのクレジット制。`resource_class: large`で1回あたり十数分（ビルド・単体テスト込み）を
  使う。障害時だけ起動する前提で、平常時の試験は月1回程度に抑える
- クレジットが尽きると起動がCircleCIに拒否され、画面に「無料枠（クレジット）が不足している可能性」と出る。
  **有料プランの契約・課金の自動開始はしない**（必要なら人が判断する）
- `large`が使えないプランでは`.circleci/config.yml`の`resource_class`を下げる（next buildのメモリ不足に注意）

## 5. 必須チェックの移行（段階移行。人が行う）

**現状（2026-10-07実査）**: developのブランチ保護とruleset「protect develop」（id 20194705）の両方で、
必須チェックは`lint-and-build`（GitHub Actions、`integration_id`/`app_id` 15368）だけ。bypass actorsは無し。
issue-deckのGitHub App（app id 4448617）は`statuses`権限を持っていない。

**このままでは、バックアップCIが合格してもマージできない**（`lint-and-build`がActionsから来ないため）。
次の順で移す。途中で検査の空白期間を作らないため、**1→2→3を飛ばさない**。

1. 4章を済ませ、試験PRでバックアップCIの合格と`issue-deck/ci-gate`の発行を確かめる
2. **通常時にも共通チェックが出る状態にする**（Actionsの結果を`issue-deck/ci-gate`へ写す。#4113）。
   これが無いまま3へ進むと、通常のPRが共通チェック待ちで永久に止まる
3. 必須チェックを`lint-and-build`(15368)から`issue-deck/ci-gate`（issue-deck App、4448617）へ置き換える。
   ブランチ保護とrulesetの両方を変える（Administration権限が要るため、org ownerの`gh`で実行）

### ロールバック（導入前の保護設定へ戻す）

共通チェックを外し、Actionsの`lint-and-build`だけを必須に戻す。

```bash
gh api -X PUT repos/guchi-apps/issue-deck/rulesets/20194705 --input - <<'JSON'
{"rules":[{"type":"required_status_checks","parameters":{"do_not_enforce_on_create":false,
"strict_required_status_checks_policy":false,
"required_status_checks":[{"context":"lint-and-build","integration_id":15368}]}}]}
JSON
gh api -X PATCH repos/guchi-apps/issue-deck/branches/develop/protection/required_status_checks \
  --input - <<'JSON'
{"strict":false,"checks":[{"context":"lint-and-build","app_id":15368}]}
JSON
```

確認: `gh api repos/guchi-apps/issue-deck/rules/branches/develop --jq '.[].parameters.required_status_checks'`
が`lint-and-build`/15368だけを返すこと。

### issue-deckが判定経路の依存先になる

3の後は、**issue-deckが止まっているとdevelopへのマージが止まる**（共通チェックを発行するのがissue-deckだけになるため）。
issue-deckが応答しない・GitHub Appの権限が外れた場合、共通チェックは`pending`のまま残り、画面上は
「確認不能」と同じ扱いになる（成功にはならない）。長引く場合は上のロールバックで`lint-and-build`へ戻す。

## 6. 障害時の切替と通常運用への復帰

切替（Actionsのジョブが開始されない・止まっていると判断したら。公式の障害情報の有無は条件にしない）:

1. PR詳細の「バックアップCI（GitHub Actions障害時）」を開き、1行目が「ジョブが開始されていません」
   「待機中・実行中」のまま動かないことを確かめる
2. 「バックアップCIで実行」→ 内容を確認して「起動する」
3. 完了を待つ（Webhookが届けば即時、届かなくてもpollerが約30秒ごとに照合する）。失敗したら
   CircleCIのログを開いて直し、pushしてから再実行する（**コードの不具合を「障害」として上書きしない**）
4. `バックアップCI成功`になれば、そのhead/baseに対して`issue-deck/ci-gate`がsuccessになる

復帰（Actionsが動き始めたら）: 何もしなくてよい。次のpushからはActionsが従来どおり検査する。
バックアップCIの合格は**そのhead/baseに対してだけ**有効で、新しいpush・baseの更新で自動的に無効になる。
Actionsの遅れて届いた結果は、バックアップCIの記録を書き換えない。

## 7. 定期的な動作確認（月1回目安）

1. 適当な試験PR（develop向け）で「バックアップCIで実行」を押す
2. `バックアップCI成功`になり、内訳に全検査（現在15件）が並ぶこと、ログリンクが開けることを確かめる
3. 確認したらPRを閉じる（クレジットを消費するので回数を増やさない）

## 8. 未対応（#4065の残り）

- Actionsの結果を通常時も`issue-deck/ci-gate`へ写す処理と、必須チェックの置き換え（5章の2・3。#4113）
- Actions停止中に、サブPCのAIレビュー（`PR_REVIEW`）をissue-deckから起動・回収し、既存のマージ判定へ
  接続する処理（現在の起点は`claude-review-develop.yml`で、Actionsが止まるとレビューも始まらない。#4114）
