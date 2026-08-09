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
- 設計の経緯・issue-deck自身での詳細実装は[docs/multi-agent-workflow.md](multi-agent-workflow.md)を
  参照。

## 導入ステップの全体像

上から順に実行すればよい。

1. [対象リポジトリの構成を調べ、5つの設定値を決める](#0-最初に決める5つの設定値)
2. [ワークフローファイルを配置する](#1-ワークフローファイル一式)（移行済みの2つは**コピーせず参照**、残りはコピーして改変）
3. [ラベル体系](#2-ラベル体系)を作成する
4. [CLAUDE.md](#3-claudemd)を新規作成、または既存ファイルに運用ルールを追記する
5. [Secrets](#4-secrets)を登録する
6. [ブランチ運用](#5-ブランチ運用)を揃える（`develop`/`main`の2段階運用、ブランチ命名規則、Branch protection）
7. [コピーしたワークフローのリポジトリ差異を吸収する](#6-リポジトリ差異の吸収チェックリスト)（参照方式のものは`with:`で指定済みのため対象外）
8. 必要に応じて[ラベル差分チェック](#7-ラベル差分チェック)・[ワークフロー同期のずれ検知](#8-ワークフロー同期のずれ検知)の
   スクリプトを利用する
9. [共有知識リポジトリの参照設定](#10-共有知識リポジトリの参照設定)を行う（任意）
10. [動作を確認する](#11-導入後の動作確認)
11. [docs/supported-repositories.md](supported-repositories.md)に導入状況を記録する

## 0. 最初に決める5つの設定値

参照方式のワークフロー（`claude-issue-dispatch.yml`）に渡す `with:` の値。**対象リポジトリごとに決めるのはこれだけ**で、ワークフロー本体を編集する必要はない。

| 設定 | 決め方 | 例 |
|---|---|---|
| `runtime-setup` | DBあり（Prisma等）→`node-db` / DBなしのNext.js等→`node` / 素のJS・依存なし→`minimal` | `minimal` |
| `package-manager` | `pnpm-lock.yaml`があれば`pnpm`、`package-lock.json`なら`npm` | `npm` |
| `node-version` | 対象リポジトリのCI（`ci.yml`）が固定しているバージョンに揃える。固定していなければ未指定でよい | `"20.19"` |
| `prompts-ref` | **`uses:`と同じタグ**。対象リポジトリに`.github/prompts/`が無い限り必須 | `workflows/v6` |
| `post-implement-script` | 実装後に固有の後処理（スクリーンショット撮影など）が要る場合のみ、そのスクリプトのパス | `scripts/ci-post-implement.sh` |

判断材料は以下のコマンドで集められる。

```bash
REPO=m-guchi/<対象リポジトリ>
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
| **参照方式**（移行済み） | `claude-issue-dispatch.yml`・`issue-labels.yml` | 薄いcallerを置き、issue-deck側の`reusable-*.yml`を`uses:`で呼ぶ。**ワークフロー本体もプロンプトもコピーしない** |
| コピー方式（未移行） | `claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`・`release-develop-to-main.yml`・`shared-knowledge-propose.yml` | ファイルをコピーし、リポジトリ差異に合わせて改変する |

参照方式は薄いcallerを置くだけで済み、issue-deck側の改善が**参照タグを上げるだけ**で反映される（背景と方式は[docs/cross-repo-automation.md](cross-repo-automation.md)を参照）。未移行のものも順次こちらへ寄せていく。

| ファイル | 役割 | 主な改変ポイント（技術スタックが異なる場合） |
|---|---|---|
| `claude-issue-dispatch.yml` | `@claude`コメントを起点に、計画提示／実装／PR作成／質問応答／スクリーンショット撮影までを無人実行する。**トリガー定義とプレビュー系ジョブのみ**を持ち、本体は`reusable-issue-dispatch.yml`を`uses:`で呼ぶ | **コピーではなく薄いcallerを置く。** 技術スタックの差は`with:`の`runtime-setup`（`node-db`/`node`/`minimal`）・`package-manager`（`npm`/`pnpm`）で指定する（下記「再利用可能ワークフローの参照」）。プレビュー系の`deploy-preview`／`notify-preview-url`ジョブはFly.io設定がアプリ固有のため、caller側に置いて対象リポジトリの`deploy-preview.yml`を呼ぶ |
| `reusable-issue-dispatch.yml` | 上記のジョブ本体（`on: workflow_call`）。`triage`／`dispatch`／`notify-failure`を含む | **対象リポジトリへコピーしない。** issue-deck側の1つを共有する。`.github/prompts/`配下は`prompts-ref`で取得元を指定する（下記「プロンプトの取得元」。**指定しないと呼び出し元側の`.github/prompts/`が読まれ、無ければ落ちる**） |
| `issue-labels.yml` | `01.planning`〜`09.main`のラベル状態遷移を担うワークフローの**トリガー定義のみ**。ジョブ本体は`reusable-issue-labels.yml`にあり、`uses:`で呼び出す | **コピーではなく、issue-deckの`reusable-issue-labels.yml`をタグ固定で参照する薄いcallerを置く**（下記「再利用可能ワークフローの参照」を参照）。ラベル名・`issue-<番号>`ブランチ命名規則が一致していれば改変不要 |
| `reusable-issue-labels.yml` | 上記のジョブ本体（`on: workflow_call`）。他リポジトリから呼び出される実体 | **対象リポジトリへコピーしない。** issue-deck側の1つを共有する |
| `claude-review-develop.yml` | develop向けPRの自動レビュー・自動マージ不可判定（`risk-check`）・Auto-merge有効化を行う | `risk-check`ジョブの機械判定パターン（`prisma/migrations/**`・`.env*`・`.github/workflows/**`・`**/auth/**`等）を、対象リポジトリのディレクトリ構成・自動マージ不可カテゴリに合わせて調整する |
| `claude-conflict-resolve.yml` | develop向けPRがdevelopとコンフリクトした場合に自動解消を試みる | 検証ステップ（lint/test/build相当のコマンド）を対象リポジトリのコマンドに置き換える |
| `claude-ci-fix.yml` | develop向けPRのCIが失敗した場合に自動修正を試みる | CIワークフロー名（`workflows: ["CI"]`）・検証ステップ（lint/test/build相当のコマンド）を対象リポジトリの構成に置き換える |
| `release-develop-to-main.yml` | develop→mainのバージョンbump PR・リリースPR作成を自動化する（`workflow_dispatch`のみ） | バージョン管理方式（`package.json`の`version`比較か、別言語のバージョンファイルか）に応じた改変が必要 |
| `shared-knowledge-propose.yml` | developマージ後、承認済みの「共有知識への追加提案」を共有知識リポジトリ（`m-guchi/docs`）へのPull Requestに変換する | リポジトリ固有の前提を持たないため、ほぼ無改変で移植できる。共有知識リポジトリを別のものにする場合はリポジトリ変数`SHARED_CONTEXT_REPO`で切り替える。導入は任意（共有知識層を使わないリポジトリでは不要） |

各ワークフローの改変ポイントの詳細・実例（`m-guchi/shopping-list`を対象にしたケーススタディ）は
[docs/cross-repo-automation.md](cross-repo-automation.md)の「ワークフローごとの移植コスト」を参照。

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
    uses: m-guchi/issue-deck/.github/workflows/reusable-issue-labels.yml@workflows/v6
    permissions:
      issues: write
      pull-requests: write
      contents: write
```

`claude-issue-dispatch.yml` のように技術スタックの差がある場合は `with:` で指定する。

```yaml
jobs:
  dispatch:
    uses: m-guchi/issue-deck/.github/workflows/reusable-issue-dispatch.yml@workflows/v6
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

#### プロンプトの取得元（`prompts-ref`）

**他リポジトリから呼ぶ場合は必ず指定する。**

```yaml
    uses: m-guchi/issue-deck/.github/workflows/reusable-issue-dispatch.yml@workflows/v6
    with:
      prompts-ref: workflows/v6   # ↑の uses: と同じタグを指定する
```

共有ワークフローは `actions/checkout`（`repository:` 未指定＝呼び出し元）でチェックアウトするため、**`.github/prompts/` 配下も呼び出し元リポジトリのものが読まれる**。指定しないと、プロンプトを持たないリポジトリでは最初のClaudeステップで落ちる。

- `prompts-ref` が空（既定）→ 呼び出し元の `.github/prompts/` を使う。**issue-deck 自身はこちら**
- 非空 → `m-guchi/issue-deck` をその ref でチェックアウトし、そちらのプロンプトを使う

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
| `workflows/v6` | 上記 | 使用量出力スクリプトも共有側から解決するよう修正（#964）。現時点の最新タグで、m-guchi/shopping-list・m-guchi/dayspanが参照している |

タグの一覧は `git tag --list 'workflows/*'`、各リポジトリが参照中のバージョンは対象リポジトリのcallerファイルで確認する（[docs/supported-repositories.md](supported-repositories.md)「参照方式のワークフローは sync-state の対象外」を参照）。
- **`permissions`はcaller側で付与する。** 呼ばれる側の権限はcallerの付与範囲を超えられない。
- **`secrets: inherit`は不要**（`secrets.GITHUB_TOKEN`は再利用可能ワークフローでも自動的に利用可能）。ただしリポジトリ固有のsecretsを使うワークフローでは必要になる。その場合、渡るのは**caller側リポジトリのsecrets**であるため、各リポジトリに個別の設定が要る。
- issue-deckがprivateリポジトリになった場合、または対象リポジトリがprivateの場合は、issue-deck側の Settings → Actions → Access で同一オーナーからのアクセスを許可する必要がある（publicどうしなら設定不要）。

### プロンプト・補助スクリプトはコピーしない

`claude-issue-dispatch.yml`のプロンプト本文は、ワークフローYAMLではなく`.github/prompts/`配下のMarkdownに置いている（#907。GitHub Actionsの式テンプレート長の上限21,000バイトを避けるため。詳細は[docs/multi-agent/prompts-and-models.md](multi-agent/prompts-and-models.md)）。

**参照方式では、これらを対象リポジトリへコピーする必要はない。** `prompts-ref`を指定すれば、issue-deck側が`.shared-prompts/`へチェックアウトされ、そちらのファイルが使われる（#960・#964）。

| ファイル | 参照方式での扱い |
|---|---|
| `.github/prompts/{plan,split,question,implement}.md` | **コピー不要。** `prompts-ref`で解決される |
| `.github/scripts/summarize-claude-usage.sh` | **コピー不要。** 同じく`prompts-ref`で解決される |

**`prompts-ref`を指定し忘れると、呼び出し元リポジトリの`.github/prompts/`が読まれ、存在しないため最初のClaudeステップで落ちる。** 使用量出力スクリプトも同様に解決されるため、これが無いと`exit 127`でジョブが失敗する（#964で実際に発生）。

対象リポジトリ固有のプロンプトを使いたい場合に限り、`.github/prompts/`配下を自分で用意して`prompts-ref`を未指定にする。ただしプロンプトは4ファイル・約48KBで最も更新頻度が高い部分のため、**特段の理由がなければ共有側を使う**こと。

プロンプト内の動的な値は`${ISSUE_NUMBER}`・`${BRANCH}`・`${PR_URL}`・`${MODE}`・`${REPOSITORY}`・`${RUN_URL}`のプレースホルダで表現され、ワークフロー側の「〜プロンプトを組み立てる」ステップが`envsubst`で埋めて環境変数へ格納する。

### 参考: issue-deckの全ワークフロー一覧

上記6ファイル以外にissue-deckが持つワークフローは、issue-deck自身のCI・デプロイ用途に固有であり、
マルチエージェント運用の移植対象ではない（参考として一覧化する）。

| ファイル | 用途 | 移植要否 |
|---|---|---|
| `ci.yml` | lint・型チェック・テスト・ビルドを実行するCI本体 | 対象リポジトリごとに固有の内容のため、そのままの移植ではなく参考にする程度 |
| `deploy.yml` | `main`へのpushをトリガーにしたPM2デプロイ | issue-deck固有の本番環境向け。不要 |
| `deploy-preview.yml` | 本番DBダンプをサニタイズしてFly.io Machine上にIssueごとのプレビュー環境をデプロイする（`workflow_dispatch`／`workflow_call`） | issue-deck固有のFly.io Machine構成向け。不要 |
| `cleanup-preview.yml` | `deploy-preview.yml`が作ったIssueごとのプレビューアプリを破棄する（PRクローズ・Issueクローズ・ラベル解除・アイドル5分での定期掃除） | 同上。`deploy-preview.yml`を導入する場合のみ対で必要 |
| `preview-logs.yml` | デプロイを伴わず、プレビュー環境のMachineのログだけを取得する（`workflow_dispatch`） | issue-deck固有のFly.io Machine構成向け。不要 |
| `release.yml` | リリースタグ関連の処理 | issue-deck固有。不要 |

## 2. ラベル体系

マルチエージェント運用の状態遷移・オプション制御に使う14個のラベルは、issue-deckリポジトリに
手動で作成したカスタムラベルであり、導入前の他リポジトリには存在しない。

**ラベルの正はこのissue-deckリポジトリに置いている。** `m-guchi/docs`の`label-sync/`にある
同期スクリプトで、issue-deckをソースとして対象リポジトリへ一括作成できる。

```bash
cd /home/guchi/apps/_docs/label-sync
./sync-labels.sh dry-run --from issue-deck --to my-app   # 差分プレビュー
./sync-labels.sh apply   --from issue-deck --to my-app   # 反映
```

同期スクリプトはissue-deckの全ラベルを配るため、下記14個に加えて`30.bug`・`51.improvement`等の
分類用ラベルもあわせて作成される。ラベルを個別に作りたい場合は次の`gh label create`を使う。

| ラベル | 色 | 説明 | 用途 |
|---|---|---|---|
| `00.check-user` | `f0883e` | ユーザーの確認・指示が必要 | 承認待ち・自動マージ保留の合図。他の状態ラベルと併用 |
| `00.qa-answered` | `c5def5` | 質問への回答のみ完了 | `00.check-user`と常に併用。単なる質問・確認と判定された場合に付与し、承認ボタンの文言を出し分ける |
| `01.planning` | `e9f7e6` | 状態：計画検討中 | `21.plan-required`選択時のみ経由 |
| `02.wip` | `d3f2d0` | 状態：実装中 | 実装エージェントが着手時に付与 |
| `03.d:marge` | `a8e6a1` | developへのPRを作成・マージ待ち | PR作成時に付与 |
| `05.develop` | `6fcf73` | developへマージ完了（main未反映） | developマージ完了時に付与 |
| `07.m:marge` | `2f9e44` | mainへのPRを作成・マージ待ち | develop→mainのPRが開いている間 |
| `09.main` | `1b5e20` | mainへマージ完了・リリース済み | この時点でissueをclose |
| `11.local` | `e99695` | ローカル(VSCode等)で対応中。無人実行ワークフローを起動しない | 付いている間`claude-issue-dispatch.yml`が計画・実装・分割・追加対応を行わない（読み取り専用の質問応答のみ例外）。ローカルセッションとの二重起動防止 |
| `21.plan-required` | `d4c5f9` | 計画の確認・承認が必要 | 実装前にPlan modeでの計画提示を必須にする |
| `22.merge-confirm-required` | `d4c5f9` | developへのマージ前に人間の確認・承認が必要 | 内容によらず常に`00.check-user`を付与させる |
| `23.preview-required` | `d4c5f9` | 画面プレビューでの確認・承認が必要 | PR作成前に開発サーバーURLでの確認を必須にする |
| `24.screenshot-required` | `d4c5f9` | スクリーンショットでの視覚確認・承認が必要 | PR作成前にスクリーンショット取得・承認を必須にする |
| `70.confirm` | `5319e7` | 確認項目（実施するか検討必要） | 計画提示ステップが関連Issueを自発的に起票する際に付与し、`02.wip`等の実装フローへ自動で乗らないようにする |

`gh label create`での作成例:

```bash
gh label create "00.check-user" --color f0883e --description "ユーザーの確認・指示が必要"
gh label create "00.qa-answered" --color c5def5 --description "質問への回答のみ完了"
gh label create "01.planning" --color e9f7e6 --description "状態：計画検討中"
gh label create "02.wip" --color d3f2d0 --description "状態：実装中"
gh label create "03.d:marge" --color a8e6a1 --description "developへのPRを作成・マージ待ち"
gh label create "05.develop" --color 6fcf73 --description "developへマージ完了（main未反映）"
gh label create "07.m:marge" --color 2f9e44 --description "mainへのPRを作成・マージ待ち"
gh label create "09.main" --color 1b5e20 --description "mainへマージ完了・リリース済み"
gh label create "11.local" --color e99695 --description "ローカル(VSCode等)で対応中。無人実行ワークフローを起動しない"
gh label create "21.plan-required" --color d4c5f9 --description "計画の確認・承認が必要"
gh label create "22.merge-confirm-required" --color d4c5f9 --description "developへのマージ前に人間の確認・承認が必要"
gh label create "23.preview-required" --color d4c5f9 --description "画面プレビューでの確認・承認が必要"
gh label create "24.screenshot-required" --color d4c5f9 --description "スクリーンショットでの視覚確認・承認が必要"
gh label create "70.confirm" --color 5319e7 --description "確認項目（実施するか検討必要）"
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
| `WORKFLOW_PAT` | `.github/workflows/`配下へのpush・`00.check-user`ラベル付け替え等、既定の`GITHUB_TOKEN`では権限が足りない操作に使うFine-grained PAT（Repository permissions > Workflows: Read and write を含む） | 既定の`GITHUB_TOKEN`は`.github/workflows/`配下へのpushをGitHub仕様上許可できないため必須 |
| `GITHUB_TOKEN` | Issue/PRへのコメント投稿・ラベル操作等の既定操作 | GitHub Actionsが自動的に提供する既定のSecretsのため、リポジトリ側での登録は不要 |
| `OP_SERVICE_ACCOUNT_TOKEN` | issue-deck自身のSignaly（社内通知）連携で使う1Password Service Accountトークン | マルチエージェント運用そのものには不要。issue-deckの`ci.yml`/`deploy.yml`/`release.yml`固有の設定であり、他リポジトリで導入する必然性はない |

`m-guchi/shopping-list`のケーススタディでは、1Password Service Account経由でのSecrets注入
（`1password/load-secrets-action@v4` + `op://...`参照）が既に稼働しており、`CLAUDE_CODE_OAUTH_TOKEN`も
同じ経路で配布可能と確認できている。ただし`WORKFLOW_PAT`は`actions/checkout`の`token`入力に
`checkout`ステップの時点で渡す必要があり、1Password経由の注入は`checkout`後にしか実行できないため、
`WORKFLOW_PAT`だけはGitHub Secretsへの直接登録が必要になる点に注意（詳細は
[docs/cross-repo-automation.md](cross-repo-automation.md)のケーススタディ参照）。

## 5. ブランチ運用

- `main`は本番環境と一致するリリース用ブランチ。直接push禁止、`develop`→`main`のPRのみ
- `develop`が日常の開発ブランチ
- Issue専用ブランチは`develop`から作成し、ブランチ名は`issue-<Issue番号>`とする
  （`issue-labels.yml`等のIssue番号特定処理がこの命名規則に依存しており、従わないブランチは
  全ワークフローの対象外になる）
- Branch protection: `main`はRequire pull request before merging・Required status checks、
  `develop`は最低限`required_status_checks`（CIジョブ名）を設定する。詳細な設定値・設定コマンド例は
  [docs/multi-agent/branching.md](multi-agent/branching.md)の「ブランチ保護ルール案」を参照

## 6. リポジトリ差異の吸収チェックリスト

> **適用範囲**: 本節は**コピー方式のワークフロー**（`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`・`release-develop-to-main.yml`）が対象。参照方式の2つ（`claude-issue-dispatch.yml`・`issue-labels.yml`）は「0. 最初に決める5つの設定値」の`with:`で吸収済みのため、ワークフローを編集する必要はない。


ワークフローファイルをそのままコピーしても動かない、個別カスタマイズが必要な観点。

- [ ] **パッケージマネージャ・依存関係インストールコマンド**（pnpm/npm/yarn、Node.js以外のスタックを
      含むか）
- [ ] **lint・型チェック・テスト・ビルドコマンド**
- [ ] **DBマイグレーション・シードの要否とコマンド**（DBを使わないリポジトリではステップごと削除）
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
デプロイ方針など）は、各リポジトリの`CLAUDE.md`に複製せず、共有知識リポジトリ`m-guchi/docs`で
一元管理する。各リポジトリのワークフローは実行時にそれを`.shared-context/`へcheckoutして読む。
設計の全体像は[docs/shared-knowledge.md](shared-knowledge.md)を参照。

導入は任意だが、行う場合は次の3点が必要。

- [ ] **`.gitignore`に`/.shared-context/`を追加する。** checkout先をワークツリー内に置くため、
      誤コミットを防ぐ。
- [ ] **`secrets.WORKFLOW_PAT`が共有知識リポジトリへ到達できることを確認する。**
      `m-guchi/docs`はprivateのため、checkoutにトークンが要る。PATのRepository accessが
      「All repositories」であれば追加設定は不要（issue-deckはこの設定）。リポジトリを個別指定
      している場合は`m-guchi/docs`を追加し、`Contents: Read and write`・
      `Pull requests: Read and write`を付与する（`shared-knowledge-propose.yml`まで導入せず
      読み取りだけなら`Contents: Read`で足りる）。
- [ ] **共有知識のcheckoutステップを各ワークフローへ追加し、プロンプトに参照ルールを書く。**
      issue-deckの`claude-issue-dispatch.yml`・`claude-review-develop.yml`の
      「共有知識リポジトリをcheckoutする」ステップをそのままコピーできる。共有知識リポジトリを
      別のものにする場合は、リポジトリ変数`SHARED_CONTEXT_REPO`（既定値`m-guchi/docs`）・
      `SHARED_CONTEXT_REF`（既定値`main`）で切り替えられるため、ワークフロー本文の改変は不要。

知見の書き戻し（実装エージェントの提案 → レビューエージェントの審査 → `shared-knowledge-propose.yml`
による反映PR → 人間のマージ）まで導入する場合は、`shared-knowledge-propose.yml`もあわせてコピーし、
`CLAUDE.md`に「`.shared-context/`は読み取り専用」「共通知見は提案コメントにとどめる」ルールを
記載する。

## 11. 導入後の動作確認

いきなり実装を走らせず、影響の小さい順に確認する。

| 順 | 確認内容 | 方法 |
|---|---|---|
| 1 | ラベル遷移 | `issue-<番号>`ブランチへpushし、Issueに`02.wip`が付くこと |
| 2 | 読み取り専用の質問応答 | Issueに`@claude 質問: ...`とコメントし、回答が投稿されること。**ブランチもラベルも変更されない**ため最も安全 |
| 3 | 実装フロー | `@claude`とコメントし、ブランチ作成・PR作成まで通ること |
| 4 | 撮影（該当する場合） | `24.screenshot-required`付きIssueで実装し、画像が投稿されること |

**2 の時点で、参照方式が成立しているかはほぼ判断できる。** 実行ログのジョブ名が `dispatch / triage` のように`caller名 / callee名`の形になっていれば、再利用ワークフロー経由で動いている。

`prompts-ref`が効いているかは「共有ファイルの参照先を決める」ステップのログで確認する。

```
プロンプトの参照先: .shared-prompts/.github/prompts
使用量出力スクリプト: .shared-prompts/.github/scripts/summarize-claude-usage.sh
```

`.shared-prompts/`から始まっていれば共有側、`./`から始まっていれば呼び出し元側のものが使われている。

### 実行ログの追跡時の注意

コメント投稿をきっかけに結果を確認するとき、**`gh run list --limit 1`で「最新のrun」を取ってはいけない。** botコメントやラベル操作が数秒差で同時に飛ぶため、自分が起こしたものではないrunを掴む。投稿前後のrun一覧を差分で取り、`event`と`createdAt`を自分のコメントの`createdAt`と突き合わせて特定すること。

## 関連ドキュメント

- [docs/shared-knowledge.md](shared-knowledge.md) — 全アプリ共通の共有知識リポジトリの設計
- [docs/cross-repo-automation.md](cross-repo-automation.md) — 展開方式の選択肢比較・調査結果
- [docs/supported-repositories.md](supported-repositories.md) — 導入済み・検討中リポジトリの記録
- [docs/multi-agent-workflow.md](multi-agent-workflow.md) — issue-deck自身の設計・実装の詳細
- [docs/github-app-permissions.md](github-app-permissions.md) — GitHub Appの権限棚卸し
- [CLAUDE.md](../CLAUDE.md) — issue-deckの運用ルール本体
