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
  - **GitHub Actions実行（無人）**: 対話的な承認者がその場にいないため二段階に分ける。①エージェントが計画をPRドラフト or Issueコメントとして投稿し`00.check-user`を付与して停止 → ②人間がコメント/ラベル操作で承認 → ③再起動されたエージェントが実装を再開する。②→③の具体的な再起動トリガーはPhase5で確定した（`00.check-user`ラベルを人間が外すことを承認とみなす。詳細は「Phase 5」節を参照）。

## Issueラベルの状態遷移

マルチエージェント運用で進めるIssueは、原則として以下の順でラベルが遷移する。全PJ共通の`01.wip`は流用しつつ、旧`02.close`（状態：対応済）はissue-deckでは`09.main`にリネームして統合した（他リポジトリの`02.close`には影響しない。ラベルはリポジトリごとの設定のため）。

1. `01.wip` — 実装エージェントがコード実装中
2. `03.d:marge` — developへPR作成・マージ中
3. `05.develop` — developへマージ完了（main未反映）
4. `07.m:marge` — mainへPR作成・マージ中
5. `09.main` — mainへマージ完了。この時点でissueをcloseする

`00.check-user`（ユーザーのチェックが必要）は上記のどの段階でも他のラベルと併用して付与する。

develop→mainのリリースフロー自体（バージョンアップコミット・PR作成等）は現状、既存の手動運用（release-to-mainスキル参照）のまま（Phase2の`start-reviewer.sh`は`05.develop`までを扱う）。ただし上記1〜5のラベル遷移自体は、`.github/workflows/issue-labels.yml`によりGitHub Actions上でイベント駆動に自動化済み（次項参照）。

### GitHub Actionsによるラベル遷移の自動化

`.github/workflows/issue-labels.yml`が、上記の状態遷移をGitHubイベント（ブランチpush・PR作成・PRマージ）をトリガーに自動的に付け替える。

- `01.wip`〜`05.develop`: 実装エージェント・レビュー統合エージェントが手順どおり手動でラベルを付け替える運用は継続する（着手直後・PR作成時点で即座にラベルへ反映される速報性を残すため）。Actionsはこれと同じ遷移を安全網として保証するもので、エージェント側が付け忘れても、対応するブランチpush・PR作成・PRマージのタイミングで自動的に是正される。
- `07.m:marge`・`09.main`: 対応するエージェント運用が存在しないため、Actionsが唯一の付与手段となる。develop→mainのPRが開いている間は`05.develop`のissueを`07.m:marge`へ、PRがマージされた時点で`05.develop`/`07.m:marge`のissueを`09.main`へ一括遷移し、あわせてissueをcloseする。

issue番号の特定は、Issue専用ブランチの命名規約`issue-<番号>`（`scripts/start-issue.sh`が作成）から行う。この規約に従わないブランチ・PRは対象外（何もしない）。

`develop-pr-opened`（`03.d:marge`遷移時）・`develop-pr-merged`（`05.develop`遷移時）は、ラベル遷移と
同時に`gh issue comment`でIssueへ完了報告のコメントも投稿する。ラベルだけでは気付きにくいため、
PRオープン・マージという確実なイベントに紐づけて通知している。

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
- **`develop`**: Phase4で`required_status_checks`（`lint-and-build`）のみを設定した（`gh api PUT repos/{owner}/{repo}/branches/develop/protection`、`required_pull_request_reviews`・`restrictions`は`null`のまま）。これは`gh pr merge --auto`がCIの完了を待たずに即マージしてしまうのを防ぐための最小構成で、直接pushやApprove必須化は行っていない。「Require pull request before merging」＋bypass=人間アカウントのみへの本格的な制限は、影響範囲が大きく本Issueの完了条件にも必須ではないため見送った。GitHub Actions専用トークン（`github.token`、Phase3/4で導入済み）を使えば技術的には設定可能なので、必要になった時点で改めて検討する。

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
- `.github/workflows/claude-issue-dispatch.yml`（Phase5、作成済み）

手動セットアップ項目:
- GitHubラベル`21.plan-required`の新規作成
- GitHubラベル`22.preview-required`・`23.screenshot-required`の新規作成
- GitHubラベル`20.auto-implement`の新規作成（Phase5、作成済み）
- `main`のBranch protection設定（未設定のため）
- リポジトリ設定でAuto-merge機能を有効化（Phase4、`gh repo edit --enable-auto-merge`で設定済み）
- `develop`のBranch protectionに`required_status_checks`（`lint-and-build`）を設定（Phase4）

## Phase 5: Issueラベル/@claudeコメント起点の完全自動化

