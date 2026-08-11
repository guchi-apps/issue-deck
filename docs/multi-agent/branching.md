# ブランチ・worktree運用とエージェントの役割

Issueごとにブランチ・worktree・Claude Codeセッションを分離する運用と、各エージェントの責務。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## ブランチ・worktree運用

- ブランチ名はラベルによる接頭辞分けをせず、単純に `issue-<Issue番号>`（例: `issue-123`）とする。
- worktreeは本体リポジトリの外、`~/apps/issue-deck-worktrees/<ブランチ名>/` に作成する。本体 `~/apps/issue-deck` は常にレビュー・統合エージェント用の `develop` 最新チェックアウトとして空けておく。
- worktree作成後に必要な準備:
  - `.env.local` を本体からコピーする（`.gitignore`対象でworktreeに複製されないため。symlinkではなくコピーとし、将来worktreeごとに値を変える余地を残す）
    - コピーは新規作成時の1回だけで、その後は追随しない。そのため**既存worktreeの再開時は、本体の`.env.local`にあってworktree側に無いキーだけを値ごと追記する**（#1099）。既存キーの値は書き換えないので、ローカルで書き換えている場合も壊れない。`PORT`はworktreeごとに採番するため対象外。worktree側でコメントアウトしているキーは「意図的に無効化している」とみなして復活させない。追記したキーは**キー名のみ**を表示する（値はログに出さない）
  - `pnpm install`（pnpmのcontent-addressableストアにより高速）
  - `postinstall` で `prisma generate` が走る
- 開発用MySQL DBはworktree間で共有する（Issueごとに新規DBは作らない）。通常のIssueはスキーマ変更を伴わない前提。マイグレーションを伴うIssueは下記「自動マージ不可カテゴリ」の対象として扱う。
- 開発サーバー（`pnpm dev`）のポートは`start-issue.sh`/`.ps1`が`.env.local`に`PORT=4000 + Issue番号`を自動設定する（例: issue-46 → 4046）。複数Issueのworktreeで同時に`pnpm dev`を起動しても衝突せず、developへマージする前に人間がブラウザ（`http://localhost:<ポート>`）で直接画面を確認できる。実装エージェントは画面に関わる変更のPRで、このURLを「確認方法」に記載する。
- ポート設定に加えて、開発サーバーの起動・停止も自動化されている。`start-issue.sh`は`prepare_issue()`完了後、最終的に`exec claude ...`でClaude CLIへプロセス置き換えするのではなく、新規`scripts/run-issue-session.sh`（Issue番号・devポート・プロンプトファイルパスを引数に取るラッパー）を`exec`する。このラッパーが`pnpm dev`をバックグラウンド起動（ログ・PIDは`$ISSUE_DECK_WORKTREE_BASE/.dev-servers/issue-<n>.{log,pid}`）したうえで、`claude`を（execせず）フォアグラウンドの子プロセスとして実行し、`trap ... EXIT HUP TERM`でclaude終了時に開発サーバーのプロセスグループを停止する。Ctrl+C（`INT`）は意図的にtrapしない（1回の押下は現在の処理の中断であることが多く、devサーバーまで止めると過剰停止になるため）。`kill -9`やWSLごとのクラッシュ等、trapで捕捉できない強制終了時はPIDファイルが残るため、`$ISSUE_DECK_WORKTREE_BASE/.dev-servers/issue-<n>.pid`のPIDを手動で`kill`するのがフォールバック手段になる。
- `start-issue.sh`はWSLのターミナルから直接叩くほか、issue-deckの画面の「ローカルで開始」からワンクリックで起動できる（`issuedeck://`プロトコル → `scripts/start-local-session.sh` 経由。#1049）。詳細は[local-quick-start.md](local-quick-start.md)。
- VSCodeのClaude Codeタブを横に並べて複数Issueを並行で進める場合は、タブ内で`/issue <番号>`（`.claude/commands/issue.md`）を使う。`start-issue.sh --prepare-only`でworktreeだけを用意し、そのセッションがそのまま実装に入る（#1049）。**本体チェックアウトは全タブで共有されるため、そこでのブランチ切り替えは他タブのセッションを巻き込む。**
- `start-issue.sh`はworktree準備時に`scripts/setup-lan-access.sh`を呼び、Windows側のポートフォワーディング（`netsh interface portproxy`）とファイアウォール許可を自動設定したうえで、`http://<WSL IP>.sslip.io:<ポート>`をあわせて提示する（同一LAN上のスマホ等、`localhost`が使えない別端末からの確認用。詳細はsslip-io-lan-devスキル参照）。WSLのIPはWSL再起動のたびに変わるため、`scripts/dev.sh`経由の通常起動時も含め、devサーバー起動のたびに再設定する。Windowsの管理者権限が必要なためUACダイアログが表示される。`next.config.ts`の`allowedDevOrigins`は個別IPではなく`*.sslip.io`（ワイルドカード）を許可しており、WSLのIPが変わってもコード変更不要。

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
- 全アプリ共通の共有知識（`.shared-context/`）を必要な範囲で参照する
- 実装中に得た知見を、アプリ固有なら`docs/`へ同梱し、全アプリ共通と判断したものは対応Issueへ「追加提案」コメントとして投稿する（共有知識リポジトリ自体は編集しない。[docs/shared-knowledge.md](../shared-knowledge.md)参照）

