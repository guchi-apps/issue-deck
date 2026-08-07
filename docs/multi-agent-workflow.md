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

## 実装範囲が広いIssueをサブIssueに分割する（GitHub Actions実行のみ）

大きなIssueをそのまま単一のGitHub Actionsジョブに渡すと、実装が長時間化して適切に処理しきれない懸念がある（issue #144）。これを避けるため、`21.plan-required`の計画提示ステップ（上記）に、実装範囲が広いと判断した場合はサブIssueへの分割を提案する仕組みを組み込んでいる。

- 計画提示ステップは、計画コメントの末尾に判断結果を示すマーカー（`<!-- issue-deck-plan-type:implement -->` または `<!-- issue-deck-plan-type:split -->`）を必ず埋め込む。分割を提案する場合は、計画コメント本文に分割後の各サブIssue案（タイトル・スコープ・依存関係）を明記する。
- 人間が計画を確認し`00.check-user`を外す（＝承認）と、別のワークフロー実行がこのマーカーを読み取り、`implement`（そのまま実装）または`split`（サブIssue作成）に自動的に分岐する。
- `split`の場合、計画コメントの分割案に沿って`gh issue create`でサブIssueを実際に作成し（本文に「分割元: #<元Issue番号>」を含め、単独で着手できる情報を持たせる）、元IssueにサブIssue一覧をコメントしたうえで、元Issueを`not planned`理由でクローズする。
- サブIssueへの実際の着手（`@claude`コメントによる起動）は自動連鎖させず、これまでどおり人間が個別に行う。分割はあくまで「大きな作業を、無人実行で扱える単位に事前に切り分ける」ところまでを自動化するもので、着手の判断は人間に残す。
- クローズ済みのIssueに対する`@claude`コメントやラベル操作では、計画・実装・分割のいずれも再始動しない（分割で元Issueがクローズされた後の誤爆防止。通常の`09.main`クローズ後のIssueにも同様に適用される）。

ローカル実行（`scripts/start-issue.sh`）では、分割の判断・提案自体はPlan mode内で人間に提示できるが、実際のサブIssue作成や元Issueのクローズを自動化する仕組みは今のところ用意していない（人間が`gh issue create`等で手動対応する）。

## Issueラベルの状態遷移

マルチエージェント運用で進めるIssueは、原則として以下の順でラベルが遷移する。全PJ共通の`01.wip`は`02.wip`にリネームし、実装着手前の計画検討中を表す`01.planning`を新設した（`21.plan-required`が付いていないIssueでは`01.planning`を経由せず最初から`02.wip`になる）。旧`02.close`（状態：対応済）はissue-deckでは`09.main`にリネームして統合した（他リポジトリの`02.close`には影響しない。ラベルはリポジトリごとの設定のため）。

1. `01.planning` — 実装エージェントが計画検討中（`21.plan-required`選択時のみ経由）
2. `02.wip` — 実装エージェントがコード実装中
3. `03.d:marge` — developへPR作成・マージ中
4. `05.develop` — developへマージ完了（main未反映）
5. `07.m:marge` — mainへPR作成・マージ中
6. `09.main` — mainへマージ完了。この時点でissueをcloseする

`00.check-user`（ユーザーのチェックが必要）は上記のどの段階でも他のラベルと併用して付与する。

上記1〜5の進捗ラベル（`01.planning`/`02.wip`/`03.d:marge`/`05.develop`/`07.m:marge`）は、`09.main`遷移を経由せずにIssueがクローズされた場合（`21.plan-required`の計画を拒否して直接クローズした場合など）、`.github/workflows/issue-labels.yml`の`cleanup-on-close`ジョブによってクローズ時に自動的に除去される（#464）。「本番反映済み」を示す恒久的な状態である`09.main`のみ除去対象から除外する。

develop→mainのリリースフロー（バージョンアップコミット・PR作成）は、`.github/workflows/release-develop-to-main.yml`によりバージョンbump PR・develop→mainのPR作成までを自動化済み（Phase 6参照。release-to-mainスキルが定める手順の1〜3に相当）。ただし人間の確認なしにPRが作成されることを避けるため、起動は`workflow_dispatch`による手動実行のみとしている（developへのPRマージやscheduleでの自動起動はしない）。実際のマージ（手順4）はこれまでどおり人間が手動で行う（Phase2の`start-reviewer.sh`は`05.develop`までを扱う）。上記1〜5のラベル遷移自体は、`.github/workflows/issue-labels.yml`によりGitHub Actions上でイベント駆動に自動化済み（次項参照）。

### GitHub Actionsによるラベル遷移の自動化

`.github/workflows/issue-labels.yml`が、上記の状態遷移をGitHubイベント（ブランチpush・PR作成・PRマージ）をトリガーに自動的に付け替える。

- `01.planning`〜`05.develop`: 実装エージェント・レビュー統合エージェントが手順どおり手動でラベルを付け替える運用は継続する（着手直後・PR作成時点で即座にラベルへ反映される速報性を残すため）。Actionsはこれと同じ遷移を安全網として保証するもので、エージェント側が付け忘れても、対応するブランチpush・PR作成・PRマージのタイミングで自動的に是正される。
- `07.m:marge`・`09.main`: 対応するエージェント運用が存在しないため、Actionsが唯一の付与手段となる。develop→mainのPRが開いている間は`05.develop`のissueを`07.m:marge`へ、PRがマージされた時点で`05.develop`/`07.m:marge`のissueを`09.main`へ一括遷移し、あわせてissueをcloseする。

issue番号の特定は、Issue専用ブランチの命名規約`issue-<番号>`（`scripts/start-issue.sh`が作成）から行う。この規約に従わないブランチ・PRは対象外（何もしない）。

`develop-pr-opened`（`03.d:marge`遷移時）・`develop-pr-merged`（`05.develop`遷移時）は、ラベル遷移と
同時に`gh issue comment`でIssueへ完了報告のコメントも投稿する。ラベルだけでは気付きにくいため、
PRオープン・マージという確実なイベントに紐づけて通知している。

`develop-pr-merged`は、`claude-review-develop.yml`の`auto-merge`ジョブが有効化するGitHub Auto-merge
機能による実際のマージ（必須ステータスチェック通過後にGitHub側が非同期に実行）では発火しないことが
ある（Issue #112。GITHUB_TOKEN起点のイベントは他のワークフローを起動しないというGitHub仕様の影響を
受けるため）。`auto-merge`ジョブ自体はWORKFLOW_PATでAuto-mergeを有効化するよう対応済みだが、
根本解消したか確証が持てないため、`develop-merge-sweep`ジョブが`schedule`（15分おき）・
`workflow_dispatch`をトリガーに、`03.d:marge`が付いた全issueを走査し、対応ブランチ
（`issue-<番号>`）からのdevelop向けPRが既にマージ済みであれば`05.develop`へ遷移する安全網を
別途設けている。

## 開発環境プレビュー要否をIssueラベルでトグルする

開発サーバー（`pnpm dev`）のポート割り当て自体はコストがないため、ラベルの有無に関わらず常に`.env.local`に`PORT=4000 + Issue番号`を設定する。ラベルは「画面確認をPR作成前の承認ゲートにするかどうか」を制御する。

- ラベル `23.preview-required` の有無で`start-issue.sh`が生成するプロンプトの文言が分岐する。
  - **ラベルなし（デフォルト）**: 実装エージェントは、画面に関わる変更を行った場合PR本文の「確認方法」に開発サーバーのURL（`http://localhost:<ポート>`）とアクセス手順を記載するだけで、承認待ちなしにそのままPR作成まで進める。
  - **ラベルあり**: PRを作成する**前**に、実際に開発サーバーを起動してURLをユーザーに提示し、画面を確認してもらったうえで明示的な承認を得てからPRを作成する（`21.plan-required`と同様の承認ゲート）。