`.github/workflows/claude-issue-dispatch.yml`で実装済み。ローカルの`scripts/start-issue.sh`が行っている
作業（issue-<番号>ブランチ作成・実装・develop向けPR作成）をGitHub Actions上で無人実行する。

### トリガー

- Issueへのラベル`20.auto-implement`付与（新規作成したラベル）
- Issueへの`@claude`コメント

パブリックリポジトリのため`@claude`コメント自体は誰でも投稿できるが、ラベルの付与・削除はGitHub側で
write権限を要求する。トリガー経路によらず一律で実行者(`github.actor`)のリポジトリ権限を
`gh api repos/{owner}/{repo}/collaborators/{actor}/permission`で確認し、write権限未満なら何もしない。

### `21.plan-required`が付いている場合の二段階トリガー（再起動方法を確定）

「未解決の課題」に残っていた「②→③の具体的な再起動トリガー」を以下のとおり確定した。

1. **計画提示**: `21.plan-required`が付いたissueへの初回dispatch時は実装せず、コードを調査した計画を
   `gh issue comment`でissueに投稿し、`00.check-user`を付与して停止する。
2. **承認・再開**: 人間が計画を確認し、issueから`00.check-user`ラベルを外すと「承認」とみなし、
   同ワークフローが実装を再開する（`issues: unlabeled`イベントをトリガーに使う）。
3. **練り直し**: `00.check-user`が付いたまま（＝未承認）人間が`@claude`とコメントした場合は、計画への
   修正依頼として扱い、計画コメントを投稿し直す（`00.check-user`は外さない）。

`00.check-user`はPhase4の自動マージ不可判定でも使われる汎用の「要確認」ラベルだが、対応する
`issue-<番号>`ブランチがまだ存在しない状態でのみ「承認」と解釈するようガードしている
（ブランチ作成後は本ワークフローはそのissueに対して常にskipする）ため、Phase4側の判定と混線しない。

### 着手直後の通知コメント

モード判定（plan/implement）が終わった直後に、`gh issue comment`で「依頼を確認し対応を開始する」旨を
issueに投稿するステップを設けている（issue #75）。Claude Codeエージェント自身に通知コメントの投稿を
委ねると、調査に時間がかかった場合や途中で行き詰まった場合に「依頼を受け取ったこと」自体が使用者に
伝わらない恐れがある。そのため後続のClaude Codeステップとは独立した、失敗しにくい単純なシェル
スクリプトのステップとしてモード判定直後に配置し、確実に投稿する（下記「計画提示ステップの信頼性
確保」のフォールバック検証と同じ考え方）。

### 無人実行時の権限モード（許可ツールリスト）

- **計画提示ステップ**: `--allowedTools "Bash(gh issue view:*),Bash(gh issue comment:*),Bash(gh issue edit:*),Bash(gh pr list:*),Bash(gh api:*),Bash(git ls-remote:*),Bash(git log:*)"`。
  コード変更ツール（Edit/Write）は許可しない（計画提示のみで実装はしないため）。当初`gh issue`系3種のみを
  許可していたが、計画立案のための調査で`git ls-remote`・`gh pr list`・`gh api`（関連PR・ブランチ状況の確認）
  を試みて未許可コマンドとして拒否され続け、ターン数を使い切ってコメント投稿・ラベル付与に到達できない
  失敗が実際に発生した（Issue #70で確認）。読み取り専用の調査コマンドを許可リストに加えて解消した。
- **実装ステップ**: `--allowedTools "Edit,Write,Bash(git:*),Bash(gh:*),Bash(pnpm:*),Bash(npx:*)"`。
  `--dangerously-skip-permissions`等の全許可フラグは使わず、必要なツール・コマンドプレフィックスのみを
  明示的に許可する方針（Phase1〜4から継続）。
- git push・PR作成はリポジトリsecretsの`WORKFLOW_PAT`（Fine-grained PAT、Repository permissions >
  Workflows: Read and write を含む）で行う（issue #106）。`Checkout develop`ステップの
  `actions/checkout`の`token`入力と、実装ステップ（`claude-code-action`）の`github_token`入力・
  `GH_TOKEN`環境変数の両方に配線している。既定の`GITHUB_TOKEN`は`.github/workflows/`配下への
  pushをGitHubの仕様上原理的に許可できない（リポジトリの「Workflow permissions」設定を
  Read and writeにしても解除されない）ため、`.github/workflows/`自体を変更するIssueを本ワークフロー
  で扱うにはPATが必須。他のステップ（状態判定・通知コメント・計画提示など、ワークフローファイルを
  変更しない箇所）は既定の`GITHUB_TOKEN`のままとし、PATの利用は最小限にとどめている。

### 計画提示ステップの信頼性確保

