# PRコンフリクト・CI失敗の自動解消

develop向けPRがコンフリクトした場合、およびCIが失敗した場合の自動修復。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## PRコンフリクトの自動解消（#315）

develop向けPRがdevelopとの間でコンフリクトした場合、これまでは人間がIssueに`@claude`コメントで
個別にコンフリクト解消を依頼する必要があった。`.github/workflows/claude-conflict-resolve.yml`が
この依頼を自動化し、コンフリクトを検知したら人間の操作なしにClaude Codeが解消を試みる。

### ジョブ構成

- **detect-conflicts**: developとコンフリクトしている（`mergeable`が`CONFLICTING`）PRを対応
  Issue番号の配列として検出する。トリガーが`pull_request`の場合は`gh pr view`でトリガー元のPR
  1件のみを対象にし、それ以外（`push`/`schedule`/`workflow_dispatch`）は
  `gh pr list --base develop --state open --json number,headRefName,mergeable`でdevelop向けの
  全OPEN PRを取得し、ブランチ命名規約`issue-<番号>`（`scripts/start-issue.sh`が作成）に従うものを
  対象にする（#814）。
- **resolve-conflicts**: 検出したIssue番号ごとに`strategy.matrix`で並列実行する。まず対象PRの状態を
  （detect-conflicts実行時点からのタイムラグを考慮して）再確認したうえで、対応ブランチへ
  `git merge origin/develop`でdevelopを取り込み、Claude Codeでコンフリクトを解消してpushする。
  意味的に矛盾する等、安全に自動解消できないと判断した場合は無理に解消せず`00.check-user`を
  付与して人間に判断を委ねる。

### トリガー

- `push`（`develop`）: developへ新たな変更が入るとOPENなPRがコンフリクトしうるため、最も速報性が
  高い経路としてその都度検知する。
- `pull_request`（`develop`向け、`opened`/`reopened`）: develop向けPRが作成された直後、既に
  developとコンフリクトした状態で生まれるケース（issue #715）を即座に拾うため。`synchronize`
  （PRへの追加push毎）は含めない。実装エージェントが1つのIssueに対して何度も細かくpushする間、
  毎回`detect-conflicts`から`resolve-conflicts`のmatrixジョブが走ると、`resolve-conflicts`が
  使う同じ`issue-dispatch-<番号>-branch`concurrencyグループ内で実装ステップ自体と噛み合い
  キューが詰まる懸念があるため。developが動いてPRがコンフリクトに変化するケースは既存の
  `push`（`develop`）トリガーでカバーされる。このトリガーはトリガー元のPR自身が既に
  コンフリクトしていないかだけを見ればよく、develop向けの他PRの状態まで見る必要はない。
  1回のワークフロー実行内のmatrix全ジョブのチェックはトリガーしたPRのチェック一覧に紐付いて
  表示されるため、以前は全件スキャンしていたことで、たまたま同じタイミングでコンフリクト
  していた無関係な他PRのチェックまで表示されてしまう不具合があった（#814で修正）。
- `schedule`（15分おき）: GitHubの`mergeable`判定は非同期に計算されるため、push・pull_request
  直後の検知時点ではまだ計算が終わっておらず`UNKNOWN`のままの場合がある。`detect-conflicts`の
  ポーリング（下記）でも解消しきれなかった取りこぼしを拾い直す安全網として、`issue-labels.yml`の
  各scheduleジョブと同じ間隔で走査する。
- `workflow_dispatch`: 手動実行用。

`detect-conflicts`は、対象PR（群）のうち`issue-<番号>`命名規約に従うものの中に`mergeable`が
`UNKNOWN`（判定計算未完了）のものが残っている間、10秒間隔・最大6回（計1分程度）ポーリングして
再取得する。`pull_request`イベント発火の瞬間は`mergeable`の計算がまだ終わっていないことが多く、
「計算未完了イコールコンフリクトなし」と誤判定してPRのコンフリクトを取りこぼすのを防ぐため。
このポーリングは`push`・`schedule`トリガーの既存挙動にも同様に効く。

