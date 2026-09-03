# 他リポジトリでも同様の自動化を有効にするための調査

issue #354 に対応する調査ドキュメント。IssueDeck本体（Webアプリ）に既にある「実装を開始」
ボタン・「質問する」ボタンは、`@claude ...`形式の定型コメントをGitHub App経由で
投稿する仕組み自体は特定リポジトリに依存せず汎用化されている。しかし、そのコメントを実際に
受けて実装〜レビュー〜マージまで進める自動化本体（`.github/workflows/`配下のワークフロー群と
対応するラベル体系）は、現状issue-deckリポジトリ自身にのみ存在し、issue-deck自身の開発
（セルフホスティング）専用になっている。本ドキュメントは、この自動化を他リポジトリでも
使えるようにするために必要な要素を整理し、実現方式の選択肢を比較する。**コード変更は行わず、
調査結果のドキュメント化のみを行う。** 実際に他リポジトリへ導入する際の実務手順は
[docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md)（issue #723）を参照。

## 現状把握

### IssueDeckアプリ側（汎用化済みの部分）

- `src/lib/github/start-implementation.ts`: 「実装を開始」ボタン押下時に`@claude 実装を開始
  してください`という定型コメントを投稿する。あわせて選択したオプション（`21.plan-required`・
  `23.preview-required`・`24.screenshot-required`に対応するラベル）を付与する。リポジトリ固有の
  前提を含まない。
- `src/lib/github/ask-claude.ts`: 「質問する」ボタン（Issue詳細のコメント欄の下。#1913）押下時に
  `@claude 質問: <本文>`という
  定型コメントを投稿する。質問コメントは末尾の`<!-- issue-deck-question -->`マーカー、回答コメントは
  `<!-- issue-deck-qa-answer -->`マーカーで識別する（#1294。「質問である」ことの識別と「Actionsを
  起こすトリガー」は別の軸で、後者は本文の先頭が`@claude`かどうかで決まる。詳細は
  [docs/multi-agent/subpc-dispatch.md](multi-agent/subpc-dispatch.md)）。
  こちらもリポジトリ固有の前提を含まない。
- どちらも投稿するのはコメントとラベルのみで、実際にコメントを解釈して実装まで進める処理は
  持たない。つまりアプリ側は「起動トリガーを送る」役割に閉じており、他リポジトリでこのボタンを
  押しても、対象リポジトリに対応するワークフローが存在しない限り何も起こらない。

### 自動化本体（issue-deck専用）

`.github/workflows/`配下の主要ワークフローとその責務:

| ファイル | 責務 |
|---|---|
| `claude-issue-dispatch.yml` | `@claude`コメントを起点に、計画提示／実装／PR作成／質問応答／スクリーンショット撮影までを無人実行する（944行、最大のワークフロー） |
| `issue-labels.yml` | `Planning`〜`Done`の進捗（Project Status）の状態遷移をブランチpush・PR作成・PRマージ等のイベントで自動化する（#991 Phase 5までは`01.planning`〜`09.main`のラベル遷移だった） |
| `claude-review-develop.yml` | develop向けPRの自動レビュー・自動マージ不可判定（`risk-check`）・Auto-merge有効化を行う |
| `claude-conflict-resolve.yml` | develop向けPRがdevelopとコンフリクトした場合に自動解消を試みる |
| `release-develop-to-main.yml` | develop→mainのバージョンbump PR・リリースPR作成を自動化する（`workflow_dispatch`のみ） |

設計の経緯・詳細は[docs/multi-agent-workflow.md](multi-agent-workflow.md)を参照。

これらのワークフローは、以下のようにissue-deck固有の前提へ強く結合している。

- **技術スタック固有のセットアップ手順**: `claude-issue-dispatch.yml`はpnpm（`pnpm/action-setup`）・
  Next.js（`next dev`）・Prisma（`pnpm db:migrate:deploy`）・MySQL（`services.mysql`のサービス
  コンテナ、`DATABASE_URL=mysql://...`）を直接ハードコードしている。他言語・他フレームワークの
  リポジトリではこれらのステップ自体が成立しない。