- 承認の得方は実行形態により異なる（`21.plan-required`と同じ考え方）。
  - **ローカル実行**: 提示後にそのまま応答を止めて、ユーザーからの返信（承認）を待つ。
  - **GitHub Actions実行（無人）**: `00.check-user`を付与して停止し、人間の承認後に再起動して続行する。

## スクリーンショット取得要否をIssueラベルでトグルする

グローバルCLAUDE.mdの方針（Playwright等のブラウザ自動操作はトークン消費が大きいため明示指示がある場合のみ実施）に合わせ、実装エージェントによるスクリーンショットの自動取得はデフォルトで行わない。視覚的な確認と承認をPR作成前のゲートにしたいIssueにはラベルで個別に有効化する。

- ラベル `24.screenshot-required` の有無で分岐する。
  - **ラベルなし（デフォルト）**: スクリーンショットの自動取得は行わない。
  - **ラベルあり**: PRを作成する**前**に、実装エージェントが`run`スキル等を使って開発サーバー上で変更箇所のスクリーンショットを取得してユーザーに提示し、明示的な承認を得てからPRを作成する（承認の得方は上記`23.preview-required`と同じ）。Playwright等の新規依存関係の追加が必要な場合は、追加前に必ずユーザーに確認する（依存関係の追加はCLAUDE.mdの方針により無断で行えないため）。

## developへのマージ前確認要否をIssueラベルでトグルする（#366）

「自動マージ可否の判定方法」（後述）は、変更内容（パスパターン・依存関係の変更内容）に基づく
機械的・意味的判定のみで自動マージ可否を決めており、Issue単位で「この変更は内容によらず必ず
人間の確認を経てからマージしたい」と明示的に指定する手段が無かった。これをIssueラベルで
トグルできるようにする。

- ラベル `22.merge-confirm-required` の有無で分岐する。
  - **ラベルなし（デフォルト）**: 従来どおり、`risk-check`（機械的判定）・`claude-review`
    （意味的判定）の結果のみで自動マージ可否を判断する。
  - **ラベルあり**: 対応Issueに付いている限り、develop向けPRへのpushのたびに`risk-check`
    ジョブが判定し、変更内容によらず常に`00.check-user`を付与して自動マージをスキップする
    （詳細は「自動マージ可否の判定方法」参照）。他の`21.plan-required`等と異なり、実装
    エージェントの挙動（Plan mode・画面確認等）を分岐させるものではなく、レビュー・統合側の
    自動マージ判定にのみ影響する。
  - `24.screenshot-required`が付いている場合も同様に`risk-check`ジョブが常に`00.check-user`を
    付与する（#567）。無人実行では撮影自体は完結できてもスクリーンショットの内容を人間が
    確認する前にdevelopへマージされてしまう問題があったため、`22.merge-confirm-required`と
    同じ仕組みに乗せている。詳細は「自動マージ可否の判定方法」・Phase7参照。
  - 一度きりの`00.check-user`の手動付与と異なり、PRが複数回pushされる場合（追加修正・
    コンフリクト解消の自動push等）でも、そのPRが存在する間はIssueにラベルを付けたままにして
    おけば毎回のpushで確実に確認ゲートがかかる。
  - 「実装を開始」ダイアログのチェックボックス（`src/lib/github/start-implementation.ts`の
    `START_IMPLEMENTATION_OPTIONS`）にも「マージ前に確認が必要」として追加済みで、`21.plan-required`
    等と同様にダイアログから選択して付与できる（#366）。

## エージェントの役割

### 実装エージェント

Issueごとに独立したClaude Codeセッションとして起動する。

責務:
- GitHub Issueの内容を取得する。取得したら**忘れずに`02.wip`ラベルを付与する**（実装中であることを示すため。付け忘れやすいので要注意）
- 最新の`develop`からIssue専用ブランチ（`issue-<番号>`）を作成する
- Git worktreeで作業フォルダを分離する
- `21.plan-required`ラベルが付いていれば、実装前にPlan modeで計画を提示し承認を得る
- Issueの要件を実装する
- テスト・Lint・型チェック・ビルドを実行する
- 変更をコミットしてpushする
- `develop`向けPull Requestを作成する（本文に対応Issue・実装内容・テスト内容・確認方法・注意点を記載。developマージ時点ではissueをcloseしない運用のため、`closes #番号`/`fixes #番号`は使わず`#番号`のみ記載する）
- `02.wip`→`03.d:marge`のラベル付け替え

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
- **明示的指定（`risk-check`ジョブ、`22.merge-confirm-required`・`24.screenshot-required`ラベル）**: 変更内容によらず、対応Issueに`22.merge-confirm-required`または`24.screenshot-required`ラベルが付いている場合は常に`00.check-user`を付与する（「developへのマージ前確認要否をIssueラベルでトグルする」参照、#366・#567）。
- **`00.check-user`を両判定共通の「マージ保留」シグナルとして使う**: `auto-merge`ジョブは`risk-check`・`claude-review`の完了後、対応Issueに`00.check-user`が付いていないことだけを確認して`gh pr merge --auto --merge`（Auto-merge機能。リポジトリ設定で有効化済み）を実行する。判定ロジックとマージ可否判断を疎結合に保つことで、判定方法を追加・変更してもマージ側のロジックは変えずに済む。必須ステータスチェック（`develop`の`lint-and-build`）待ちのポーリングは自前実装せず、GitHub Auto-merge機能に任せる。
- **手動マージ時の`00.check-user`除去**: `00.check-user`が付いたPRは自動マージがスキップされ、人間がPRリンクから手動マージする運用になる。このマージ操作自体が確認完了を意味するため、`.github/workflows/issue-labels.yml`の`develop-pr-merged`・`develop-merge-sweep`・`main-pr-merged`の各ジョブは、状態遷移とあわせて`00.check-user`も除去する（#266）。
- **同一PRへの連続pushでのコメント重複防止**: 実装エージェントが追加修正等で同一PRに連続してpushすると、そのたびに`risk-check`ジョブが再実行される。ラベル自体はpushのたびに再付与して確認ゲートを確実に保つが、そのpush開始時点で対応Issueに既に`00.check-user`が付いていた場合はコメント投稿のみ省略する。実装がまだ進行中の段階で同内容の「developへのマージ前にユーザーの確認が必要」コメントが繰り返し投稿され、作業中なのか確認待ちなのか紛らわしくなる問題を防ぐため（#594）。

## 段階的導入計画

1. **Phase 1**: `start-issue.sh`/`.ps1` — worktree・ブランチ・Claude Code起動のコマンド化
2. **Phase 2**: `start-reviewer.sh`/`.ps1` — レビュー・統合セッション起動のコマンド化
3. **Phase 2.5**: `.github/workflows/issue-labels.yml` — ラベル状態遷移（`01.planning`〜`09.main`）のGitHub Actionsによる自動化
4. **Phase 3**: PR作成時の自動レビューをGitHub Actionsで実行（`subscription-lists`リポジトリの`claude-code-action`テンプレートを土台にカスタマイズ）
5. **Phase 4**: 低リスクなPRのみ`develop`へ自動マージ（自動マージ可否の判定方法を実装）
6. **Phase 5**: Issueへの`@claude`コメントを起点に実装からPR作成まで自動化
7. **Phase 6**: develop→mainのリリースフロー（バージョンbump PR・develop→mainのPR作成）を自動化

