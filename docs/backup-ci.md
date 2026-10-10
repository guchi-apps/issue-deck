# バックアップCI（GitHub Actions障害時のCircleCI）

いつ読むか: GitHub Actionsのジョブが開始されない・止まっていて、develop向けPRの検証を続けたいとき。
バックアップCIの設定・必須チェックの移行・ロールバックを触るとき。

起点: #4065。**初期導入の対象は`guchi-apps/issue-deck`のdevelop向けPRだけ**（main向け・リリース・
本番デプロイの代替、他リポジトリへの展開、障害の自動判定・自動切替は対象外）。

## 1. 全体像

```
通常時:  PR ──push──▶ GitHub Actions（ci.yml）──▶ lint-and-build 等（必須ジョブ）
                                              │  pollerの巡回／workflow_runのWebhookで照合（#4113）
                                              ▼
障害時:  PR詳細「バックアップCIで実行」──▶ issue-deck ──CircleCI API──▶ CircleCI（.circleci/config.yml）
                                              ▲   完了Webhook／pollerの巡回で照合        │
                                              └──────────── 結果（ci-result.json）◀──────┘
                                              └──▶ 最後に始まった試行の結果を commit status `issue-deck/ci-gate` へ
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
- 共通チェックへどちらの経路（Actions／バックアップCI）を出したかの正本は`CiGateState`（#4113）。
  PRごとに、採用した経路・試行・その開始時刻・状態・発行状況を持つ
- コードは`src/lib/backup-ci/`（`state.ts`・`gate.ts`・`merge.ts`が判定の純関数、`service.ts`が起動・回収、
  `gate-service.ts`が共通チェックの決定・発行とActionsの取り込み、`merge-service.ts`が合格後のレビュー依頼と
  developへのマージ（#4114）、`github.ts`がGitHubへの読み書き、`circleci-client.ts`がCircleCIのAPI）、
  画面は`src/components/dashboard/pull-request-backup-ci.tsx`

## 2. 安全のための約束（変えるときは#4065を読み直す）

| 約束 | どこで守っているか |
|---|---|
| 通常のpush/PRでCircleCIは走らない | `.circleci/config.yml`のワークフローは`backup_ci`パラメータが真のときだけ。CircleCIプロジェクトにpush/PRのトリガーを作らない（4章） |
| PR内の変更で検査を省けない・手順を変えられない | 起動時に`config.branch`と`checkout.branch`の両方へPRのbase（develop）を渡し、headはジョブ内で`head_sha`をSHA指定で取り出す（同じリポジトリでは両者のrefが一致しないとCircleCIがHTTP 400で拒否する。#4215）。ランナーと定義は`base_sha`の版を`git show`で取り出して使う。issue-deckは結果のダイジェストをbaseの定義と照合する |
| headだけの検査で代用しない | baseへheadを`--no-ff`でマージした結果を検査し、検査したコミットの親が`[base, head]`であることを確かめる |
| 起動後に先端が動いても取り違えない | ブランチ名ではなく要求したSHAを`git fetch`して検査する。完了時にPRの現在のhead/baseと比べ、違えば`superseded` |
| head/baseが更新されたら合格を流用しない | 巡回（約30秒ごと。合格は3分おき）が合格済みの実行もPRと照合し、変わっていれば無効にして共通チェックを`pending`へ戻す |
| 不明・timeout・キャンセル・検査欠落を成功にしない | `evaluateBackupCiResult`・`decideCiGateFromBackupRun`。90分で`unverifiable` |
| 応答不明の起動要求を再送しない | `trigger_unknown`で止める。利用者がCircleCIの画面で確かめてから再実行する |
| 二重に採用しない | 未完了の実行はPRごとに1件（`activeKey`の一意制約）。共通チェックはPRで最新の試行からしか発行しない |
| 2つの経路から都合のよい成功を選ばない | Actions（ci.ymlのPRで最後に作られた実行の、最新の試行）とバックアップCI（PRで最新の試行）のうち、**最後に始まった方**だけを採用する（`chooseCiGateCandidate`）。成功している方を選ぶ規則は無い |
| 遅れて届いた結果で巻き戻さない | バックアップCIより前に始まって止まっていたActionsの実行が後から終わっても、採用は変わらない。同じ経路で前回より古い試行・完了から検査中への後退が見えたら、前回の採用を保つ（`CiGateState`の`sourceStartedAt`・`sourceRef`） |
| Actionsの検査失敗をバックアップCIで上書きしない | 今のheadに対してActionsの必須ジョブが`failure`で終わっていれば、バックアップCIを起動させない（キャンセル・未開始・検査中は障害の可能性があるので止めない） |
| 同名ジョブで合格を作れない | Actionsは`.github/workflows/ci.yml`の`pull_request`起動の実行だけを数え、必須ジョブ名はPRの**base**の`ci/required-checks.json`から取る。必須ジョブの欠落・スキップ・キャンセルは`error` |
| 偽のWebhookで合格を作れない | `circleci-signature`をHMAC-SHA256で検証。本文の状態は使わず、APIで照合し直す。イベントIDで重複排除（`CircleciWebhookDelivery`） |
| 合格だけでマージしない・Actionsの判定ジョブを待たない | 合格後はissue-deckがサブPCのCodexレビュー（`PR_REVIEW`）を積み、LGTMで、ラベル・`.shared-context/`・コンフリクトの条件を満たし、共通チェックがその合格を採用しているときだけ`expectedHeadSha`付きでマージする（`decideBackupCiMerge`。6章） |
| テスト環境へ権限を渡さない | CircleCIプロジェクトにContext・環境変数を設定しない。検査はプレースホルダ値で動く。マージ・共通チェックの発行はissue-deckのGitHub Appだけが行う |

## 3. 画面

PR詳細（develop向けの未マージPR）の「バックアップCI（GitHub Actions障害時）」。

- 1行目は**元のGitHub Actionsの状態**（ジョブ未開始／待機中・実行中／成功／失敗）。共通チェックとは
  別に出し、Actionsの履歴は消さない
- 続く行がCircleCIの最新の実行（`CircleCIで代替実行中`／`バックアップCI成功`／`失敗`／`結果確認不能`／
  `PRが更新されたため無効`）。ログはCircleCIのワークフロー画面へのリンク
- 開くと、head/base・検査したコミット・検査定義の版・共通チェックの発行状況・検査ごとの結果と、
  「バックアップCIで実行」ボタン（押すと対象のリポジトリ・PR・コミット・実行先を確認してから起動）
- 未設定・権限不足・無料枠不足など起動できない理由は、その場に必要な操作と一緒に出る
- 2行目（あれば）は**共通チェックにどちらの経路の結果を出しているか**（`共通チェック issue-deck/ci-gate:
  success（GitHub Actionsの結果を採用）`など。発行に失敗していればその理由）
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

値の配り方: `CIRCLECI_API_TOKEN`・`CIRCLECI_WEBHOOK_SECRET`は`.github/secrets-manifest.tsv`と`deploy.yml`に
入っている（#4113）。1Passwordへ入れたあと`scripts/sync-github-secrets.sh`で同期し、本番をデプロイし直すと
サーバーの`.env`へ入る。どちらも未設定のままでもデプロイは通る（バックアップCIの起動・Webhookの受信だけができない）。

### 実行環境の前提（PyYAML）

実行環境`cimg/base:current`にはPyYAMLが無い（GitHub Actionsの`ubuntu-latest`には入っている）。
`scripts/check-workflow-gh-repo.sh`・`scripts/check-workflow-job-permissions.sh`が`python3`の
`import yaml`を使うため、`.circleci/config.yml`が`apt-get install -y python3-yaml`で用意する（#4232）。
検査スクリプトが使うPythonライブラリを増やしたら、このステップも合わせる。

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
2. **通常時にも共通チェックが出る状態にする**（#4113）。これが無いまま3へ進むと、通常のPRが共通チェック待ちで
   永久に止まる
   - #4113が本番へ出ていることを確かめ、PR詳細のバックアップCI欄「このリポジトリのバックアップCI設定」で
     「通常時もGitHub Actionsの結果を共通チェック（issue-deck/ci-gate）へ写す」をオンにして保存する
   - 以後、pollerの巡回（約30秒ごと。合否が決まったPRは3分おき）がdevelop向けのopenなPRすべてについて、
     ci.ymlの必須ジョブ（`ci/required-checks.json`の各グループ）の結果を共通チェックへ写す
   - 任意: GitHub Appの設定で**Workflow run**イベントを購読すると、Actionsの完了がすぐ写る（無くても巡回で写る）
   - 確認: 下のコマンドで、**全open PRが`none`以外**（success/pending/failure/error）を返すこと
     ```bash
     for n in $(gh pr list --repo guchi-apps/issue-deck --base develop --state open --json number --jq '.[].number'); do
       sha=$(gh api repos/guchi-apps/issue-deck/pulls/$n --jq .head.sha)
       st=$(gh api repos/guchi-apps/issue-deck/commits/$sha/status \
         --jq '[.statuses[] | select(.context=="issue-deck/ci-gate")][0].state // "none"')
       echo "#$n $st"
     done
     ```
     あわせて、Actionsが成功したPRで`success`、失敗したPRで`failure`になっていることを数件見比べる
3. 必須チェックを`lint-and-build`(15368)から`issue-deck/ci-gate`（issue-deck App、4448617）へ置き換える。
   ブランチ保護とrulesetの両方を変える（Administration権限が要るため、org ownerの`gh`で実行）。
   rulesetは**`rules`の配列を丸ごと置き換える**APIなので、取得したものの`required_status_checks`だけを書き換えて戻す
   ```bash
   gh api repos/guchi-apps/issue-deck/rulesets/20194705 \
     | jq '{rules: [.rules[] | if .type == "required_status_checks"
         then .parameters.required_status_checks = [{"context":"issue-deck/ci-gate","integration_id":4448617}]
         else . end]}' \
     | gh api -X PUT repos/guchi-apps/issue-deck/rulesets/20194705 --input -
   gh api -X PATCH repos/guchi-apps/issue-deck/branches/develop/protection/required_status_checks \
     --input - <<'JSON'
   {"strict":false,"checks":[{"context":"issue-deck/ci-gate","app_id":4448617}]}
   JSON
   ```
   確認: `gh api repos/guchi-apps/issue-deck/rules/branches/develop --jq '.[].parameters.required_status_checks'`
   が`issue-deck/ci-gate`/4448617だけを返すこと。続けて、次にdevelopへ向くPRが共通チェックの成功で
   自動マージされることを見届ける
   - 移したあとは、設定の「通常時もGitHub Actionsの結果を共通チェックへ写す」を**外さない**
     （外すと通常のPRに共通チェックが出ず、マージできなくなる）

`strict`（baseの更新を要求する）は今と同じく`false`のまま。Actions経由の合格は、baseが進んでも
headが同じ間は有効（現在の`lint-and-build`と同じ扱い）。バックアップCIの合格だけは、その時のbaseに
対してしか有効にしない（baseが進めばActionsの結果へ戻る）。

### ロールバック（導入前の保護設定へ戻す）

共通チェックを外し、Actionsの`lint-and-build`だけを必須に戻す。

```bash
gh api repos/guchi-apps/issue-deck/rulesets/20194705 \
  | jq '{rules: [.rules[] | if .type == "required_status_checks"
      then .parameters.required_status_checks = [{"context":"lint-and-build","integration_id":15368}]
      else . end]}' \
  | gh api -X PUT repos/guchi-apps/issue-deck/rulesets/20194705 --input -
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
Actionsの結果を写す主経路は**サブPCのpollerが叩く`POST /api/dispatch/claim`の巡回**なので、サブPCの
pollerが止まっている間も写りが止まる（GitHub Appが`workflow_run`を購読していれば、そのWebhookで写る）。