- **ブランチ運用・命名規則**: `develop`→`main`の2段階ブランチ運用、Issue専用ブランチの命名規則
  `issue-<番号>`（ローカルの`scripts/start-issue.sh`が作成する規則をワークフロー側も前提にしている）
  に、`issue-labels.yml`のIssue番号特定処理や`claude-review-develop.yml`の対象PR判定が依存している。
  この命名規則に従わないブランチ・PRは全ワークフローの対象外（何もしない）という設計。
- **スクリーンショット撮影の固定パス**: `claude-issue-dispatch.yml`のPlaywright撮影処理は
  `/dashboard`固定パス・issue-deck専用のCIバイパス機構（`src/lib/ci-auth-bypass.ts`、CIバイパス用
  Cookieでミドルウェアの認証チェックをスキップする仕組み）に依存している。他リポジトリでは
  この機構自体が存在しない。
- **自動マージ不可判定のパス・カテゴリ**: `claude-review-develop.yml`の`risk-check`ジョブは
  issue-deckのCLAUDE.mdが定める自動マージ不可カテゴリ（認証・認可、DBマイグレーション、
  GitHub Actions/デプロイ設定等）を、issue-deckのディレクトリ構成（`prisma/migrations/**`等）に
  合わせたパターンで機械判定している。
  （現在はパターンを`reusable-claude-review-develop.yml`へ内蔵し、リポジトリ固有の追加は
  `risk-paths`入力で行う。**カテゴリ該当でマージを止めるかどうかは`merge-policy`入力で
  切り替えられ、既定の`relaxed`＝止めないがcallerを持つ全リポジトリに効く**。#2775・#2790。
  止めたいリポジトリだけがcallerへ`merge-policy: strict`と書く。
  詳細は[docs/multi-agent/labels.md](multi-agent/labels.md)「変更カテゴリで止めるかは
  `merge-policy`で切り替える」）
- **ラベル体系**: `21.plan-required`〜`24.screenshot-required`・`00.check-user`はissue-deck
  リポジトリ側で個別に作成したカスタムラベルであり、他リポジトリには存在しない。
  （調査当時は`01.planning`〜`09.main`の進捗ラベルも同じ扱いだったが、#991 Phase 5・#1010で
  廃止し、進捗はGitHub ProjectsのStatusへ移した）

### データモデル側

`prisma/schema.prisma`の`GithubInstallation`/`Repository`モデルには、リポジトリごとの自動化設定
（ワークフロー有効化フラグ・Secrets・ブランチ運用方針など）を保持するフィールドは現状存在しない
（`Repository`が持つのは`ownerLogin`・`name`・`fullName`・`defaultBranch`等のGitHub側メタデータの
キャッシュのみ）。

一方、Secrets的な値の暗号化保管ユーティリティ自体は`src/lib/crypto/secret-cipher.ts`
（AES-256-GCM、`GITHUB_USER_TOKEN_ENCRYPTION_KEY`）として既に存在するが、現状の用途は
`User.githubAccessToken`（ユーザー本人のGitHub OAuthアクセストークン）の暗号化保存のみに
限定されている（`src/app/auth/callback/route.ts`で暗号化・`src/app/api/issues/comments/route.ts`で
復号）。リポジトリ単位のSecrets（他リポジトリで`CLAUDE_CODE_OAUTH_TOKEN`相当を保存する等）を
想定した設計にはなっていないが、暗号化の仕組み自体は流用できる可能性がある。

### GitHub Appの権限

IssueDeckのGitHub App認証は`src/lib/github/app-auth.ts`（`@octokit/auth-app`、`GITHUB_APP_ID`・
`GITHUB_APP_PRIVATE_KEY_BASE64`）で行っている。App自体の権限スコープ（`contents`・`workflows`・
`secrets`書き込み権限の有無等）はGitHub側のApp設定画面でのみ確認・変更でき、リポジトリ内の
コード調査だけでは確定できない。現状のIssueDeck用GitHub Appが、連携先リポジトリへ
`.github/workflows/`ファイルやSecretsを書き込む権限を持っているかは未確認。