各Phaseは前段が安定稼働してから着手する。

## 今後作成するファイル（Phase進行に合わせて）

- `scripts/start-issue.sh` / `scripts/start-issue.ps1`（Phase1）
- `scripts/prompts/implementation-agent.md`（Phase1）
- `scripts/start-reviewer.sh` / `scripts/start-reviewer.ps1`（Phase2）
- `scripts/prompts/review-agent.md`（Phase2）
- `.github/workflows/issue-labels.yml`（Phase2.5、作成済み）
- `.github/workflows/claude-review-develop.yml`（Phase3、作成済み。Phase4で`risk-check`/`auto-merge`ジョブを追加）
- `.github/workflows/claude-issue-dispatch.yml`（Phase5、作成済み）
- `.github/workflows/release-develop-to-main.yml`（Phase6、作成済み）

手動セットアップ項目:
- GitHubラベル`21.plan-required`の新規作成
- GitHubラベル`23.preview-required`・`24.screenshot-required`の新規作成
- GitHubラベル`22.merge-confirm-required`の新規作成（#366、作成済み）
- `main`のBranch protection設定（未設定のため）
- リポジトリ設定でAuto-merge機能を有効化（Phase4、`gh repo edit --enable-auto-merge`で設定済み）
- `develop`のBranch protectionに`required_status_checks`（`lint-and-build`）を設定（Phase4）

## Phase 5: @claudeコメント起点の完全自動化

`.github/workflows/claude-issue-dispatch.yml`で実装済み。ローカルの`scripts/start-issue.sh`が行っている
作業（issue-<番号>ブランチ作成・実装・develop向けPR作成）をGitHub Actions上で無人実行する。

### トリガー

- Issueへの`@claude`コメント（起動トリガーはこれに一本化。旧`20.auto-implement`ラベルは廃止した）

パブリックリポジトリのため`@claude`コメント自体は誰でも投稿できる。トリガー経路によらず一律で
実行者(`github.actor`)のリポジトリ権限を`gh api repos/{owner}/{repo}/collaborators/{actor}/permission`
で確認し、write権限未満なら何もしない。

コメント本文とのマッチングは`contains()`ではなく`startsWith()`で行う（本文の先頭が`@claude`か
どうかのみ判定し、本文中のどこかに`@claude`という文字列が含まれるだけでは反応しない、#173）。
`contains()`だと、このワークフロー自身が投稿する完了報告コメント（承認コメントの定型文
`APPROVE_COMMENT_BODY`を説明のため引用する場合など）にまで反応し、報告コメントが次のワーク
フロー実行を誘発し、その実行がまた報告コメントを投稿して…という無限ループを起こしうる
（#173で実際に2回連続発生した）。アプリが送信する定型コメント（`APPROVE_COMMENT_BODY`・
`START_IMPLEMENTATION_COMMENT_BODY`等）と、人間が手動で投稿する起動コメントはいずれも本文の
先頭が`@claude`という慣習のため、`startsWith()`に絞っても正規の起動経路は損なわれない。

なお`21.plan-required`の承認再開（`00.check-user`ラベルの削除）は引き続き`issues: unlabeled`
イベントをトリガーに使う（下記「二段階トリガー」参照）。ラベル付与（`labeled`イベント）はもはや
本ワークフローのトリガーには使わない。

### `21.plan-required`が付いている場合の二段階トリガー（再起動方法を確定）

「未解決の課題」に残っていた「②→③の具体的な再起動トリガー」を以下のとおり確定した。

1. **計画提示**: `21.plan-required`が付いたissueへの初回dispatch時は実装せず、コードを調査した計画を
   `gh issue comment`でissueに投稿し、`00.check-user`を付与して停止する。
2. **承認・再開**: 人間が計画を確認し、issueから`00.check-user`ラベルを外すと「承認」とみなし、
   同ワークフローが実装を再開する（`issues: unlabeled`イベントをトリガーに使う）。
3. **練り直し**: `00.check-user`が付いたまま（＝未承認）人間が`@claude`とコメントした場合は、計画への
   修正依頼として扱い、計画コメントを投稿し直す（`00.check-user`は外さない）。
4. **拒否**: 承認も練り直しもせず、計画自体を取りやめて実装しない場合は、人間が
   `gh issue close`（またはGitHub Web UI）でIssueを`not planned`等の理由で直接クローズする。
   クローズ済みのIssueは本ワークフローの全モードで再始動しない（`issue_closed`ガード）ため、
   拒否のコメント自体に`@claude`を含める必要はない（コメントを残さずクローズするだけでもよい）。
   クローズ後も`00.check-user`ラベルや`01.planning`/`02.wip`等の進捗ラベルが「要確認」「計画検討中」
   「作業中」のまま残ると紛らわしいため、`.github/workflows/issue-labels.yml`の`cleanup-on-close`
   ジョブが、Issueクローズをトリガーに`00.check-user`と進捗ラベル（`01.planning`/`02.wip`/
   `03.d:marge`/`05.develop`/`07.m:marge`。`09.main`は「本番反映済み」の恒久的な状態を示すため除外）
   を自動的に除去する
   （issue #172、#464）。この除去自体が`00.check-user`の`unlabeled`イベントを発生させ本
   ワークフローを起動するが、対象issueは既にクローズ済みのため`issue_closed`ガードにより
   何もせず`mode=skip`となる。

`00.check-user`はPhase4の自動マージ不可判定でも使われる汎用の「要確認」ラベルだが、対応issueの
PRが既に作成されている場合にのみ本ワークフローは常にskipし、それ以前の状態でのみ「承認」と
解釈するようガードしている（`gh pr list --head issue-<番号>`でPR有無を判定）ため、Phase4側の
判定（常にPR作成後にしか起こらない）と混線しない。

### 実装が詰まった状態からの再開（issue #112）

無人実行の実装ステップが権限拒否等で行き詰まり、PRもコメント投稿もできないまま終了することが
ある（issue #112で実際に発生。`permission_denials_count`が多数記録され、`issue-<番号>`ブランチは
pushされたがPRが作成されないまま終了した）。この場合、当時の実装（ブランチ有無だけで常にskipする
判定）では、PRが無いまま`issue-<番号>`ブランチだけが残り、以後どのイベントが来ても再始動しない
状態でスタックしてしまい、人間がブランチを手動削除する以外に復旧手段が無かった。

判定ステップでは「`02.wip`が付いているのにPRが無い」状態を検知でき、当初はこれを詰まった実装の
リトライとみなして`issue-<番号>`ブランチを自動削除・作り直しした上で実装ステップを再実行していた。
しかし、これは「そのissueに来た@claudeコメントや00.check-user解除イベントなら何でも」トリガーに
なってしまい、実は前回コミットまで進んでいた作業が本人の意図に関わらず無言で失われる恐れがあった。

そのため、ブランチの削除・作り直しは自動化せず人間の明示操作（`git push origin --delete
issue-<番号>`等）に委ねたうえで、この詰まった状態を`mode=additional`（既存ブランチへの追加対応、
#129）に統合し、issue_commentでの呼びかけがあれば既存の`issue-<番号>`ブランチをそのままcheckout
して続きから自動的に再開するようにした。前回コミットを失うことなく、無駄なやり直しも避けられる。
実装ステップのプロンプト側で`git log develop..HEAD --stat`等により現在のブランチの状態をまず
確認させ、続行可能ならそのまま実装を続けて完了時に新規でPRを作成し、続行が難しいほど中途半端・
矛盾した状態だと判断した場合は無理に修正せず`00.check-user`を付与して人間に判断を委ねる。

