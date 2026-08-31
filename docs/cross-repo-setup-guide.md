# 他リポジトリへのマルチエージェント運用 導入ガイド

issue #723 に対応する実務向けガイド。issue-deckの「Issueごとの複数Claude Codeエージェント運用」
（`@claude`コメント起点の計画〜実装〜PR作成〜レビュー〜マージまでの無人実行）を、他リポジトリで
実際に導入する担当者（人間・別のClaude Codeエージェントいずれも想定）がそのまま作業できる粒度で
チェックリスト化したものである。

## 位置づけ・他ドキュメントとの違い

- [docs/cross-repo-automation.md](cross-repo-automation.md): 展開方式の**選択肢比較**（テンプレート
  PR自動作成／CLIスキャフォールディング／設定ファイル方式）や、`m-guchi/shopping-list`を対象にした
  実現可能性の調査結果をまとめた**調査ドキュメント**。コード変更は行わず調査のみに留めている。
  「なぜその方式にするか」「どこまでが技術的に可能か」を知りたい場合はこちらを参照する。
- **本ドキュメント（`cross-repo-setup-guide.md`）**: 上記調査を踏まえ、「実際に他リポジトリで何を
  作ればよいか」を手順化した**実務ガイド**。ワークフローファイル・ラベル・CLAUDE.md・Secrets・
  ブランチ運用など、導入時にそのまま埋めるべき設定項目をチェックリスト形式でまとめる。
- [docs/supported-repositories.md](supported-repositories.md): 実際に導入済み・検討中のリポジトリの
  **記録簿**。本ガイドに沿って導入したら、この一覧に導入状況を追記する。
- [docs/multi-repo-changes.md](multi-repo-changes.md): **導入済みのリポジトリ群へ変更を横展開する**
  ときの進め方（#1698）。本ガイドが「まだ入っていないリポジトリに運用一式を入れる」手順なのに対し、
  あちらは「もう入っているリポジトリ全体に同じ直しを配る」手順を扱う。Issueを起点に他リポジトリへ
  PRが自動作成されることは**無い**という前提と、種類ごとの配り方をまとめている。
- 設計の経緯・issue-deck自身での詳細実装は[docs/multi-agent-workflow.md](multi-agent-workflow.md)を
  参照。

## 導入ステップの全体像

上から順に実行すればよい。