現状使用している権限の機能ごとの棚卸し（Issues/Actions/Pull requests等の通常権限と、Issue移動機能
（`transferIssue`）にのみ必要な`Administration`権限の切り分け、Administrationをより狭い権限に
置き換えられるかの調査結果）は[docs/github-app-permissions.md](github-app-permissions.md)を参照
（#523・#532）。

## 他リポジトリへ展開する上で必要になる要素

### 1. ワークフローファイル一式の配布方法

他リポジトリに`.github/workflows/claude-issue-dispatch.yml`等一式を配置する必要がある。選択肢:

- **IssueDeckがテンプレートからPRを自動作成する**: 連携リポジトリに対し、ワークフローファイル一式を
  追加するPRをIssueDeckが自動生成する。GitHub Appに`contents`/`pull_requests`書き込み権限が必要。
  リポジトリ側のCI設定・ブランチ運用に合わせたカスタマイズが必要な場合、PRのdiffを人間がレビュー・
  調整する前提になる。
- **CLIでスキャフォールディングする**: `npx issue-deck-init`のようなCLIツールを別途配布し、
  連携リポジトリのメンテナーがローカルで実行してワークフローファイルを生成する。IssueDeck側の
  GitHub App権限を増やさずに済むが、IssueDeckのWebアプリからワンクリックで完結する体験は失われる。
- **テンプレートリポジトリ + 手動コピー**: 単にテンプレートを公開し、利用者が手動でコピー・調整する。
  実装コストは最小だが自動化の恩恵が薄い。

### 2. リポジトリごとの差異の吸収

`claude-issue-dispatch.yml`にハードコードされているpnpm/Next.js/Prisma/MySQL前提を、設定可能に
する必要がある。少なくとも以下の軸で差異を吸収する仕組みが要る。

- パッケージマネージャ・依存関係インストールコマンド（pnpm/npm/yarn、Python/Rubyなど非Node.js
  スタックも含めるか）
- lint・型チェック・テスト・ビルドコマンド
- DBマイグレーション・シードの要否とコマンド（DBを使わないリポジトリも当然ある）
- ブランチ運用（`develop`/`main`の2段階か、`main`直接か）とブランチ命名規則
- 画面確認・スクリーンショット撮影の要否（対象がWebアプリでない場合はそもそも不要）

設定方法としては、連携リポジトリ側に設定ファイル（例: `.issue-deck.yml`）を置く方式と、
IssueDeckのDB（`Repository`モデルへのフィールド追加）で管理する方式が考えられる。前者は
リポジトリ側で完結しGit管理下に置けるが、IssueDeck側から見た設定変更のUI操作性は劣る。

### 3. Secrets配布

連携リポジトリのGitHub Actionsから無人でClaude Codeを実行するには、各リポジトリに
`CLAUDE_CODE_OAUTH_TOKEN`相当のSecretsが必要になる。論点:

- **誰の認証情報を使うか**: IssueDeck運営者が持つ1つのトークンを全リポジトリで共有するか、
  連携リポジトリのメンテナーが自身のClaude Codeサブスクリプション（またはAPIキー）を個別に
  登録するか。前者はIssueDeck運営者の利用枠を消費し続けるスケーラビリティ・コストの問題があり、
  後者は各メンテナーにセットアップの手間を強いる。
- **課金面**: 上記と表裏一体で、Claude Code実行のAPI利用料を誰が負担するかというビジネス上の
  論点。プロダクト設計判断であり、コード調査だけでは結論が出せない。