### 着手直後の通知コメント

モード判定（plan/implement）が終わった直後に、`gh issue comment`で「依頼を確認し対応を開始する」旨を
issueに投稿するステップを設けている（issue #75）。Claude Codeエージェント自身に通知コメントの投稿を
委ねると、調査に時間がかかった場合や途中で行き詰まった場合に「依頼を受け取ったこと」自体が使用者に
伝わらない恐れがある。そのため後続のClaude Codeステップとは独立した、失敗しにくい単純なシェル
スクリプトのステップとしてモード判定直後に配置し、確実に投稿する（下記「計画提示ステップの信頼性
確保」のフォールバック検証と同じ考え方）。

### コメント投稿元・ボットの役割表示（`issue-deck-source` / `issue-deck-agent`マーカー）

issue-deckは1つのIssueに複数のワークフロー・複数のモードのボットコメントが積み重なるため、
issue詳細画面（`comment-thread.tsx`）はコメントを投稿者別に整理して表示する。ログイン中の
ユーザー本人のコメントは右寄せの吹き出し、ボットのコメントは役割ごとにアイコン・色を分けた
左寄せの吹き出しで表示し、ヘッダには（役割が判別できる場合）loginの代わりに役割の表示名を出す。

役割の判定は`src/lib/github/comment-source.ts`の`resolveCommentSource()` /
`commentAgentRole()`が行う。優先順位は次のとおり。

1. `<!-- issue-deck-fallback-notice -->`（`fallback-notice.ts`） → エラー通知ボット
2. `<!-- issue-deck-qa-answer -->`（`ask-claude.ts`） → 回答ボット
3. `<!-- issue-deck-plan-type:implement|split -->` → 計画ボット／分割ボット
4. `<!-- issue-deck-agent:<role> -->`（`role`は`implementer` / `splitter` / `guide`のいずれか） →
   指定された役割
5. `<!-- issue-deck-source:<id> -->`のうち`claude-review-develop` / `claude-conflict-resolve` /
   `issue-labels` → レビューボット／コンフリクト解消ボット／進捗通知ボット（`claude-issue-dispatch`
   はこのidだけでは役割が一意に決まらないため対象外。4のagentマーカーか、下記6の絵文字フォール
   バックで判別する）
6. 本文書き出しの絵文字（`🔍`→計画ボット、`🔧`→実装ボット、`🔀`→分割ボット、`ℹ️`→案内ボット） →
   マーカー導入前の過去コメント向けのフォールバック推測
7. 上記いずれにも該当しないbotログイン → 役割なしの汎用ボット（ヘッダにはloginをそのまま表示）
8. bot以外のログイン → 役割解決の対象外（人間のコメントとして表示）

`issue-deck-source`マーカー自体は#563/#564で導入済みの投稿元ワークフロー識別用マーカーで、本
`issue-deck-agent`マーカーとは別軸（source＝どのワークフローが投稿したか、agent＝その中の
どの役割か）として併記する。`claude-issue-dispatch.yml`は計画・実装・分割・案内のいずれのコメント
も同じ`claude-issue-dispatch`というsource idで投稿するため、agentマーカーが無いと役割まで
区別できない。他の3ワークフロー（`claude-review-develop` / `claude-conflict-resolve` /
`issue-labels`）はsource idだけで役割が一意に決まるため、agentマーカーは付与していない。

**新しくボットコメントを追加する場合は、上記の優先順位のどれか1つに当てはまるマーカーを必ず
本文末尾に付与すること。** 特に`claude-issue-dispatch.yml`に新しいコメント種別を追加する場合、
1〜3のいずれにも該当しないなら`<!-- issue-deck-agent:implementer|splitter|guide -->`のいずれかを
選んで付与する（迷った場合は、実装作業そのものに関する通知なら`implementer`、それ以外の案内・
状態通知なら`guide`を選ぶ）。マーカーを付け忘れると、絵文字フォールバック（6）に頼ることになり、
文言を変えるだけで表示が壊れる脆い状態になる。

各役割のアイコン・色は`src/lib/github/comment-source.ts`の`COMMENT_AGENT_PROFILES`に集約している。

### Claudeアプリへの引き継ぎ時にコメントで記録する（#412）

無人実行（`claude-issue-dispatch.yml`）が行き詰まった場合の逃げ道として、「Claudeアプリで開く」
ボタン（issue #360）が用意されている。しかしこのボタンは単なる`<a href>`リンクのため、クリック
してclaude.aiへ遷移してもissue側には何の記録も残らず、「無人実行がフォールバックしたまま放置
されている」のか「実は人間がClaudeアプリで作業中」なのかが区別できない問題があった。

これは上記「着手直後の通知コメント」と同じ考え方で、「エージェント自身が気を利かせてコメントを
残す」ことに頼らず、UI側（issue-deckアプリ自身）がボタン押下時に確実に引き継ぎ記録コメントを
投稿してから遷移する方式にした（`buildClaudeAppHandoffCommentBody`）。コメント本文は
`@claude`から書き始めない（`claude-issue-dispatch.yml`の`startsWith("@claude")`トリガーを
誤爆させ、無人実行を再起動してしまうため）。コメント投稿はページ遷移をブロックしないfire-and-
forgetで行い、投稿に失敗してもClaudeアプリへの遷移自体は必ず行う。

### 無人実行時の権限モード（許可ツールリスト）

- **計画提示ステップ**: `--allowedTools "Bash(gh issue view:*),Bash(gh issue comment:*),Bash(gh issue edit:*),Bash(gh pr list:*),Bash(gh api:*),Bash(git ls-remote:*),Bash(git log:*),Bash(curl:*),Read"`。
  コード変更ツール（Edit/Write）は許可しない（計画提示のみで実装はしないため）。当初`gh issue`系3種のみを
  許可していたが、計画立案のための調査で`git ls-remote`・`gh pr list`・`gh api`（関連PR・ブランチ状況の確認）
  を試みて未許可コマンドとして拒否され続け、ターン数を使い切ってコメント投稿・ラベル付与に到達できない
  失敗が実際に発生した（Issue #70で確認）。読み取り専用の調査コマンドを許可リストに加えて解消した。
- **実装ステップ**: `--allowedTools "Edit,Write,Read,Bash(git:*),Bash(gh:*),Bash(pnpm:*),Bash(npx:*),Bash(curl:*)"`。
  `--dangerously-skip-permissions`等の全許可フラグは使わず、必要なツール・コマンドプレフィックスのみを
  明示的に許可する方針（Phase1〜4から継続）。
- `Bash(curl:*)`・`Read`は、issue本文に貼り付けられた画像がissue-deck独自の画像アップロードAPI
  （`user-images.githubusercontent.com`等のGitHub純正CDNではなく`/api/issues/images/...`）経由の場合、
  claude-code-action組み込みの画像取得機能の対象外となり素通りしていた問題への対応として追加した
  （Issue #195）。`WebFetch`はHTMLをMarkdown化して要約する用途向けで画像本体をClaudeに見せられないため、
  代わりに`curl`でローカルに保存し`Read`で開く方式にした。`Bash(curl:*)`はURL・HTTPメソッドを問わず
  任意の外部通信を許可してしまう（シークレットの外部送信等）ため、より狭い許可（ドメイン限定や
  GET専用化）が理想だが、Bashの許可ルールはコマンド文字列の前方一致でしか絞り込めずフラグの
  順序次第で回避されてしまう。本ワークフローは既に`Bash(git:*)`・`Bash(gh:*)`など広い許可を与えており
  （信頼された運用者のIssueのみを想定した既存の前提を踏襲）、`curl`もその前提の範囲内として許可した。