禁止事項:
- `main`/`develop`への直接コミット・push
- 他Issueのブランチ・worktreeの編集
- 不要なforce push
- 自分が作成したPull Requestの自己マージ
- 共有知識リポジトリ（`.shared-context/`・ローカルの`~/apps/_docs`）の編集・コミット

### レビュー・統合エージェント

レビュー・統合専用のClaude Codeセッションを別に用意する。

責務:
- `gh pr list --base develop` で未処理PRの一覧を確認する（複数ある場合は1件ずつ処理し、develop最新との競合・CI結果・他PRとの依存関係を都度確認する）
- 対応Issueの要件充足、Issue外変更の混入有無、コード品質・セキュリティ、CI結果を確認する
- 「自動マージ不可カテゴリ」に該当する変更を検知したら`00.check-user`を付与し、マージせずユーザーの確認を待つ
- 問題がなければ`develop`へマージし、マージ後`develop`上で再テストする。あわせて対応Issueのラベルを`03.d:marge`→`05.develop`に付け替える（issueはcloseしない）
- 実装エージェントが投稿した共有知識への追加提案を、再利用性・正確性・重複・恒久性の4観点で審査し、承認/却下のマーカー付きコメントを投稿する（[docs/shared-knowledge.md](../shared-knowledge.md)参照）

禁止事項:
- `main`への直接マージ・push
- 共有知識リポジトリの編集・コミット（反映は`shared-knowledge-propose.yml`がPRを作成し、人間がマージする）

## 全アプリ共通の共有知識層（shared context）

GitHub Actions上の実行はチェックアウトしたワークツリーしか参照できないため、個人環境の
グローバル`CLAUDE.md`・スキルは読み込まれない。その結果、全アプリ共通のルール（Git/GitHub運用、
Actions上でClaude Codeを動かす際の知見、共通コーディング方針、デプロイ方針など）を各リポジトリの
`CLAUDE.md`とワークフローのプロンプトへ手で複製することになり、複製先が静かにずれていく。

これを解消するため、共通知識は共有知識リポジトリ`guchi-apps/docs`で一元管理し、各ワークフローが
実行時に`.shared-context/`へcheckoutして読む構成にしている。あわせて、実装中に得た知見を
「アプリ固有＝対象リポジトリの`docs/`」「全アプリ共通＝提案 → レビュー審査 → 反映PR → 人間の
マージ」に振り分ける循環を用意し、セッションではなくGit管理されたドキュメントとして知見を
引き継げるようにしている。

設計の全体像・提案フォーマット・審査の4観点・共有知識リポジトリ側に必要なファイルは
[docs/shared-knowledge.md](../shared-knowledge.md)を参照。他リポジトリへ導入する際の手順は
[docs/cross-repo-setup-guide.md](../cross-repo-setup-guide.md)の「10. 共有知識リポジトリの参照設定」を参照。

## ローカル自動化とGitHub Actionsの役割分担