- **配布方法**: IssueDeck側でユーザーごとにトークンを暗号化保存し（`secret-cipher.ts`を
  流用できる可能性がある）、連携リポジトリのSecretsへGitHub API（`gh api`の
  `repos/{owner}/{repo}/actions/secrets`相当）経由でIssueDeckが直接設定する方式であれば、
  利用者は手動でSecrets設定画面を操作せずに済む。ただしこの場合IssueDeckのGitHub Appに
  Secrets書き込み権限が必要になる。

### 4. GitHub Appの権限確認

前述のとおり、現状のGitHub Appが連携リポジトリへの`contents`（ワークフローファイル追加）・
`workflows`（`.github/workflows/`への書き込み）・`secrets`（Actions Secretsの書き込み）権限を
持っているかは、GitHub側の設定画面でしか確認できず、本調査では確定できない。展開方式の選択
（上記1・3）によって必要な権限が変わるため、方式が決まった時点で改めて確認・申請が必要になる。

### 5. ラベル体系の可変化

> **2026-08-12 追記（#1010）**: 進捗ラベル（`01.planning`〜`09.main`）は#991 Phase 5で廃止し、
> 進捗はGitHub ProjectsのStatusで管理するようになった。この節が扱う「ラベル体系の可変化」の
> 対象は、条件系ラベル（`21.plan-required`〜`24.screenshot-required`・`00.check-user`等）だけに
> 縮んでいる。以下は当時の記述をそのまま残す。

`01.planning`〜`09.main`・`21.plan-required`〜`24.screenshot-required`・`00.check-user`は、いずれも
issue-deckリポジトリに手動で作成したカスタムラベルであり、他リポジトリには存在しない。展開時には
以下のいずれかが必要になる。

- ワークフロー配布時にラベルも`gh label create`等で自動作成する
- ラベル名自体をリポジトリごとに設定可能にする（ワークフロー内のラベル名が現状ハードコードされて
  おり、可変化には各ワークフローの修正が必要）
- 固定のラベル名・体系をそのまま使うことを前提とし、連携リポジトリ側に手動でのラベル作成を求める

### 6. セキュリティ・信頼境界

第三者リポジトリに対してIssueDeck経由で無人Claude Code実行を許可することには、issue-deck自身の
セルフホスティングにはない追加のリスクがある。

- 現状issue-deckでは、`@claude`コメント起動時に実行者（`github.actor`）のリポジトリ`write`権限を
  `gh api repos/{owner}/{repo}/collaborators/{actor}/permission`で確認するのみ（詳細は
  [docs/multi-agent/dispatch.md](multi-agent/dispatch.md)参照）。他リポジトリでも
  同じ考え方で足りるかは、連携リポジトリの性質（公開範囲・コントリビューター構成）次第で変わりうる。
- IssueDeckが発行・管理するトークン（GitHub App / 上記3のClaude Codeトークン）が、連携リポジトリの
  Actions実行環境に渡ることになるため、そのリポジトリのワークフロー定義やコードが信頼できない
  場合に悪用されるリスクをどう抑えるかの検討が必要（例: フォークからのPRでは実行しない、
  Actions実行時のみ最小権限のトークンを都度発行する、等）。
- 自動マージ不可カテゴリ（`00.check-user`付与対象）の判定は、issue-deckのCLAUDE.mdが定める
  カテゴリ・ディレクトリパターンに基づいている。他リポジトリでは技術スタック・ディレクトリ構成が
  異なるため、この判定パターンもリポジトリごとに設定可能にする必要がある（上記2と関連）。

## 実現方式の選択肢比較

| 観点 | A: テンプレートPR自動作成 | B: CLIスキャフォールディング | C: 設定ファイル方式 + 共通ワークフロー |
|---|---|---|---|
| 導入体験 | IssueDeckのUIから完結、最も手軽 | ローカル操作が必要 | Aと同程度（設定ファイルの初期値もPRに含められる） |
| IssueDeck側権限 | 連携リポジトリへの書き込み権限が必要（増加） | 増加なし | Aと同様に増加 |
| リポジトリ差異の吸収 | ワークフローファイル自体を都度カスタマイズして生成する必要がある | 利用者がテンプレートを手動編集する前提にしやすい | 設定ファイルの値を読み取る共通ワークフローにできるため、ワークフロー本体の複製・改変が最小限で済む |
| 保守性（issue-deck側の改善を配布先へ反映） | 配布済みリポジトリへの再配布が必要 | 同左 | 共通ワークフロー本体を更新するだけで配布済みリポジトリ全体に効く（設定ファイルを参照する形にできれば） |