- git push（ラベル操作を含む）はリポジトリsecretsの`WORKFLOW_PAT`（Fine-grained PAT、Repository
  permissions > Workflows: Read and write を含む）で行う（issue #106）。既定の`GITHUB_TOKEN`は
  `.github/workflows/`配下へのpushをGitHubの仕様上原理的に許可できない（リポジトリの
  「Workflow permissions」設定をRead and writeにしても解除されない）ため、`.github/workflows/`
  自体を変更するIssueを本ワークフローで扱うにはPATが必須。この認証は`Checkout develop`ステップの
  直後に置いた`pushの認証をWORKFLOW_PATに固定する`ステップ（`git remote set-url --push origin`で
  `remote.origin.pushurl`にPATを埋め込んだURLを設定する）で完結しており、後続の実装ステップ
  （`claude-code-action`）側の`github_token`入力・`GH_TOKEN`環境変数には依存しない。他のステップ
  （状態判定・通知コメント・計画提示など、ワークフローファイルを変更しない箇所）は既定の
  `GITHUB_TOKEN`のままとし、PATの利用は最小限にとどめている。
  - 実装ステップの`GH_TOKEN`環境変数（および`github_token`入力）は、上記のとおりgit pushの認証には
    使われないため、そのまま既定の`GITHUB_TOKEN`（`${{ github.token }}`）を設定している。これにより
    `gh issue comment` / `gh pr create` / `gh pr comment` / `gh issue edit`はすべてトークンを
    上書きせずそのまま実行すればよく、投稿者・作成者は`github-actions[bot]`になる。同じパターンが
    使われる`.github/workflows/claude-conflict-resolve.yml`のコンフリクト解消ステップも同様の方針
    にしている。
  - 当初（issue #576時点）は`GH_TOKEN`を`WORKFLOW_PAT`（人間（m-guchi）名義のFine-grained PAT）に
    設定したうえで、Issue/PRへのコメント投稿・PR作成のみコマンド単位で`DEFAULT_GH_TOKEN`
    （既定の`GITHUB_TOKEN`）に明示的に上書きさせるようプロンプトで指示する方式を取っていた。しかし
    実際にはClaude Codeのbashツール自体が持つシークレット保護のガードレールが、`TOKEN`を含む名前の
    環境変数の展開を一律ブロックするため、この上書きは実行時に機能せず、完了報告コメント・PRの
    投稿者が人間（m-guchi）名義のまま記録され続ける問題が再発した（issue #621）。そこで
    「git pushの認証はcheckoutステップ側で完結しており実装ステップの`GH_TOKEN`には依存しない」と
    判断し、コマンド単位の上書きという壊れやすい方式をやめて既定の`GITHUB_TOKEN`をそのまま使う
    構成に変更した（issue #635）。
  - しかしこの「checkoutステップ側で完結している」という前提は誤りだった（issue #662）。
    `claude-code-action`は実行時に`replaceCheckoutCredentials()`で、`actions/checkout`が残した
    `http.<server>/.extraheader`を削除したうえで`remote.origin.url`を
    `https://x-access-token:<action自身のトークン>@github.com/...`に差し替える。`github_token`
    入力を省略した場合のそのトークンはOIDC交換で得たClaude GitHub Appのインストールトークンであり、
    `workflows`権限を持たないため、`.github/workflows/`配下を含むpushだけが
    `refusing to allow a GitHub App to create or update workflow ... without 'workflows' permission`
    で拒否されるようになった（issue #622・#638・#652が実際にこれで停止した）。
    一方で`github_token`に`WORKFLOW_PAT`を戻すと、`claude-code-action`が実装ステップの`GH_TOKEN`も
    同じPATへ上書きするため（`src/entrypoints/run.ts`）、issue #621の「投稿者が人間名義になる」問題が
    再発する。actionに渡すトークンは1本しかなく「pushはPAT・コメントはbot」を両立できないため、
    actionが書き換えないpush専用URL（`remote.origin.pushurl`）にだけPATを固定する方式に変更した。
    fetchはaction自身のトークン、pushはPATという分離が成立し、プロンプト側は
    `git push origin <ブランチ名>`のままでよい。

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
3. **設定回数までの自動リトライ（#497）**: 2のフォールバック検証ステップが「新規コメント（計画提示
   ステップ）・新規コメントとPRのいずれも（実装ステップ）が確認できない」と判断した時点で、即座に
   `00.check-user`を付けて止めるのではなく、まず全リポジトリ共通の自動リトライ上限（`GET
   /api/settings/auto-retry`から取得する`autoRetryLimit`。#496で追加した読み取り専用APIを、
   リポジトリ単位ではなくアプリ全体で共通の設定に置き換えたもの）と現在のリトライ回数を比較する。
   上限未満であれば「自動リトライします」という
   趣旨のコメントを投稿したうえで`gh workflow run claude-issue-dispatch.yml -f
   issue_number=<n> -f retry_attempt=<n+1>`で`claude-issue-dispatch.yml`自身を`workflow_dispatch`
   経由で再起動し、`00.check-user`は付与せず終了する。上限に達した場合（`autoRetryLimit`が未設定・
   API到達不可の場合は常に上限0扱いとし安全側にフォールバックする）は従来どおりのフォールバック
   通知＋`00.check-user`を行う。
   - `workflow_dispatch`による自己再起動は、`GITHUB_TOKEN`によるAPI呼び出しが新たなワークフロー
     実行を誘発しないGitHubの仕様上の制約（[docs/actions-token-model.md](actions-token-model.md)
     参照）のため、`secrets.WORKFLOW_PAT`を使う。
   - `workflow_dispatch`トリガー自体は、`workflow_dispatch`のAPI呼び出しがリポジトリへのwrite
     権限を要求するGitHub側の仕様により、`issue_comment`向けの実行者パーミッション確認と同等の
     信頼レベルが既に担保されているとみなし、Bot判定・実行者パーミッション確認をスキップする。
   - 自動リトライ発火時のコメントには、フォールバック通知の`<!-- issue-deck-fallback-notice -->`
     マーカーを付けない（`00.check-user`も付けないため、issue-deck画面の「続きを実装・調査を依頼」
     ボタンは表示されず、UIの継続依頼導線と自動リトライが二重に走ることはない）。