## 6. 障害時の切替と通常運用への復帰

切替（Actionsのジョブが開始されない・止まっていると判断したら。公式の障害情報の有無は条件にしない）:

1. PR詳細の「バックアップCI（GitHub Actions障害時）」を開き、1行目が「ジョブが開始されていません」
   「待機中・実行中」のまま動かないことを確かめる
2. 「バックアップCIで実行」→ 内容を確認して「起動する」
3. 完了を待つ（Webhookが届けば即時、届かなくてもpollerが約30秒ごとに照合する）。失敗したら
   CircleCIのログを開いて直し、pushしてから再実行する（**コードの不具合を「障害」として上書きしない**）
4. `バックアップCI成功`になれば、そのhead/baseに対して`issue-deck/ci-gate`がsuccessになる
5. そのあとは**人の操作なしで**developへのマージまで進む（#4114）。PR詳細のバックアップCI欄に
   「developへのマージ: …」として進み具合が出る

### 合格後のレビューとdevelopへのマージ（#4114）

Actionsが止まっていると、通常の経路（`claude-review-develop.yml`の`codex-review`→`auto-merge`）は
レビューも始まらず、マージ判定も動かない。そこで**バックアップCIの合格を共通チェックへ採用したPR**に
限り、issue-deckが同じ判定をサーバー側で行う。契機はpollerの巡回（`POST /api/dispatch/claim`、約30秒ごと）で、
実装は`src/lib/backup-ci/merge.ts`（判定）・`merge-service.ts`（実行）。