C（設定ファイル + 共通ワークフロー本体を可能な限り集約する方式）が保守性の観点で有利に見えるが、
「共通ワークフロー本体をどこに置き、各リポジトリからどう参照するか」（例: `workflow_call`による
再利用可能ワークフロー化）の技術検証が別途必要。いずれの方式を採るにせよ、上記2（差異の吸収）の
設定項目の設計が先行して必要になる。

## 段階的ロードマップ案（将来切り出す候補Issue）

以下はあくまで案であり、本Issueの対応としてこれらのIssueを実際に作成することはしない。

1. GitHub Appの権限確認（GitHub側App設定画面での棚卸し。上記4）
2. リポジトリごとの差異吸収のための設定スキーマ設計（上記2。`.issue-deck.yml`案のドラフト作成）
3. `claude-issue-dispatch.yml`等を`workflow_call`で再利用可能ワークフロー化する技術検証（技術スタック
   固有部分を設定値で差し替えられるようにする最小限のPoC。まずissue-deck自身のワークフローで
   動作を崩さないことを確認する）
4. ラベル自動作成の仕組み（上記5）
5. Secrets配布方式の決定とプロトタイプ（上記3。課金面の方針決定が前提）
6. セキュリティレビュー（上記6。信頼境界の設計を固めてから展開開始する）
7. テンプレートPR自動作成 or CLIスキャフォールディングの実装（上記1。方式比較の結論を受けて）

なお、実際に自動化が導入・検討されているリポジトリの一覧は
[docs/supported-repositories.md](supported-repositories.md)に記録する。

## ケーススタディ: m-guchi/shopping-list での実現可能性（issue #357）

issue #357 の調査として、実際の連携候補である`m-guchi/shopping-list`リポジトリを対象に、
上記1〜6の各要素がどの程度そのまま適用できるかを検証した。**結論としては実現可能であり、
issue-deck自身よりもむしろ導入は容易**（DBなし・ビルドなし・npm依存パッケージゼロのため、
`claude-issue-dispatch.yml`の前段セットアップの大半が不要になる）。唯一、スクリーンショットの
無人撮影（`24.screenshot-required`）だけは、shopping-list側に追加実装がなければ成立しない。

### shopping-listの構成（調査時点: v0.2.0 / develop = 5c43ad1）

| 項目 | 内容 |
|---|---|
| 概要 | Notionの「🛒 買い物リスト」DBと同期するPWA |
| フロントエンド | Vanilla JS PWA（`frontend/`、**ビルド不要**）。`@supabase/supabase-js`はesm.sh からCDN動的import |
| バックエンド | Node.js（`backend/`、`node:http`のみ・**npm依存パッケージなし**）。Notion APIの薄いプロキシ |
| DB | **なし**（Notionが唯一の情報源。マイグレーション・シードの概念が存在しない） |
| 認証 | Supabase Auth + Google OAuth。バックエンドが`node:crypto`でJWTを自前検証（`backend/auth.js`） |
| パッケージマネージャ | npm（lockfileもコミットされていない。`package.json`に`dependencies`自体がない） |
| lint/test/build | `npm run check`（`node --check`による構文チェックのみ）。テスト・ビルド・型チェックは無し |
| Node.jsバージョン | 20.19（既存ワークフローの`actions/setup-node`指定値） |
| デプロイ | `main`へのpushで`deploy.yml`がVPSへSSHデプロイ（PM2、ポート3101） |
| コード規模 | JS計約1,100行 |
| コントリビューター | `m-guchi`（admin）1名のみ |