| フェーズ | 実行場所 | 認証 | 想定用途 |
|---|---|---|---|
| ローカル起動（実装・レビュー） | ローカル(WSL)・人間が起動 | ユーザー自身の`gh auth` | 手動起動だが手順を自動化。人間が横で見ている前提 |
| GitHub Actions | GitHub Actions | `CLAUDE_CODE_OAUTH_TOKEN`（専用） | 無人実行。人間不在でも安全に倒せる設計が必須 |

ローカル実行はユーザー自身のGitHub認証で動くため、「developへの直接push禁止」はGitHubのbranch protectionでは技術的に強制できない（bypassしても同じアカウントになるため）。この段階ではCLAUDE.md・プロンプト内の運用ルールとして守らせる。GitHub Actionsでは専用トークンという別IDが使えるため、branch protectionのbypass listを人間アカウントのみにする設計が意味を持つ。

### ローカル実行と無人実行の二重起動を防ぐ（`11.local`）

同じIssueをローカルセッションと`claude-issue-dispatch.yml`（無人実行）が同時に進めてしまう事故が起きうる（#905）。原因は、無人実行が「計画が承認された」と判断するシグナルが`00.check-user`ラベルの除去である一方、ローカルセッションも承認を受けてラベルを次段階へ進める際に同じ操作を行うため、両者をイベントから区別できないことにある。#905では、ローカル側がPRを作成している裏で無人実行が計画フェーズを最初からやり直し、`21.plan-required`・`00.check-user`・`01.planning`・`03.d:marge`が同時に付いた矛盾状態になった。

これを二段構えで防ぐ（#919）。

1. **`issues/unlabeled`経路のガード**: `00.check-user`の除去イベントを受けた時点で`02.wip`または`03.d:marge`が付いている場合、そのIssueは別経路で着手済み・PR作成済みなので`mode=skip`とする。
   `01.planning`はこの判定に含めない。無人実行の計画提示ステップが付けた`01.planning`は実装着手時まで外れず、正規の承認時点の状態が「`01.planning` + `00.check-user` + `21.plan-required`」になるため、含めると本来の承認経路が動かなくなる。
2. **`11.local`ラベル**: 付いている間は、トリガー経路によらず`mode=skip`とする（読み取り専用の`mode=ask`だけは例外として通す）。1のガードはラベルを付け替える順序によってはすり抜ける（ローカル側が`02.wip`を付ける前に`00.check-user`を外した場合など）ため、人間が明示的に立てられる停止フラグを併せて用意する。
   `@claude`コメント経由でスキップした場合は、無言で終わらせず「`11.local`が付いているため無人実行では対応しない」旨をIssueへ返信する。
   順番待ちの間に`11.local`が付いた場合も、`dispatch`ジョブ冒頭の陳腐化チェックで検知して中止する。

`11.local`は`0x.`始まりではないため、issue-deck画面上は進捗ステップ（`WorkflowStepBadge`）ではなく通常のラベルとして表示・編集できる（`src/lib/issue-status.ts`の`isProgressLabel`）。あわせて番号帯が重ならないよう、優先度ラベルを`80.Priority: High`・`89.Priority: low`へリネームした。

## ブランチ保護ルール案

- **`main`**: 組織標準（`_docs/guides/github-repo-setup.md` §5）どおり設定する。Require pull request before merging、Required status checks=`lint-and-build`（`.github/workflows/ci.yml`のジョブ名）、Restrict updates、bypass=自分のアカウント（For pull requests only）。**現状（2026年時点）未設定のため要設定。** 実際の設定はGitHub Web UIで行う（workflowでは自動化しない）。
- **`develop`**: Phase4で`required_status_checks`（`lint-and-build`）のみを設定した（`gh api PUT repos/{owner}/{repo}/branches/develop/protection`、`required_pull_request_reviews`・`restrictions`は`null`のまま）。これは`gh pr merge --auto`がCIの完了を待たずに即マージしてしまうのを防ぐための最小構成で、直接pushやApprove必須化は行っていない。「Require pull request before merging」＋bypass=人間アカウントのみへの本格的な制限は、影響範囲が大きく本Issueの完了条件にも必須ではないため見送った。GitHub Actions専用トークン（`github.token`、Phase3/4で導入済み）を使えば技術的には設定可能なので、必要になった時点で改めて検討する。