develop向けPRは`claude[bot]`（Claude Code GitHub App）が作成するため、`pull_request`トリガーでの
`resolve-conflicts`ジョブの`claude-code-action`ステップはactorが`claude[bot]`になる。
`claude-code-action`は既定でbot起点の実行を拒否するため、`allowed_bots: "claude[bot]"`を指定して
明示的に許可している（`claude-review-develop.yml`等と同じ対処。#814）。

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

## CI失敗の自動解消（#807）

develop向けPR（`issue-<番号>`ブランチ）の`.github/workflows/ci.yml`（CI）が失敗した場合、これまでは
人間がIssueに`@claude`コメントで個別に修正を依頼する必要があった。`.github/workflows/claude-ci-fix.yml`が
この依頼を自動化し、CI失敗を検知したら人間の操作なしにClaude Codeが修正を試みる。上記「PR
コンフリクトの自動解消（#315）」と同じ設計思想で、`.github/workflows/claude-conflict-resolve.yml`と
対になるワークフローとして実装している。

develop→mainのリリースPR（head=`develop`）のCI失敗は対象外（#812で別途検討）。リリースPRのheadは
`develop`自体であり、`develop`への直接pushが禁止のためこのワークフローと同じ「対象ブランチへ
直接push」方式を適用できないこと、対応する単一のIssueが存在せずリトライ管理・報告先の前提が
コンフリクト解消・CI失敗解消のいずれとも異なることが理由。

### ジョブ構成

- **detect**: `workflow_run`イベントのペイロードから、develop向けかつ`issue-<番号>`命名規約に
  従うブランチのPRの失敗のみを対象Issue番号として抽出する。`workflow_dispatch`で手動実行する
  場合は入力されたIssue番号をそのまま使う。
- **fix**: 対象PRの状態（Issueのクローズ有無、現在のHEADに対するCIの実行結果）を再確認したうえで、
  対応ブランチをcheckoutし、`gh run view <run_id> --log-failed`で取得した失敗ログをもとに
  Claude Codeが原因を読解して修正し、`pnpm test`・`pnpm build:ci`で確認してからpushする。
  安全に自動修正できないと判断した場合は無理をせず`00.check-user`を付与して人間に判断を委ねる。

### トリガー

- `workflow_run`（`workflows: ["CI"]`, `types: [completed]`）: CIの結果が出るたびに検知する。
  `ci.yml`は`concurrency.cancel-in-progress: true`のため、追加pushで前の実行が`cancelled`に
  なった場合は`conclusion != 'failure'`となり誤反応しない。`conclusion == 'failure'`かつ
  `event == 'pull_request'`かつ対象PRの`base.ref == 'develop'`かつ`head.ref`が`issue-<番号>`
  規約に従うもののみを対象にする。
- `workflow_dispatch`: 手動実行用。対象のIssue番号を入力する。

### 既存の実装ワークフローとの競合回避

`resolve-conflicts`ジョブと同様、`fix`ジョブは`claude-issue-dispatch.yml`の`dispatch`ジョブの
`branch`レーンと同じconcurrencyグループ（`issue-dispatch-<Issue番号>-branch`）で直列化する。
同じ`issue-<番号>`ブランチへ、人間からの追加依頼（`@claude`コメント）による実装ステップや
コンフリクト自動解消のpushと競合しないようにするため。push後は`issue-labels.yml`の
`wip-on-push`ジョブが付与する`02.wip`を明示的に除去する。

### リトライ上限

同一原因の修正を繰り返し試みても直らない無限ループを避けるため、対象Issueに
`<!-- issue-deck-source:claude-ci-fix -->`マーカー付きの「着手コメント」が既に2回投稿されている
場合は、3回目以降の自動修正は行わず`00.check-user`を付与して人間に委ねる。

### 修正方針

ログから読み取った原因をもとにコードを修正し、`pnpm test`（lint・typecheck・unit test）・
`pnpm build:ci`で確認してからコミット・pushする（環境変数は`claude-conflict-resolve.yml`と
同じプレースホルダー値を使う）。表面的にCIを通すためだけの修正（lintエラーの握りつぶし、
失敗しているテストの無効化・削除等）は明示的に禁止しており、テスト失敗がロジックの不具合を
示している場合はロジック側を直すようプロンプトで指示している。