1. 止める条件を先に見る（Codexの枠を使う前）。対応Issue（`issue-<番号>`ブランチ）が無い・Issueに
   `00.check-user`／`22.merge-confirm-required`／`23.preview-required`が付いている・差分に`.shared-context/`が
   ある・developとコンフリクトしている、のどれかなら自動マージしない
2. サブPCのCodexレビューを既存の`requestPrReviewJob`で積む（Actionsのrunは紐付けない）。**Actions上の
   Claudeレビューの代わり**で、実装担当がClaudeでもCodexでレビューする（#4149のワークフロー変更PRと同じ扱い。
   サブPCの`PR_REVIEW`はCodexにしか対応していない）。同じPR・HEADのジョブがあれば活性キーで相乗りする
3. 判定が`lgtm`で、PRのhead/baseが合格した実行と同じなら、`mergePullRequest`へ**合格したheadのSHAを
   `expectedHeadSha`として渡して**マージする（その間にpushされればGitHubが断る）。PRに記録のコメントを残す
4. `needs-check`・`changes-requested`は`00.check-user`＋`01.check-merge`、レビューの失敗・サブPCが無い・
   マージAPIが10回失敗した場合は`00.check-user`＋`01.check-blocked`を付け、理由をIssue（無ければPR）へ書く

