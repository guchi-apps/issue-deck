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

1. [ワークフローファイル一式](#1-ワークフローファイル一式)をコピーし、リポジトリ差異に合わせて改変する
2. [ラベル体系](#2-ラベル体系)を作成する
3. [CLAUDE.md](#3-claudemd)を新規作成、または既存ファイルに運用ルールを追記する
4. [Secrets](#4-secrets)を登録する
5. [ブランチ運用](#5-ブランチ運用)を揃える（`develop`/`main`の2段階運用、ブランチ命名規則、Branch protection）
6. [リポジトリ差異の吸収チェックリスト](#6-リポジトリ差異の吸収チェックリスト)を確認し、ワークフロー内の
   技術スタック固有部分を置き換える
7. 必要に応じて[ラベル差分チェック](#7-ラベル差分チェック)・[ワークフロー同期のずれ検知](#8-ワークフロー同期のずれ検知)の
   スクリプトを利用する
8. [docs/supported-repositories.md](supported-repositories.md)に導入状況を記録する

## 1. ワークフローファイル一式

`.github/workflows/`配下のうち、マルチエージェント運用の自動化本体は以下5ファイルである。

| ファイル | 役割 | 主な改変ポイント（技術スタックが異なる場合） |
|---|---|---|
| `claude-issue-dispatch.yml` | `@claude`コメントを起点に、計画提示／実装／PR作成／質問応答／スクリーンショット撮影までを無人実行する（issue-deckでは944行、最大のワークフロー） | pnpm（`pnpm/action-setup`）・Next.js（`next dev`）・Prisma（`pnpm db:migrate:deploy`）・MySQLサービスコンテナ等、issue-deck固有のセットアップ手順を対象リポジトリのスタックに置き換える。DBを使わない・ビルド不要なリポジトリではこれらのステップ自体を削除できる |
| `issue-labels.yml` | `01.planning`〜`09.main`のラベル状態遷移をブランチpush・PR作成・PRマージ等のイベントで自動化する | ラベル名・`issue-<番号>`ブランチ命名規則が一致していればほぼ無改変で移植できる。スクリーンショット撮影を導入しないリポジトリでは、末尾の`screenshots`ブランチ掃除ジョブを削除してよい |
| `claude-review-develop.yml` | develop向けPRの自動レビュー・自動マージ不可判定（`risk-check`）・Auto-merge有効化を行う | `risk-check`ジョブの機械判定パターン（`prisma/migrations/**`・`.env*`・`.github/workflows/**`・`**/auth/**`等）を、対象リポジトリのディレクトリ構成・自動マージ不可カテゴリに合わせて調整する |
| `claude-conflict-resolve.yml` | develop向けPRがdevelopとコンフリクトした場合に自動解消を試みる | 検証ステップ（lint/test/build相当のコマンド）を対象リポジトリのコマンドに置き換える |
| `release-develop-to-main.yml` | develop→mainのバージョンbump PR・リリースPR作成を自動化する（`workflow_dispatch`のみ） | バージョン管理方式（`package.json`の`version`比較か、別言語のバージョンファイルか）に応じた改変が必要 |

各ワークフローの改変ポイントの詳細・実例（`m-guchi/shopping-list`を対象にしたケーススタディ）は
[docs/cross-repo-automation.md](cross-repo-automation.md)の「ワークフローごとの移植コスト」を参照。

### 参考: issue-deckの全ワークフロー一覧

上記5ファイル以外にissue-deckが持つワークフローは、issue-deck自身のCI・デプロイ用途に固有であり、
マルチエージェント運用の移植対象ではない（参考として一覧化する）。

| ファイル | 用途 | 移植要否 |
|---|---|---|
| `ci.yml` | lint・型チェック・テスト・ビルドを実行するCI本体 | 対象リポジトリごとに固有の内容のため、そのままの移植ではなく参考にする程度 |
| `deploy.yml` | `main`へのpushをトリガーにしたPM2デプロイ | issue-deck固有の本番環境向け。不要 |
| `release.yml` | リリースタグ関連の処理 | issue-deck固有。不要 |

## 2. ラベル体系

マルチエージェント運用の状態遷移・オプション制御に使う12個のラベルは、issue-deckリポジトリに
手動で作成したカスタムラベルであり、他リポジトリには存在しない。

| ラベル | 色 | 説明 | 用途 |
|---|---|---|---|
| `00.check-user` | `f0883e` | ユーザーの確認・指示が必要 | 承認待ち・自動マージ保留の合図。他の状態ラベルと併用 |
| `01.planning` | `e9f7e6` | 状態：計画検討中 | `21.plan-required`選択時のみ経由 |
| `02.wip` | `d3f2d0` | 状態：実装中 | 実装エージェントが着手時に付与 |
| `03.d:marge` | `a8e6a1` | developへのPRを作成・マージ待ち | PR作成時に付与 |
| `05.develop` | `6fcf73` | developへマージ完了（main未反映） | developマージ完了時に付与 |
| `07.m:marge` | `2f9e44` | mainへのPRを作成・マージ待ち | develop→mainのPRが開いている間 |
| `09.main` | `1b5e20` | mainへマージ完了・リリース済み | この時点でissueをclose |
| `21.plan-required` | `d4c5f9` | 計画の確認・承認が必要 | 実装前にPlan modeでの計画提示を必須にする |
| `22.merge-confirm-required` | `d4c5f9` | developへのマージ前に人間の確認・承認が必要 | 内容によらず常に`00.check-user`を付与させる |
| `23.preview-required` | `d4c5f9` | 画面プレビューでの確認・承認が必要 | PR作成前に開発サーバーURLでの確認を必須にする |
| `24.screenshot-required` | `d4c5f9` | スクリーンショットでの視覚確認・承認が必要 | PR作成前にスクリーンショット取得・承認を必須にする |
| `70.confirm` | `5319e7` | 確認項目（実施するか検討必要） | 計画提示ステップが関連Issueを自発的に起票する際に付与し、`02.wip`等の実装フローへ自動で乗らないようにする |

`gh label create`での作成例:

```bash
gh label create "00.check-user" --color f0883e --description "ユーザーの確認・指示が必要"
gh label create "01.planning" --color e9f7e6 --description "状態：計画検討中"
gh label create "02.wip" --color d3f2d0 --description "状態：実装中"
gh label create "03.d:marge" --color a8e6a1 --description "developへのPRを作成・マージ待ち"
gh label create "05.develop" --color 6fcf73 --description "developへマージ完了（main未反映）"
gh label create "07.m:marge" --color 2f9e44 --description "mainへのPRを作成・マージ待ち"
gh label create "09.main" --color 1b5e20 --description "mainへマージ完了・リリース済み"
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
  [docs/multi-agent-workflow.md](multi-agent-workflow.md)の「ブランチ保護ルール案」を参照

## 6. リポジトリ差異の吸収チェックリスト

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

## 関連ドキュメント

- [docs/cross-repo-automation.md](cross-repo-automation.md) — 展開方式の選択肢比較・調査結果
- [docs/supported-repositories.md](supported-repositories.md) — 導入済み・検討中リポジトリの記録
- [docs/multi-agent-workflow.md](multi-agent-workflow.md) — issue-deck自身の設計・実装の詳細
- [docs/github-app-permissions.md](github-app-permissions.md) — GitHub Appの権限棚卸し
- [CLAUDE.md](../CLAUDE.md) — issue-deckの運用ルール本体
