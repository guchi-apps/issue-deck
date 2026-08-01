# Issueごとの複数Claude Codeエージェント運用 設計

issue #16 に一部対応する設計ドキュメント。

## 背景

現在 `develop` ブランチ上で複数のClaude Codeセッションが直接作業しており、変更の上書き・コンフリクト・作業内容の混在が起きる問題がある。これを解消するため、Issueごとに専用ブランチ・git worktree・Claude Codeセッションを分離し、実装は必ず`develop`向けPRを経由、別の「レビュー・統合エージェント」が確認してからマージする運用へ移行する。将来的にはIssueラベル/`@claude`コメントを起点にGitHub Actions上で実装〜レビュー〜自動マージまで行う自動化も見据える。

## 全体像

```text
GitHub Issue
↓
Issue専用ブランチ・worktreeを作成
↓
実装担当Claude Codeを起動
↓
実装・テスト・コミット・push
↓
develop向けPull Requestを作成
↓
レビュー・統合担当Claude Codeが確認
↓
問題がなければdevelopへマージ
```

```text
main   （直接push禁止、develop→mainのPRのみ、CI必須）
└─ develop （日常のベース。将来的にはPR経由のマージのみに寄せる）
   ├─ issue-123
   ├─ issue-124
   └─ issue-125
```

## ブランチ・worktree運用

- ブランチ名はラベルによる接頭辞分けをせず、単純に `issue-<Issue番号>`（例: `issue-123`）とする。
- worktreeは本体リポジトリの外、`~/apps/issue-deck-worktrees/<ブランチ名>/` に作成する。本体 `~/apps/issue-deck` は常にレビュー・統合エージェント用の `develop` 最新チェックアウトとして空けておく。
- worktree作成後に必要な準備:
  - `.env.local` を本体からコピーする（`.gitignore`対象でworktreeに複製されないため。symlinkではなくコピーとし、将来worktreeごとに値を変える余地を残す）
  - `pnpm install`（pnpmのcontent-addressableストアにより高速）
  - `postinstall` で `prisma generate` が走る
- 開発用MySQL DBはworktree間で共有する（Issueごとに新規DBは作らない）。通常のIssueはスキーマ変更を伴わない前提。マイグレーションを伴うIssueは下記「自動マージ不可カテゴリ」の対象として扱う。
- 開発サーバー（`pnpm dev`）のポートは`start-issue.sh`/`.ps1`が`.env.local`に`PORT=4000 + Issue番号`を自動設定する（例: issue-46 → 4046）。複数Issueのworktreeで同時に`pnpm dev`を起動しても衝突せず、developへマージする前に人間がブラウザ（`http://localhost:<ポート>`）で直接画面を確認できる。実装エージェントは画面に関わる変更のPRで、このURLを「確認方法」に記載する。
- `start-issue.sh`はworktree準備時に`scripts/setup-lan-access.sh`を呼び、Windows側のポートフォワーディング（`netsh interface portproxy`）とファイアウォール許可を自動設定したうえで、`http://<WSL IP>.sslip.io:<ポート>`をあわせて提示する（同一LAN上のスマホ等、`localhost`が使えない別端末からの確認用。詳細はsslip-io-lan-devスキル参照）。WSLのIPはWSL再起動のたびに変わるため、`scripts/dev.sh`経由の通常起動時も含め、devサーバー起動のたびに再設定する。Windowsの管理者権限が必要なためUACダイアログが表示される。`next.config.ts`の`allowedDevOrigins`は個別IPではなく`*.sslip.io`（ワイルドカード）を許可しており、WSLのIPが変わってもコード変更不要。

## 実装前の「計画フェーズ」要否をIssueラベルでトグルする

Issueによっては実装前に設計・アプローチのすり合わせ（Claude CodeのPlan mode相当）が必要だが、単純なIssueでは不要。これをIssue単位でオン/オフする。

- ラベル `21.plan-required`（新規作成予定）の有無で実装エージェントが分岐する。
  - **ラベルなし（デフォルト）**: 実装エージェントはそのまま実装に入る。
  - **ラベルあり**: 実装エージェントは実装前に計画（アプローチ・変更範囲・懸念点）をまとめて提示し、承認を得てから実装に入る。
- 「承認待ち」を表す専用ラベル `00.check-user`（ユーザーの確認・指示が必要）を計画承認待ちの合図としても使う。
- 実行形態による承認方法の違い:
  - **ローカル実行（人間が横にいる）**: Claude Code本来のPlan mode（`EnterPlanMode`→提示→`ExitPlanMode`で承認）がそのまま使える。起動スクリプトは「`21.plan-required`が付いているので実装前に必ずPlan modeで計画提示すること」という一文をプロンプトに含めるだけでよい。
  - **GitHub Actions実行（無人）**: 対話的な承認者がその場にいないため二段階に分ける。①エージェントが計画をPRドラフト or Issueコメントとして投稿し`00.check-user`を付与して停止 → ②人間がコメント/ラベル操作で承認 → ③再起動されたエージェントが実装を再開する。②→③の具体的な再起動トリガーは未確定（該当フェーズ設計時に詰める）。