4. **エラー原因（一過性/恒常的）に応じたフォールバック文言・リトライ挙動の出し分け（#621）**:
   上記のフォールバック通知は、当初「ツール権限拒否等の恒常的な障害」を前提にした固定文言だったが、
   実際には計画提示・実装ステップに使う`anthropics/claude-code-action@v1`ステップ自体が、Claude
   起動前後のGitHub API呼び出し（実行者の権限チェック等、アクション内部の処理）が一時的に失敗した
   ことでステップごと`failure`終了するケースがあり（Issue #610で実際に観測: 権限チェックAPIの
   一時的な503エラー）、その場合も同じ「ツール権限拒否」文言のフォールバック通知が投稿されて
   ユーザーに誤った原因認識を与えていた。そこで、`Claude Code（計画提示）`・
   `Claude Code（実装・PR作成）`の各ステップに`id`（`claude_plan`・`claude_implement`）を付け、
   後続のフォールバック検証ステップから`steps.<id>.outcome`を参照して次のように区別する。
   - ステップの終了状態が`failure`（アクション自体がエラー終了した）→ 一過性のインフラ障害
     （`ERROR_TYPE=transient`）とみなし、「GitHub API呼び出しが一時的に失敗した可能性があり、
     再実行すれば解消する場合がある」という趣旨の文言を投稿する。
   - ステップの終了状態が`failure`以外（Claude自体は完走したが、新規コメント・PRが確認できない）
     → 従来どおり、ツール権限拒否等の恒常的な障害（`ERROR_TYPE=persistent`）とみなし、既存の文言を
     投稿する。
   - リトライ判定にも同じ区別を用いる。3の自動リトライ上限（`autoRetryLimit`）は`APP_BASE_URL`
     未設定・API到達不可の場合は常に上限0扱いになり自動リトライが働かない仕様だが、一過性障害と
     判定した場合に限り、`autoRetryLimit`が取得できない/低すぎる環境でも最低限のリトライ回数
     （ワークフロー内の`TRANSIENT_FALLBACK_RETRY_LIMIT`、現在は2回）を保証する。恒常的な障害と
     判定した場合はリトライしても解消しない可能性が高いため、この下駄は適用せず`APP_BASE_URL`
     未設定時は従来どおりリトライしない。
   - このエラー種別判定は、アクションステップ自体の終了状態という機械的に取得できる情報のみに
     基づく簡易な推定であり、HTTPステータスコード等アクション内部のエラー詳細までは判別しない
     （ジョブログからの詳細抽出はアクション実行中のログ取得の信頼性が不確かなため見送った）。

### 使用するモデルの設定（#622）

`claude-issue-dispatch.yml`の各モード（計画提示・分割・質問応答・実装/追加対応）の
`claude-code-action`起動時、`claude_args`に含める`--model`の値は、自動リトライ上限
（`autoRetryLimit`）と同じ`AppSetting`シングルトンテーブルで管理する全リポジトリ共通の設定
（`claudeModel`。既定値は`"auto"`）から決める。アプリ設定ダイアログ（歯車アイコン）で
「自動」「Opus」「Sonnet」「Haiku」のいずれかを選択でき、値は`GET /api/settings/claude-model`
（読み取り専用、認証不要）経由でワークフローから参照する。

- ジョブの先頭付近（実行者・状態判定ステップの直後）に専用ステップを設け、`APP_BASE_URL`未設定
  時やAPI疎通失敗時、または許可された値（`opus`/`sonnet`/`haiku`）以外が返った場合は安全側で
  `"auto"`扱いにフォールバックする（autoRetryLimitの取得ステップと同じ方針）。
- `claudeModel`が`"auto"`の場合は`--model`を一切付与せず、`claude-code-action`側のデフォルト
  モデルに委ねる。それ以外の場合は`--model <値>`を各`claude_args`に追記する。
- モデル値はスナップショット日付を含む具体的なモデルIDではなく、Claude Code CLIが解決する
  エイリアス（`opus`/`sonnet`/`haiku`）のみを許可する。特定のスナップショットに固定すると、
  将来Anthropic側でデフォルトモデルが更新されても自動的に恩恵を受けられなくなるため。

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
- **GitHub Auto-mergeによるdevelopマージ後、`03.d:marge`が`05.develop`へ遷移しないことがある**
  （Issue #112、対応済み）: 上記と同根の制約で、`claude-review-develop.yml`の`auto-merge`ジョブが
  既定の`GITHUB_TOKEN`で有効化していたGitHub Auto-merge機能による実際のマージは、
  `issue-labels.yml`の`develop-pr-merged`ジョブ（`pull_request: closed`トリガー）を起動しないこと
  があった。対応として`auto-merge`ジョブの`GH_TOKEN`を`WORKFLOW_PAT`に切り替え、あわせて
  `issue-labels.yml`に`schedule`（15分おき）で走査する`develop-merge-sweep`ジョブを追加し、
  取りこぼした`03.d:marge`を拾い直す安全網とした。PATへの切り替えで根本解消したかはGitHubの
  非公開の内部仕様に依存するため確証がなく、安全網を併設することでリスクを吸収している。
- `24.screenshot-required`が付いたissueをPhase5経由（無人実行）で処理する場合は、Phase7で統合した
  Playwright撮影（#258）により、実際にスクリーンショットを撮影してIssueコメントに埋め込んだ
  うえで通常どおり完了処理（PR作成）まで進める（PR作成自体はブロックしない。スクリーンショットは
  PR側ではなくIssue側のスレッドに集約する、#589）。ただし developへの
  実際のマージは`risk-check`ジョブが`00.check-user`を付与するため、人間がスクリーンショットを
  確認するまで保留される（#567）。詳細はPhase7参照。
- `23.preview-required`が付いていて`24.screenshot-required`が付いていないissueをPhase5経由
  （無人実行）で処理する場合、実際に到達可能なプレビューURLを無人実行環境から提供できないため、
  実装・コミット・ブランチpushまで行った上で`00.check-user`を付与しPR作成前に停止する運用にとどめて
  いる。このケースの「承認後の再開」はPhase5のスコープでは自動化しておらず、人間が手動で`gh pr create`
  する運用（申し送り事項）。停止時のコメントには上記のポート割り当て規約（`PORT=4000 + Issue番号`）に
  基づく`http://localhost:<ポート>`と、同一LAN上の別端末から確認する場合向けの
  `http://<WSLまたはLANのIPアドレス>.sslip.io:<ポート>`をあわせて案内する。無人実行のワークフロー
  自体はdevサーバーを起動しないため、人間が手元でブランチをcheckoutして`pnpm dev`を起動した際に
  開くURLとしての案内であり、実際に到達可能なURLをその場で提示しているわけではない。

## Phase 6: develop→mainのリリースフロー自動化

`.github/workflows/release-develop-to-main.yml`で実装済み（issue #55）。release-to-mainスキル
（`.claude/skills/release-to-main/SKILL.md`）が定める手順のうち、「1. バージョンを上げる」
「2. developへの反映（フィーチャーブランチ+PR）」「3. develop→mainのPRを作成する」までを
自動化する。手順4（実際のマージ、マージコミット必須）はCLAUDE.mdの自動マージ不可カテゴリ
（`develop`→`main`のマージ）に該当するため、これまでどおり人間が手動で行う。

### 状態判定

他に状態を保持せず、develop/mainそれぞれの`package.json`の`version`フィールドの比較だけで
判定する。

- **main版 == develop版**（まだ何もバンプしていない）: developとmainに差分があれば、
  develop向けのバージョンbump PRが無いことを確認したうえで新規に作成する。
- **main版 != develop版**（バンプPRが既にdevelopへマージ済み）: develop→mainのPRが無いことを
  確認したうえで新規に作成する。

### バージョンの上げ幅の判定

issueのラベルではなく、main/develop間の実際のコード差分の内容から判定する。専用のClaude
Codeステップ（`claude-code-action`、`--json-schema`による構造化出力）が`git diff origin/main
origin/develop`・`git log origin/main..origin/develop`を確認し、semverに基づき
major/minor/patchのいずれかと判断根拠を返す。判定ステップ自体が失敗した場合や、返り値が
major/minor/patchのいずれでもない不正な場合はpatchにフォールバックする。判断が誤っている
と思われる場合は人間が生成されたPR上でバージョンを直接修正する想定（release-to-mainスキルの
「迷う場合はユーザーに確認する」に相当）。

### トリガー

`workflow_dispatch`（手動実行）のみ。バンプPR・develop→mainのPR作成は人間の確認なしに
走ってしまうため、developへのPRマージや`schedule`による自動起動はしない（#178）。人間が
GitHub ActionsのUIから`Run workflow`で明示的に実行する。