### 上記1〜6の各要素の適合状況

#### 既に条件が揃っているもの

- **ブランチ運用（上記2）**: デフォルトブランチが`develop`で、`develop`→`main`の2段階運用も
  issue-deckと**一致**している。差異の吸収が不要な軸。
- **ラベル体系（上記5）**: `00.check-user`・`01.wip`・`03.d:marge`・`05.develop`・`07.m:marge`・
  `09.main`・`21.plan-required`・`23.preview-required`・`24.screenshot-required`が、色・説明文まで
  issue-deckと同一の内容で**既に全て作成済み**。issue #3（「ログイン機能を実装する」）は実際に
  `09.main`まで遷移して運用されている。少なくともshopping-listに関しては「ラベル体系の可変化」は
  課題にならず、`gh label create`による自動作成も不要。
  - **補記（2026-08-08、実際の導入時に判明）**: 上記は調査時点（2026-08-04）の記述であり、その後
    issue-deck側で#638の「進捗管理ラベルの見直し」によりラベルが世代交代したため、実際に導入した
    時点では**差異ゼロではなくなっていた**。shopping-list側は旧世代（`01.wip`単独、
    `22.preview-required`/`23.screenshot-required`）のまま止まっており、issue-deck現行の
    `01.planning`+`02.wip`分割・`22.merge-confirm-required`追加・preview/screenshotの23/24への
    繰り上げに合わせたリネーム・追加が必要だった。ワークフロー側はラベル名をハードコードしている
    ため、この不一致は`gh issue edit --add-label`の実行時エラーとして現れる。
    **他リポジトリへ展開する際は、既にラベルが揃っているように見えても、
    [docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md)「2. ラベル体系」の定義および
    `scripts/check-label-diff.sh`で必ず現行世代との差分を確認すること。**
- **セキュリティ・信頼境界（上記6）**: コラボレーターがリポジトリオーナー1名のみのプライベート
  相当構成であり、「第三者コントリビューターのフォークPRから秘匿情報が漏れる」類のリスクは現状
  存在しない。issue-deckと同じ`github.actor`のwrite権限確認で十分と考えられる。
- **Secrets配布（上記3）**: shopping-listには既に**1Password Service Accountベースのシークレット
  注入機構**が稼働している（GitHub Secretsには`OP_SERVICE_ACCOUNT_TOKEN`のみを置き、実値は
  `1password/load-secrets-action@v4` + `.github/*.env.tpl`の`op://apps/...`参照で注入する方式）。
  なおissue-deck自身は#1302で`ci.yml`/`deploy.yml`/`release.yml`の1Password依存を外し、
  実行時の取得先をGitHubのsecret/variableへ移した（日次レート制限の枯渇でデプロイが止まったため）。`CLAUDE_CODE_OAUTH_TOKEN`・`WORKFLOW_PAT`も同じ経路で
  1Passwordに置いて注入できるため、**IssueDeck側にActions Secrets書き込み権限を追加せずに済む**。
  これは上記3で挙げた「IssueDeckがGitHub API経由でSecretsを直接設定する」方式の代替として、
  少なくともm-guchi配下のリポジトリ群には現実的な選択肢になる（他リポジトリも同じ1Password運用に
  揃っていることが前提）。

#### 不足しており追加が必要なもの

- **`CLAUDE.md`が存在しない**: `claude-issue-dispatch.yml`のプロンプトも`claude-review-develop.yml`の
  自動マージ不可判定も、リポジトリのCLAUDE.mdが定める運用ルール（ブランチ運用・禁止事項・
  自動マージ不可カテゴリ）を前提にしている。shopping-listにはCLAUDE.md自体が無いため、新規作成が必要。