## Issueラベルの状態遷移

マルチエージェント運用で進めるIssueは、原則として以下の順でラベルが遷移する。全PJ共通の`01.wip`は流用しつつ、旧`02.close`（状態：対応済）はissue-deckでは`09.main`にリネームして統合した（他リポジトリの`02.close`には影響しない。ラベルはリポジトリごとの設定のため）。

1. `01.wip` — 実装エージェントがコード実装中
2. `03.d:marge` — developへPR作成・マージ中
3. `05.develop` — developへマージ完了（main未反映）
4. `07.m:marge` — mainへPR作成・マージ中
5. `09.main` — mainへマージ完了。この時点でissueをcloseする

`00.check-user`（ユーザーのチェックが必要）は上記のどの段階でも他のラベルと併用して付与する。

develop→mainのリリースフロー自体（バージョンアップコミット・PR作成等）は現状、既存の手動運用（git-github-jaスキル参照）のまま（Phase2の`start-reviewer.sh`は`05.develop`までを扱う）。ただし上記1〜5のラベル遷移自体は、`.github/workflows/issue-labels.yml`によりGitHub Actions上でイベント駆動に自動化済み（次項参照）。

### GitHub Actionsによるラベル遷移の自動化

`.github/workflows/issue-labels.yml`が、上記の状態遷移をGitHubイベント（ブランチpush・PR作成・PRマージ）をトリガーに自動的に付け替える。

- `01.wip`〜`05.develop`: 実装エージェント・レビュー統合エージェントが手順どおり手動でラベルを付け替える運用は継続する（着手直後・PR作成時点で即座にラベルへ反映される速報性を残すため）。Actionsはこれと同じ遷移を安全網として保証するもので、エージェント側が付け忘れても、対応するブランチpush・PR作成・PRマージのタイミングで自動的に是正される。
- `07.m:marge`・`09.main`: 対応するエージェント運用が存在しないため、Actionsが唯一の付与手段となる。develop→mainのPRが開いている間は`05.develop`のissueを`07.m:marge`へ、PRがマージされた時点で`05.develop`/`07.m:marge`のissueを`09.main`へ一括遷移し、あわせてissueをcloseする。

issue番号の特定は、Issue専用ブランチの命名規約`issue-<番号>`（`scripts/start-issue.sh`が作成）から行う。この規約に従わないブランチ・PRは対象外（何もしない）。

## 開発環境プレビュー要否をIssueラベルでトグルする

開発サーバー（`pnpm dev`）のポート割り当て自体はコストがないため、ラベルの有無に関わらず常に`.env.local`に`PORT=4000 + Issue番号`を設定する。ラベルは「画面確認をPR作成前の承認ゲートにするかどうか」を制御する。

- ラベル `22.preview-required` の有無で`start-issue.sh`が生成するプロンプトの文言が分岐する。
  - **ラベルなし（デフォルト）**: 実装エージェントは、画面に関わる変更を行った場合PR本文の「確認方法」に開発サーバーのURL（`http://localhost:<ポート>`）とアクセス手順を記載するだけで、承認待ちなしにそのままPR作成まで進める。
  - **ラベルあり**: PRを作成する**前**に、実際に開発サーバーを起動してURLをユーザーに提示し、画面を確認してもらったうえで明示的な承認を得てからPRを作成する（`21.plan-required`と同様の承認ゲート）。
- 承認の得方は実行形態により異なる（`21.plan-required`と同じ考え方）。
  - **ローカル実行**: 提示後にそのまま応答を止めて、ユーザーからの返信（承認）を待つ。
  - **GitHub Actions実行（無人）**: `00.check-user`を付与して停止し、人間の承認後に再起動して続行する。

## スクリーンショット取得要否をIssueラベルでトグルする

グローバルCLAUDE.mdの方針（Playwright等のブラウザ自動操作はトークン消費が大きいため明示指示がある場合のみ実施）に合わせ、実装エージェントによるスクリーンショットの自動取得はデフォルトで行わない。視覚的な確認と承認をPR作成前のゲートにしたいIssueにはラベルで個別に有効化する。