方針の判断（#4114で決めたこと）:

- **自動でマージする**（画面のボタン待ちにしない）。develop向けの`merge-policy: relaxed`と同じで、自動マージ
  不可カテゴリでは止めない。確実に人の目を通したいIssueには、通常時と同じく`22.merge-confirm-required`を付ける
- 共通チェックが後からActionsの結果を採用した（Actionsが復帰して後から再実行された）ら、この経路は手を引き
  （`skipped`）、通常の`auto-merge`に任せる
- レビュー指摘の自動修正（`claude-review-fix.yml`への受け渡し）はActionsの経路なので行わない。`changes-requested`は
  人へ渡す
- **必須チェックの移行（5章の3）前は、マージがブランチ保護に断られる**（`lint-and-build`が来ないため）。
  10回失敗すると`gave_up`で人へ渡し、理由に移行の確認を促す文を入れる

復帰（Actionsが動き始めたら）: 何もしなくてよい。次のpushからはActionsが従来どおり検査する。
バックアップCIの合格は**そのhead/baseに対してだけ**有効で、新しいpush・baseの更新で自動的に無効になる。
Actionsの遅れて届いた結果（バックアップCIより前に始まって止まっていた実行の完了）は、共通チェックの採用を
変えない。バックアップCIの後にActionsで**再実行**（またはpush）した場合は、そちらが後に始まった試行なので
Actionsの結果が採用される。

## 7. 定期的な動作確認（月1回目安）

1. 適当な試験PR（develop向け）で「バックアップCIで実行」を押す
2. `バックアップCI成功`になり、内訳に全検査（現在15件）が並ぶこと、ログリンクが開けることを確かめる
3. 確認したらPRを閉じる（クレジットを消費するので回数を増やさない）

## 8. 未対応（#4065の残り）

- 必須チェックの置き換え（5章の2のオン操作と3。Administration権限が要るため人が行う。手作業Issue #4151）
- Actions停止中の経路でマージしたPRには、PR本文の「検証結果」節（`issue-deck-verification`）が書かれない
  （Actionsの`auto-merge`が書くもの）。リリースPRの表ではそのPRのレビュー結果が「取得できず」になる
- 合格後のマージ（6章）の実地確認（試験PRで、管理者バイパスや保護解除なしにdevelopへマージできること）は、
  4章の初期設定と5章の必須チェックの移行のあとに行う