- **`issue-<番号>`ブランチ運用の実績がない**: 既存PR（#1・#2・#4）はいずれも`develop`→`main`の
  直接PRで、Issue専用ブランチは使われていない。`scripts/start-issue.sh`相当のスクリプトも無い。
  ただしワークフロー側の正規表現（`^issue-([0-9]+)$`）に合わせるだけなので、障壁としては低い。
- **Secretsの登録**: `CLAUDE_CODE_OAUTH_TOKEN`・`WORKFLOW_PAT`は未登録（READMEのセットアップ
  チェックリストに挙がっているのは`OP_SERVICE_ACCOUNT_TOKEN`のみ）。上記のとおり1Password経由で
  配布できるが、`WORKFLOW_PAT`は`actions/checkout`の`token`入力に渡す必要があり、
  `load-secrets-action`はcheckout後にしか実行できないため、これだけはGitHub Secretsへ直接登録する
  必要がある点に注意（この制約は`claude-issue-dispatch.yml`の構造に由来する）。
- **`develop`のBranch protection**: shopping-listのREADMEが設定を求めているのは`main`のみ。
  issue-deck側のリリースフロー（[docs/multi-agent-workflow.md](multi-agent-workflow.md)・
  `release-to-main`スキル）は`develop`も保護されている前提で組まれているため、揃えるかどうかの判断が要る。
- **GitHub Appのインストール状況（上記4）**: shopping-listのissue #3はリポジトリオーナー本人が
  作成しており（issue-deck側のIssueは`issue-deck[bot]`が作成している）、IssueDeckのGitHub Appが
  shopping-listにインストール済みかは本調査では確認できなかった。GitHub側の設定画面での確認が必要。

### ワークフローごとの移植コスト

| ワークフロー | 移植可否 | 必要な改変 |
|---|---|---|
| `issue-labels.yml`（237行） | ほぼそのまま | ラベル名・`issue-<番号>`規約が一致するため実質無改変。末尾のスクリーンショット削除ジョブ（`screenshots`ブランチの`issue-<番号>/`配下を掃除する処理）は、撮影を導入しないなら削除する |
| `claude-issue-dispatch.yml`（944行） | 可。**大幅に簡素化できる** | MySQLサービスコンテナ・pnpm setup・`pnpm install`・`pnpm db:migrate:deploy`・`pnpm db:seed:ci`・`playwright install`の前段ステップ（120行相当）が**丸ごと不要**。`claude_args`の`Bash(pnpm:*)`→`Bash(npm:*)`。lint/test/buildの指示は`npm run check`に置換 |
| `claude-review-develop.yml`（283行） | 可 | `risk-check`のパターン調整。`prisma/migrations/**`は該当なしのため削除。`.github/workflows/**`はそのまま有効。`**/auth/**`判定（`(^\|/)auth(/\|\.[^/]*$)`）は`backend/auth.js`・`frontend/auth.js`・`frontend/auth/callback.html`にそのままヒットするので有効。`package.json`のメジャー更新判定は依存パッケージが無いため実質空振りだが無害。**追加すべき対象**として`deploy/`・`scripts/update-env-file.sh`・`.github/*.env.tpl`（本番設定・Secrets参照の変更）がある |
| `claude-conflict-resolve.yml`（285行） | 可 | pnpm setup・`pnpm install`・`pnpm test`／`pnpm build:ci`の検証ステップを`npm run check`へ置換するのみ |
| `release-develop-to-main.yml`（299行） | フックを実装すればそのまま利用可能 | バージョン判定・bump自体は`package.json`の`version`比較で行っており汎用的。#800でバンプ処理が`npm pkg set version`から`npm version --no-git-tag-version`へ変更され、`RELEASE_CHANGELOG`環境変数＋`package.json`の`"version"` lifecycleスクリプトによる更新履歴同期の汎用フックが追加された（詳細は[docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md)の「6. リポジトリ差異の吸収チェックリスト」参照）ため、shopping-listのような更新履歴表示を持つリポジトリは`"version"`スクリプトを定義するだけで移植でき、`release-develop-to-main.yml`本体の個別改造は不要になった。#1729では同じ経路に利用者向けの操作手順（`RELEASE_USAGE`）が追加され、`"version"`スクリプト側で読む変数が1つ増えた（既存のスクリプトは読まなくても壊れない）。ただし`ci.yml`の`version-check`ジョブがタグ重複を検査する点との整合は引き続き個別対応が必要 |