- ラベル `23.screenshot-required` の有無で分岐する。
  - **ラベルなし（デフォルト）**: スクリーンショットの自動取得は行わない。
  - **ラベルあり**: PRを作成する**前**に、実装エージェントが`run`スキル等を使って開発サーバー上で変更箇所のスクリーンショットを取得してユーザーに提示し、明示的な承認を得てからPRを作成する（承認の得方は上記`22.preview-required`と同じ）。Playwright等の新規依存関係の追加が必要な場合は、追加前に必ずユーザーに確認する（依存関係の追加はCLAUDE.mdの方針により無断で行えないため）。

## エージェントの役割

### 実装エージェント

Issueごとに独立したClaude Codeセッションとして起動する。

責務:
- GitHub Issueの内容を取得する。取得したら**忘れずに`01.wip`ラベルを付与する**（実装中であることを示すため。付け忘れやすいので要注意）
- 最新の`develop`からIssue専用ブランチ（`issue-<番号>`）を作成する
- Git worktreeで作業フォルダを分離する
- `21.plan-required`ラベルが付いていれば、実装前にPlan modeで計画を提示し承認を得る
- Issueの要件を実装する
- テスト・Lint・型チェック・ビルドを実行する
- 変更をコミットしてpushする
- `develop`向けPull Requestを作成する（本文に対応Issue・実装内容・テスト内容・確認方法・注意点を記載。developマージ時点ではissueをcloseしない運用のため、`closes #番号`/`fixes #番号`は使わず`#番号`のみ記載する）
- `01.wip`→`03.d:marge`のラベル付け替え

禁止事項:
- `main`/`develop`への直接コミット・push
- 他Issueのブランチ・worktreeの編集
- 不要なforce push
- 自分が作成したPull Requestの自己マージ

### レビュー・統合エージェント

レビュー・統合専用のClaude Codeセッションを別に用意する。

責務:
- `gh pr list --base develop` で未処理PRの一覧を確認する（複数ある場合は1件ずつ処理し、develop最新との競合・CI結果・他PRとの依存関係を都度確認する）
- 対応Issueの要件充足、Issue外変更の混入有無、コード品質・セキュリティ、CI結果を確認する
- 「自動マージ不可カテゴリ」に該当する変更を検知したら`00.check-user`を付与し、マージせずユーザーの確認を待つ
- 問題がなければ`develop`へマージし、マージ後`develop`上で再テストする。あわせて対応Issueのラベルを`03.d:marge`→`05.develop`に付け替える（issueはcloseしない）

禁止事項:
- `main`への直接マージ・push

## ローカル自動化とGitHub Actionsの役割分担

| フェーズ | 実行場所 | 認証 | 想定用途 |
|---|---|---|---|
| ローカル起動（実装・レビュー） | ローカル(WSL)・人間が起動 | ユーザー自身の`gh auth` | 手動起動だが手順を自動化。人間が横で見ている前提 |
| GitHub Actions | GitHub Actions | `CLAUDE_CODE_OAUTH_TOKEN`（専用） | 無人実行。人間不在でも安全に倒せる設計が必須 |

ローカル実行はユーザー自身のGitHub認証で動くため、「developへの直接push禁止」はGitHubのbranch protectionでは技術的に強制できない（bypassしても同じアカウントになるため）。この段階ではCLAUDE.md・プロンプト内の運用ルールとして守らせる。GitHub Actionsでは専用トークンという別IDが使えるため、branch protectionのbypass listを人間アカウントのみにする設計が意味を持つ。

## ブランチ保護ルール案

- **`main`**: 組織標準（`_docs/guides/github-repo-setup.md` §5）どおり設定する。Require pull request before merging、Required status checks=`lint-and-build`（`.github/workflows/ci.yml`のジョブ名）、Restrict updates、bypass=自分のアカウント（For pull requests only）。**現状（2026年時点）未設定のため要設定。** 実際の設定はGitHub Web UIで行う（workflowでは自動化しない）。
- **`develop`**: Phase4で`required_status_checks`（`lint-and-build`）のみを設定する方針とした（`gh api PUT repos/{owner}/{repo}/branches/develop/protection`、`required_pull_request_reviews`・`restrictions`は`null`のまま）。**設定コマンドの実行はClaude Code CLIのauto modeクラシファイアにブロックされたため、2026-08-02時点でまだ未実施。** これは`gh pr merge --auto`がCIの完了を待たずに即マージしてしまうのを防ぐための最小構成で、直接pushやApprove必須化は行わない想定。「Require pull request before merging」＋bypass=人間アカウントのみへの本格的な制限は、影響範囲が大きく本Issueの完了条件にも必須ではないため見送った。GitHub Actions専用トークン（`github.token`、Phase3/4で導入済み）を使えば技術的には設定可能なので、必要になった時点で改めて検討する。

## 自動マージ可否の判定方法

自動マージ不可カテゴリ（`00.check-user`付与対象）:
- 認証・認可
- DBスキーマ変更・マイグレーション
- 本番環境の設定
- GitHub Actionsやデプロイ設定
- Secretsや環境変数
- 課金・決済
- 大規模な依存関係の更新
- `develop`→`main`のマージ