同時実行による二重作成を避けるため、`concurrency`グループで直列化している（手動実行のみの
現在でも、短時間に複数回実行された場合の安全網として維持している）。

### 自動マージされないことの担保

バージョンbump用PR（`release/v*` → `develop`）・develop→mainのPR（`develop` → `main`）は
いずれも、ブランチ名が`issue-<番号>`の命名規約に従わないため、`claude-review-develop.yml`の
`auto-merge`ジョブが対応Issue番号を特定できず自動マージをスキップする（既存の仕組みがそのまま
効くため、本Phaseで新たなガードは追加していない）。develop→mainのPRについてはそもそも
`claude-review-develop.yml`が`develop`向けPRしか対象にしないため関与しない。

## Phase 7: 無人実行でのスクリーンショット撮影・画像埋め込み（#199, #255, #256, #257, #258）

issue #199（「PC画面とスマホ画面のデザインを確認したい」）は複数の技術的障壁があるため4つの
サブIssueに分割された。

- #255: 任意のPNG画像をGitHub Issueコメントに画像として埋め込む手段の確立（DB・認証には
  触れない）
- #256: 無人実行フローにMySQLサービスコンテナを追加し、開発サーバーを起動できるようにする
- #257: Supabaseを経由しないCI専用ログインバイパス機構
- #258: 上記3件の上に実際のPlaywright撮影処理を統合し、Phase5の`24.screenshot-required`の
  挙動を「撮影できないので`00.check-user`を付与して停止する」から「実際に撮影してIssue
  コメントに埋め込んだうえで通常どおり完了処理まで進める」に変更する

### 画像埋め込みの仕組み（#255）

- 画像は`develop`/`main`の祖先には含まれない専用のorphanブランチ`screenshots`にコミットする
  （通常のリリースフローではマージしない）。
- コミットした画像を`https://raw.githubusercontent.com/<owner>/<repo>/screenshots/issue-<番号>/<ファイル名>.png`
  のURLとして参照し、Markdownの`![...](...)`記法で`gh issue comment`の本文に埋め込む。公開
  リポジトリのため認証なしで表示できる（`scripts/post-issue-screenshot.sh`実行時に実機検証済み、
  `raw.githubusercontent.com`から`content-type: image/png`で200が返ることを確認した）。
- `scripts/post-issue-screenshot.sh <issue番号> <画像ファイルパス> [画像ファイルパス...]`が、
  画像を`screenshots`ブランチの`issue-<番号>/`配下にコミット・pushし、上記raw URLを標準出力に
  1行1URLで出力する。呼び出し側（将来のPlaywright統合サブIssueなど）はこの出力をそのまま
  `gh issue comment`の本文に埋め込めばよい。ファイル名には取得時刻を接頭辞として付与しており、
  同名ファイルで撮り直した場合でも`raw.githubusercontent.com`側の古いキャッシュを参照し続けない
  ようにしている。

### 権限

`screenshots`ブランチは`.github/workflows/`配下を含まないため、pushには
issue #106のようなworkflow書き込み権限を持つPAT（`secrets.WORKFLOW_PAT`）は不要で、既定の
`GITHUB_TOKEN`（`contents: write`権限）で足りる（懸念点として#255のissue本文に挙げられていたが、
検証の結果PATは不要と判明した）。

### 肥大化対策

`screenshots`ブランチが際限なく肥大化しないよう、`issue-labels.yml`の`cleanup-on-close`ジョブが
Issueクローズをトリガーに対応する`issue-<番号>/`ディレクトリを削除する。定期的なバッチ削除等は
導入していない（クローズされないまま放置されるIssueは通常のIssue運用上も稀なため、クローズ時の
削除のみで十分と判断した）。

### Playwright撮影の統合（#258）

`24.screenshot-required`が付いたissueをPhase5経由（無人実行）で処理する場合、`claude-issue-
dispatch.yml`のClaude Codeステップ（実装・PR作成）が、実装・テスト・コミットを終えた後に
`pnpm run capture:issue-screenshots -- <issue番号> [対象パス]`を実行する。これは`package.json`の
`capture:issue-screenshots`スクリプト経由で`scripts/capture-issue-screenshots.sh`を実行するもの。
かつては実装ステップの`allowedTools`に`Bash(scripts/capture-issue-screenshots.sh:*)`という
前方一致の許可を直接列挙していたが、エージェントが`bash scripts/capture-issue-screenshots.sh
<issue番号>`のように`bash `を前置して呼び出すと一致せず拒否される問題があったため、既に
許可済みの`Bash(pnpm:*)`経由の呼び出しに変更し、`allowedTools`からその許可は削除した
（Issue #522）。

第2引数（対象パス）は実装エージェントが今回の変更内容から判断して指定する（#567）。

1. `next dev`をバックグラウンドで起動する（DB・CIバイパス用ユーザーは、この前段の
   シェルスクリプトのステップ（DBマイグレーション・`scripts/ci-seed-user.mjs`・
   `scripts/db:seed:ci`）で既に用意済み）
2. Playwright（`scripts/capture-screenshots.mjs`）で、CIバイパス用Cookie
   （`src/lib/ci-auth-bypass.ts`の`CI_BYPASS_COOKIE_NAME`）をセットしたうえで撮影対象へ
   アクセスし、スクリーンショットを撮影する。
   - **対象パスを明示指定した場合**: そのパスをデスクトップビューポート（1440x900）と
     モバイルデバイスプリセット（`devices['iPhone 13']`）の両方で撮影する（`desktop.png`・
     `mobile.png`の2枚）。
   - **対象パスを省略した場合（フォールバック）**: デスクトップは`/dashboard`1枚
     （`desktop.png`）、モバイルはホーム（`/dashboard`、`mobile-home.png`）・イシュー一覧
     （`/dashboard?mscreen=issues`、`mobile-issues.png`）・イシュー詳細
     （`/dashboard?mscreen=issue-detail&missue=<id>`、`mobile-issue-detail.png`）の計3枚を
     撮影する。スマホUIは別ルートではなく`/dashboard`単体ページ内でURLクエリ
     （`mscreen`/`missue`等、`src/hooks/use-mobile-screen.ts`）によって画面を切り替える
     SPA構成のため、これらは同一ページへの異なるクエリとして表現できる。デスクトップ/
     モバイルの出し分けはTailwindの`md:hidden`等によるCSS制御のため、モバイルデバイス
     プリセットで撮影すれば自動的にモバイルUIが撮れる。イシュー詳細の`missue`はGitHubの
     Issue番号ではなくPrisma `Issue.id`（`cuid()`）が必要なため、`scripts/ci-get-sample-
     issue-id.mjs`でCI用ダミーデータ（`scripts/seed-ci-db.mjs`）のIssue idを取得してから
     撮影する。
   - 撮影対象を`/`ではなく`/dashboard`に固定しているのは、CIバイパスCookie使用時は
     `src/lib/supabase/middleware.ts`の認証チェック自体をスキップするため、`/`が本来の遷移先
     （未ログインなら`/login`、ログイン済みなら`/login`経由で`/dashboard`へリダイレクト）に
     到達せずログイン画面がそのまま表示されてしまうため
3. 開発サーバーを停止し、`scripts/post-issue-screenshot.sh`（#255）で`screenshots`ブランチへ
   コミット・pushする

`scripts/capture-issue-screenshots.sh`は撮影対象パスの有無に応じて上記いずれかの構成で
`scripts/capture-screenshots.mjs`（複数の`名前:パス:device`の組を任意個数受け取る汎用形）を
呼び出し、埋め込み用のraw URLを標準出力に出力する（対象パス明示指定時は2行、省略時は4行）。