### スクリーンショット・プレビュー（上記2の「画面確認」軸）

shopping-listはWebアプリ（PWA）なので撮影の対象になり得る。起動自体は`npm run dev`
（＝`node backend/index.js`）のみでビルド不要と、issue-deckより軽い。しかし
**`24.screenshot-required`相当の無人撮影は、現状のshopping-listには追加実装なしでは成立しない**。

- 全画面がSupabase Auth + Google OAuthログインの背後にある（`frontend/app.js`のログイン画面、
  バックエンドは全APIで`Authorization: Bearer <JWT>`必須）。issue-deckの`src/lib/ci-auth-bypass.ts`に
  相当するCIバイパス機構が存在しない。
- JWT検証は`backend/auth.js`がSupabaseのJWKSエンドポイントを実際に`fetch`して行うため、CIで
  ダミートークンを通すには検証をバイパスする仕組みの追加が必要。
- 表示データの出所がNotion APIの実体であり、DBが無いためシードできない。CIで意味のある画面を
  撮るにはNotion APIのスタブが要る。
- フロントエンドが`@supabase/supabase-js`をesm.sh からCDN動的importしているため、CIの
  ネットワーク制約次第では読み込みに失敗しうる。

したがってshopping-listでは、まず`23.preview-required`（人間が手元で確認する運用）に限定して
導入し、`24.screenshot-required`は「CIバイパス + Notionスタブ」をshopping-list側に実装する
別Issueとして切り出すのが現実的。

### このケーススタディから見た方式選択への示唆

- 「上記2（リポジトリ差異の吸収）」で吸収すべき軸のうち、shopping-listで実際に差異が出たのは
  **パッケージマネージャ／検証コマンド**と**DBセットアップの要否**と**画面確認の可否**の3軸のみで、
  ブランチ運用・ラベル体系は差異ゼロだった。設定スキーマ（`.issue-deck.yml`案）の初期版は、
  この3軸＋`risk-check`の追加パスパターンを最小セットとして設計すれば足りる可能性が高い。
- DBセットアップ・Playwright・パッケージマネージャの各ステップは「有効／無効」を設定値で切り替える
  構造（`if:`条件）にできれば、issue-deckとshopping-listの両方を1つの再利用可能ワークフロー
  （`workflow_call`）でカバーできる見込み。方式C（設定ファイル + 共通ワークフロー）が有利という
  上記の比較結論を、実例として補強する材料になる。

## 未確定・要人間判断の事項

- 「他のリポジトリ」がどの程度多様な技術スタック・運用を想定しているか（IssueDeckで連携する
  全リポジトリを対象にするのか、まずはNext.js/pnpm系の近いスタックに限定するのか）はプロダクト
  方針に関わり、本ドキュメントでは断定しない。
- Claude Code実行のAPI利用料をどう負担・課金するかはビジネス上の論点であり、コード調査だけでは
  結論が出せない。
- GitHub Appの権限拡張（Secrets書き込み等）は、GitHub側の設定変更が必要でありローカル調査だけでは
  確定できない。
- IssueDeckのGitHub Appが`m-guchi/shopping-list`にインストール済みかは、GitHub側のApp設定画面での
  確認が必要（上記ケーススタディ参照）。
- shopping-listの`develop`にBranch protectionを設定するか（issue-deckのリリースフローに揃えるか）は
  運用方針の判断。
- shopping-listで`24.screenshot-required`を使えるようにするための「CIログインバイパス + Notion API
  スタブ」の実装は、shopping-listリポジトリ側の変更であり、issue-deck側の対応範囲外。別Issueとして
  切り出すかどうかの判断が必要。