許可コマンドを広げても、より調査対象が広いIssueでは未許可の操作（他のBashコマンド・ツール）に
突き当たり、同様にコメント投稿まで到達できない失敗が再発する可能性は構造的に残る。これを個別の
許可コマンド追加だけで塞ぎ続けるのではなく、二段構えで対処する。

1. **プロンプト側の回避策**: 計画提示ステップのプロンプトに「調査に行き詰まった場合はそれ以上粘らず、
   分かっている範囲の情報で計画をまとめてコメント投稿を最優先する」「実装範囲が広く一度の計画に
   まとめきれない場合は、Issueの分割を計画コメントの中で提案してよい（分割作業自体はこのステップでは
   行わない）」という指示を追加した。調査を早めに切り上げさせることでターン数の消費を抑える狙い。
   ただし「何回失敗したら諦めるか」はモデルの裁量に委ねられるため、これだけでは失敗確率を下げる
   だけで、到達を保証するものではない。
2. **機械的な検証・フォールバック（本命）**: 計画提示ステップの前後でIssueのコメント数を記録・比較し、
   新規コメントが増えていなければ「計画提示ステップ実行後、コメント投稿を検証する」ステップが
   `gh issue comment`でフォールバック通知を投稿し`00.check-user`を付与する。この検証ステップは
   `gh issue view`/`gh issue comment`/`gh issue edit`のみを使う単純なシェルスクリプトであり、
   Claude Code自体の許可コマンドの問題から独立しているため、1で防ぎきれなかったケースでも
   「Issueに何も反映されないまま無言で終わる」事態を確実に防げる。

### 自動投稿コメントへの実行ログリンク付与

`claude-issue-dispatch.yml`・`issue-labels.yml`がGitHub Actions上で`gh issue comment`を使って
自動投稿するコメント（着手通知・計画提示・計画提示失敗時のフォールバック・画面確認待ちの通知・
develop向けPR作成完了・developマージ完了）には、末尾に`実行ログ: <ワークフロー実行のURL>`を
追記している（issue #106）。URLは`${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}`
で組み立てられ、そのコメントを投稿した1回のワークフロー実行を指す。人間がコメントから該当する
Actionsの実行ログへワンクリックで辿れるようにし、無人実行時のトラブルシュートを追跡しやすくする
のが狙い。計画提示ステップの計画コメント自体はClaude Codeエージェントが投稿するため、シェル
スクリプト側でURLを組み立てて渡すのではなく、プロンプトの指示に組み込んでエージェントに
追記させている。

### 既知の制約・今後の検討事項

- **develop向けPR作成後、Phase3/4のレビュー・自動マージが自動発火するか未検証**: `WORKFLOW_PAT`への
  切り替え（前述）により、`claude-issue-dispatch.yml`が作成するPRは既定の`GITHUB_TOKEN`ではなく
  実PAT由来になったため、GitHub仕様上の「`GITHUB_TOKEN`によるpush/PR作成は他のワークフローを
  起動しない」制限は受けなくなった。そのため`claude-review-develop.yml`（Phase3/4）が自動発火する
  可能性があるが、実運用でまだ確認できていない。Phase5の完了条件は「develop向けPR作成まで」であり、
  developへのマージまでの自動化は前提にしていないため、発火してもしなくても許容する
  （実装ステップのプロンプト内で`03.d:marge`ラベル付与を自前でも行っており、自動発火に依存しない）。
- `22.preview-required`・`23.screenshot-required`が付いたissueをPhase5経由（無人実行）で処理する場合、
  画面確認・スクリーンショット取得ができないため、実装・コミット・ブランチpushまで行った上で
  `00.check-user`を付与しPR作成前に停止する運用にとどめている。このケースの「承認後の再開」は
  Phase5のスコープでは自動化しておらず、人間が手動で`gh pr create`する運用（申し送り事項）。

## 未解決の課題・申し送り事項

- Claude Code CLIの起動オプション（`--permission-mode`の具体的な値、`--add-dir`等）は実装時に`claude --help`で最新仕様を確認する。特に無人実行（Phase3以降）で全チェックを無効化するようなフラグ（例: `--dangerously-skip-permissions`）を使うのは、意図しない破壊的操作のリスクがあるため避け、ローカル実行は`acceptEdits`（人間が横にいる前提）、GitHub Actions実行は`claude-code-action`側の許可ツールリスト等で制御する方針とする。
- VS Code拡張（Claude Code for VS Code）側に「起動時に初期プロンプトを自動投入する」公式な方法は確認できていない。Phase1では「ターミナルで`claude "プロンプト"`として起動し、その結果としてVS Codeが開く」形（またはVS Codeは別途手動で開く）を落としどころとする想定。