呼び出し元のClaude Codeエージェントは、取得したURLを対象パス明示指定時は`![PC画面](...)`・
`![スマホ画面](...)`、省略時は`![PC画面](...)`・`![スマホ:ホーム](...)`・
`![スマホ:イシュー一覧](...)`・`![スマホ:イシュー詳細](...)`というMarkdown画像記法で、PR本文・
PRコメントではなくIssue側の完了報告コメント（`gh issue comment`）に埋め込む（#589。以前はPR本文・
PRコメントに埋め込んでいたが、視覚確認・承認をイシューコメント側で完結させるため変更した）。

develop向けPRのマージ前には、`risk-check`ジョブが`24.screenshot-required`ラベルの有無を見て
常に`00.check-user`を付与するため（「developへのマージ前確認要否をIssueラベルでトグルする」・
「自動マージ可否の判定方法」参照、#567）、撮影したスクリーンショットを人間が確認するまで
developへは自動マージされない。`22.preview-required`は依然、無人実行環境から到達可能な
プレビューURLを提供できないため、`24.screenshot-required`が付いていない場合はPhase5の説明の
とおり`00.check-user`で停止する運用を維持している。

#### CIバイパス用ユーザーとダミーデータの紐付け

`/dashboard`のリポジトリ・Issue一覧は`UserInstallation`（ユーザーとGitHub Appインストールの
紐付け）経由で絞り込まれる（`src/app/dashboard/page.tsx`, `src/lib/issues-for-user.ts`）。
`scripts/ci-seed-user.mjs`（#257）はCIバイパス用ユーザーの作成のみ、`scripts/seed-ci-db.mjs`
（#256）はダミーのリポジトリ・Issueの作成のみを行っており、両者を紐付ける`UserInstallation`が
どちらにも存在しなかった（#258で発覚）。そのため`seed-ci-db.mjs`に、CIバイパス用ユーザーが
存在する場合に限り対応する`UserInstallation`をupsertする処理を追加した。ワークフロー上も
`scripts/ci-seed-user.mjs`を`seed-ci-db.mjs`より先に実行する順序に固定している。

#### DBセットアップ・Playwrightブラウザのインストールを実行する条件

`Setup pnpm`・`Setup Node.js`・依存関係インストール・DBマイグレーション・CIバイパス用ユーザーの
シード・ダミーデータのシード・Playwrightブラウザ（chromium）のインストールは、いずれも上記の
スクリーンショット撮影でのみ使われる。当初はDBセットアップ一式（chromiumのダウンロードを除く）
を`24.screenshot-required`の有無によらず毎回実行していたが、撮影しないissueでは完全に無駄な
処理のため、chromiumダウンロード（数分かかる）と同様にstate stepが出力する
`screenshot_required`が`true`の場合のみ実行するよう変更した（#319）。

## PRコンフリクトの自動解消（#315）

develop向けPRがdevelopとの間でコンフリクトした場合、これまでは人間がIssueに`@claude`コメントで
個別にコンフリクト解消を依頼する必要があった。`.github/workflows/claude-conflict-resolve.yml`が
この依頼を自動化し、コンフリクトを検知したら人間の操作なしにClaude Codeが解消を試みる。

### ジョブ構成

- **detect-conflicts**: `gh pr list --base develop --state open --json number,headRefName,mergeable`で
  develop向けの全OPEN PRを取得し、ブランチ命名規約`issue-<番号>`（`scripts/start-issue.sh`が作成）に
  従い、かつ`mergeable`が`CONFLICTING`（developとコンフリクト中）のものを対応Issue番号の配列として
  検出する。
- **resolve-conflicts**: 検出したIssue番号ごとに`strategy.matrix`で並列実行する。まず対象PRの状態を
  （detect-conflicts実行時点からのタイムラグを考慮して）再確認したうえで、対応ブランチへ
  `git merge origin/develop`でdevelopを取り込み、Claude Codeでコンフリクトを解消してpushする。
  意味的に矛盾する等、安全に自動解消できないと判断した場合は無理に解消せず`00.check-user`を
  付与して人間に判断を委ねる。

### トリガー

- `push`（`develop`）: developへ新たな変更が入るとOPENなPRがコンフリクトしうるため、最も速報性が
  高い経路としてその都度検知する。
- `schedule`（15分おき）: GitHubの`mergeable`判定は非同期に計算されるため、push直後の検知時点では
  まだ計算が終わっておらず`UNKNOWN`のままの場合がある。取りこぼしを拾い直す安全網として、
  `issue-labels.yml`の各scheduleジョブと同じ間隔で走査する。
- `workflow_dispatch`: 手動実行用。

### 既存の実装ワークフローとの競合回避

`claude-issue-dispatch.yml`の`dispatch`ジョブのconcurrencyグループは、`triage`ジョブが`mode`
（`implement`/`additional`→`branch`、`plan`/`split`/`ask`/`skip`→`comment`）から算出する
lane別に`issue-dispatch-<Issue番号>-branch`/`issue-dispatch-<Issue番号>-comment`へ分割されている。
`resolve-conflicts`ジョブは常に`issue-<番号>`ブランチへpushするため、`branch`レーンの
concurrencyグループ（`issue-dispatch-<Issue番号>-branch`）に固定して使う。同じ`issue-<番号>`
ブランチへ、人間からの追加依頼（`@claude`コメント）による実装ステップと本ワークフローの
コンフリクト解消が同時に走ってpushが競合するのを避けるため。

コンフリクト解消のための`git push`は`issue-labels.yml`の`wip-on-push`ジョブ（`issue-*`ブランチへの
push全般をトリガーに無条件で`02.wip`を付与する）を誘発する。`03.d:marge`/`00.check-user`状態の
issueに`02.wip`が混在して残らないよう、`resolve-conflicts`ジョブ自身が解消後に明示的に`02.wip`を
除去する。

### 解消方針

リベースではなく`git merge origin/develop`によるマージを使う（force pushは禁止のため）。
コンフリクトしたファイルは、そのPRが実装した変更の意図とdevelopの最新変更の両方を踏まえて
Claude Codeが読解し、片方を機械的に採用するのではなく両立するように解消する。解消後は
`pnpm test`（lint・typecheck）・`pnpm build:ci`を実行して問題がないことを確認してからコミット・
pushする。`pnpm build:ci`に必要な環境変数は、実装ステップの画面確認用DBセットアップとは異なり
実際のDB接続を必要としないため、`.github/workflows/ci.yml`のbuildステップと同じプレースホルダー値を
Claude Codeステップの`env`にそのまま設定している（MySQLサービスコンテナは使わない）。

## 未解決の課題・申し送り事項

- Claude Code CLIの起動オプション（`--permission-mode`の具体的な値、`--add-dir`等）は実装時に`claude --help`で最新仕様を確認する。特に無人実行（Phase3以降）で全チェックを無効化するようなフラグ（例: `--dangerously-skip-permissions`）を使うのは、意図しない破壊的操作のリスクがあるため避け、ローカル実行は`acceptEdits`（人間が横にいる前提）、GitHub Actions実行は`claude-code-action`側の許可ツールリスト等で制御する方針とする。
- VS Code拡張（Claude Code for VS Code）側に「起動時に初期プロンプトを自動投入する」公式な方法は確認できていない。Phase1では「ターミナルで`claude "プロンプト"`として起動し、その結果としてVS Codeが開く」形（またはVS Codeは別途手動で開く）を落としどころとする想定。