1. [対象リポジトリの構成を調べ、5つの設定値を決める](#0-最初に決める5つの設定値)
2. [ワークフローファイルを配置する](#1-ワークフローファイル一式)（移行済みの5つは**コピーせず参照**、残りはコピーして改変）。**素の`claude.yml`があれば削除する**
3. [ラベル体系](#2-ラベル体系)を作成する（**旧世代のラベルがある場合は、進捗を控えてから消す**）
4. [CLAUDE.md](#3-claudemd)を新規作成、または既存ファイルに運用ルールを追記する
5. [Secrets](#4-secrets)を登録する
6. [`.gitignore`に共有ディレクトリを追加する](#gitignoreに共有ディレクトリを追加する)（**忘れやすい**）
7. [ブランチ運用](#5-ブランチ運用)を揃える（`develop`/`main`の2段階運用、**デフォルトブランチを`develop`にする**、ブランチ命名規則、Branch protection）
8. [コピーしたワークフローのリポジトリ差異を吸収する](#6-リポジトリ差異の吸収チェックリスト)（参照方式のものは`with:`で指定済みのため対象外）
9. 必要に応じて[ラベル差分チェック](#7-ラベル差分チェック)・[ワークフロー同期のずれ検知](#8-ワークフロー同期のずれ検知)の
   スクリプトを利用する
10. [共有知識リポジトリの参照設定](#10-共有知識リポジトリの参照設定)を行う（任意）
11. [盤面へ載せる](#11-盤面へ載せるリポジトリを再同期)（issue-deckの画面で「リポジトリを再同期」）
12. 控えておいた進捗を[書き戻す](#進捗ラベルが唯一の状態記録になっている重要)（旧世代のラベルがあった場合）
13. [動作を確認する](#12-導入後の動作確認)
14. [docs/supported-repositories.md](supported-repositories.md)に導入状況を記録する

## 0. 最初に決める5つの設定値

参照方式のワークフロー（`claude-issue-dispatch.yml`）に渡す `with:` の値。**対象リポジトリごとに決めるのはこれだけ**で、ワークフロー本体を編集する必要はない。

| 設定 | 決め方 | 例 |
|---|---|---|
| `runtime-setup` | DBあり（Prisma等）→`node-db` / DBなしのNext.js等→`node` / 素のJS・依存なし→`minimal` | `minimal` |
| `package-manager` | `pnpm-lock.yaml`があれば`pnpm`、`package-lock.json`なら`npm` | `npm` |
| `node-version` | 対象リポジトリのCI（`ci.yml`）が固定しているバージョンに揃える。固定していなければ未指定でよい | `"20.19"` |
| `prompts-ref` | **`uses:`と同じタグ**。対象リポジトリに`.github/prompts/`が無い限り必須 | `workflows/v9` |
| `post-implement-script` | 実装後に固有の後処理（スクリーンショット撮影など）が要る場合のみ、そのスクリプトのパス | `scripts/ci-post-implement.sh` |

判断材料は以下のコマンドで集められる。

```bash
REPO=guchi-apps/<対象リポジトリ>
gh api "repos/$REPO/contents" -q '[.[].name] | join(" ")'          # prisma/ や lock ファイルの有無
gh api "repos/$REPO/contents/package.json" -q .content | base64 -d # scripts と依存関係
gh api "repos/$REPO/contents/.github/workflows/ci.yml" -q .content | base64 -d | grep node-version
```

各アプリの実際の構成調査結果は[docs/cross-repo-automation.md](cross-repo-automation.md)を参照（12アプリ分。`node-db`が7、`node`が2、`minimal`が3）。

## 1. ワークフローファイル一式

`.github/workflows/`配下のうち、マルチエージェント運用の自動化本体は以下のファイルである。

**移植方法は2種類ある。** どちらに該当するかを先に確認すること。

| 方式 | 対象ワークフロー | やること |
|---|---|---|
| **参照方式**（移行済み） | `claude-issue-dispatch.yml`・`issue-labels.yml`・`claude-ci-fix.yml`・`claude-conflict-resolve.yml`・`claude-review-develop.yml`・`release-develop-to-main.yml`・`claude-pr-repair.yml`・`version-tag-check.yml`・`deploy-retry.yml` | 薄いcallerを置き、issue-deck側の`reusable-*.yml`を`uses:`で呼ぶ。**ワークフロー本体もプロンプトもコピーしない** |

参照方式は薄いcallerを置くだけで済み、issue-deck側の改善が**参照タグを上げるだけ**で反映される（背景と方式は[docs/cross-repo-automation.md](cross-repo-automation.md)を参照）。未移行のものも順次こちらへ寄せていく。

| ファイル | 役割 | 主な改変ポイント（技術スタックが異なる場合） |
|---|---|---|
| `claude-issue-dispatch.yml` | `@claude`コメントを起点に、計画提示／実装／PR作成／質問応答／スクリーンショット撮影までを無人実行する。**トリガー定義のみ**を持ち、本体は`reusable-issue-dispatch.yml`を`uses:`で呼ぶ | **コピーではなく薄いcallerを置く。** 技術スタックの差は`with:`の`runtime-setup`（`node-db`/`node`/`minimal`）・`package-manager`（`npm`/`pnpm`）で指定する（下記「再利用可能ワークフローの参照」）。プレビュー系ジョブを持つ場合は設定がアプリ固有のためcaller側に置く（issue-deck自身のFly.ioプレビューは#1308で廃止済み） |
| `reusable-issue-dispatch.yml` | 上記のジョブ本体（`on: workflow_call`）。`triage`／`dispatch`／`notify-failure`を含む | **対象リポジトリへコピーしない。** issue-deck側の1つを共有する。`.github/prompts/`配下は`prompts-ref`で取得元を指定する（下記「プロンプトの取得元」。**指定しないと呼び出し元側の`.github/prompts/`が読まれ、無ければ落ちる**） |
| `issue-labels.yml` | `Planning`〜`Done`の進捗（Project Status）の状態遷移を担うワークフローの**トリガー定義のみ**。ジョブ本体は`reusable-issue-labels.yml`にあり、`uses:`で呼び出す | **コピーではなく、issue-deckの`reusable-issue-labels.yml`をタグ固定で参照する薄いcallerを置く**（下記「再利用可能ワークフローの参照」を参照）。`issue-<番号>`ブランチ命名規則が一致していれば改変不要 |
| `reusable-issue-labels.yml` | 上記のジョブ本体（`on: workflow_call`）。他リポジトリから呼び出される実体 | **対象リポジトリへコピーしない。** issue-deck側の1つを共有する |
| `claude-review-develop.yml` | develop向けPRの自動レビュー・自動マージ不可判定（`risk-check`）・Auto-merge有効化を行う。**トリガー定義と`concurrency`のみ**を持ち、本体は`reusable-claude-review-develop.yml`を`uses:`で呼ぶ（#1078） | **コピーではなく薄いcallerを置く。** リポジトリ固有のリスクパスは`risk-paths`、依存関係の判定基準は`dependency-check`、差分規模の閾値は`review-file-threshold`・`review-line-threshold`、除外するlockファイルは`lock-files`で指定する。プロンプトは`prompts-ref`に`uses:`と同じタグを指定してissue-deck側を共有する |
| `reusable-claude-review-develop.yml` | 上記のジョブ本体（`on: workflow_call`）。`identify-issue`／`wait-for-ci`／`risk-check`／`claude-review`／`auto-merge`と各fallbackを含む。`wait-for-ci`は`00.check-user`を付けるジョブ（`auto-merge`・`claude-review-fallback`）の前段だけに効き、`risk-check`・`claude-review`はCIと並行して走る（#2066・#2136） | **対象リポジトリへコピーしない。** issue-deck側の1つを共有する |
| `claude-conflict-resolve.yml` | develop向けPRがdevelopとコンフリクトした場合に自動解消を試みる。**トリガー定義のみ**を持ち、本体は`reusable-claude-conflict-resolve.yml`を`uses:`で呼ぶ（#1066） | **コピーではなく薄いcallerを置く。** 指定する入力は`claude-ci-fix.yml`と同じ（`runtime-setup`・`package-manager`・`node-version`・`build-env`・`verify-commands`・`prompts-ref`）。**トリガーに`push`を書かないこと**（`claude-code-action`が`push`イベントに非対応で必ず`Unsupported event type: push`で落ちる。#1330）。developへのpushを契機にしたい場合は、issue-deck側と同じく**そのリポジトリのCIワークフローの`workflow_run`（`types: [requested]`・`branches: [develop]`）**を購読する。`workflows:`には**そのリポジトリのCIワークフローの`name:`**を書く（issue-deckは`CI`だが、リポジトリによって異なる） |
| `reusable-claude-conflict-resolve.yml` | 上記のジョブ本体（`on: workflow_call`）。`detect-conflicts`／`resolve-conflicts`を含む | **対象リポジトリへコピーしない。** issue-deck側の1つを共有する |
| `claude-ci-fix.yml` | develop向けPRのCIが失敗した場合に自動修正を試みる。**トリガー定義のみ**を持ち、本体は`reusable-claude-ci-fix.yml`を`uses:`で呼ぶ（#1066） | **コピーではなく薄いcallerを置く。** 技術スタックの差は`with:`の`runtime-setup`・`package-manager`・`node-version`で、ビルド検証に要るダミー環境変数は`build-env`で、修正後の検証手順の説明は`verify-commands`で指定する。**Nodeのセットアップは要るが依存のインストールは不要**なリポジトリ（検証が`node --check`だけで`node_modules`を要さない等）は`install-dependencies: false`を渡す。プロンプトは`prompts-ref`に`uses:`と同じタグを指定してissue-deck側を共有する |
| `reusable-claude-ci-fix.yml` | 上記のジョブ本体（`on: workflow_call`）。`detect`／`fix`を含む | **対象リポジトリへコピーしない。** issue-deck側の1つを共有する |
| `claude-pr-repair.yml` | Issueに紐づかないPR（バンプPR・develop→mainのリリースPR）のCI失敗・コンフリクトを、issue-deckの画面のボタンから修復する（`workflow_dispatch`のみ）。**トリガー定義のみ**を持ち、本体は`reusable-claude-pr-repair.yml`を`uses:`で呼ぶ（#1293） | **コピーではなく薄いcallerを置く。** 指定する入力は`claude-ci-fix.yml`と同じものに加え、自身の`workflow_dispatch`入力を`pr-number`・`mode`として渡す。導入は任意（画面のボタンからの修復を使わないリポジトリでは不要） |
| `reusable-claude-pr-repair.yml` | 上記のジョブ本体（`on: workflow_call`）。`repair`ジョブ1つ | **対象リポジトリへコピーしない。** issue-deck側の1つを共有する |
| `release-develop-to-main.yml` | develop→mainのバージョンbump PR・リリースPR作成を自動化する（`workflow_dispatch`と、バージョンファイルへのpush）。**トリガー定義のみ**を持ち、本体は`reusable-release-develop-to-main.yml`を`uses:`で呼ぶ（#1181） | **コピーではなく薄いcallerを置く。** バージョン管理方式の差は`with:`の`version-file`・`version-query`・`bump-command`で指定する（下記「リリースワークフローのバージョン管理方式」） |
| `version-tag-check.yml` | `main`宛のPRの時点で、**mainへ入るまで露見しないデプロイの失敗**を落とす（#1367・#2135）。リリースタグの重複と、`deploy.yml`の設定漏れの2ジョブ。**トリガー定義のみ**を持ち、本体は`reusable-version-tag-check.yml`を`uses:`で呼ぶ | **コピーではなく薄いcallerを置く。** バージョン管理方式の差は`with:`の`version-file`・`version-query`で、タグの接頭辞は`tag-prefix`で指定する（既定は`package.json`・`.version`・`v`）。**トリガーを`develop`へ広げないこと**（featureブランチのバージョンは直前のリリースのままでタグが必ず存在するため、developへの全PRが赤くなる） |
| `reusable-version-tag-check.yml` | 上記のジョブ本体（`on: workflow_call`）。`version-tag-check`（タグの重複）と`deploy-config-check`（`deploy.yml`の設定漏れ。#2135）の2ジョブ。**検査を増やすときはこのファイルへジョブを足す**——callerを配り直さずに参照タグの更新だけで全リポジトリへ届く。**ファイル名は改名しない**（14リポジトリのcallerが名指ししており、改名するとタグを上げた瞬間に全リポジトリのmain宛PRが startup_failure になる） | **対象リポジトリへコピーしない。** issue-deck側の1つを共有する |
| `deploy-retry.yml` | 本番デプロイ（`deploy.yml`）が一時的な失敗（SSH断・ネットワーク・アプリの起動待ち等）で落ちたとき、1回だけ自動で再実行する（#2134）。**トリガー定義のみ**を持ち、本体は`reusable-deploy-retry.yml`を`uses:`で呼ぶ | **コピーではなく薄いcallerを置く。** `workflow_run`の`workflows:`には**そのリポジトリの`deploy.yml`の`name:`**を書く（issue-deckは`Deploy to Production`）。Signalyの通知に出す名前は`app-name`で指定する。**`deploy.yml`のジョブ名が`build`・`deploy`と違う場合は`retryable-jobs`を渡して合わせる**（合っていないジョブだけが失敗したときは安全側に倒れて再実行しない）。導入は任意。**`vps`・`subpc`は実機のインフラ設定を流すため、入れるかを個別に判断する** |
| `reusable-deploy-retry.yml` | 上記のジョブ本体（`on: workflow_call`）。`deploy-retry`ジョブ1つ | **対象リポジトリへコピーしない。** issue-deck側の1つを共有する |

各ワークフローの改変ポイントの詳細・実例（`m-guchi/shopping-list`を対象にしたケーススタディ）は
[docs/cross-repo-automation.md](cross-repo-automation.md)の「ワークフローごとの移植コスト」を参照。

> **`build-env`に実シークレットを渡さないこと**（`reusable-claude-ci-fix.yml`、#1066）。
> この入力はCI上でビルド検証を通すためだけのプレースホルダー値を想定しており、値は
> caller側のワークフローファイル（＝リポジトリにコミットされる平文）に書かれる。
> 実シークレットは`secrets: inherit`で別途渡るため、`build-env`に置く理由は無い。
> 値は1行で書く（改行を含む値は扱えず、`KEY=VALUE`形式でない行があればジョブが失敗する）。

> **`risk-paths`の書式**（`reusable-claude-review-develop.yml`、#1078）。1行1件で
> `<grep -E の正規表現> :: <Issueコメントに出す理由>` と書く。区切りは前後に半角スペースを
> 伴うコロン2つ（` :: `）。**区切りに`|`は使えない**（`^deploy/|\.env\.tpl$`のように正規表現側が
> 選択を含むため）。区切りの無い行があればジョブが失敗する。
> `.github/workflows/**`・`.env*`・`.shared-context/**`・`prisma/migrations/**`・`**/auth/**`は
> 再利用ワークフロー側に内蔵されており、指定しなくても常に判定される。**入力はリスクを追加できるが
> 削減はできない**（宣言し忘れたリポジトリで認証やマイグレーションの変更が無確認でマージされるのを防ぐため）。

### 再利用可能ワークフローの参照

`reusable-*.yml` を使うワークフローは、対象リポジトリ側にトリガー定義だけを持つ薄いcallerを置く。

```yaml
# 対象リポジトリの .github/workflows/issue-labels.yml
name: Issue Labels

on:
  # issue-deck側の同名ファイルからトリガー定義をコピーする
  push:
    branches:
      - "issue-*"
  # …（以下略）

jobs:
  labels:
    uses: guchi-apps/issue-deck/.github/workflows/reusable-issue-labels.yml@workflows/v9
    permissions:
      issues: write
      pull-requests: write
      contents: write
    # 進捗をissue-deckのProjectカンバンへ反映したい場合のみ（#991 Phase 2）。
    # 省略すると報告ステップがスキップされるだけで、ラベル遷移には影響しない
    secrets:
      PROGRESS_REPORT_SECRET: ${{ secrets.PROGRESS_REPORT_SECRET }}
```

**この`secrets:`が効くのは、報告ステップを含むタグ（`workflows/v6`より後）を参照している場合のみ。**
`v6`以前のタグには報告ステップ自体が無いため、渡しても何も起きない（エラーにもならない）。

> **タグを上げてもトリガーは増えない。** `on:`はcaller側にしか無いため、再利用可能ワークフロー側で
> 新しいイベントを使うジョブが増えても、対象リポジトリのcallerに同じイベントを書き足すまでそのジョブは
> 一度も走らない。`propagate-workflow-tag.yml`が書き換えるのは`@workflows/vN`と`prompts-ref`だけで、
> `on:`には触れない（`.github/scripts/propagate-workflow-tag.sh`の`sed`）。
> 該当するのは`manual-step-label`ジョブ（#1492。`issues: types: [opened, edited]`が必要。無いと
> タイトルが`[手作業]`のIssueへ`71.manual-step`が自動で付かない）で、issue-deck側の
> `issue-labels.yml`は`types: [opened, edited, closed]`になっている。
>
> **取りこぼしは`schedule`が埋め直すようになった（#2010）。** `manual-step-label`ジョブは
> `schedule`・`workflow_dispatch`でも動き、タイトルが`[手作業]`で始まるopenなIssueのうち
> ラベルの無いものを拾い直す。したがって`schedule`を持つcallerであれば、`opened`・`edited`の
> 追記が遅れても最終的にはラベルが付く。**ただし遅れる**（cronの間隔ぶん）ため、
> `issues: types:`を揃えること自体は引き続き必要。

`claude-issue-dispatch.yml` のように技術スタックの差がある場合は `with:` で指定する。

```yaml
jobs:
  dispatch:
    uses: guchi-apps/issue-deck/.github/workflows/reusable-issue-dispatch.yml@workflows/v9
    with:
      runtime-setup: minimal    # node-db / node / minimal
      package-manager: npm      # npm / pnpm（既定は npm）
    secrets: inherit
    permissions:
      contents: write
      pull-requests: write
      issues: write
      actions: read
      id-token: write
```

`runtime-setup` の選び方は以下のとおり（アプリ12個の実態調査は[docs/cross-repo-automation.md](cross-repo-automation.md)を参照）。

| 値 | 対象 | 実行される準備 |
|---|---|---|
| `node-db` | Next.js + DB（Prisma等） | Node・依存インストール・DBマイグレーション・シード・Playwright |
| `node` | Next.js（DBなし） | Node・依存インストール・Playwright |
| `minimal` | 素のJS・依存パッケージなし | なし |

DBマイグレーションとシードは `db:migrate:deploy` / `db:seed:ci` を `--if-present` で呼ぶため、対象リポジトリにそのスクリプトが無ければ何もせず成功する。`scripts/ci-seed-user.mjs` も存在する場合のみ実行される。`inputs` を増やさずスタック差を吸収するための割り切り。

**判定は`prisma/`の有無で足りる。** `portfolio`（#1047の5周目）はNext.jsだが`prisma/`が無く、
`node`を選んだ。`--if-present`があるので`node-db`にしても壊れはしないが、MySQLサービス
コンテナの起動とマイグレーションの待ち時間が毎回乗るため、DBを使わないなら`node`にする。
**`node`では`database-name`は使われない**ので、指定せずに省く。

### 実装ステップが実行できるコマンド（許可リスト）

**無人実行のClaude Codeは許可リスト方式で、載っていないコマンドは拒否される。** 検証コマンドが
実行できるかは、`package.json`にscriptがあるかどうかとは別の話になる。

| 種別 | 許可されているもの |
|---|---|
| パッケージマネージャ | `package-manager`が`pnpm`なら`pnpm`、そうでなければ`npm`。**取り違え防止のためここだけ分ける** |
| JS実行系 | `node`・`npx`（常時。パッケージマネージャに依存しないため） |
| Python | `python`・`python3`・`pip`・`pip3`・`pytest`（常時） |
| 状態確認 | `ls`・`cat`・`head`・`tail`・`wc`（読み取り専用） |
| その他 | `git`・`gh`・`curl`・`grep`・`find`、`Edit`・`Write`・`Read`・`Grep`・`Glob` |

**書き込み・削除系（`mkdir`・`rm`・`mv`・`sed -i`）と`corepack`は意図的に許可していない。**
一時ファイルは`/tmp`直下へ直接書けばディレクトリ作成が要らず、ランナーは実行ごとに破棄される
ため掃除も要らない。一括置換は`Edit`の`replace_all`を使う。プロンプト側でそう案内している。

**コマンドを`&&`・`;`・`|`でつなぐと拒否される。** 許可判定はつないだ各コマンドごとに
行われるため、片方が未許可だと全体が落ちる。**改行して複数行に分けたコマンドも拒否される**
ことがある（`curl`が許可されているのに2行に分けて書いて拒否された実例がある）。

**この許可リストは`reusable-issue-dispatch.yml`・`reusable-claude-ci-fix.yml`・
`reusable-claude-conflict-resolve.yml`・`reusable-claude-pr-repair.yml`の4ファイルで同一に
保つ。** `src/lib/workflows/allowed-tools.test.ts`が一致をテストしている。

**Pythonはランナー標準のものを使う。** `setup-python`は入れていないため、CIが
`actions/setup-python`でバージョンを固定している場合はズレる可能性がある。厳密に揃える
必要が出たら`runtime-setup`のプリセット追加を検討する。

**Pythonを使うリポジトリでは`workflows/v10`以上を参照すること。** v9までは許可リストが
`pnpm`固定で、`python`・`pip`・`pytest`のいずれも実行できなかった（#1147）。`signaly`のように
**検証手段がPythonのテストしか無い**リポジトリでは、タグを下げると検証が一切できなくなる。

**Node系の依存は実装ステップの前にインストールされる（#931）。** `runtime-setup`が
`minimal`以外なら、撮影の有無によらず`npm ci`（または`pnpm install --frozen-lockfile`）が
走る。パッケージマネージャもPATHに通った状態で実装ステップが始まる。

以前は`24.screenshot-required`が付いているときだけ走っていた。**その結果、pnpmの
リポジトリで詰んだ。** `pnpm`自体がランナーに無く、入れるには`corepack`か`npm`が要るが
どちらも許可リストに無いため、エージェントが10回試して全部拒否され、76ターン・10分を
費やしてコード変更ゼロで停止した（issue-deck#1115のrunで実測）。

**Python・その他の言語の依存はインストールされない。** プリセットが無いため、
`pip install -r requirements.txt`は実装エージェント自身が実行する。CLAUDE.mdに
**どのディレクトリでどのコマンドを打つか**を書いておくと、この往復が減る。

**`minimal`のリポジトリでも依存はインストールされない。** 依存ゼロ・ロックファイル無しが
`minimal`を選ぶ条件なので通常は問題にならないが、サブディレクトリに依存がある構成
（`myroom`の`frontend/`）では、エージェントが自分で`cd frontend && npm ci`する必要がある。

これ以外のコマンド（`make`・`cargo`・`go`・`docker`等）が要るリポジトリは、そのままでは
検証できない。導入時に`package.json`・CI設定を見て、**検証コマンドが上の表に収まるかを
確認する**こと。収まらない場合は許可リストの拡張が必要になる。

**`minimal`は「Nodeを使わない」という意味ではない。** `solitaire`（#1047の6周目）は
`npm test`（`node --test tests`）でテストするが`minimal`を選んだ。判定基準は**依存パッケージと
ロックファイルの有無**であって、Nodeを使うかどうかではない。依存ゼロのリポジトリで`node`を
選ぶと、ロックファイルが無い状態で`npm ci`が走って失敗する。

**準備ステップは全てリポジトリルートで動く。** モノレポ的な構成で実際の依存がサブディレクトリに
ある場合、ルートを見て判定する。`myroom`（#1047の7周目）はルートの`package.json`が
バージョン管理用scriptのみ・`package-lock.json`も空のスタブ（`"packages": {}`）で、実際の依存は
`frontend/`にある。**この場合も`minimal`**で、`cd frontend && npm ci`は実装エージェント自身の
仕事になる。

**`package-manager`は`minimal`でも指定する意味がある。** 準備ステップには使われないが、
**実装ステップの許可ツールの出し分け**（上記「実装ステップが実行できるコマンド」）が
この値を見る（#1147）。`pnpm`にすると`npm`・`node`が許可されないため、npmのリポジトリで
`minimal`を選ぶ場合も`npm`にしておくこと。**Nodeを一切使わないリポジトリでも既定値の`npm`のまま
にする**（`signaly`。`pnpm`にすると`node`が許可されなくなり、後で困る）。

**`node-version`は指定しない選択もある。** `signaly`（#1047の8周目）はNodeが一切無い
（`package.json`がルートにもサブディレクトリにも無く、フロントエンドは素のHTML/JS）ため
指定していない。他の7リポジトリは全て指定している。


`node-version`は`runtime-setup`と独立した軸で、`cache:`を付けずに`actions/setup-node`を
呼ぶだけなので、**ロックファイルが無くても`minimal`と併用できる**。CIとNodeのバージョンを
揃えたいだけなら`node`へ格上げする必要はない。

なお`minimal`ではPlaywrightがインストールされないため、**`24.screenshot-required`は無人実行では
成立しない**。ラベル自体は残しつつ、ローカル実行専用として扱う旨をCLAUDE.mdへ書いておく。

### 素の Claude Code ワークフローがある場合は削除する

`/install-github-app` を実行したことのあるリポジトリには、`claude.yml`・`claude-code-review.yml`
が残っていることがある。**マルチエージェント運用のものではなく、そのままだと二重起動する。**

```yaml
# claude.yml（素）
on:
  issue_comment:
    types: [created]
if: contains(github.event.comment.body, '@claude')
```

`claude-issue-dispatch.yml` も同じ `issue_comment` で起動するため、**1つのコメントで Claude が
2回走る。** トークンを倍消費するうえ、2つの Claude が同じIssue・同じブランチを触って競合しうる。

さらに `claude.yml` は `contains` 判定である点が厄介で、**マルチエージェント運用が投稿する
進捗コメントや計画コメントの本文に `@claude` が含まれるだけでも反応する。** 意図しない起動が
連鎖する余地がある。

`claude-code-review.yml` は `pull_request` 起点で `claude-issue-dispatch.yml` とは重ならないが、
`claude-review-develop.yml` を入れる場合は重複する。運用を一本化するなら、あわせて削除する。

導入時に確認する。

```bash
gh api repos/guchi-apps/my-app/contents/.github/workflows --jq '.[].name'
```

削除したら、**再導入されないよう `CLAUDE.md` に理由を残す。** `/install-github-app` を
もう一度実行すると復活するため。

> `subscription-lists`（#1047の3周目）で実際に踏んだ。削除後に`@claude`コメントを投げて、
> `issue_comment`で起動したワークフローが`Claude Issue Dispatch`の1つだけであることを確認した。

### npm scriptが揃っていなくても導入できる

**「共有ワークフローが期待するnpm scriptを持たないリポジトリは導入が難しい」と考えなくてよい。**
実際にワークフローが呼ぶのは上記2つだけで、しかも次の二重の条件が付く。

- `24.screenshot-required` が付いたIssueの実行でのみ走る（通常の実装では呼ばれない）
- `--if-present` で保護されている（無ければ何もせず成功する）

`test`・`typecheck`・`lint` はワークフローからは呼ばれない。プロンプト（`implement.md`）が
「テスト・Lint・型チェック・ビルドを実行する」と指示するだけなので、**実行するコマンドは
そのリポジトリの実態に合わせればよい。**

したがって**scriptを増やして横並びに揃える必要は無い。** 代わりに、そのリポジトリの
検証コマンドを`CLAUDE.md`（または`AGENTS.md`）へ明記する。エージェントは存在しない
コマンドを探さずに済む。

> `car-care`（#1047の2周目）は`test`・`typecheck`・`db:migrate:deploy`のいずれも持たないが、
> callerの値は`meisai-lab`（すべて持つ）と完全に同一（`node-db`/`npm`/`20.19`）で済んだ。
> 適応が必要だったのは`AGENTS.md`に検証コマンド（`lint`・`build:ci`）を書くことだけ。

**ラッパー付きのコマンドがある場合は、CI向けの素の方を書く。** ローカル用のコマンドは
`.env`を要求するため、CI・無人実行では落ちる。どちらが素かは**リポジトリごとに違う**ので、
名前から推測せず`package.json`を見る。

| リポジトリ | 素（CI・無人実行向け） | ラッパー付き（ローカル用） | ラッパーの中身 |
|---|---|---|---|
| `car-care` | `build:ci` | `build` | `scripts/with-local-env.sh` |
| `asset-manager` | **`build`** | **`build:local`** | `scripts/with-local-env.sh` |
| `portfolio` | **`build`** | **`build:local`** | **`op run --env-file=.env.tpl`（1Password CLI）** |

**同じ`build`という名前で意味が逆**になっている。`asset-manager`にはさらに`check`
（`lint && typecheck && build:local`）があり、一見まとめて検証できそうだが`build:local`を
含むため無人実行では使えない。**「便利そうなまとめコマンド」ほど確認する。**

**ラッパーの中身によって失敗の仕方が変わる。** `with-local-env.sh`系は`.env`が無いことで
落ちるが、`portfolio`の`op run`は**`op`コマンド自体がrunnerに無い**ため`command not found`
で落ちる。後者はエラーメッセージからは環境変数の問題に見えないので、`package.json`を先に
読んでおかないと原因の切り分けに時間を取られる。

**検証コマンドが`lint`と`build`だけのリポジトリもある**（`portfolio`）。`typecheck`・`test`が
無いこと自体は問題ではない（ワークフローが呼ぶのは`--if-present`で保護されたDB系だけ）が、
CLAUDE.mdに**無いことを明記**しておかないと、エージェントが存在しないコマンドを探して
`package.json`を読み直す往復が発生する。

#### プロンプトの取得元（`prompts-ref`）

**他リポジトリから呼ぶ場合は必ず指定する。**

```yaml
    uses: guchi-apps/issue-deck/.github/workflows/reusable-issue-dispatch.yml@workflows/v9
    with:
      prompts-ref: workflows/v9   # ↑の uses: と同じタグを指定する
```

共有ワークフローは `actions/checkout`（`repository:` 未指定＝呼び出し元）でチェックアウトするため、**`.github/prompts/` 配下も呼び出し元リポジトリのものが読まれる**。指定しないと、プロンプトを持たないリポジトリでは最初のClaudeステップで落ちる。

- `prompts-ref` が空（既定）→ 呼び出し元の `.github/prompts/` を使う。**issue-deck 自身はこちら**
- 非空 → `guchi-apps/issue-deck` をその ref でチェックアウトし、そちらのプロンプトを使う

プロンプトを各リポジトリへコピーしない方針にしているのは、4ファイル・約48KBあり中身のほとんどが汎用である一方、**最も更新頻度が高い部分**だから。コピーすると、ワークフロー本体を集約した意味が薄れる。

`prompts-ref` を指定すると、issue-deck 側が `.shared-prompts/` へフルチェックアウトされる。プロンプトに加えて **使用量出力スクリプト（`.github/scripts/summarize-claude-usage.sh`）もそちらのものが使われる**ため、呼び出し元にスクリプトを置かなくてもトークン使用量のJob Summary出力が効く（#964）。どちらにも無い場合はスキップされ、ジョブは失敗しない。

##### なぜタグを2回書くのか

`uses:` の ref は式で書けず（`@${{ inputs.x }}` は不可）、再利用ワークフローが**自分の ref を知る手段も無い**ため、呼び出し元から渡してもらう以外に方法がない。上の例のように `uses:` の直下に並べて書くこと。

`uses:` のタグだけ上げて `prompts-ref` を据え置くと、**新しいワークフローで古いプロンプトが使われる**。タグを上げる際は必ず両方を更新する。

#### 実装ステップのNodeバージョン固定（`node-version`）

```yaml
    with:
      runtime-setup: minimal
      node-version: "20.19"
```

指定した場合のみ、実装（`mode=implement|additional`）の前に `actions/setup-node` でバージョンを固定する。未指定ならランナー既定のNodeが使われる（issue-deck自身は未指定）。

ランタイム準備側（`runtime-setup: node`/`node-db`）のSetup Nodeとは**目的が異なる**。あちらは撮影・DB準備のためのもので `24.screenshot-required` に紐づくが、こちらは撮影の有無によらず実装のたびに効く。プリセットに混ぜると、撮影を使わないリポジトリがバージョン固定のためだけに `node` プリセットを選ばざるを得ず、不要な依存インストールとPlaywrightのダウンロードまで走ってしまうため、直交する軸として独立させている。

なお `node-version` を指定しつつ `runtime-setup` が `node`/`node-db` で、かつ `24.screenshot-required` も付いている場合は `actions/setup-node` が2回走るが、同じバージョンの再実行はキャッシュヒットで数秒であり実害は無い。

#### リポジトリ固有の後処理（`post-implement-script`）

ランタイム準備のプリセットでは吸収できない、そのリポジトリ固有の後処理を差し込む口（#952）。

```yaml
    with:
      runtime-setup: minimal
      post-implement-script: scripts/ci-post-implement.sh
```

- 実装（`mode=implement|additional`）が**成功した後**、`dispatch`ジョブの最終ステップとして実行される。実装結果の検証・フォールバック通知より後に置いているため、後処理の失敗が「実装は完了したのに未完了として通知される」事態を招かない
- 未指定（既定）なら何もしない。issue-deck自身は使っていない
- スクリプトには以下が環境変数で渡る。**絞り込みはスクリプト側で行う**

  | 変数 | 内容 |
  |---|---|
  | `ISSUE_NUMBER` | 対象Issue番号 |
  | `BRANCH` | 実装ブランチ名（`issue-<番号>`） |
  | `MODE` | `implement` / `additional` |
  | `SCREENSHOT_REQUIRED` | `24.screenshot-required` の有無 |
  | `PREVIEW_REQUIRED` | `23.preview-required` の有無 |
  | `GH_TOKEN` / `GH_REPO` | `gh` コマンド用 |

ワークフロー側の `if:` に用途固有の条件（`SCREENSHOT_REQUIRED` など）を書いていないのは、そうするとこのフックが特定用途専用になり、他の後処理に使えなくなるため。

最初の利用者は shopping-list のスクリーンショット撮影。撮影の作法は「そのアプリをどう起動するか」に強く依存する（shopping-listは自前バックエンドを`NOTION_STUB`付きで起動し`/healthz`を待つ必要がある）ため、issue-deck方式（Claudeがプロンプト指示でスクリプトを実行し、スクリプト自身がサーバーを起動する）へ寄せるより、差し込み口を用意する方針とした。

- **参照はタグ固定とする。** `@develop`を参照するとissue-deck側の不具合が全アプリへ同時に波及する。issue-deck自身だけがローカルパス（`./.github/workflows/reusable-*.yml`）で常に最新を参照し、カナリアとして先に問題を検知する。
- **タグ名は `workflows/vN` 形式**（`v1`のような形にしない）。理由は2つある。
  - アプリのリリースタグ（`vX.Y.Z`、`deploy.yml`がmainから作成）と名前空間を分けるため
  - `release.yml`が`on: push: tags: ["v*"]`でGitHub Releaseを作るため。`v1`という名前でタグを切ると、その瞬間に意図しないReleaseが作られる
- **タグは再利用可能ワークフロー全体で1バージョン**であり、ワークフローごとに別体系にはしない（#934）。ラベル体系が複数のワークフローをまたいで共有されているため、個別にバージョンをずらすと整合が壊れる。

現在のタグと、含まれる再利用可能ワークフローの対応は以下のとおり。

| タグ | 含まれる再利用可能ワークフロー | 備考 |
|---|---|---|
| `workflows/v1` | `reusable-issue-labels.yml` | |
| `workflows/v2` | 上記 + `reusable-issue-dispatch.yml` | issue-deck自身での動作確認（#945）完了後に作成した |
| `workflows/v3` | 上記 | `post-implement-script` inputs を追加（#952） |
| `workflows/v4` | 上記 | `node-version` inputs を追加（#956） |
| `workflows/v5` | 上記 | `prompts-ref` inputs を追加（#960） |
| `workflows/v6` | 上記 | 使用量出力スクリプトも共有側から解決するよう修正（#964） |
| `workflows/v7` | 上記 | Organization `guchi-apps` への移行後に作成（#1009 Phase 4） |
| `workflows/v8` | 上記 | Phase 5 の前。ラベル遷移とStatus報告の両方を行う最後の版 |
| `workflows/v9` | 上記 | #991 Phase 5（#1010）で進捗ラベルを廃止し、Statusを唯一の正にした版。あわせて対象issue取得の警告を「対象なし」と「疎通不可」で出し分ける（#1124） |
| `workflows/v10`〜`workflows/v15` | 上記 + `reusable-release-develop-to-main.yml`・`reusable-claude-pr-repair.yml` | この表では個別に追えていない。内訳は`git log --oneline <前のタグ>..workflows/vN`で確認する |
| `workflows/v16` | 上記 + `reusable-version-tag-check.yml` | #1367。#1381でタグを作成し、#1459で`version-tag-check.yml`のcallerを対象14リポジトリへ配った（[docs/supported-repositories.md](supported-repositories.md)「`version-tag-check.yml`の配布状況」） |
| `workflows/v17` | 上記 | #1470。`reusable-issue-labels.yml`の`develop-pr-opened`が、`claude-review-develop.yml`を持たないリポジトリで`00.check-user`を付けるようになった版。**このタグを配るまで、対象リポジトリのdevelop向けPRは判定されないまま開いたまま残り続ける** |
| `workflows/v18` | 上記 | #1490。`00.check-user`を付ける全経路が、その理由を表す`01.check-*`もあわせて付けるようになった版。あわせて`claude-review-develop`・`claude-ci-fix`・`claude-conflict-resolve`・`release-develop-to-main`の`gh issue edit`に`gh label list`ガードを入れた。**このタグを配るまで、対象リポジトリでは理由ラベルが付かない**（`00.check-user`だけが付く従来どおりの動作） |
| `workflows/v19` | 上記 | #1548。`reusable-release-develop-to-main.yml`が`bump-kind` inputを受け取り、issue-deckの画面から上げ幅（major/minor/patch）を指定してリリースを起動できるようになった版。**タグの作成と配布は#1565で人が行う。** 配布と同時にcaller側へ`workflow_dispatch`の`bump_kind` inputと`with: bump-kind:`を足すまで、対象リポジトリでは画面で上げ幅を選ぶと「上げ幅の指定に未対応です」になる（自動判定での起動は従来どおり動く）。**caller側の追加は#1603で12リポジトリの配布PRへ入れた**（[supported-repositories.md](supported-repositories.md)「callerの`bump_kind`入力の配布状況」） |
| `workflows/v20` | 上記 | #1729（対応PRは#1738）。`reusable-release-develop-to-main.yml`が利用者向けの使い方（操作手順）も生成し、`RELEASE_USAGE`環境変数として`version` lifecycleスクリプトへ渡すようになった版。**タグの作成と画面からの配布は#1739で人が行った。** 配布しても、各アプリの`version`スクリプトが`RELEASE_USAGE`を受け取るまでそのアプリの更新履歴画面には出ない（バンプPR本文とissue-deckのリリースシートには出る）。受け取り方は本ガイドの「`RELEASE_USAGE`（使い方）の受け取り方」、対応状況は[supported-repositories.md](supported-repositories.md)「使い方の自動生成（`RELEASE_USAGE`）の対応状況」 |
| `workflows/v21` | 上記 | #1766。`reusable-issue-dispatch.yml`の質問応答（`mode=ask`）が、回答の投稿後に自分の受付コメントを削除し、回答できなかった場合はエラー通知ボット名義（`<!-- issue-deck-fallback-notice -->`）で通知するようになった版。回答の検証も件数比較から回答マーカーの有無へ変えた。**タグの作成と画面からの配布は人が行う。** 配るまで、対象リポジトリの質問は従来どおり受付コメントが残り、回答できなかった場合の通知も案内ボット名義のままになる（issue-deck側の「回答待ち」解除は配布前でも効く） |
| `workflows/v22` | 上記 | #1861（対応PRは#1868）。進捗の報告が一時的なAPI不調で失われても`Implementation`のまま取り残されない版。`develop-merge-sweep`が`Implementation`も走査し（マージ済みPRの先端とブランチの先端が一致するときだけ進める）、通知より先に進捗報告へissue番号を渡し、issue-deckへのPOST/GETに5xxと接続失敗に限った再試行が入った。**タグの作成と画面からの配布は#1870で人が行った。** 配るまで、対象リポジトリでは`develop-pr-opened`の報告が5xxに当たるとマージ済みのissueが`Implementation`に残り続ける |
| `workflows/v23` | 上記 | #1901。`reusable-issue-labels.yml`に`main-direct-pr-opened`・`main-direct-merged`が入り、**developを経由せず`issue-<番号>` → `main`のPRしか作らないリポジトリ**（`guchi-apps/docs`）でも`Develop PR` → `Done`まで進んでissueがcloseされるようになった版。**タグの作成と`docs`へのcaller新規配置は人が行う。** develop運用の既存リポジトリは`base.ref`の条件に一致しないため、配っても挙動は変わらない |
| `workflows/v24` | 上記 | #1999。`reusable-issue-labels.yml`の`develop-merge-sweep`が、**PRのマージとほぼ同時にpushされてdevelopへ入らないままのコミット**を検知して`00.check-user`＋`01.check-blocked`で人へ渡すようになった版（あわせて、developへ入っていないコミットが無ければ先端が違っても`Develop`へ進める）。**タグの作成と画面からの配布は人が行う。** 配るまで、対象リポジトリでは取り残しが15分おきに見送られ続けるだけで通知されない（`guchi-apps/subscription-lists#99`で実測） |
| `workflows/v25` | 上記 | #2042（対応PRは#2043）。`reusable-release-develop-to-main.yml`が作るバンプPRの本文が、実際の挙動どおり「CI通過後にdevelopへ自動マージされる」と案内するようになった版。それまでは直後で`gh pr merge --auto --merge`を実行しているにもかかわらず「自動マージはされません」と書いており、PRを見た人が手動マージを待つか、逆に放置して意図せずdevelopへ入っていた。**タグの作成と画面からの配布は人が行う。** 配るまで、対象リポジトリのバンプPRには誤った案内が出続ける（issue-deck自身はローカルパス参照のため配布前から直っている） |
| `workflows/v26` | 上記 | #2049。`reusable-sync-secrets.yml`が、同期スクリプトの失敗時にもログ（`FAIL <KEY>（理由）`の行と集計）と件数・項目名を出すようになった版。`run:`の既定シェル`bash -e {0}`の下で終了コードを`|| rc=$?`で受けていなかったため、**失敗したときだけ`cat "$LOG"`にも集計にも到達せず**、Actionsには`##[error]Process completed with exit code 1.`しか、画面には`同期=0 スキップ=0 失敗=0`としか出なかった（`guchi-apps/car-care#99`の切り分けが手作業になった）。**タグの作成と画面からの配布は人が行う。** 配るまで、対象リポジトリではシークレット同期が失敗しても理由が分からないままになる（issue-deck自身はローカルパス参照のため配布前から直っている）<br>あわせて#2106。`reusable-issue-labels.yml`の`manual-step-body-check`が、指摘が1件も無いときに空本文のコメントを投稿しようとして`Body cannot be blank`で落ちていたのを直した版。**まだタグを切っていないため、この行に足している。** 配るまで、対象リポジトリでは書式どおりの手作業Issueを起票するたびにジョブが1本失敗し、前回の指摘コメントも消えない<br>あわせて#2126。`reusable-claude-review-develop.yml`の`risk-check`が`permissions:`に`contents: read`を持つようになった版。**privateリポジトリではこれが無いとcheckoutが必ず失敗し、`claude-review`・`auto-merge`と両fallbackがすべてskipされる**（`Repository not found`。ジョブに`permissions:`を明示すると書かなかったスコープは`none`になるため）。**まだタグを切っていないため、この行に足している。** 配るまで、`vps`・`subpc`（どちらもprivate）へcallerを置いてもリスク判定・自動レビュー・自動マージが一切効かず、失敗の通知すら出ない（issue-deck自身はpublicで匿名cloneが通るため表面化していなかった）<br>あわせて#2135。`reusable-version-tag-check.yml`に`deploy-config-check`ジョブが入り、**mainへ入るまで露見しない`deploy.yml`の設定漏れ**（`appleboy/ssh-action`の`with.envs:`への追記漏れ・`tar`の対象に実在しないパス・`packageManager`のpnpmメジャー）をmain宛PRで落とすようになった版。**まだタグを切っていないため、この行に足している。** **callerの追加・書き換えは不要**で、参照タグを上げるだけで効き始める。配るまで、対象リポジトリでは従来どおりmainへマージした後の`deploy.yml`の失敗で初めて分かる |
| `workflows/v27` | 上記 | #2294。`reusable-issue-labels.yml`から`schedule`で動くジョブが無くなった版。`develop-merge-sweep`（マージ済みなのに`Develop PR`・`Implementation`へ取り残された進捗の回収）をジョブごと削除し、`manual-step-label`は`issues`イベント専用にした。どちらもissue-deck側の巡回（サブPCのpollerが叩く`POST /api/issues/progress-sweep`）へ移してある。**Actionsの課金はジョブ単位で1分未満切り上げのため、実測20秒・5秒のこの2ジョブがprivateリポジトリの従量課金のほとんどを占めていた**（docs/github-billing.md）。**タグの作成と画面からの配布は人が行う。** **callerの変更は不要**で、参照タグを上げれば`schedule`のrunは全ジョブskip（課金なし）になる。配るまで、対象リポジトリでは従来どおり15分ごとに2分ぶんのActionsが課金され続ける |
| `workflows/v28` | 上記 | #2391。`reusable-release-develop-to-main.yml`が、バンプのたびに生成した利用者向けの文面を`.github/release-notes.md`へ書き出すようになった版。リリース通知（`NOTIFY_KIND: リリース`）の本文はこのファイルから読むため、**配るまで対象リポジトリのリリース通知にはバージョン番号しか載らない**（`.github/scripts/signaly-notify.sh`はファイルが無ければ本文なしで送るので、欠けても表面化しない。実際に存在するのはissue-deckだけだった。#2421）。**2026-08-28に#2429でタグを切り、21リポジトリへ配布済み**（`uses:`・`prompts-ref`とも`workflows/v28`。配布PRは自動マージ）。**callerの追加・書き換えは不要**で、参照タグを上げれば効き始める<br>あわせて#835・#2388。`.github/workflows/`の`secrets.WORKFLOW_PAT`参照を、`actions/create-github-app-token@v3`が発行する1時間失効のインストールトークンへ寄せた版。**発行ステップに`if: vars.WORKFLOW_APP_ID != ''`が付いており、未登録のリポジトリではskipされて従来のPATへ落ちる**ので、配っただけでは挙動が変わらない（organization変数の登録が切り替えのスイッチ）。あわせて`reusable-claude-review-develop.yml`の`allowed_bots`へ`issue-deck[bot]`が入った<br>あわせて#2335。`reusable-issue-labels.yml`が、マージ時のラベル除去を3回まで再試行するようになった版（マージ済みなのに`00.check-user`＋`01.check-merge`が残る取りこぼしを減らす）<br>あわせて#2351・#2401・#2417。無人実行のプロンプト（`.github/prompts/implement.md`）に、調査の往復を減らす作法（Read/Grep/Globを使う・依存の無い調査は1応答でまとめる）と、手作業Issueの1Password手順を`op signin`なしで代行できる形に書く指示が入った版。**`uses:`だけでなく`prompts-ref`も同じタグへ上げないと届かない** |

> **新しく置くcallerは、既存callerの版に合わせず最新のタグで置く。** #1591で
> `clip-hive`・`ops-dashboard`へ`release-develop-to-main.yml`を足したときは、同じリポジトリの
> 他のcallerが`v18`のままでも新規ファイルだけ`v19`（`bump_kind`対応込み）で置いた。
> 既存callerの引き上げ（#1565）とは作業が別で、揃えて置くと引き上げ対象を自分で増やすことになる。

> **既存リポジトリのタグを`v9`へ上げる場合は順序に注意。** 進捗ラベルが残っているうちは、
> caller更新 → 動作確認 → ラベル削除の順を守る（下記「2. ラベル体系」の
> 「タグを上げる順序 — callerが先、ラベル削除が後」を参照）。

タグの一覧は `git tag --list 'workflows/*'`、各リポジトリが参照中のバージョンは対象リポジトリのcallerファイルで確認する（[docs/supported-repositories.md](supported-repositories.md)「参照方式のワークフローは sync-state の対象外」を参照）。

> **再利用可能ワークフローを新しく増やしたときは、初回の配置だけ手作業になる**（#1367）。
> `propagate-workflow-tag.yml`（画面の設定ダイアログから起動する配布）が行うのは、対象リポジトリに
> **既にある**ワークフローファイルの`@workflows/vN`・`prompts-ref`を新しいタグへ書き換えることだけで
> （`.github/scripts/propagate-workflow-tag.sh`の`sed`）、**新しいcallerファイルを追加はしない。**
> 各リポジトリへ最初の1回を置くところまでは、`71.manual-step`のIssueとして起票して人が行う。
> 2回目以降（タグの追随）は配布の対象に自動で乗る。
>
> **初回配置を`propagate-workflow-tag.yml`へ寄せていないのは、「どのリポジトリへ置くべきか」の
> 判定がワークフローごとに違うため**（#1459）。`version-tag-check.yml`は`deploy.yml`が
> `vX.Y.Z`タグを作るリポジトリだけが対象で、タグを作らないリポジトリ（`guchi-apps/vps`）には
> 守るものが無い。`claude-pr-repair.yml`は導入自体が任意。
> 配布側に持たせると「全リポジトリへ一律に配る」挙動にしかできず、対象の判断を毎回人が
> やり直すことになる。
>
> **例外は自動修復の3つ**（`claude-conflict-resolve.yml`・`claude-ci-fix.yml`・
> `claude-pr-repair.yml`。#1948）**と`claude-review-develop.yml`**（#1475）**・
> `deploy-retry.yml`**（#2134）。
> **対象の判定を機械で書けた**ため、別の配布
> （`propagate-repair-workflows.yml`）として初回配置まで自動化してある——自動修復の前2つと
> `claude-review-develop.yml`は`claude-issue-dispatch.yml`を持つリポジトリ、
> `claude-pr-repair.yml`は`release-develop-to-main.yml`を持つリポジトリ、
> `deploy-retry.yml`は`deploy.yml`を持つリポジトリが対象（ただし**`vps`・`subpc`へ配るかは
> 配布のときに判断する**。実機のインフラ設定を流すリポジトリのため）。`with:`は
> 同じリポジトリの`claude-issue-dispatch.yml`から写す（**`claude-review-develop.yml`だけは
> 写さない**。`reusable-claude-review-develop.yml`が`runtime-setup`等を宣言しておらず、
> 渡すと読み込みごと失敗するため）。**タグの配布とは別のボタン・別のワークフローで、
> こちらは自動マージしない。** 仕組みは[multi-agent/auto-repair.md](multi-agent/auto-repair.md)
> 「配布状況と、不足しているcallerの配布」を参照。
>
> **`claude-review-develop.yml`を配る前に、リポジトリ設定（`Allow auto-merge`と`develop`の
> ブランチ保護）を揃えておく**（#1475）。保護が無いと`gh pr merge --auto`が「既にマージ
> 可能」として断られ、callerを置いても自動マージは1本も成立しない。**設定はワークフローから
> は変えられない**（`WORKFLOW_PAT`がAdministrationを持たない）ため、
> `scripts/setup-develop-auto-merge.sh`をorg owner本人の`gh`で一度だけ実行する。配布側は
> 前提が揃っているかを読んで警告するだけ。下記「`develop`のブランチ保護は自動マージの前提」を参照。
- **`permissions`はcaller側で付与する。** 呼ばれる側の権限はcallerの付与範囲を超えられない。
- **`secrets: inherit`は不要**（`secrets.GITHUB_TOKEN`は再利用可能ワークフローでも自動的に利用可能）。ただしリポジトリ固有のsecretsを使うワークフローでは必要になる。その場合、渡るのは**caller側リポジトリのsecrets**であるため、各リポジトリに個別の設定が要る。`reusable-issue-labels.yml`は`inherit`ではなく`PROGRESS_REPORT_SECRET`だけを個別に渡す形にしている（呼ばれる側へ渡る秘密を最小限に保つため）。
- **`vars`は`secrets`と違い、渡さなくても参照できる**（caller側リポジトリ・organizationの変数として解決される）。`APP_BASE_URL`はこの経路で届くため、caller側に`with:`も`secrets:`も要らない。
- issue-deckがprivateリポジトリになった場合、または対象リポジトリがprivateの場合は、issue-deck側の Settings → Actions → Access で同一オーナーからのアクセスを許可する必要がある（publicどうしなら設定不要）。

### プロンプト・補助スクリプトはコピーしない

`claude-issue-dispatch.yml`のプロンプト本文は、ワークフローYAMLではなく`.github/prompts/`配下のMarkdownに置いている（#907。GitHub Actionsの式テンプレート長の上限21,000バイトを避けるため。詳細は[docs/multi-agent/prompts-and-models.md](multi-agent/prompts-and-models.md)）。

**参照方式では、これらを対象リポジトリへコピーする必要はない。** `prompts-ref`を指定すれば、issue-deck側が`.shared-prompts/`へチェックアウトされ、そちらのファイルが使われる（#960・#964）。

| ファイル | 参照方式での扱い |
|---|---|
| `.github/prompts/{plan,plan-review,split,question,implement}.md` | **コピー不要。** `prompts-ref`で解決される |
| `.github/scripts/summarize-claude-usage.sh` | **コピー不要。** 同じく`prompts-ref`で解決される |
| `scripts/fleet-status.sh` | **コピー不要。** 同じく`prompts-ref`で解決される（計画レビューへ並行状況を差し込む。#1218。無くてもその節が空になるだけでジョブは失敗しない） |

**`prompts-ref`を指定し忘れると、呼び出し元リポジトリの`.github/prompts/`が読まれ、存在しないため最初のClaudeステップで落ちる。** 使用量出力スクリプトも同様に解決されるため、これが無いと`exit 127`でジョブが失敗する（#964で実際に発生）。

対象リポジトリ固有のプロンプトを使いたい場合に限り、`.github/prompts/`配下を自分で用意して`prompts-ref`を未指定にする。ただしプロンプトは5ファイル・約78KBで最も更新頻度が高い部分のため、**特段の理由がなければ共有側を使う**こと。

プロンプト内の動的な値は`${ISSUE_NUMBER}`・`${BRANCH}`・`${PR_URL}`・`${MODE}`・`${REPOSITORY}`・`${RUN_URL}`・`${PACKAGE_MANAGER}`（計画レビューのみ`${FLEET_STATUS}`も）のプレースホルダで表現され、ワークフロー側の「〜プロンプトを組み立てる」ステップが`envsubst`で埋めて環境変数へ格納する。

### 参考: issue-deckの全ワークフロー一覧

上記6ファイル以外にissue-deckが持つワークフローは、issue-deck自身のCI・デプロイ用途に固有であり、
マルチエージェント運用の移植対象ではない（参考として一覧化する）。

| ファイル | 用途 | 移植要否 |
|---|---|---|
| `ci.yml` | lint・型チェック・テスト・ビルドを実行するCI本体 | 対象リポジトリごとに固有の内容のため、そのままの移植ではなく参考にする程度 |
| `deploy.yml` | `main`へのpushをトリガーにしたPM2デプロイ | issue-deck固有の本番環境向け。不要 |
| `release.yml` | リリースタグ関連の処理 | issue-deck固有。不要 |
| `load-secrets-check.yml` | シークレットの供給元（GitHub／1Password）を検証する（`workflow_dispatch`）。本番には触れず、解決できたかどうかと解決できなかった項目名だけを報告する（#1306） | **展開時に有用。** 対象リポジトリへGitHub側のsecret/variableを投入したあと、`deploy.yml`を切り替える前にこれで確認できる |
| `propagate-workflow-tag.yml` | 共有ワークフローの参照タグ（`uses:`・`prompts-ref`）を、展開済みの他リポジトリへ配るPRを作成する（`workflow_dispatch`）。issue-deck画面（設定ダイアログ）から起動される（#1173） | issue-deck固有（配布元としての役割）。対象リポジトリ側には何もコピーしない。不要 |
| `propagate-shared-files.yml` | ワークフロー以外の配布物（`.github/scripts/signaly-notify.sh`等、`.github/scripts/`配下にコピーして使うファイル）を、配布元（issue-deck）の内容へそろえるPRを配布先ごとに作成する（`workflow_dispatch`）。issue-deck画面（設定＞フリート運用＞共有ワークフローのバージョン「共有スクリプト」欄）から起動される（#2240） | issue-deck固有（配布元としての役割）。対象リポジトリ側には何もコピーしない。不要 |
| `sync-secrets.yml` | 1Password（値の正）から、そのリポジトリのGitHub secret / variableへ値を同期する（`workflow_dispatch`）。本体は`reusable-sync-secrets.yml`で、ここは薄いcaller。issue-deck画面（設定ダイアログ → シークレットの同期）から起動される（#1309） | **展開する。** 下記「シークレット同期を画面のボタンから起こす」を参照 |
| `reusable-sync-secrets.yml` | 上記の本体（`workflow_call`）。`scripts/sync-github-secrets.sh`をそのまま実行し、結果（件数と、同期・スキップ・失敗した項目名だけ）をissue-deckへ報告する（#1309・#2022） | 配布元としてissue-deckに置く。対象リポジトリはcallerから`@workflows/vN`で参照する |

## 2. ラベル体系

マルチエージェント運用のオプション制御に使う9個のラベルは、issue-deckリポジトリに
手動で作成したカスタムラベルであり、導入前の他リポジトリには存在しない。

**ラベルの正はこのissue-deckリポジトリに置いている。** `guchi-apps/docs`の`label-sync/`にある
同期スクリプトで、issue-deckをソースとして対象リポジトリへ一括作成できる。

```bash
cd /home/guchi/apps/_docs/label-sync
GITHUB_USER=guchi-apps ./sync-labels.sh dry-run --from issue-deck --to my-app --delete-unmanaged
GITHUB_USER=guchi-apps ./sync-labels.sh apply   --from issue-deck --to my-app --delete-unmanaged
```

**`GITHUB_USER=guchi-apps`を必ず付ける。** スクリプトの既定値は組織移行前の`m-guchi`のままで
（#996の移行に追随していない）、省略すると存在しないリポジトリを見に行く。

**`apply`は`[y/N]`の対話確認を求める。** `--delete-unmanaged`を付けた場合は警告も出す。
自動化のつもりで非対話に流すと、**警告だけ出して何も変更せず正常終了する**ため、
成功したように見えて実際には同期されていない。実行後は必ず`gh label list`で結果を確かめる。

```bash
gh label list --repo guchi-apps/my-app --limit 60 --json name --jq '[.[].name]|sort|join(" ")'
```

### ラベルが入る経路は2つで、Organizationのデフォルトラベルは採らない（#1002）

新しいリポジトリへラベルが入る経路は次の2つ。**どちらもissue-deckのラベルを正にしている。**

| 経路 | 使うとき |
|---|---|
| 画面の「新規アプリを立ち上げる」がAPIで写す（[`src/lib/github/repositories-api.ts`](../src/lib/github/repositories-api.ts)の`cloneRepositoryLabels`） | issue-deckの導線でリポジトリを作ったとき（既定） |
| `guchi-apps/docs`の`label-sync/sync-labels.sh`（1件なら`gh label clone --force`） | 導線を通さず作ったリポジトリ・既存リポジトリの差分是正 |

GitHubにはOrganization単位で「新規リポジトリに自動で入るラベル」を定義する機能
（Organization Settings → Code, planning, and automation → Repository → Repository defaults）が
あるが、**採用していない**（#1002で見送りを決めた）。

- **効くのは新規リポジトリだけで、既存リポジトリには一切適用されない**
  （[Managing default labels for repositories in your organization](https://docs.github.com/en/organizations/managing-organization-settings/managing-default-labels-for-repositories-in-your-organization)）。
  `sync-labels.sh`の置き換えにはならない
- **その唯一の適用先である「新規リポジトリへの初期投入」は、立ち上げ導線が既にAPIで済ませている**
  （#2188・#2247）。GitHub既定の`bug`・`documentation`等を消すところまで自動で揃うため、
  重ねて設定しても増える効果が無い
- **Organizationのデフォルトラベルを操作するREST APIは提供されていない**
  （`gh api orgs/guchi-apps/labels`は`Not Found`）。登録も更新もブラウザでの手作業になり、
  ラベルを1つ足すたびに正（issue-deck）とは別に手で直す場所が増える

### 既存の別世代のラベルがあるリポジトリ

導入前のリポジトリは旧世代のラベル体系を持っていることが多い（`01.wip`・`22.preview-required`・
`10.Priority: High`など）。**`--delete-unmanaged`を使い、旧ラベルを残さない。** 新旧が併存すると
どちらを付けるか迷い、ワークフローが参照する名前と食い違ったまま気づけない。

**削除は、そのラベルが付いているIssueからの除去でもある。** 実行前に対象を数え、
**特に進捗を表していたラベルが付いたopenなIssueを控えておく**（次項）。

```bash
R=guchi-apps/my-app
for l in "01.wip" "03.d:marge" "05.develop" "07.m:marge" "09.main"; do
  gh issue list --repo $R --state open --label "$l" --json number,title \
    --jq '.[] | "  '"$l"' → #\(.number) \(.title)"'
done
```

### 進捗ラベルが唯一の状態記録になっている（重要）

**旧世代のリポジトリでは、進捗ラベルがそのIssueの状態を示す唯一の記録である。**
issue-deck・dayspan・shopping-listのように既に盤面へ載っているリポジトリと違い、
Statusという写しが存在しない。

そして**盤面へ載せる処理（`addMissingProjectItems`）は、追加したアイテムのStatusを一律`Ready`に
する**。したがってラベルを消してから載せると、「developへマージ済みだが本番未反映」といった
状態が失われ、すべて未着手として並ぶ。

手順は次のとおり。

1. ラベル同期の**前**に、進捗ラベルが付いたopenなIssueを控える（上のコマンド）
2. ラベルを同期する（旧進捗ラベルは削除される）
3. callerを置き、盤面へ載せる
4. 控えた状態を進捗報告APIで書き戻す

```bash
curl -sS -X POST "$APP_BASE_URL/api/progress" \
  -H "Authorization: Bearer $PROGRESS_REPORT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"repository":"guchi-apps/my-app","issue":66,"status":"develop"}'
```

`status`に渡すのは`ProgressStatusKey`（`planning`・`implementation`・`develop-pr`・`develop`・
`release`・`done`）。旧ラベルとの対応は
[progress-status-architecture.md](progress-status-architecture.md)の対応表を参照。

**このAPIは盤面に無いIssueを自分で載せてから書く**（#1036）ため、再同期を待つ必要はない。

同期スクリプトはissue-deckの全ラベルを配るため、下記の条件系ラベルに加えて`30.bug`・
`51.improvement`等の分類用ラベルもあわせて作成される。番号帯そのものの意味と全ラベルの一覧は
[multi-agent/labels.md](multi-agent/labels.md)「ラベルの番号帯の設計」を参照。ラベルを個別に
作りたい場合は次の`gh label create`を使う。

| ラベル | 色 | 説明 | 用途 |
|---|---|---|---|
| `00.check-user` | `f0883e` | ユーザーの確認・指示が必要 | 承認待ち・自動マージ保留の合図。他の状態ラベルと併用 |
| `01.check-*` | `fef2c0` | `00.check-user`が付いた理由（`01.check-plan`・`01.check-input`・`01.check-merge`・`01.check-blocked`・`01.check-answered`の5枚。#1490） | `00.check-user`とのANDでしか読まれず、単独では意味を持たない。未配布のリポジトリでは付与が黙ってスキップされる |
| `11.local` | `e99695` | ローカル(VSCode等)で対応中。無人実行ワークフローを起動しない | 付いている間`claude-issue-dispatch.yml`が計画・実装・分割・追加対応を行わない（読み取り専用の質問応答のみ例外）。ローカルセッションとの二重起動防止 |
| `21.plan-required` | `d4c5f9` | 計画の確認・承認が必要 | 実装前にPlan modeでの計画提示を必須にする |
| `22.merge-confirm-required` | `d4c5f9` | developへのマージ前に人間の確認・承認が必要 | 内容によらず常に`00.check-user`を付与させる |
| `23.preview-required` | `d4c5f9` | 画面プレビューでの確認・承認が必要 | PR作成前に開発サーバーURLでの確認を必須にする |
| `24.screenshot-required` | `d4c5f9` | スクリーンショットでの視覚確認・承認が必要 | PR作成前にスクリーンショット取得・承認を必須にする |
| `25.artifact-required` | `d4c5f9` | アーティファクトでの視覚確認・承認が必要 | **実装着手前**に見た目のアーティファクト公開・承認を必須にする（ローカル実行専用。#1473・#1540。配布先は限られる。**配っていないリポジトリでは`62.design`による既定ONも効かない**——存在しないラベル名を付与するとその場で作られてしまうため。#1956） |
| `70.confirm` | `5319e7` | 確認項目（実施するか検討必要） | 計画提示ステップ・質問応答ステップが関連Issueを自発的に起票する際に付与し、実装フローへ自動で乗らないようにする（#735・#1528） |
| `71.manual-step` | `d876e3` | ユーザー自身の手作業が必要（エージェントが代行できない） | デプロイ後に残る手作業を単独Issueとして起票する際に付与し、issue-deckの「ユーザーの作業待ち」ビューへ載せる（[multi-agent/labels.md](multi-agent/labels.md)） |

> **進捗ラベル（`01.planning`〜`09.main`）は作成しない。** #991 Phase 5（#1010）で廃止し、進捗は
> GitHub ProjectsのStatusで管理する（[progress-status-architecture.md](progress-status-architecture.md)）。
> ここに残るのは条件系ラベル（Status = 今どこにいるか、Label = どんな性質・条件があるか）だけ。

### 画面から一括でタグ更新PRを作る

**issue-deckのアプリ設定ダイアログに「共有ワークフローのバージョン」の節がある**（#985・#1173）。
各リポジトリが参照しているタグを一覧し、更新が必要なものへPRを一括作成できる。

一覧は状態でグループ分けして出す（#1602）。同じ文言が14行並ぶだけの一覧では、何件が
未更新なのかを数えないと分からなかったため。

| グループ | 意味 | 行の表示 |
|---|---|---|
| **更新が必要** | issue-deck側の改善が届いていない | `v18 → v19`。`uses`と`prompts-ref`の不一致はここに別途出す（**新しいワークフローで古いプロンプトが使われる**別種の異常） |
| **更新PRの確認待ち** | 更新PRが既にopen。**この行は配布の対象から外れる** | PR番号へのリンク |
| **最新** | 最新タグを参照している | 既定でたたむ |

**上げ忘れても何も起きないため、この一覧が唯一の気づく手段になる。** `workflows/v10`は
car-careだけに配られ、他9リポジトリはv9のまま残っていた（#1147の修正が届いていない状態）。

#### 一覧の対象は「共有ワークフローを参照しているか」で決める（#2303）

母集団は**連携済み・アーカイブ済みでないリポジトリすべて**で、`.github/workflows/`に
`@workflows/vN`の参照が1つも無いものだけを落とす（`collectWorkflowTags`）。

**`Repository.hasClaudeWorkflow`で絞ってはいけない。** あれは`claude-issue-dispatch.yml`の
有無、つまり**無人実行に対応しているか**の列で、「共有ワークフローを参照しているか」とは
別の軸である。絞っていた間、`issue-labels.yml`だけで共有ワークフローを参照している
`vps`・`docs`・`subpc`・`claude-config`・`question`は一覧にも配布にも永久に現れなかった。

実害が出ている。#2294で`reusable-issue-labels.yml`から`schedule`ジョブを外し
`workflows/v27`を配ったところ、**PRが作られたのは15リポジトリで、課金が発生している
`vps`・`docs`・`subpc`・`claude-config`は1件も含まれず**、目的の従量課金停止が達成できて
いなかった（4件とも`claude-issue-dispatch.yml`が404だったため）。同じ代用は
`/api/repositories/release-pending-merges`が#1727で先に取り除いている。

**広がるのはタグ配布と共有スクリプトの更新だけで、callerの新規配布は広がらない。**
`REPAIR_WORKFLOW_SPECS`の`requires`はすべて`claude-issue-dispatch.yml`を含んでおり、
持たないリポジトリは配布の対象外になる（下記
[supported-repositories.md](supported-repositories.md)「画面の配布ボタンの対象外なので
手で配る」）。配布スクリプトが参照タグと`with:`の値をそのcallerから写すため、無ければ
`fail`で落ちるからで、挙げるとボタンを押した時点で必ず失敗する。

#### 次に配るタグも同じ画面から切る（#1876・#2476）

配布（既存タグを各リポジトリへ配る）は自動化されていたが、**配るタグを切る操作だけが手作業
として残っていた**（`workflows/v20`・`v21`・`v22`で毎回`71.manual-step`のIssueが立っていた）。
そのため同じボタンの並びに「新しいタグを切って配る」を置き、`POST /api/workflow-tags/release`
が**次の版数を`main`の先端に切ってから**配布を起動する。`develop`は見ない（まだ本番へ出て
いないワークフローが全リポジトリで走り出すため）。

**このボタンは未更新の件数で出し分けない**（#2476）。「N件を`vNN`へ更新する」は配る先が
無ければ押す意味が無いので未更新1件以上が条件でよいが、**タグを切るのは逆で、全リポジトリが
最新タグに揃った＝配布が一巡した状態こそ、次のタグを切る場面**である。2つを同じ
`targets.length > 0`の中に入れていたため、その状態でだけ導線が消え、#1876で画面へ統合した
はずの手作業が元の行き止まりに戻っていた。**表示条件は「その操作をしたい状況」で決める。
並んでいるボタンでも、同じ条件とは限らない。**

押す前の判断材料として、ボタンの下に`main`が最新タグからどれだけ進んでいるかを出す
（`sourceAhead`）。進んでいなければ切っても中身は最新タグと同じで、全リポジトリへ配り直す
だけになる。**押せなくはしない**——切り直したい場面はあるので、無駄打ちだと分かれば足りる。
取得はGraphQLの`Ref.compare(headRef: "main")`で行い、**RESTの`/compare`は使わない**
（あちらは差分のコミットとファイルまで返すため、画面を開くたび・配布の実行中は10秒ごとに
数百KBを運ぶことになる）。

#### 更新PRは既定で自動マージする（#1602）

チェックボックス「作成したPRを自動でマージする」が既定でON。ONのときの配布は次のように動く。

1. 配布先に**Issueを作らず**、`workflow-tag/vN`ブランチでPRだけを作る（マージ後に人が閉じる
   だけのIssueが、配布のたびにリポジトリ数ぶん残るのを避けるため）
2. リポジトリのauto-mergeを有効化したうえで、`gh pr merge --auto --squash`で予約する。
   必須チェックを持つリポジトリでは**CIの成功後にマージされる**
3. 予約が使えない（auto-mergeを有効化できない・必須チェックが無く「既にマージ可能」と
   断られる）場合はその場でマージする
4. どれも通らなければ**PRを残して警告**にとどめる。人がマージすれば従来と同じ結果になり、
   1件の失敗で残りの配布は止まらない

チェックを外すと従来どおりIssue＋PRの作成までで止まり、マージは人が行う。

**この自動マージはCLAUDE.mdの自動マージ不可カテゴリ（GitHub Actionsの変更）に対する唯一の
例外で、対象はこの配布PRに限られる。** 差分が`@workflows/vN`と`prompts-ref`の置換だけの
機械的なPRで、配るタグ自体はissue-deck側で確認を通してから切っているため、配布先で見ても
判断材料が増えない。

#### 連続して押せないようにしてある（#1602）

起動は数秒で返るが、PRが出来上がるまでは数分かかる。その間に押せると**同じリポジトリへ
2本目のPRが作られる**（参照タグはマージされるまで古いままなので、対象からも消えない）。
そのため次の3か所で止めている。

- 画面: 配布ワークフローの**実行状態を取得して**ボタンを無効にする（画面を開き直しても効く）
- API: `POST /api/workflow-tags/propagate`が実行中なら`409`で断る
- 対象の決め方: 更新PRが既にopenのリポジトリを対象から外す（`propagationTargets`）

#### 取得はGraphQLでまとめる（RESTで1ファイルずつ読まない）

この一覧は**全リポジトリの`.github/workflows/`にある全ワークフローの本文**を必要とする。
どのファイルが共有ワークフローを参照しているかは、名前では分からず本文の`uses:`を見るまで
判別できないためで、`ci.yml`・`deploy.yml`のような無関係なファイルも読む必要がある。

RESTで「ディレクトリ一覧」→「ファイルごとの内容」と読むと、リポジトリあたり
`1 + ワークフロー数`のリクエストになる。実測では**141リクエスト・42秒**かかり、その42秒の
どこかで1回でも失敗すればパネル全体が「取得に失敗しました」になっていた（本番では`503`。#1503）。

**GraphQLならTreeの`entries`からBlobの`text`まで1往復で取れる。** リポジトリをエイリアス
（`r0`・`r1`…）で並べれば複数リポジトリを1本のクエリにまとめられ、同じ内容が**3リクエスト・
約4秒**で揃う（[`lib/github/workflow-tags.ts`](../src/lib/github/workflow-tags.ts)）。
GraphQLのレート制限はRESTと別枠のため、RESTの5,000回/時も消費しない。

同じ手は「ブランチ」画面でも使っている（#1455。[code-map.md](code-map.md)）。
**リポジトリ数・ファイル数に比例して往復が増える作りにしない**のが共通の判断。

まとめ取りで注意する点は2つ。

- **トークンはインストール単位**なので、1本のクエリに混ぜられるのは同じインストールに属する
  リポジトリだけ。
- **一部のエイリアスだけ解決できなかった場合、GraphQLは`data`と`errors`を同時に返す**
  （DBに残っている削除済みリポジトリなど）。`githubGraphql`は既定で`errors`があれば全体を
  失敗にするため、まとめ取りでは`allowPartialData`を立てて残りを表示する。

### 再利用可能ワークフローが呼び出し元のファイルを前提にしない

**呼び出し元に無いファイルを実行すると、本来の処理が成功していてもジョブ全体が失敗する。**

実際に踏んだ形（#1181）。`reusable-release-develop-to-main.yml` が
`.github/scripts/summarize-claude-usage.sh` を直接実行していたため、`signaly` で
**バージョンbump自体は成功しバンプPRも作られたのに、使用量出力のステップだけが落ちて
ジョブが失敗**した。

**このスクリプトを持っているのは10リポジトリ中 `dayspan` だけだった。**

補助的な処理は**存在するときだけ実行する**。

```yaml
run: |
  USAGE=.github/scripts/summarize-claude-usage.sh
  if [ -x "$USAGE" ]; then
    "$USAGE" "<ステップ名>" "<execution_file>"
  else
    echo "$USAGE が無いため、使用量のJob Summary出力はスキップします"
  fi
```

`reusable-issue-dispatch.yml` は `prompts-ref` 経由で共有側のスクリプトを使えるが
（#964）、リリース側は呼び出し元のcheckoutしか持たないため、無ければスキップする方針にした。

**「本体は成功しているのにジョブが失敗する」形は原因が分かりにくい。** ステップ単位の
conclusion を見ないと、どこで落ちたか特定できない。

### 呼ばれる側の権限は caller の付与範囲を超えられない

**超えると `startup_failure` になる。** ジョブが1つも作られず、ログも残らない。#1181 で実際に踏んだ。

```yaml
# caller
jobs:
  release:
    uses: ./.github/workflows/reusable-release-develop-to-main.yml
    permissions:
      issues: write   # ← 呼ばれる側の全ジョブが要求する範囲を満たす必要がある
```

**通常のワークフローとルールが違う。** 通常は job が workflow レベルの既定を上回る指定をして
よいが、**再利用可能ワークフローでは caller が渡した範囲が上限**になる。

実際に踏んだ形。`release-develop-to-main.yml` は元のコピー方式で
「workflowレベル `issues: read` ＋ `notify-failure` ジョブだけ `issues: write`」と書かれており、
これはコピー方式では合法だった。再利用可能化した途端に超過と判定される。

**`src/lib/workflows/reusable-workflow-contract.test.ts` がこの超過を検知する。**
ローカルパス参照の caller を辿り、呼ばれる側の各ジョブが要求する権限と突き合わせる。

#### トップレベルの `concurrency`・`permissions` は原因ではない

**最初はこれを疑って外したが、間違いだった。** 実際に動いている例がある。

| ファイル | トップレベル | 状態 |
|---|---|---|
| `deploy-preview.yml`（#1308で廃止） | `concurrency` あり | `workflow_call` で呼ばれて**正常動作**していた |
| `reusable-issue-labels.yml` | `permissions` あり | 同上 |

**`startup_failure` は原因が分かりにくい。** ジョブが作られないためログが無く、
`gh run view` も「This run likely failed because of a workflow file issue.」としか出さない。
YAMLとしては妥当なので構文チェックも通る。**推測で直すと、真因を潰さないまま2回目の失敗を招く**
（実際そうなった）。

### リリースワークフローのバージョン管理方式

`release-develop-to-main.yml`は**バージョンの差だけで状態を判定する**（`main`と`develop`の
バージョンが同じならバンプPRを作り、違えばdevelop→mainのPRを作る）。そのため
**どこにバージョンがあるか**をcallerが伝える必要がある。

| input | 既定 | 用途 |
|---|---|---|
| `version-file` | `package.json` | バージョンを読み書きするファイル |
| `version-query` | `.version` | 値を取り出すjq式 |
| `bump-command` | 空 | 空なら`npm version <新版> --no-git-tag-version` |

11リポジトリでの実測値（#1181）。

| バージョンの場所 | 該当 |
|---|---|
| `package.json` | 9件 |
| **`frontend/package.json`** | **`myroom`**（ルートの`package.json`は`version`を持たない） |
| **`version.json`** | **`signaly`**（Nodeを一切使わないため`package.json`が無い） |

**`version-query`は11件すべて`.version`だった。** 実質の差異は`version-file`だけ。

#### `bump-command` が要るのはどんなときか

**`npm version`を使う理由は「バージョンを書き換えること」ではなく、`version` lifecycle
スクリプトを起動すること。** これが更新履歴フック（`RELEASE_CHANGELOG`）と使い方フック
（`RELEASE_USAGE`・#1729）の土台になっている
（`npm pkg set`ではlifecycleスクリプトが起動しない）。

`bump-command`が要るのは次の2つのどちらかに当てはまるときで、それ以外は既定値でよい。

**1. ルートに`package.json`が無い**（`npm version`がそのままでは使えない）

```yaml
# myroom: frontend/ のpackage.jsonを対象にする（バージョン番号を受け取る）
bump-command: npm version "$NEW_VERSION" --no-git-tag-version --prefix frontend
# signaly: Pythonのスクリプトで version.json を書き換える（上げ幅を受け取る）
bump-command: python3 scripts/bump_version.py "$BUMP_KIND"
```

**2. `preversion`に依存関係を要するコマンドがある**（#1591）

**共有ワークフローはバージョンbumpのために依存関係をインストールしない。**
`reusable-release-develop-to-main.yml`には`setup-node`も`npm ci`も無く、`actions/checkout`直後の
チェックアウトでいきなり`npm version`を叩く。`preversion: npm test`（`eslint && tsc`）を持つ
リポジトリでは、これが`node_modules`不在で走って`npm error code 127`（`eslint: not found`）に
なり、bumpステップごと落ちる。

```yaml
# meisai-lab・clip-hive: preversion を止め、version フックの中身は明示的に実行して補う
bump-command: npm version "$NEW_VERSION" --no-git-tag-version --ignore-scripts && npm_package_version="$NEW_VERSION" node scripts/version-changelog.mjs
```

`--ignore-scripts`は更新履歴を書く`version`フックまで止めてしまうため、その中身を直接呼ぶ。
**このとき`npm_package_version`を明示的に渡す**——スクリプトはnpm lifecycle経由で実行される
前提でバージョン番号をこの環境変数から読むため、直接実行では空になる。
`version`フック内の`git add`は、共有ワークフローがbumpコミット前に`git add -A`するため不要。

**`preversion`自体は消さない。** ローカルで`npm version`を叩いたときのガードとして機能しており、
品質確認はバンプPR上のCIでも行われる。逆に、**これから`version` lifecycleを足すリポジトリでは
`preversion`を作らない**（`ops-dashboard`はこの形にしたため`bump-command`が要らなかった）。
`version`フックから呼ぶスクリプトも、Node標準モジュールだけで書くこと。

**スクリプトによって受け取る引数が違う。** 次の4つが環境変数で渡るので、実装に合わせて選ぶ。

| 変数 | 例 |
|---|---|
| `NEW_VERSION` | `1.5.9`（バージョン番号そのもの） |
| **`BUMP_KIND`** | **`patch` / `minor` / `major`（上げ幅）** |
| `RELEASE_CHANGELOG` | 利用者向けの更新履歴文言 |
| `RELEASE_USAGE` | 利用者向けの操作手順（#1729） |

`signaly`の`scripts/bump_version.py`は**上げ幅を受け取る**形で、`NEW_VERSION`を渡すと
`使い方: python scripts/bump_version.py [patch|minor|major]`で失敗する（#1181で実際に踏んだ）。
**呼ぶ前にスクリプトの引数を確認すること。**

**4つとも環境変数として渡る**（`NEW_VERSION` はステップ内で計算した値を `export` している）。
`bump-command` は `bash -c` の子プロセスで動くため、`export` を忘れると空文字が渡る。
`myroom` で `npm error Invalid version: ` となり、これで発覚した（#1181）。

#### `RELEASE_USAGE`（使い方）の受け取り方

`RELEASE_CHANGELOG`が**「何が変わったか」**であるのに対し、`RELEASE_USAGE`は
**「どう使うか」**（どこを開く / 何を押す・実行する / どうなれば成功か）を、`1. `で始まる
番号付きの行として3〜5行で渡す（#1729）。「新しい機能が入ったのは分かるが、どこを押せば
使えるのか分からない」を解消するためのもので、更新履歴と同じ経路に相乗りしている。

**受け取る側は次の3点を守る。**

- **更新履歴と同じバージョンのエントリに、別の項目として持たせる。** Next.jsアプリ標準の
  `APP_CHANGELOG`（`version` / `date` / `changes`）なら`usage`を足し、更新履歴の画面で
  そのバージョンの`changes`の下に出す。`changes`の中へ混ぜない——「変わったこと」と
  「操作手順」は読む場面が違う
- **空文字なら項目ごと持たせない。** 画面で使える変化が無いリリース（内部改善・不具合修正だけ）
  では生成されず空になる。空の見出しだけが残ると「書き漏らし」に見える
- **改行を保つ。** 番号付きの複数行で渡るため、1行へ潰さない

`RELEASE_CHANGELOG`だけを読んでいる既存のスクリプトはそのままでも壊れない（未使用の環境変数が
1つ増えるだけ）。対応状況は[docs/supported-repositories.md](supported-repositories.md)を参照。

**実行後にバージョンが実際に変わったかを検証する**ため、コマンドが成功しても書き換わって
いなければワークフローが止まる。上記2つの失敗はいずれもコマンド自体の終了コードで
検出されたが、引数が合っていても書き換え先が違うようなケースはこの検証が拾う。

### タグを上げる順序 — callerが先、ラベル削除が後

**進捗ラベルが残っているリポジトリでcallerを`v9`へ上げるとき、ラベルの削除は必ずcaller更新の
後に行う。** 逆順にすると`claude-ci-fix`・`claude-conflict-resolve`のジョブが失敗する。

`v8`のこの2つの実体は、ガード無しで進捗ラベルを消す。

```yaml
run: gh issue edit "$ISSUE_NUMBER" --remove-label "02.wip"
```

他のジョブは`gh label list`と突き合わせて実在するラベルだけを対象にしている（#975）が、
この2つにはその保護が無い。**ラベル定義が存在しないリポジトリでは`gh issue edit`がexit 1を返し、
`if: always()`で走るこのステップがジョブごと落とす。** `v9`ではStatusの再報告に置き換わっている
ため、先にcallerを上げてしまえば問題は起きない。

なお**このガードの非対称は#1490で解消した。** `claude-ci-fix`・`claude-conflict-resolve`に加え、
同じく保護の無かった`claude-review-develop`・`release-develop-to-main`にも`gh label list`との
突き合わせを入れてある。上の注意が効くのは`v17`以前を参照しているリポジトリだけ。

正しい順序は次のとおり（`dayspan`・`shopping-list`で実施した手順、#1129）。

1. issue-deck側で`workflows/vN`を切る（**mainから**。developから切らない）
2. 対象リポジトリのcallerを`vN`へ上げる。**5ファイル・9箇所すべて**を揃える
   （`issue-labels.yml`は`uses:`のみ、他4つは`uses:`と`prompts-ref`の2箇所）
3. そのPRのActionsで、ラベルを付けずにStatusだけを報告していることを確認する
   （`issue #N を implementation として報告しました`が出て、Issueにラベルが付かない）
4. PRをマージし、Statusが`Develop`へ進むことを確認する
5. **そのあとで**`scripts/remove-progress-labels.sh --apply --repo <name>`を実行する

3を飛ばさないこと。ラベルを消してしまうと、`vN`が期待どおり動かなかった場合に戻す手段が無くなる。

`gh label create`での作成例:

```bash
gh label create "00.check-user" --color f0883e --description "ユーザーの確認・指示が必要"
# 00.check-userが付いている理由を表す補助ラベル(#1490)。00.check-userとのANDでしか読まれず、
# 単独では意味を持たない。未配布のリポジトリでは付与が黙ってスキップされるだけで壊れない。
gh label create "01.check-plan" --color fef2c0 --description "計画の承認待ち（00.check-userの理由）"
gh label create "01.check-input" --color fef2c0 --description "質問・確認への回答待ち（00.check-userの理由）"
gh label create "01.check-merge" --color fef2c0 --description "PRのマージ待ち（00.check-userの理由）"
gh label create "01.check-blocked" --color fef2c0 --description "続け方の指示待ち。エージェントは停止（00.check-userの理由）"
# 00.qa-answeredは01.check-answeredへリネームする。gh label editなら付いているIssueから
# 外れずにその場で名前が変わるため、作り直さずこちらを使う（未作成のリポジトリではcreate）。
gh label edit "00.qa-answered" --name "01.check-answered" --color fef2c0 --description "回答済み。読むだけで実装は再開しない（00.check-userの理由）"
gh label create "11.local" --color e99695 --description "ローカル(VSCode等)で対応中。無人実行ワークフローを起動しない"
gh label create "21.plan-required" --color d4c5f9 --description "計画の確認・承認が必要"
gh label create "22.merge-confirm-required" --color d4c5f9 --description "developへのマージ前に人間の確認・承認が必要"
gh label create "23.preview-required" --color d4c5f9 --description "画面プレビューでの確認・承認が必要"
gh label create "24.screenshot-required" --color d4c5f9 --description "スクリーンショットでの視覚確認・承認が必要"
# 25.artifact-requiredはローカルセッション専用（無人実行では作れない）のため、他リポジトリへはまだ配っていない（#1473）
gh label create "25.artifact-required" --color d4c5f9 --description "アーティファクトでの視覚確認・承認が必要"
gh label create "70.confirm" --color 5319e7 --description "確認項目（実施するか検討必要）"
# 71.manual-stepは`manual-step-label`ジョブ(#1492)が参照する。無いリポジトリでは付与が警告付きで
# スキップされ、手作業Issueが「ユーザーの作業待ち」ビューに現れない。
gh label create "71.manual-step" --color d876e3 --description "ユーザー自身の手作業が必要（エージェントが代行できない）"
```

issue-deckにはこの他に`51.improvement`・`65.docs`等、Issueの分類目的のみで使う一般的なラベルも
存在するが、ワークフロー側からは参照されずマルチエージェント運用のスコープ外のため、本ガイドの
対象には含めない。共通化すべきかどうかは運用方針の判断であり、必要であれば[7. ラベル差分チェック](#7-ラベル差分チェック)で
両リポジトリの全ラベルの差分を確認したうえで判断する。

## 3. CLAUDE.md

`claude-issue-dispatch.yml`の各ステップのプロンプトも`claude-review-develop.yml`の自動マージ不可
判定も、リポジトリの`CLAUDE.md`が定める運用ルールを前提にしている。対象リポジトリに`CLAUDE.md`が
無ければ新規作成、既にあれば以下の内容を追記する。

必須セクション（issue-deckの[CLAUDE.md](../CLAUDE.md)から流用する場合の対応箇所）:

- **ブランチ運用**: `develop`/`main`の2段階運用、Issue専用ブランチの命名規則`issue-<番号>`
- **依存関係の追加・シークレットの扱いに関する判断基準**: GitHub Actions上の無人実行では確認相手が
  いないため、依存関係追加が必要な場合は追加せず`00.check-user`を付与して停止する、といった
  無人実行前提のルール
- **Issueラベルの状態遷移**: 上記「2. ラベル体系」の11ラベルの遷移順序
- **自動マージ不可カテゴリ**: 認証・認可、DBスキーマ変更、本番環境設定、GitHub Actions/デプロイ設定、
  Secrets/環境変数、課金・決済、大規模な依存関係更新、develop→mainのマージ
- **実装エージェント・レビュー統合エージェントの禁止事項**: `main`/`develop`への直接コミット・push、
  他Issueのブランチ編集、不要なforce push、自己マージ禁止等
- **PR本文テンプレート**: 対応Issue・実装内容・テスト内容・確認方法・注意点

流用時の注意点:

- issue-deckのCLAUDE.mdはissue-deck自身のディレクトリ構成（`prisma/migrations/**`等）を前提にした
  記述を含む。対象リポジトリの技術スタックに合わせてパス・コマンドを書き換える（詳細は
  「6. リポジトリ差異の吸収チェックリスト」参照）
- コミットのAuthor名・コミットメッセージの言語（日本語/英語）等、issue-deck固有の慣習をそのまま
  引き継ぐかどうかは対象リポジトリの運用方針次第で判断する

## 4. Secrets

無人実行のGitHub Actionsから利用するSecretsは以下のとおり。

| Secrets名 | 用途 | 備考 |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude-code-action`の実行に使うClaude Codeの認証トークン | 各リポジトリで個別に発行・登録が必要 |
| `WORKFLOW_APP_ID`（variable）・`WORKFLOW_APP_PRIVATE_KEY` | `.github/workflows/`配下へのpush等に使うGitHub Appインストールトークンの発行元（#835）。organizationに1組登録すれば全リポジトリで共有される | **この2つが揃っているリポジトリでは`WORKFLOW_PAT`は使われない。** 1時間で失効するため期限管理が不要。詳細は[actions-token-model.md](actions-token-model.md)「8. 案Bへの移行（#835）」 |
| `WORKFLOW_PAT` | `.github/workflows/`配下へのpush・`00.check-user`ラベル付け替え等、既定の`GITHUB_TOKEN`では権限が足りない操作に使うFine-grained PAT（Repository permissions > Workflows: Read and write を含む）。**`sync-secrets.yml`（#1309）が使うため Secrets・Variables の Read and write も要る** | 上のApp用の値が未登録のときのフォールバックとして残っている。`sync-secrets.yml`と他リポジトリへの配布（`propagate-*`）は今もこちらを使うため、削除はできない |
| `GITHUB_TOKEN` | Issue/PRへのコメント投稿・ラベル操作等の既定操作 | GitHub Actionsが自動的に提供する既定のSecretsのため、リポジトリ側での登録は不要 |
| `PROGRESS_REPORT_SECRET` | issue-deckの進捗API（`POST /api/progress`で報告、`GET /api/progress`で問い合わせ）の共有シークレット（#991 Phase 2・Phase 5） | **必須**（後述）。organization secretとして1つ登録すれば全リポジトリで共有できる。`reusable-issue-labels.yml`は`workflow_call`の`required: false`で受け取り（callerが明示的に渡す）、`reusable-issue-dispatch.yml`は`secrets: inherit`で受け取る |
| `OP_SERVICE_ACCOUNT_TOKEN` | 1Password Service Accountトークン | **issue-deckでは不要になった。** `ci.yml`/`deploy.yml`/`release.yml`は#1302で1Password依存を外し、唯一の利用元だったプレビュー環境系は#1308で廃止したため、issue-deckの1Password利用はゼロになった。1Passwordは引き続き値の「正」として使うが、GitHubへの反映は`scripts/sync-github-secrets.sh`で値の変更時にのみ行う |

### シークレットの供給元を切り替える（#1306）

`.github/actions/load-secrets` は、`.github/secrets-manifest.tsv` に従って**GitHubのsecret/variable
または1Passwordから**環境変数を組み立てる複合アクション。片方で解決できない項目はもう片方から補う。

```yaml
  notify:
    runs-on: ubuntu-latest
    # GitHub側の値は**ジョブの env: で明示的に**渡す。複合アクションのステップはジョブの
    # env: を引き継ぐが、呼び出しステップの env: は引き継がない。
    env:
      SIGNALY_WEBHOOK_URL: ${{ secrets.SIGNALY_WEBHOOK_URL }}
    steps:
      - name: Checkout code           # ローカルパスのアクションのため先にcheckoutが要る
        uses: actions/checkout@v4

      - name: 不足分を1Passwordから補う
        uses: ./.github/actions/load-secrets
        with:
          # only を省略するとマニフェストの全項目が対象
          only: SIGNALY_WEBHOOK_URL
          # 空を渡すと1Passwordを一切触らない
          op-token: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
```

**GitHub側の投入が済んでいないリポジトリは1Passwordのまま動き、投入が済んだ順に自動で
GitHub側へ切り替わる**ため、全リポジトリを一斉に切り替える必要がない。

1Passwordから補う際は、**不足している項目だけ**を並べた一時テンプレートを生成して渡す。
テンプレート全体を渡すと不要な項目まで取りに行き、日次レート制限を無駄に消費するため。

`GITHUB_`で始まる名前の読み替え（`GH_NAME`列）は、`env:`ブロックを
`scripts/generate-workflow-env-block.sh`で生成すれば自動で反映される。

解決できなかった項目は**名前だけ**が報告される。値はログに出ない。

#### `secrets` コンテキストは丸ごと渡せない

当初は `secrets-json: ${{ toJSON(secrets) }}` でアクションへ渡し、アクション側がマニフェストを
見て選ぶ設計にした。**しかしその形にするとワークフローのrunが`action_required`になり、ジョブが
1つも作られなくなる**（PR #1315で3回とも再現）。必須チェックが「失敗」ではなく「そもそも
実行されない」状態になるため、`gh pr checks`の一覧を眺めているだけでは気づきにくい。

切り分けの結果は次のとおり。

| ci.ymlの内容 | CI |
|---|---|
| 変更なし | 成功（5ジョブ） |
| ローカル複合アクションの参照のみ | **成功（5ジョブ）** |
| + `toJSON(secrets)`・`toJSON(vars)` を入力へ渡す | **`action_required`・ジョブ0件** |

ローカル複合アクションを`uses: ./...`で呼ぶこと自体は問題ない。`toJSON(secrets)`を入力へ
渡した場合のみ起きる。そのためGitHub側の値は呼び出し側のジョブの`env:`に明示的に並べる。

`env:`ブロックは`scripts/generate-workflow-env-block.sh`で生成でき、マニフェストとのズレは
`scripts/check-load-secrets-env-block.sh`が検出する（CIの`docs-sync-check`ジョブに入っている）。
マニフェストへ項目を足したのに`env:`へ足し忘れると、検証ワークフローがその項目を見ないまま
「OK」を出してしまうため。

### 共通値はorganizationへ寄せる（#1307）

複数リポジトリが同じ `op://` を参照している値は、organization secret / organization variable として
**1回だけ**設定する。対応表は [`.github/org-secrets-manifest.tsv`](../.github/org-secrets-manifest.tsv)。

**GitHub Team（2026-08-14に切り替え）が前提。** GitHub Freeではorganization secretをprivateリポジトリ
から参照できず、org共通化ができなかった（#1011に整理あり）。Teamへの引き上げで、privateリポジトリの
ブランチ保護と合わせて2つの制約が同時に外れた。

投入は同期スクリプトで行う（`admin:org` スコープが要る）。

```bash
op signin
scripts/sync-github-secrets.sh --manifest .github/org-secrets-manifest.tsv --dry-run
scripts/sync-github-secrets.sh --manifest .github/org-secrets-manifest.tsv
```

| organizationでの名前 | 参照しているリポジトリ数 | 種別 |
|---|---|---|
| `SERVER_HOST`・`SERVER_SSH_PORT` | 15 | secret |
| `SERVER_USERNAME` | 14 | secret |
| `SERVER_SSH_PRIVATE_KEY` | 13 | secret |
| `SHARED_DB_HOST`・`SHARED_DB_PORT`・`SHARED_DB_USER`・`SHARED_DB_PASSWORD` | 9 | secret |
| `SHARED_DB_MIGRATE_USER`・`SHARED_DB_MIGRATE_PASSWORD` | 5 | secret |
| `SUPABASE_PROJECT_URL`・`SUPABASE_PUBLISHABLE_KEY` | 8 | variable（公開値） |
| `SIGNALY_WEBHOOK_URL` | 17 | secret（#2255） |
| `SIGNALY_LOGIN_WEBHOOK_URL` | 8 | secret（#2286） |

1リポジトリでしか使わない値（実測115件）は各リポジトリのrepository secretに置く。

`SIGNALY_WEBHOOK_URL`（CI・デプロイ通知）だけは事情が違い、**参照している`op://`はリポジトリごとに
別だった**（`op://apps/<アプリ>/ci-webhook-url`）。通知先もアプリごとの別チャンネルだったが、
リポジトリを増やすたびにSignalyでのチャンネル作成・1Passwordへの登録・repository secretの投入が
必要で、**新規リポジトリの設定の手間がそのまま増え続けていた**。そこで#2255で
「全リポジトリのCI・デプロイ結果を1つのチャンネルへ集約する」ことにし、issue-deckの既存の
CIチャンネルを共通チャンネルとして流用してorganizationへ寄せた。

**repository secretは同名のorganization secretを覆い隠す。** そのため各リポジトリでは、
マニフェストを`scope=inherit`へ変えたうえで**repository secretを削除する**まで従来の
チャンネルへ飛び続ける。逆に言えば、リポジトリ単位で好きな順に移行できる。

#### リリース通知だけは別チャンネルへ分ける（#2391）

**集約の単位は「用途」であって「アプリ」ではない。** CI・デプロイは1日に何十件も流れるため、
月に数回のリリースがその中に埋もれ、しかも通知に載るのはバージョン番号だけだった。そこで
**リリース（`NOTIFY_KIND: リリース`）だけを別チャンネルへ分け、本文に変更内容を載せる**。
CI・デプロイの通知先は変えない。

| 用途 | organization secret | 値の正 |
|---|---|---|
| CI・デプロイ | `SIGNALY_WEBHOOK_URL` | `op://apps/Notify/ci-webhook-url` |
| **リリース** | `SIGNALY_RELEASE_WEBHOOK_URL` | `op://apps/Notify/release-webhook-url` |
| ログイン | `SIGNALY_LOGIN_WEBHOOK_URL` | `op://apps/Notify/login-webhook-url` |

**未登録でも通知は消えない。** `.github/scripts/signaly-notify.sh` は
`SIGNALY_RELEASE_WEBHOOK_URL` が空ならCI・デプロイのチャンネルへ送る。ログイン通知の集約と
違って「organization secretを先に作る」順序の制約が無く、secretの登録・スクリプトの配布・
ワークフローの1行追加をどの順で進めてもよい。

**変更内容の出どころは `.github/release-notes.md`。** 共有ワークフロー
`reusable-release-develop-to-main.yml` がバージョンbumpのたびに、生成した利用者向けの文面
（`RELEASE_CHANGELOG`・`RELEASE_USAGE`）をこのファイルへ書き出してバンプPRに含める。
**各アプリの更新履歴ファイルとは別に持つ**——`RELEASE_CHANGELOG` を受け取る `"version"`
lifecycleスクリプトを持つのはフリート16リポジトリ中7件しかなく、残りでは生成された文面が
バンプPR本文にしか残らないため。通知スクリプトは**先頭の見出し `# v<バージョン>` が
`NOTIFY_VERSION` と一致したときだけ**本文に載せる（古い文面を新しいリリースの通知へ貼るより、
本文なしで送るほうがまし）。

各リポジトリへ行き渡らせる手順は
[supported-repositories.md](supported-repositories.md)「`.github/scripts/signaly-notify.sh`の配布状況」を参照。

#### ログイン通知も同じ形で集約する（#2286）

ログイン通知（`LOGIN_WEBHOOK_URL`）もCI・デプロイ通知と同じ理由で1本のチャンネルへ集約する
（guchi-apps/signaly#192）。どのアプリへのログインかは、チャンネルではなく通知の
`notifications.source` で見分ける。organization上の名前は `SIGNALY_LOGIN_WEBHOOK_URL`、
値の正は `op://apps/Notify/login-webhook-url`。

**organization secretを先に作り、各リポジトリの`inherit`化はその後。** organization secretが
無いうちにマニフェストだけ`inherit`へ変えると、デプロイが空値を`.env`へ書き、ログイン通知が
**エラーを出さずに止まる**。

CI・デプロイ通知と違い、**repository secret側の名前がリポジトリごとに割れている**。
organization項目と同名（`SIGNALY_LOGIN_WEBHOOK_URL`）のものだけが覆い隠すため、
`inherit`へ切り替える前にリポジトリごとに実際の名前を確認する。

```bash
gh api repos/guchi-apps/<repo>/actions/secrets --jq '.secrets[].name' | grep -i login
```

| repository secretの名前 | リポジトリ | org項目を覆い隠すか |
|---|---|---|
| `SIGNALY_LOGIN_WEBHOOK_URL` | asset-manager・clip-hive・meisai-lab・ops-dashboard・subscription-lists・portfolio | **覆い隠す**（削除が要る） |
| `LOGIN_WEBHOOK_URL` | signaly | 覆い隠さない |
| `SIGNALY_WEBHOOK_LOGIN_URL`（綴り違い） | car-care | 覆い隠さない |

（2026-08-25時点。いずれも`inherit`化とあわせて削除する）

#### 各リポジトリの移行手順（#2287）

対象は8リポジトリ（`asset-manager`・`portfolio`・`ops-dashboard`・`meisai-lab`・`car-care`・
`clip-hive`・`subscription-lists`・`signaly`）。リポジトリごとに次の順で行う。

1. **通知のペイロードへ `source` を足す。** これが先。詳細は下の「`source` を足すのが先」を参照
2. `.github/secrets-manifest.tsv` を `inherit` へ切り替える。**環境変数名（KEY列）も
   `SIGNALY_LOGIN_WEBHOOK_URL` へ揃える**（`signaly` の `LOGIN_WEBHOOK_URL`・`car-care` の
   `SIGNALY_WEBHOOK_LOGIN_URL` はこの機会に改名する）

   ```
   SIGNALY_LOGIN_WEBHOOK_URL	inherit	secret	SIGNALY_LOGIN_WEBHOOK_URL	-
   ```

3. `deploy.yml` の `secrets.*` 参照と `.env` テンプレート・`.env.example` の名前も同じ名前へ揃える
4. repository secretを削除する（1〜3が`main`まで出た後）
5. 1Passwordのアプリアイテムから `login-webhook-url` フィールドを削除する

4と5はSecretsの変更にあたるため、エージェントは実施せず`71.manual-step`のIssueへ切り出す。
1〜3はリポジトリごとに子Issueへ切り出す（#2287のサブIssue）。

**切り替わる時点はリポジトリで違う。** repository secretの名前がorganization項目と同名の6
リポジトリは、手順4（削除）まで従来のチャンネルへ飛び続ける。名前が違う`signaly`・`car-care`は
**手順2〜3が本番へ出た時点で切り替わる**ため、`source` の追加を同じPRに入れておく必要がある。

#### `source` を足すのが先

**共通チャンネルのURLを直接叩き始めた瞬間に、送信元の情報が消える。** 今はチャンネル統合
（merge）で旧チャンネルIDが `channel_aliases` に残っており、Signalyが別名から送信元を補って
いる（`channel_aliases.source`）。organization secretへ寄せると別名を経由しなくなるため、
この救済が効かなくなる。

`signaly` の `backend/login_notify.py` はペイロードに `source` を持っているが、**他アプリの
Next.js側（`src/lib/signaly.ts` 等）は Discord 形式の `embeds` か `content` だけで、`source` も
`username` も `App` フィールドも持たない**（2026-08-25時点で7アプリすべて）。

```ts
body: JSON.stringify({
  source: APP_NAME,   // ← 追加
  embeds: [{ title: `🔐 ${APP_NAME} にログイン`, color: 5763719, fields }],
})
```

Signalyの送信元の判定は `X-Signaly-Source` ヘッダー → `?source=` クエリ → ペイロードの
`source` → `fields` の `App`／`Repository` → Discord形式の `username` の順。**HTTPヘッダーは
ASCIIしか運べない**ため、日本語のアプリ名を渡すならヘッダーではなくペイロードの `source` を
使う（guchi-apps/signaly の `CLAUDE.md`「通知チャンネルと送信元（source）」）。

**`source` の値はリポジトリ名に揃える**（`asset-manager`・`car-care` など）。CI・デプロイ通知は
embedの `Repository` フィールド（`guchi-apps/<repo>`）の末尾を送信元にするため（signalyの
`backend/webhook.py` の `_source_from_fields`）、ログイン通知も同じ形にしておくと共通チャンネルの
一覧で表記が揃う。

#### 環境変数名がリポジトリごとに違っても吸収できる

同じ値を別の名前で受けているリポジトリが実際にある。

| 同じ `op://` 参照 | 使われている環境変数名 |
|---|---|
| `Server/host` | `HOST` / `SSH_HOST` |
| `Server/username` | `USERNAME` / `SSH_USERNAME` |
| `Supabase/project-url` | `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL` |
| `Supabase/publishable-key` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_PUBLISHABLE_KEY` |

各リポジトリのマニフェストで `scope=inherit` とし、`GH_NAME`列にorganization側の名前を書く。
`scripts/generate-workflow-env-block.sh` が `HOST: ${{ secrets.SERVER_HOST }}` のように読み替えた
`env:` ブロックを生成する。

```
# car-care の .github/secrets-manifest.tsv（抜粋）
HOST	inherit	secret	SERVER_HOST	-
DB_PASSWORD	inherit	secret	SHARED_DB_PASSWORD	-
DB_NAME	repo	secret	DB_NAME	op://apps/Car/db-name
```

#### SSH鍵の参照が3通りに割れていた

```
op://apps/githubaction-sshkey/private_key?ssh-format=openssh   ← 13リポジトリ
op://apps/githubaction-sshkey/private_key                       ← 1リポジトリ
op://apps/githubaction-sshkey/PRIVATE_KEY                       ← 1リポジトリ
```

`?ssh-format=openssh` の有無で取得される形式が変わる。organizationへ寄せる際、多数派かつ
issue-deckで実績のある **openssh 付きに統一**した。

### アプリ間で共有する認証値は提供側の`op://`を参照する（#2624）

アプリ同士がAPIを呼び合うときの共有シークレット（AIDEが他アプリを叩くトークンなど）は、
**値を検証する側＝提供側のアイテムを唯一の正とし、利用側のマニフェストがその`op://`を
そのまま参照する**。利用側のアイテムへ同じ値を入れ直さない。

```
guchi-apps/dayspan  INTERNAL_API_KEY    op://apps/dayspan/internal-api-key   ← 正（受け取って照合する側）
guchi-apps/aide     AIDE_DAYSPAN_TOKEN  op://apps/dayspan/internal-api-key   ← 利用側は同じ場所を指す
```

**複製すると、片方だけ入れ替えた時点で連携が黙って止まる。** #2624の時点でAIDEと5アプリの間で
値が複製されており、`AIDE_RESEARCH_DESK_TOKEN`に至っては利用側のフィールドが作られないまま
参照だけが残り、GitHubのsecretも未登録で連携が未配線だった（マニフェストのコメントには
「Research Desk側の`INTERNAL_API_KEY`と同じ値にする」と、人が手で揃える前提が書かれていた）。

**organization secretへは寄せない。** 上の「共通値はorganizationへ寄せる」が対象にしているのは
フリート全体で使う接続情報（`SERVER_*`・`SHARED_DB_*`・`SIGNALY_*`）で、2アプリの間だけで使う
認証値をorganizationへ置くと、関係の無いリポジトリのワークフローからも読めてしまう。
**repository secretのまま、参照先だけを1か所にする**（GitHub側の名前は両者で違ってよい）。

複製は`scripts/check-duplicate-secret-values.sh`で検出できる。ボールトの値をハッシュで
突き合わせ、同じ値が2つ以上のフィールドに入っているものと、参照先が実在しないものを報告する
（値もハッシュも出力しない）。

```bash
scripts/check-duplicate-secret-values.sh
```

値の性質上一致するもの（本人のメールアドレス・VAPIDの`subject`）は
[`.github/duplicate-secret-allowlist.txt`](../.github/duplicate-secret-allowlist.txt)へ書いて
報告から外す。**資格情報はここへ書かず、参照へ寄せる。**

`scripts/provision-secret.sh --copy-from`はこの複製を作る操作なので、既定で断るようにしてある
（値の性質上どうしても複製が要ると判断したときだけ`--allow-duplicate`）。

#### 複製は構成の一覧では見つからない

**マニフェストを読むだけでは検出できない。** 複製された値は`op://`が別々なので、参照の一覧として
見るかぎり普通の1対1の参照に見える。共有知識の1Password台帳（`guchi-apps/docs`の
`scripts/build-1password-inventory.py`）も、実値を持たない方針から**構成だけを取得して値を読まない**
ため、この種の複製は出てこない。**値を読んで突き合わせるまで分からない**というのがこの問題の性質で、
`check-duplicate-secret-values.sh`が値を読むのはそのため。

読むときの落とし穴が2つある。

- `op item get --format json`は、伏せ字のフィールド（`concealed`）の値を返さない。**`--reveal`が要る**
- SSH鍵アイテムの`private_key`のような組み込みフィールドは`.fields[].label`に現れない。
  **フィールド一覧に無い＝存在しない、ではない**（`op://apps/githubaction-sshkey/private_key`を
  不在と誤検出した）。一覧に無いものだけを`op read`で確かめる形にしてある

#### 不要になったフィールドの削除は手作業

**サービスアカウントでは消せない。** 共有知識の`scripts/delete-1password-fields.sh`は、
`op whoami`がサービスアカウントなら明示的に中断する。書き込み権限つきのトークン
（`~/.config/issue-deck/op-writer.env`）を読み込んでも同じで、人の`op signin`が要る。
参照の付け替えはPRで進められるが、**残ったフィールドの掃除は`71.manual-step`のIssueとして
1Passwordアプリでの操作で残す**（#2417と同じ理由）。読み取りだけの確認コマンドは
サービスアカウントで代行できるので、完了の確認は自動で回せる。

### issue-deck固有: デプロイ用のSecrets・Variables（#1302）

`deploy.yml`・`release.yml`・`ci.yml`が使う値は、以前は実行のたびに1Passwordから取得していた。
1Passwordサービスアカウントの日次レート制限（**1Passwordアカウント全体で1,000リクエスト/日**、
サービスアカウントを分けても分割されない）を使い切ってデプロイが止まったため、実行時の取得先を
GitHubへ移した。GitHub側のsecret/variableにはレート制限が無い。

**1Passwordは引き続き「人が管理する唯一の正」**であり、対応表は
[`.github/secrets-manifest.tsv`](../.github/secrets-manifest.tsv)にある。値を変更したときは
`scripts/sync-github-secrets.sh`で同期する（このスクリプトが使う`op`は個人アカウントの
セッションであり、サービスアカウントの枠を消費しない）。

`issue-deck`は**PUBLICリポジトリでActionsのログが誰でも読める**。variableはマスクされないため、
公開されても害が無いと確認できた値だけをvariableにしている。接続先の構成情報（ホスト・ポート・
ユーザー名・DB名）は単体では資格情報でなくとも、VPSへの攻撃面になるためsecretに置く。

| 種別 | 名前 |
|---|---|
| Secret（接続・認証） | `SSH_PRIVATE_KEY`・`HOST`・`USERNAME`・`SSH_PORT`・`TARGET_DIR` |
| Secret（DB） | `DB_USER`・`DB_PASSWORD`・`DB_HOST`・`DB_PORT`・`DB_NAME`・`MIGRATE_DB_USER`・`MIGRATE_DB_PASSWORD` |
| Secret（アプリ） | `SUPABASE_SERVICE_ROLE_KEY`・`APP_GITHUB_APP_PRIVATE_KEY_BASE64`・`APP_GITHUB_WEBHOOK_SECRET`・`APP_GITHUB_USER_TOKEN_ENCRYPTION_KEY`・`APP_GITHUB_OAUTH_CLIENT_ID`・`APP_GITHUB_OAUTH_CLIENT_SECRET`・`APP_GITHUB_BILLING_TOKEN`・`OPENAI_API_KEY`・`ALLOWED_EMAILS`・`DISPATCH_SECRET`・`VAPID_PUBLIC_KEY`・`VAPID_PRIVATE_KEY`・`VAPID_SUBJECT` |
| Variable（公開されても害が無い値） | `NEXT_PUBLIC_SUPABASE_URL`・`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`・`NEXT_PUBLIC_GITHUB_APP_SLUG`・`APP_GITHUB_APP_ID`・`PORT` |
| organization secretを継承（repo側に作らない） | `CLAUDE_CODE_OAUTH_TOKEN`・`PROGRESS_REPORT_SECRET`・`SIGNALY_WEBHOOK_URL`（#2255） |

**Push通知のVAPID鍵（`VAPID_*`。#838）は、公開鍵もsecretに置く。** Web Pushの「公開鍵」は
ブラウザへ配る値で秘密ではないが、issue-deckはPUBLICでActionsのログが誰でも読めるため、
公開されても害が無い値でもvariableにはしない（このリポジトリの`CLAUDE.md`の方針どおり）。
3つ揃っていなければPush通知の機能だけが無効になり、デプロイは通る。

#### `GITHUB_` で始まる名前は使えない

**GitHubはsecret・variableとも`GITHUB_`で始まる名前を予約しており、作成しようとすると
HTTP 422で拒否される**（`Secret names must not start with GITHUB_.`）。実際にこれで同期が
28件中16件目で止まった。

そのためGitHub側では`APP_`を前置した名前で保存し、ワークフロー側で本来の環境変数名へ
読み替える。アプリのコードやサーバー側`.env`が使う名前は変わらない。

| 環境変数名（アプリが使う名前） | GitHub側の名前 |
|---|---|
| `GITHUB_APP_ID` | `APP_GITHUB_APP_ID` |
| `GITHUB_APP_PRIVATE_KEY_BASE64` | `APP_GITHUB_APP_PRIVATE_KEY_BASE64` |
| `GITHUB_WEBHOOK_SECRET` | `APP_GITHUB_WEBHOOK_SECRET` |
| `GITHUB_USER_TOKEN_ENCRYPTION_KEY` | `APP_GITHUB_USER_TOKEN_ENCRYPTION_KEY` |
| `GITHUB_OAUTH_CLIENT_ID` | `APP_GITHUB_OAUTH_CLIENT_ID` |
| `GITHUB_OAUTH_CLIENT_SECRET` | `APP_GITHUB_OAUTH_CLIENT_SECRET` |
| `GITHUB_BILLING_TOKEN` | `APP_GITHUB_BILLING_TOKEN` |

対応は`.github/secrets-manifest.tsv`の`GH_NAME`列が持つ。`NEXT_PUBLIC_GITHUB_APP_SLUG`は
`GITHUB_`で始まらないため読み替え不要。


最後の2つは、以前はorganization secretと1Passwordの両方に同じ値があり二重管理になっていた。
**同名のrepo secretを作るとorganization secretを覆い隠す**ため、repo側には作らない。

なお`guchi-apps`はGitHub Freeのorganizationであり、**organization secretはprivateリポジトリからは
利用できない**（publicリポジトリのみ）。共通値をorganization secretへ集約できるのはpublicな
14リポジトリまでで、privateな11リポジトリはrepository secretとして個別に持つ必要がある。

### シークレット同期を画面のボタンから起こす（#1309）

値を変えたあとの`scripts/sync-github-secrets.sh`の実行を、issue-deckの画面
（設定ダイアログ → 「1Password → GitHub のシークレット同期」）から起こせるようにしてある。

**issue-deckはsecretを書かない。** 押すと`workflow_dispatch`で対象リポジトリの
`sync-secrets.yml`が起動し、1Passwordの読み取りもGitHubへの書き込みもそのリポジトリの
Actionsの中で完結する。issue-deckは16リポジトリを操作する立場のため、直接Secrets書き込み権限を
持たせると「全リポジトリのデプロイ用シークレットを書き換えられるアプリ」になる。

導入するリポジトリ側に置くのは、次の薄いcaller 1ファイルだけ。

```yaml
# .github/workflows/sync-secrets.yml
name: Sync secrets
on:
  workflow_dispatch:
    inputs:
      only:
        description: "同期するKEYをカンマ区切りで絞る（空ならマニフェスト全件）"
        required: false
        type: string
        default: ""
concurrency:
  group: sync-secrets-${{ github.repository }}
  cancel-in-progress: false
jobs:
  sync-secrets:
    uses: guchi-apps/issue-deck/.github/workflows/reusable-sync-secrets.yml@workflows/vN
    with:
      only: ${{ inputs.only }}
    permissions:
      contents: read
    secrets: inherit
```

- **スクリプトの置き場所が`scripts/`でないリポジトリは`script-path`を指定する**
  （`vps`は`.github/scripts/sync-github-secrets.sh`。deploy.ymlがリポジトリ全体をVPSへ
  rsyncするため）
- **デフォルトブランチに載るまで`workflow_dispatch`は効かない。** マージ前に画面から押すと
  「ワークフローが見つかりません」になる
- 必要な値はすべてorganization側にある（`WORKFLOW_PAT`・`OP_SERVICE_ACCOUNT_TOKEN`・
  `PROGRESS_REPORT_SECRET`・変数`APP_BASE_URL`）。リポジトリ側での追加登録は要らない

**1Passwordの日次枠を消費するのはこの経路だけ。** ローカルCLIから直接叩く場合は個人アカウントの
セッションを使うため枠を消費しないが、Actions経由はサービスアカウントを使うため、全件同期1回で
マニフェストの項目数ぶん（20〜30件）を消費する（枠はアカウント全体で1,000件/日）。
`--dry-run`も同じだけ読むため下見にはならない。画面側は、対象キーの絞り込み・実行前の確認・
直近の成功から10分のクールダウンで連打を抑えている。

**結果として画面に出るのは件数と項目名だけ**（`同期=N スキップ=M 失敗=K` と、同期・スキップ・
失敗それぞれの項目名）。値そのものも値の長さも、ログ・画面・APIのどこにも出さない
（長さも手がかりになる）。項目名は行ごとの「内訳」を開くと出る（#2022）。**項目名を拾うのは
`reusable-sync-secrets.yml`側**なので、配布先が古いタグを参照している間は件数だけが届き、
その実行の内訳には「項目名が記録されていません」と出る。

### 変数 `APP_BASE_URL`

Secretsではなく**変数**（Variables）として登録する。値はissue-deck本体のURL
（`https://issuedeck.gucchii.com`）で、**対象アプリ自身のURLではない。** 取り違えが`dayspan`で
実際に起きた。

**organization変数として1つ登録すれば全リポジトリへ届く。** 可視性は`Public repositories`で足りる
（対象リポジトリがpublicである限り）。リポジトリ変数として個別に持つこともできるが、
リポジトリが増えるたびに設定が要る。`SHARED_CONTEXT_REPO`と同じ方式。

```bash
# admin:org が要る
gh variable set APP_BASE_URL --org guchi-apps --body "https://issuedeck.gucchii.com" --visibility all

# 対象リポジトリから解決できるかの確認（admin:org 不要）
gh api "/repos/guchi-apps/my-app/actions/organization-variables" \
  --jq '.variables[] | select(.name=="APP_BASE_URL") | .name + "=" + .value'
```

変数は`secrets`と違い、callerから`with:`でも`secrets:`でも渡す必要がない（caller側リポジトリ・
organizationの変数として解決される）。

### `APP_BASE_URL`と`PROGRESS_REPORT_SECRET`は Phase 5 以降**必須**

**#991 Phase 5（#1010）より前は、どちらも「任意」だった。** 進捗はラベルでも記録されており、
報告が届かなくてもラベル側で成立していたためである。

**進捗ラベルを廃止した現在、この2つが欠けると進捗が一切機能しない。** 代替の判断材料が無い。

| 欠けたときに起きること | Phase 5 より前 | 現在 |
|---|---|---|
| 進捗の記録 | ラベルで残る | **何も残らない**（盤面は`Ready`のまま） |
| 実行モードの判定（`mode=additional`等） | ラベルで判定 | **判定できない**（安全側に倒れてskip） |
| develop→mainの一括遷移・close | ラベルで対象を検索 | **対象を1件も見つけられない** |
| リリースPRの対象issue一覧 | ラベルで取得 | **空になる** |

いずれもジョブは成功したまま警告を出すだけなので、**壊れていることに気づきにくい。**
導入時に必ず疎通を確認する。

```bash
# 401 が返れば本番にAPIがあり鍵の検証も動いている（200 は鍵が正しい場合）
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://issuedeck.gucchii.com/api/progress?repository=guchi-apps/my-app&issue=1"
```

`m-guchi/shopping-list`のケーススタディでは、1Password Service Account経由でのSecrets注入
（`1password/load-secrets-action@v4` + `op://...`参照）が既に稼働しており、`CLAUDE_CODE_OAUTH_TOKEN`も
同じ経路で配布可能と確認できている。ただし`WORKFLOW_PAT`は`actions/checkout`の`token`入力に
`checkout`ステップの時点で渡す必要があり、1Password経由の注入は`checkout`後にしか実行できないため、
`WORKFLOW_PAT`だけはGitHub Secretsへの直接登録が必要になる点に注意（詳細は
[docs/cross-repo-automation.md](cross-repo-automation.md)のケーススタディ参照）。

### `.gitignore`に共有ディレクトリを追加する

**忘れやすい。実際に6リポジトリ連続で抜けた（#1151）。**

`claude-issue-dispatch.yml`は無人実行のたびに、呼び出し元リポジトリのワークツリーへ2つの
ディレクトリをcheckoutする。**どちらも呼び出し元の管理対象ではない。**

| ディレクトリ | 中身 | いつ作られるか |
|---|---|---|
| `.shared-context/` | 共有知識リポジトリ（`guchi-apps/docs`） | 毎回 |
| `.shared-prompts/` | issue-deck側の実装プロンプト | `prompts-ref`指定時（＝他リポジトリからの参照時は常に） |

対象リポジトリの`.gitignore`へ追記する。

```gitignore
# claude-issue-dispatch.yml が無人実行のたびにcheckoutする（リポジトリ管理外）
/.shared-context/
/.shared-prompts/
```

**入れないと2つの問題が起きる。**

1. **Lintがリポジトリ管理外のファイルを検査する。** eslint等はワークツリー全体を見るため、
   `.shared-prompts/`配下のエラーが実装エージェントの出力に混ざる。自分の変更が原因かどうかの
   切り分けに毎回手数を使う（guchi-apps/car-care#40で実際に発生）
2. **`git add -A`で共有リポジトリごとコミットされうる。** 実装プロンプトは「`.gitignore`済み
   ですが`git add -A`等で巻き込まないよう注意」と書いており、**その前提が崩れる**

確認は空ディレクトリを作って`git status`に出ないことを見ればよい。

```bash
mkdir -p .shared-context .shared-prompts && touch .shared-context/x .shared-prompts/x
git status --porcelain | grep shared   # 何も出なければ正しい
rm -rf .shared-context .shared-prompts
```

## 5. ブランチ運用

- `main`は本番環境と一致するリリース用ブランチ。直接push禁止、`develop`→`main`のPRのみ
- `develop`が日常の開発ブランチ
- **デフォルトブランチは`develop`にする。** 単なる作法ではなく、無人実行が動く条件そのもの。
  `issues`・`issue_comment`イベントはデフォルトブランチのワークフローしか起動しないため、
  `main`のままだと`claude-issue-dispatch.yml`が`@claude`コメントに永久に反応しない
  （詳細は「[盤面へ載せる](#11-盤面へ載せるリポジトリを再同期)」の同名の項）
- Issue専用ブランチは`develop`から作成し、ブランチ名は`issue-<Issue番号>`とする
  （`issue-labels.yml`等のIssue番号特定処理がこの命名規則に依存しており、従わないブランチは
  全ワークフローの対象外になる）
- Branch protection: `main`はRequire pull request before merging・Required status checks、
  `develop`は最低限`required_status_checks`（CIジョブ名）を設定する。詳細な設定値・設定コマンド例は
  [docs/multi-agent/branching.md](multi-agent/branching.md)の「ブランチ保護ルール案」を参照
- **デフォルトブランチを`main`に据え置くリポジトリでは、`delete_branch_on_merge`を`false`にする**（#1786）。
  `develop`→`main`のリリースPRは**headが`develop`**のため、この設定が`true`だとマージした瞬間に
  `develop`が自動削除され、次回以降のリリースが成立しなくなる（`push: develop`が発火せず、
  `ref: develop`のdispatchが404になる）。**既定が`develop`のリポジトリでは起きない**——GitHubは
  既定ブランチを削除しないため。あわせてrulesetに`deletion`制限を入れると二重に防げる

  ```bash
  gh api repos/guchi-apps/my-app --jq '"delete_branch_on_merge=\(.delete_branch_on_merge) default_branch=\(.default_branch)"'
  gh api --method PATCH repos/guchi-apps/my-app -F delete_branch_on_merge=false
  ```

### `develop`のブランチ保護は自動マージの前提（#1475）

**`claude-review-develop.yml`を置いても、`develop`にブランチ保護（必須ステータスチェック）が
無ければ自動マージは1本も成立しない。** `auto-merge`ジョブが実行する`gh pr merge --auto`は、
PRが既にマージ可能な状態だと**「既にマージ可能」として断られる**。必須チェックが無いPRは
判定の時点で常にその状態なので、ジョブは毎回失敗し、`auto-merge-fallback`が`00.check-user`を
付ける——**未配布のときと同じ「全て手動マージ」に、失敗したジョブのぶんノイズが加わるだけ**に
なる。実測では、`claude-review-develop.yml`が未配布だった12リポジトリすべてに保護が無かった。

同じ保護は`release-develop-to-main.yml`のバンプPR（同じく`gh pr merge --auto --merge`で予約する）
にも効く。

- **必須チェック名は対象リポジトリのCIのジョブ名に合わせる。** 実測でも`lint-and-build`・
  `test`・`verify`・`typecheck-and-test`・`backend`と割れており、`myroom`のように2つ
  （`backend`・`frontend`）あるリポジトリもある
- **実在しない名前を必須にすると、永久に埋まらずマージ不能になる。** ワークフローのジョブ名を
  そのまま信じず、**直近のdevelop向けPRで実際に成功したcheck runと突き合わせて**確かめる
- `ci.yml`の`pull_request.branches`に`develop`が含まれていることも確認する

**設定はGitHub Actionsからは変えられない。** `WORKFLOW_PAT`は Administration を持たないため、
`PATCH /repos/{repo}`（`allow_auto_merge`）もブランチ保護APIも通らない。
`propagate-workflow-tag.sh`が`|| true`付きで有効化を試し続けていたが、12リポジトリ中8件が
`false`のままで**失敗が一度も表に出ていなかった**。org owner本人の`gh`で次を実行する
（既定はdry-run）。

```bash
# 確認だけ（対象は claude-issue-dispatch.yml を持ちデフォルトブランチが develop のリポジトリ）
scripts/setup-develop-auto-merge.sh

# 適用（Allow auto-merge の有効化と develop のブランチ保護作成）
scripts/setup-develop-auto-merge.sh --apply
```

### `develop`を持たないリポジトリ（main直行）

`guchi-apps/docs`のように**`develop`を置かず、`issue-<番号>` → `main`のPRだけで回すリポジトリ**が
ある（理由は[supported-repositories.md](supported-repositories.md)の「`subpc`・`vps`・`docs`」を
参照。共有知識の提案PRが`main`宛に届くため、`develop`を挟むと全アプリが読むrefが1リリース分遅れる）。

**この形でも`issue-labels.yml`のcallerはそのまま置ける**（`workflows/v23`以降）。
`reusable-issue-labels.yml`の`main-direct-pr-opened`・`main-direct-merged`が
`base.ref == 'main'`かつ`head.ref`が`issue-<番号>`のPRを拾い、
`Implementation` → `Develop PR` → `Done`（＋issueのclose）まで進める。callerの内容は
develop運用のリポジトリと同一でよい（`on: pull_request: branches:`は元から`develop`と`main`の
両方を並べているため）。

- **`v22`以前を参照しているとこの経路は無い。** `Implementation`から先へ進むジョブが1つも
  発火せず、PRをマージして内容が反映された後もissueが盤面の「実行中」に残り続ける（#1901）
- **`claude-review-develop.yml`は入れても効かない。** callerのトリガーが`branches: [develop]`
  固定のため、base が`main`のPRは判定されない。したがってこのPRは必ず人がマージする前提で、
  `main-direct-pr-opened`が常に`00.check-user` + `01.check-merge`を付ける
- **`release-develop-to-main.yml`は入れない。** マージがそのまま反映であり、リリースという段が無い

## 6. リポジトリ差異の吸収チェックリスト

> **適用範囲**: 本節は**コピー方式のワークフロー**（現在は該当なし。以前は`shared-knowledge-propose.yml`が該当した）が対象。参照方式の6つ（`claude-issue-dispatch.yml`・`issue-labels.yml`・`claude-ci-fix.yml`・`claude-conflict-resolve.yml`・`claude-review-develop.yml`・`release-develop-to-main.yml`）は`with:`で吸収済みのため、ワークフローを編集する必要はない。


ワークフローファイルをそのままコピーしても動かない、個別カスタマイズが必要な観点。

- [ ] **`.gitignore`に`/.shared-context/`・`/.shared-prompts/`があるか**（参照方式でも必要。
      上記「[.gitignoreに共有ディレクトリを追加する](#gitignoreに共有ディレクトリを追加する)」参照）
- [ ] **パッケージマネージャ・依存関係インストールコマンド**（pnpm/npm/yarn、Node.js以外のスタックを
      含むか）
- [ ] **lint・型チェック・テスト・ビルドコマンド**
- [ ] **DBマイグレーション・シードの要否とコマンド**（DBを使わないリポジトリではステップごと削除）
- [ ] **`postinstall`が環境変数を要求しないか**（参照方式でも必要）。共有ワークフローの
      「依存関係をインストールする」ステップは`npm ci`を**環境変数なしで**実行する。Prisma 7 の
      `prisma.config.ts`で`datasource.url`を`env("DATABASE_URL")`にしていると、未設定の時点で
      configの読み込みが失敗し、`postinstall`の`prisma generate`ごと`npm ci`が落ちる。
      **無人実行の実装モードが依存インストールで必ず止まる**ので、対象リポジトリ側で未設定時の
      フォールバックを持たせる（`db-console`で実際に踏んだ。#1378。`car-care`・`clip-hive`・
      `dayspan`は元から未設定でも通る作り）。`DATABASE_URL`が渡るのは
      `24.screenshot-required`付きの実行のマイグレーション・シードのステップだけである点に注意する
- [ ] **画面確認・スクリーンショット撮影の要否**（対象がWebアプリでない場合はそもそも不要。Webアプリ
      でも、CIバイパス用の認証機構が無いと`24.screenshot-required`は成立しない）
- [ ] **`risk-check`ジョブの自動マージ不可判定パターン**（ディレクトリ構成に応じたパスパターンの
      置き換え）
- [ ] **バージョン管理方式**（`release-develop-to-main.yml`のバージョンbump処理が前提にする
      `package.json`の`version`フィールド相当のものが存在するか）
- [ ] **更新履歴表示の同期要否**（対象リポジトリが自アプリ内に更新履歴のコメント表示を持つか）。
      `release-develop-to-main.yml`はバージョン判定ステップで利用者向けの更新履歴文言
      （`changelog`）も生成し、バンプ処理を`npm version "$NEW_VERSION" --no-git-tag-version`
      で実行する際に環境変数`RELEASE_CHANGELOG`としてexportする（#800）。更新履歴表示を持つ
      リポジトリは、自分の`package.json`に`"scripts": {"version": "..."}`を定義し、その中で
      `$RELEASE_CHANGELOG`を読んで自前の更新履歴ファイルを書き換える、という契約に乗るだけで
      よい（`release-develop-to-main.yml`本体はリポジトリ固有の書き込み先を一切知らない）。
      バンプコミットは`git add -A`で作成されるため、`"version"`スクリプトが新規作成・更新した
      ファイルは自動的にコミットへ含まれる。更新履歴表示を持たないリポジトリでは`"version"`
      スクリプトを定義しなければよく、何も変わらない

`m-guchi/shopping-list`のケーススタディでは、実際に差異が出たのは上記のうち
**パッケージマネージャ／検証コマンド**・**DBセットアップの要否**・**画面確認の可否**の3軸のみで、
ブランチ運用・ラベル体系は差異ゼロだった（詳細は[docs/cross-repo-automation.md](cross-repo-automation.md)参照）。

## 7. ラベル差分チェック

issue-deckと展開先リポジトリで、どのラベルに差分があるかを可視化するスクリプト。

```bash
scripts/check-label-diff.sh <owner/repo>
# 例:
scripts/check-label-diff.sh m-guchi/shopping-list
```

`gh api repos/<repo>/labels`を両リポジトリから取得し、(a) issue-deckのみに存在するラベル、
(b) 対象リポジトリのみに存在するラベル、(c) 両方に存在するが色・説明文が異なるラベル、の3区分で
出力する。どのラベルを共通化すべきかの判断・実際のラベル作成/削除までは行わない（差分の可視化に
留まる）。`gh`・`jq`コマンドが前提。手動実行想定（対象リポジトリを引数で指定する性質上、CIに常時
組み込むものではない）。

## 8. ワークフロー同期のずれ検知

issue-deck側のワークフロー改善が、展開済みの他リポジトリへ自動反映されることはない。時間が
経つほど気づかれにくくなるこの「ずれ」を軽減するため、2つの仕組みを用意している。

1. **`docs/supported-repositories.md`への`sync-state`マーカー記録**: リポジトリがワークフローを
   導入した際、どのファイルをissue-deckのどのコミット時点からコピー・改変したかを機械可読な形で
   記録する。

   ```html
   <!-- sync-state: repo=m-guchi/shopping-list workflow=claude-issue-dispatch.yml base-commit=<SHA> -->
   ```

   実際に他リポジトリへ展開する際は、導入者がこの記録を残す運用とする（自動追記の仕組みはない）。

   **マーカーの更新は初回導入時だけでなく、issue-deck側の改善をバックポートするたびに行う。**
   バックポートのPull Requestに`docs/supported-repositories.md`のマーカー更新を含めること
   （issue-deck側のPRとして別途出す形でもよいが、忘れると次項の検知が壊れる）。取り込まなかった
   ワークフローがある場合は、そのファイルだけ古いbase-commitのまま残し、意図的であることを
   本文に明記する。

2. **`scripts/check-workflow-sync-drift.sh`**: 上記の`sync-state`マーカーを読み取り、各エントリに
   ついて`git log <base-commit>..HEAD -- .github/workflows/<workflow>`でissue-deck側にその後
   加わった変更一覧を表示する。

   ```bash
   scripts/check-workflow-sync-drift.sh
   ```

   対象リポジトリへの書き込み・チェックアウト権限は不要（issue-deck自身のgit履歴のみで完結する）。
   `.github/workflows/ci.yml`に、PRが`.github/workflows/**`を変更する場合のみ実行する非ブロッキング
   の通知ステップ（`workflow-drift-notice`ジョブ）として組み込み済みで、ワークフロー変更のたびに
   「導入済みの他リポジトリがあるので確認を」というリマインダーをログに表示する（ビルド自体は
   失敗させない）。

この記録は導入者の手動追記に依存するため、記録を怠ると検知自体が機能しないという限界がある。また
「issue-deck側で何が変わったか」は示せても、その変更が対象リポジトリへ実際に反映されたか・意図的に
取り込まなかったのかまでは判別できない。

実際に#895で、バックポート後もマーカーが更新されず、既に取り込み済みの変更まで「未反映」として
報告される状態になっていた。**当たりと外れが混在した一覧は「常に大量に出るので誰も見ない」方向へ
劣化する**ため、出力を鵜呑みにせず対象リポジトリの実ファイルと突き合わせて確認し、確認した結果は
マーカーへ反映する。

## 9. 機械的な整合性チェックについて

本ガイド自体が実態とずれていくことを防ぐため、`.github/workflows/*.yml`から抽出できる3種類の
識別子（ワークフローファイル名・ラベル名・Secrets名）が本ドキュメント本文に記載されているかを
検証するスクリプトを用意している。

```bash
scripts/check-cross-repo-guide-sync.sh
```

`.github/workflows/ci.yml`の`docs-sync-check`ジョブとしてPR・push毎に自動実行され、未記載の識別子が
あれば非ゼロ終了する。ワークフローファイルの追加/削除・新しいラベルの導入・新しいSecretsの追加を
行った際、本ガイド側の一覧を更新し忘れるとCIが落ちる。

このチェックはあくまで「識別子（ファイル名・ラベル名・Secrets名）が本文中に登場するか」の存在
チェックに限定され、記載内容が実態と意味的に正しいかまでは保証できない。また`docs-sync-check`
ジョブを追加しても、現状のBranch protectionの必須ステータスチェック一覧には自動では追加されない
（GitHub側リポジトリ設定の変更が別途必要。本ガイドの追加時点では未設定）。

## 10. 共有知識リポジトリの参照設定

全アプリ共通の知識（Git/GitHub運用、Actions上でClaude Codeを動かす際の知見、共通コーディング方針、
デプロイ方針など）は、各リポジトリの`CLAUDE.md`に複製せず、共有知識リポジトリ`guchi-apps/docs`で
一元管理する。各リポジトリのワークフローは実行時にそれを`.shared-context/`へcheckoutして読む。
設計の全体像は[docs/shared-knowledge.md](shared-knowledge.md)を参照。

導入は任意だが、行う場合は次の3点が必要。

- [ ] **`.gitignore`に`/.shared-context/`を追加する。** checkout先をワークツリー内に置くため、
      誤コミットを防ぐ。
- [ ] **`secrets.WORKFLOW_PAT`が共有知識リポジトリへ到達できることを確認する。**
      `guchi-apps/docs`はprivateのため、checkoutにトークンが要る。PATのRepository accessが
      「All repositories」であれば追加設定は不要（issue-deckはこの設定）。リポジトリを個別指定
      している場合は`guchi-apps/docs`を追加する。必要なのは`Contents: Read`だけでよい
      （共有知識への書き込みは`guchi-apps/docs`側の格上げ判定ワークフローが行うため、
      導入先のPATに書き込み権限は要らない）。
- [ ] **共有知識のcheckoutステップを各ワークフローへ追加し、プロンプトに参照ルールを書く。**
      issue-deckの`claude-issue-dispatch.yml`・`claude-review-develop.yml`の
      「共有知識リポジトリをcheckoutする」ステップをそのままコピーできる。共有知識リポジトリを
      別のものにする場合は、リポジトリ変数`SHARED_CONTEXT_REPO`（既定値`guchi-apps/docs`）・
      `SHARED_CONTEXT_REF`（既定値`main`）で切り替えられるため、ワークフロー本文の改変は不要。

知見の書き戻しは**導入先に何も置かなくてよい**（#2029）。実装エージェントが対応Issueへ残す
知見メモ（`<!-- knowledge-candidate -->`）を、`guchi-apps/docs`側の格上げ判定エージェントが
フリート全体から拾って審査する。導入先の`CLAUDE.md`には「`.shared-context/`は読み取り専用」
「知見は自リポジトリの`docs/`へ書き、同じ内容を知見メモとしてIssueへ残す」「格上げの判定は
しない」を記載する（[shared-knowledge.md](shared-knowledge.md)「9. 共有知識更新フロー」）。

## 11. 盤面へ載せる（リポジトリを再同期）

callerを置いただけでは、そのリポジトリのIssueはカンバンに載らない。**載せる条件は
`hasClaudeWorkflow`が真であること**で、この実体は`claude-issue-dispatch.yml`が存在するか
どうかそのものである（[`workflow-support.ts`](../src/lib/github/workflow-support.ts)）。

```
hasClaudeWorkflow = GET /repos/{owner}/{repo}/actions/workflows/claude-issue-dispatch.yml が 404 でない
```

### 再同期は2つあり、両方を順に押す

**役割が分かれている。片方だけでは載らない。**

| ボタン | 実体 | すること |
|---|---|---|
| リポジトリを再同期 | `POST /api/sync/repositories` → `syncInstallationRepositories` | **`hasClaudeWorkflow`を更新するだけ** |
| Issueを再同期 | `POST /api/sync/issues` → `addMissingProjectItems` | **実際に盤面へ載せる**（`hasClaudeWorkflow`が真のリポジトリが対象） |

フラグを更新するのは前者だけ、載せるのは後者だけなので、**「リポジトリを再同期」→「Issueを再同期」
の順に押す。** どちらもログインセッションを要求するため、共有シークレットでは叩けない。
画面のボタンから実行する。

### 対象リポジトリのデフォルトブランチは`develop`にする

**`claude-issue-dispatch.yml`は、デフォルトブランチに無いと登録されない。**
そして`hasClaudeWorkflow`はこの登録の有無を見るため、`develop`へマージしただけでは真にならない。

さらに致命的なのは、**`issues`・`issue_comment`イベントはデフォルトブランチのワークフローしか
起動しない**というGitHubの仕様である。デフォルトが`main`のままだと、callerを`develop`へ入れても
`@claude`コメントに永久に反応しない。

```bash
# 確認
gh api repos/guchi-apps/my-app --jq .default_branch          # develop であること
gh api repos/guchi-apps/my-app/actions/workflows --jq '.workflows[].path'

# 変更（即時に反映され、既存PRの向き先は変わらない）
gh api -X PATCH repos/guchi-apps/my-app -f default_branch=develop
```

`push`イベントはブランチ上のワークフローを起動するため、`issue-labels.yml`だけは
デフォルトブランチに無くても動いてしまう。**片方だけ動いていると原因に気づきにくい。**

> `meisai-lab`（#1047の1周目）で実際に踏んだ。11リポジトリ中このリポジトリだけデフォルトが
> `main`のままで、`issue-labels.yml`は動くのに`claude-issue-dispatch.yml`が登録すらされて
> いなかった。デフォルトブランチを`develop`へ変えた瞬間に登録された。

### 作業中のIssueは再同期を待たずに載る

進捗報告API（`POST /api/progress`）は、**盤面に無いIssueを自分で載せてからStatusを書く**（#1036）。
そのため、callerを入れたブランチをpushした時点で、そのIssueだけは先に盤面へ現れる。

再同期が必要なのは**残りのopenなIssueを一括で載せるため**であって、導入作業そのものを
進めるためではない。順序に神経質になる必要はない。

## 12. 導入後の動作確認

いきなり実装を走らせず、影響の小さい順に確認する。

| 順 | 確認内容 | 方法 |
|---|---|---|
| 0 | 疎通 | `GET /api/progress`が405以外を返すこと（405なら本番が古い）。設定不足だと以降が全部静かに失敗する |
| 1 | 進捗遷移 | `issue-<番号>`ブランチへpushし、盤面のStatusが`Implementation`になること |
| 2 | 読み取り専用の質問応答 | Issueに`@claude 質問: ...`とコメントし、回答が投稿されること。**ブランチも進捗も変更されない**ため最も安全 |
| 3 | 実装フロー | `@claude`とコメントし、ブランチ作成・PR作成まで通ること |
| 4 | カンバン起点の起動 | `Ready`のIssueを`Planning`へドラッグし、**1回目で**計画提示が始まること（#1022の`allowed_bots`未設定を検知できる。載せた直後の初回ドラッグが無反応になる不具合は #1132 で解消済み） |
| 5 | 撮影（該当する場合） | `24.screenshot-required`付きIssueで実装し、画像が投稿されること |

**初回実行は`claude-code-action`のBunダウンロードで落ちることがある。** キャッシュが無いため
必ずダウンロードが走り、そこが不安定。ログに`Downloading a new version of Bun` →
`socket hang up`が出ていれば**設定は無関係**なので、疑う前に失敗ジョブを再実行する
（`meisai-lab`では3回目で通った）。同じジョブ内で`APP_BASE_URL`への疎通も同時に失敗していれば、
ランナー側のネットワーク問題である裏付けになる。

**2 の時点で、参照方式が成立しているかはほぼ判断できる。** 実行ログのジョブ名が `dispatch / triage` のように`caller名 / callee名`の形になっていれば、再利用ワークフロー経由で動いている。

`prompts-ref`が効いているかは「共有ファイルの参照先を決める」ステップのログで確認する。

```
プロンプトの参照先: .shared-prompts/.github/prompts
使用量出力スクリプト: .shared-prompts/.github/scripts/summarize-claude-usage.sh
```

`.shared-prompts/`から始まっていれば共有側、`./`から始まっていれば呼び出し元側のものが使われている。

### 実行ログの追跡時の注意

コメント投稿をきっかけに結果を確認するとき、**`gh run list --limit 1`で「最新のrun」を取ってはいけない。** botコメントやラベル操作が数秒差で同時に飛ぶため、自分が起こしたものではないrunを掴む。投稿前後のrun一覧を差分で取り、`event`と`createdAt`を自分のコメントの`createdAt`と突き合わせて特定すること。

## 13. ローカル起動スクリプト（任意）

ここまではGitHub Actions側の話。**issue-deckの画面からローカルのClaude Codeセッションをワンクリックで
起動する**経路は別立てで、対応するかどうかもリポジトリごとに選べる。Actions側の導入とは独立している。

**サブPCからの起動だけなら、リポジトリ側の作業は要らない**（#1224）。サブPCの対応表
（`~/.config/issue-deck/local-repos.conf`）へチェックアウト先を書けば、issue-deck側の汎用
ランチャーが起動する。手順は
[docs/multi-agent/generic-launcher.md](multi-agent/generic-launcher.md)「対象リポジトリを増やす」を参照。

以下は**「起動コマンドをコピー」で貼って起動したい場合**の話（「このPC」＝`issuedeck://`は#1263で廃止）。対応させるには2つ要る。

1. リポジトリに`scripts/start-issue.sh`を置き、**ローカル起動プロトコル**に適合させる
2. 各自の環境の対応表（`~/.config/issue-deck/local-repos.conf`）に、そのリポジトリのチェックアウト先を書く

2は環境ごとの設定なのでリポジトリには入らない。1だけがリポジトリ側の作業。

適合しているかは次で確認できる。

```bash
scripts/check-local-session-contract.sh --all
```

**約束の内容・移植時に書き換える6点・検査の仕組みは
[docs/multi-agent/local-quick-start.md](multi-agent/local-quick-start.md)「ローカル起動プロトコル v2」に
まとめてある。** ここでは重複して書かない。

適合状況の一覧は [docs/supported-repositories.md](supported-repositories.md)「ローカル起動プロトコルの
適合状況」。**Actions側の対応済みとは一致しない**（導入順が「ワークフロー→ローカル」になるため）。

## 付録: 8リポジトリの設定値一覧（#1047の実績）

`#1047`で8リポジトリへ導入した際の`with:`の実績値。**同じ「Next.js」でも値が揃わない**ので、
新しいリポジトリを足すときは推測せず`package.json`・CI設定を実際に見ること。

| リポジトリ | `runtime-setup` | `package-manager` | `node-version` | 決め手 |
|---|---|---|---|---|
| `meisai-lab` | `node-db` | npm | `"20.19"` | `prisma/`あり |
| `car-care` | `node-db` | npm | `"20.19"` | `prisma/`あり |
| `subscription-lists` | `node-db` | npm | `"20.19"` | `prisma/`あり |
| `asset-manager` | `node-db` | npm | **`"20"`** | CIが`ci.yml`ではなく`test.yml` |
| `portfolio` | **`node`** | npm | `"20"` | `prisma/`が無い |
| `solitaire` | **`minimal`** | npm | `"20"` | 依存ゼロ・ロックファイル無し |
| `myroom` | `minimal` | npm | `"20"` | ルートの依存が空スタブ。実体は`frontend/` |
| `signaly` | `minimal` | npm | **指定しない** | Nodeが一切無い |

**8件すべて`npm`。** `pnpm`はissue-deck自身と`dayspan`だけで、これが#1147
（許可ツールが`pnpm`固定だった不具合）が長く発覚しなかった理由でもある。

## 付録: 4リポジトリの設定値一覧（#1011 Phase 6・#1379の実績）

privateの3件（#1011）と、#1047の起票後に作られた`aide`（#1379）を追加した際の実績値。

| リポジトリ | `runtime-setup` | `package-manager` | `node-version` | 決め手 |
|---|---|---|---|---|
| `clip-hive` | `node-db` | npm | `"20.19"` | `prisma/`あり |
| `ops-dashboard` | **`node`** | npm | **`"22.23.1"`** | `prisma/`が無い。バージョンは`.nvmrc` |
| `db-console` | `node-db` | npm | **`"22.23.1"`** | `prisma/`あり。バージョンは`.nvmrc` |
| `aide` | `node` | npm | **`"24"`** | `prisma/`が無い。依存ゼロだが`npm ci`は要る |

**`.nvmrc`を使うリポジトリでは、そこから手で写す。** CIは`node-version-file`で`.nvmrc`を読めるが、
共有ワークフローは`node-version`入力しか見ない。`ops-dashboard`・`db-console`がこれに当たる。

**依存ゼロでも`minimal`にはしない**（`aide`）。`minimal`は`npm ci`ごとスキップするため、
`devDependencies`にしか無いTypeScriptが入らず`npm run typecheck`が通らなくなる。`minimal`が正しいのは
`solitaire`のようにロックファイルすら無い場合と、`myroom`のようにルートの依存が空スタブの場合。

### この4件で新しく出た差異

| 観点 | 出たリポジトリ | 内容 |
|---|---|---|
| `postinstall`が環境変数を要求する | `db-console` | `prisma.config.ts`の`env("DATABASE_URL")`が未設定で即失敗し、`npm ci`ごと落ちる。上記チェックリスト参照 |
| ビルドがプレースホルダー環境変数を要求する | `db-console` | 素の`npm run build`が`/auth/callback`で`ERR_INVALID_URL`。CIと同じ値をAGENTS.mdへ書いた |
| ブランチ命名が違う | `ops-dashboard` | `feature/<番号>-<説明>`。この命名では対象Issueを特定できず進捗が遷移しない |
| デフォルトブランチが`main` | `db-console` | `develop`へ変更した。変更前に`develop...main`のファイル差分が空であることを実測する |
| ラベルがGitHub既定のまま | `aide` | 旧世代の進捗ラベルすら無い。控える作業は不要で、既定ラベルは役割が重複するため削除した |
| auto-merge・rulesetが無い | `aide` | 有効化と`protect develop`の作成が要る。必須チェックの名前はリポジトリのCIのジョブ名に合わせる |

### 検証コマンドの実績

**「Next.jsなら`lint`・`typecheck`・`test`・`build`が揃っている」とは限らない。**

| リポジトリ | 持っていないもの | ラッパー付きコマンド |
|---|---|---|
| `car-care` | `test`・`typecheck` | `build`（`with-local-env.sh`）。CI用は`build:ci` |
| `asset-manager` | `test` | `build:local`（`with-local-env.sh`）。CI用は`build` |
| `portfolio` | `test`・`typecheck` | `build:local`（**`op run`**）。CI用は`build` |
| `solitaire` | `lint`・`typecheck` | なし |
| `myroom` | （`frontend/`には揃っている） | なし。ただし**ルートには無い** |
| `signaly` | **Lintも型チェックも無い** | なし |

## 関連ドキュメント

- [docs/shared-knowledge.md](shared-knowledge.md) — 全アプリ共通の共有知識リポジトリの設計
- [docs/cross-repo-automation.md](cross-repo-automation.md) — 展開方式の選択肢比較・調査結果
- [docs/supported-repositories.md](supported-repositories.md) — 導入済み・検討中リポジトリの記録
- [docs/multi-agent/local-quick-start.md](multi-agent/local-quick-start.md) — ローカル起動プロトコルと画面からのワンクリック起動
- [docs/multi-agent-workflow.md](multi-agent-workflow.md) — issue-deck自身の設計・実装の詳細
- [docs/github-app-permissions.md](github-app-permissions.md) — GitHub Appの権限棚卸し
- [CLAUDE.md](../CLAUDE.md) — issue-deckの運用ルール本体