判定方法（`.github/workflows/claude-review-develop.yml`に実装済み、Phase4）:
- **一次判定（機械的、`risk-check`ジョブ）**: `git diff --name-only origin/develop...HEAD` のパスを、上記カテゴリに対応するパターン（`prisma/migrations/**`, `.env*`, `.github/workflows/**`, `**/auth/**`）に照合する。`package.json`は変更前後の`dependencies`/`devDependencies`をNode.jsで比較し、メジャーバージョンが変わった依存があるかで判定する（パッチ・マイナー更新は対象外）。ヒットしたら対応Issueに`00.check-user`を自動付与する。
- **二次判定（`claude-review`ジョブ、意味的）**: パターンに引っかからない意味的リスク（例: 認可ロジックの変更だがファイルパスに`auth`が含まれない）をレビューエージェントが読解して判断し、該当時は同様に`00.check-user`を付与する。
- **`00.check-user`を両判定共通の「マージ保留」シグナルとして使う**: `auto-merge`ジョブは`risk-check`・`claude-review`の完了後、対応Issueに`00.check-user`が付いていないことだけを確認して`gh pr merge --auto --squash`（Auto-merge機能。リポジトリ設定で有効化済み）を実行する。判定ロジックとマージ可否判断を疎結合に保つことで、判定方法を追加・変更してもマージ側のロジックは変えずに済む。必須ステータスチェック（`develop`の`lint-and-build`）待ちのポーリングは自前実装せず、GitHub Auto-merge機能に任せる。

## 段階的導入計画

1. **Phase 1**: `start-issue.sh`/`.ps1` — worktree・ブランチ・Claude Code起動のコマンド化
2. **Phase 2**: `start-reviewer.sh`/`.ps1` — レビュー・統合セッション起動のコマンド化
3. **Phase 2.5**: `.github/workflows/issue-labels.yml` — ラベル状態遷移（`01.wip`〜`09.main`）のGitHub Actionsによる自動化
4. **Phase 3**: PR作成時の自動レビューをGitHub Actionsで実行（`subscription-lists`リポジトリの`claude-code-action`テンプレートを土台にカスタマイズ）
5. **Phase 4**: 低リスクなPRのみ`develop`へ自動マージ（自動マージ可否の判定方法を実装）
6. **Phase 5**: Issueラベル/`@claude`コメントを起点に実装からPR作成まで自動化

各Phaseは前段が安定稼働してから着手する。

## 今後作成するファイル（Phase進行に合わせて）

- `scripts/start-issue.sh` / `scripts/start-issue.ps1`（Phase1）
- `scripts/prompts/implementation-agent.md`（Phase1）
- `scripts/start-reviewer.sh` / `scripts/start-reviewer.ps1`（Phase2）
- `scripts/prompts/review-agent.md`（Phase2）
- `.github/workflows/issue-labels.yml`（Phase2.5、作成済み）
- `.github/workflows/claude-review-develop.yml`（Phase3、作成済み。Phase4で`risk-check`/`auto-merge`ジョブを追加）
- `.github/workflows/claude-issue-dispatch.yml`（Phase5）

手動セットアップ項目:
- GitHubラベル`21.plan-required`の新規作成
- GitHubラベル`22.preview-required`・`23.screenshot-required`の新規作成
- `main`のBranch protection設定（未設定のため）
- リポジトリ設定でAuto-merge機能を有効化（Phase4、`gh repo edit --enable-auto-merge`で設定済み）
- `develop`のBranch protectionに`required_status_checks`（`lint-and-build`）を設定（Phase4、**未実施**。設定コマンドは「ブランチ保護ルール案」節参照。本設定が完了するまでAuto-mergeがCI完了を待たずに即マージする恐れがあるため、PR #64のマージ前に実施すること）

## 未解決の課題・申し送り事項

- Claude Code CLIの起動オプション（`--permission-mode`の具体的な値、`--add-dir`等）は実装時に`claude --help`で最新仕様を確認する。特に無人実行（Phase3以降）で全チェックを無効化するようなフラグ（例: `--dangerously-skip-permissions`）を使うのは、意図しない破壊的操作のリスクがあるため避け、ローカル実行は`acceptEdits`（人間が横にいる前提）、GitHub Actions実行は`claude-code-action`側の許可ツールリスト等で制御する方針とする。
- VS Code拡張（Claude Code for VS Code）側に「起動時に初期プロンプトを自動投入する」公式な方法は確認できていない。Phase1では「ターミナルで`claude "プロンプト"`として起動し、その結果としてVS Codeが開く」形（またはVS Codeは別途手動で開く）を落としどころとする想定。
