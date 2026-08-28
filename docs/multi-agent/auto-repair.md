# PRコンフリクト・CI失敗・本番デプロイ失敗の自動解消

develop向けPRがコンフリクトした場合、CIが失敗した場合、および本番デプロイが失敗した場合の
自動修復。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## 全体像

| 対象PR | CI失敗 | コンフリクト | 起動 |
| --- | --- | --- | --- |
| `issue-<番号>` → develop | `claude-ci-fix.yml`（#807） | `claude-conflict-resolve.yml`（#315） | 自動検知 + 画面のボタン |
| `release/vX.Y.Z` → develop（バンプPR） | `claude-pr-repair.yml`（#1293） | 同左 | 画面のボタンのみ |
| develop → main（リリースPR） | `claude-pr-repair.yml`（#1293） | 同左 | 画面のボタンのみ |

mainへ入った**後**の本番デプロイ（`deploy.yml`）の失敗だけは、上の3つとは別建てになっている
（`deploy-retry.yml`。#2134）。**PRではなくワークフローの実行が対象で、直すのではなく流し直す**
——詳細は後述の
「[本番デプロイの一時的な失敗の再実行（#2134）](#本番デプロイの一時的な失敗の再実行2134)」。
その1回で直らなかった失敗は、issue-deckが巡回して追跡用のIssueにする（#2236。後述の
「[直らなかったデプロイ失敗を、Issueにして残す（#2236）](#直らなかったデプロイ失敗をissueにして残す2236)」）。

分かれ目は**対応する単一のIssueがあるかどうか**。ある場合は報告先・リトライ管理をIssueに置ける
ので既存2ワークフローが受け持ち、無い場合は報告先を対象PR自身のコメントに置く
`claude-pr-repair.yml`が受け持つ。

`issue-<番号>` → developのコンフリクトについては、上の「自動検知」（GitHub Actionsのトリガー）に
加えて**issue-deckからの巡回検知**（#2116）がある。GitHubのイベント配送・スケジューラが
取りこぼしたコンフリクトを拾うための経路で、詳細は後述の
「[issue-deckからの巡回検知（#2116）](#issue-deckからの巡回検知2116)」。

## PRコンフリクトの自動解消（#315）

develop向けPRがdevelopとの間でコンフリクトした場合、これまでは人間がIssueに`@claude`コメントで
個別にコンフリクト解消を依頼する必要があった。`.github/workflows/claude-conflict-resolve.yml`が
この依頼を自動化し、コンフリクトを検知したら人間の操作なしにClaude Codeが解消を試みる。

このワークフローも`claude-ci-fix.yml`と同様に**トリガー定義のみ**を持ち、ジョブ本体は
`.github/workflows/reusable-claude-conflict-resolve.yml`（`on: workflow_call`）へ切り出してある
（#1066）。入力の意味・プロンプトの置き場所（`.github/prompts/conflict-resolve.md`）・
カナリア構成の考え方は後述「CI失敗の自動解消（#807）」と共通なので、そちらを参照。

`resolve-conflicts`ジョブは`strategy.matrix`で検出したIssueごとに並列実行するが、matrixは
再利用ワークフロー側に閉じている（呼び出し元でmatrixを組む形にはしていない）。呼び出し元は
`uses:`ひとつだけを持つ。

### ジョブ構成

- **detect-conflicts**: developとコンフリクトしている（`mergeable`が`CONFLICTING`）PRを対応
  Issue番号の配列として検出する。トリガーが`pull_request`の場合は`gh pr view`でトリガー元のPR
  1件のみを対象にし、それ以外（`workflow_run`/`schedule`/`workflow_dispatch`）は
  `gh pr list --base develop --state open --json number,headRefName,mergeable`でdevelop向けの
  全OPEN PRを取得し、ブランチ命名規約`issue-<番号>`（`scripts/start-issue.sh`が作成）に従うものを
  対象にする（#814）。
- **resolve-conflicts**: 検出したIssue番号ごとに`strategy.matrix`で並列実行する。まず対象PRの状態を
  （detect-conflicts実行時点からのタイムラグを考慮して）再確認したうえで、対応ブランチへ
  `git merge origin/develop`でdevelopを取り込み、Claude Codeでコンフリクトを解消してpushする。
  意味的に矛盾する等、安全に自動解消できないと判断した場合は無理に解消せず`00.check-user`を
  付与して人間に判断を委ねる。

### トリガー

- `workflow_run`（`CI` / `requested` / `develop`）: developへ新たな変更が入るとOPENなPRが
  コンフリクトしうるため、最も速報性が高い経路としてその都度検知する。本来は`push`（`develop`）で
  直接受けたいところだが、`claude-code-action`が`push`イベントに対応していない（後述）ため、
  `push`（`develop`）で走る`ci.yml`の実行がキューされた時点（`requested`）を代理のpush通知として
  使う（#1330）。`completed`ではなく`requested`にするのは、CIの完走を待つ分だけ検知が遅れるのを
  避けるためで、コンフリクト検知自体はCIの成否と無関係なので待つ必要がない。`branches: develop`は
  トリガー元のワークフロー実行の`head_branch`に対する条件なので、develop向けPRの`pull_request`で
  走るCI（`head_branch`は`issue-<番号>`）はここには入らない。
- `pull_request`（`develop`向け、`opened`/`reopened`）: develop向けPRが作成された直後、既に
  developとコンフリクトした状態で生まれるケース（issue #715）を即座に拾うため。`synchronize`
  （PRへの追加push毎）は含めない。実装エージェントが1つのIssueに対して何度も細かくpushする間、
  毎回`detect-conflicts`から`resolve-conflicts`のmatrixジョブが走ると、`resolve-conflicts`が
  使う同じ`issue-dispatch-<番号>-branch`concurrencyグループ内で実装ステップ自体と噛み合い
  キューが詰まる懸念があるため。developが動いてPRがコンフリクトに変化するケースは既存の
  `workflow_run`（`develop`）トリガーでカバーされる。このトリガーはトリガー元のPR自身が既に
  コンフリクトしていないかだけを見ればよく、develop向けの他PRの状態まで見る必要はない。
  1回のワークフロー実行内のmatrix全ジョブのチェックはトリガーしたPRのチェック一覧に紐付いて
  表示されるため、以前は全件スキャンしていたことで、たまたま同じタイミングでコンフリクト
  していた無関係な他PRのチェックまで表示されてしまう不具合があった（#814で修正）。
- `schedule`（15分おき）: GitHubの`mergeable`判定は非同期に計算されるため、workflow_run・pull_request
  直後の検知時点ではまだ計算が終わっておらず`UNKNOWN`のままの場合がある。`detect-conflicts`の
  ポーリング（下記）でも解消しきれなかった取りこぼしを拾い直す安全網として、`issue-labels.yml`の
  各scheduleジョブと同じ間隔で走査する。
- `workflow_dispatch`: 手動実行用。`issue_number`を指定するとそのIssueのdevelop向けPR1件だけを
  対象にし、未指定なら従来どおり全件走査する（#1293）。issue-deckの画面の
  「コンフリクトを自動解消」ボタンはこの入力付きで起動するため、押した対象と無関係なPRまで
  巻き込まない。

`detect-conflicts`は、対象PR（群）のうち`issue-<番号>`命名規約に従うものの中に`mergeable`が
`UNKNOWN`（判定計算未完了）のものが残っている間、10秒間隔・最大6回（計1分程度）ポーリングして
再取得する。`pull_request`イベント発火の瞬間は`mergeable`の計算がまだ終わっていないことが多く、
「計算未完了イコールコンフリクトなし」と誤判定してPRのコンフリクトを取りこぼすのを防ぐため。
このポーリングは`workflow_run`・`schedule`トリガーの既存挙動にも同様に効く。

### issue-deckからの巡回検知（#2116）

上の4つに加えて、**GitHubのイベント配送とスケジューラに依存しない5本目の検知経路**を
issue-deck側に置いている。サブPCのpollerが1巡ごとに
`POST /api/pull-requests/conflict-sweep`を叩き、issue-deckが連携済みリポジトリ全部の
develop向け`issue-<番号>`PRを見て、コンフリクトしていれば
`claude-conflict-resolve.yml`を`workflow_dispatch`する。判定は
[`lib/github/conflict-sweep.ts`](../../src/lib/github/conflict-sweep.ts)、IOは
[`lib/github/conflict-sweep-run.ts`](../../src/lib/github/conflict-sweep-run.ts)。

**なぜ要るのか。** 「PRを作った時点で既にコンフリクトしている」場合に働くのは
`pull_request(opened)`と`schedule`の2つだけで（developが動いていないので`workflow_run`は
発火しない）、そのどちらもGitHub側の都合で落ちることが実際にあった。

- `pull_request(opened)`は**イベントそのものが配送されないことがある。**
  guchi-apps/myroom#191（2026-08-22 11:12:29 UTC作成）に対しては`pull_request`起因のrunが
  1本も作られていない（`CI`・`Issue Progress`・`Claude Conflict Resolve`のいずれも。
  2分前に作られた別PRでは3本とも走っている）
- `schedule`は**15分おきと書いても15分おきには走らない。** 同日のmyroomの実測は
  08:59・09:35・09:59・10:33・10:59で、24〜36分間隔だった

結果としてmyroom#191は誰にも拾われず、人が画面のボタンを押すまでコンフリクトしたまま残った。

**既存の4経路はそのまま残す。** 先に気づいた方が起動し、どちらから起動しても
`resolve-conflicts`が着手前に対象PRの状態を再確認するため、二重に直しにいくことはない。

巡回の作りで押さえておく点。

- **間隔を決めるのはissue-deck側**（`CONFLICT_SWEEP_INTERVAL_MINUTES`・既定5分・0で無効）。
  pollerは毎巡呼ぶだけで、間隔に達していなければ`swept: false`が返る。呼ぶ側が増えても
  GitHub APIの消費が増えないようにするため
- **同じPRへ続けて起動しない**（`CONFLICT_SWEEP_RETRY_COOLDOWN_MINUTES`・30分）。
  コンフリクト解消のワークフローは`claude-ci-fix.yml`のような試行回数の上限を持たないため、
  上限の代わりに間隔で抑える。値は従来の`schedule`の実測間隔に合わせてあり、これまでより
  頻繁に再試行することはない
- **対応Issueに`00.check-user`が付いていれば起動しない。** 自動解消を断念したワークフローが
  付けるラベルなので、そのまま「人が見ると決めたもの」の目印として使う
- **対象は`issue-<番号>`→developのPRだけ。** Issueに紐づかないPRを受け持つ
  `claude-pr-repair.yml`は意図的に自動検知の経路を持たない（後述）ので、巡回でも起動しない
- **GitHub APIの消費は小さい。** PR一覧のRESTはETagの条件付きGETが効き、変化が無ければ
  レート制限を消費しない。コンフリクト有無のGraphQLは`issue-<番号>`→developのPRが
  1件でもあるときだけ、installationごとに1回投げる
- **起動そのものに失敗したPRも、同じ待ち時間だけ投げ直さない**（記録はプロセス内。DBへ書くと
  画面に「自動解消中」のバッジが出てしまうが、実際には起動できていない）。
  `workflow_dispatch`に`issue_number`入力を持たない世代のcallerを置いたままのリポジトリへは
  常に422が返るため、覚えないと巡回のたびに投げ続けることになる（2026-08-22時点で
  guchi-apps/shopping-list・guchi-apps/dayspanがこの状態。画面の「コンフリクトを自動解消」
  ボタンも同じ理由で効かない。**`on:`はcallerが持つコピーなのでタグの更新では直らず**、
  各リポジトリで直す必要がある）

develop向けPRは`claude[bot]`（Claude Code GitHub App）が作成するため、`pull_request`トリガーでの
`resolve-conflicts`ジョブの`claude-code-action`ステップはactorが`claude[bot]`になる。
`claude-code-action`は既定でbot起点の実行を拒否するため、`allowed_bots`で明示的に許可している
（`claude-review-develop.yml`等と同じ対処。#814）。指定するのは`issue-deck[bot],claude[bot]`の
2つで、後述の「画面のボタンからの起動」を通すために`issue-deck[bot]`が要る（#1328）。

### `claude-code-action`が対応しているトリガーイベント

`claude-code-action`の`claude-code-action`ステップは、実行時に`GITHUB_EVENT_NAME`を見て以下の
10種類**以外**なら`Unsupported event type: <イベント名>`を投げて即失敗する（`src/github/context.ts`の
`parseGitHubContext`）。**ワークフローのトリガーにこれ以外のイベントを書いてはいけない。**

`issues` / `issue_comment` / `pull_request` / `pull_request_target` / `pull_request_review` /
`pull_request_review_comment` / `workflow_dispatch` / `repository_dispatch` / `schedule` /
`workflow_run`

`push`はこの一覧に含まれない。`v1.0.100`〜`v1.0.192`および`main`のいずれの時点でも含まれていない
ため、「以前は動いていたが対応をやめた」のではなく最初から非対応であり、`@v1`を古いタグへ固定しても
直らない（#1330）。この制約は`push`をトリガーにしたい全ワークフロー共通で、回避には
**そのpushで走る別ワークフローの`workflow_run`を代理通知として購読する**方法を使う
（前述のコンフリクト自動解消の`CI` / `requested`はこの形）。

`workflow_run`は**デフォルトブランチ上のワークフローファイル**でのみ発火する点に注意する。
このリポジトリのデフォルトブランチは`develop`なので、`workflow_run`トリガーの追加・変更はdevelopへ
マージした時点で有効になる（言い換えると、PR上では発火しないため実地の確認はマージ後にしかできない）。
他リポジトリへ展開する場合も、そのリポジトリのデフォルトブランチが`develop`であることを先に確認する
（`main`がデフォルトなら、mainへ反映されるまで有効にならない）。

**このトリガーの修正は他リポジトリへ自動では波及しない。** 参照方式（`reusable-*.yml`を`uses:`で
呼ぶ薄いcaller）に移行済みでも、`on:`はcallerが自分で持つコピーであり`@<タグ>`のバージョン記録の
対象外のため、issue-deck側を直しても各リポジトリのcallerには`push`が残る（#1366で
guchi-apps/dayspan・guchi-apps/shopping-listが実際にこの状態だった）。全callerを横断して確認する
手順は[docs/supported-repositories.md](../supported-repositories.md)「タグが記録しないもの」を参照。

### 既存の実装ワークフローとの競合回避

`claude-issue-dispatch.yml`の`dispatch`ジョブのconcurrencyグループは、`triage`ジョブが`mode`
（`implement`/`additional`→`branch`、`plan`/`split`/`ask`/`skip`→`comment`）から算出する
lane別に`issue-dispatch-<Issue番号>-branch`/`issue-dispatch-<Issue番号>-comment`へ分割されている。
`resolve-conflicts`ジョブは常に`issue-<番号>`ブランチへpushするため、`branch`レーンの
concurrencyグループ（`issue-dispatch-<Issue番号>-branch`）に固定して使う。同じ`issue-<番号>`
ブランチへ、人間からの追加依頼（`@claude`コメント）による実装ステップと本ワークフローの
コンフリクト解消が同時に走ってpushが競合するのを避けるため。

コンフリクト解消のための`git push`は`issue-labels.yml`の`wip-on-push`ジョブ（`issue-*`ブランチへの
push全般をトリガーに無条件で`Implementation`を報告する）を誘発する。`Develop PR`にいるissueの進捗が
盤面上だけ実装中へ巻き戻らないよう、`resolve-conflicts`ジョブ自身が解消後に明示的に`Develop PR`を
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

このワークフローは**トリガー定義のみ**を持ち、ジョブ本体（`detect`／`fix`）は
`.github/workflows/reusable-claude-ci-fix.yml`（`on: workflow_call`）へ切り出してある（#1066）。
他リポジトリへ展開する際は、ワークフローをコピーせず**issue-deck側のこの実体をタグ固定で参照する
薄いcallerを置く**（[docs/cross-repo-setup-guide.md](../cross-repo-setup-guide.md)「再利用可能
ワークフローの参照」を参照）。issue-deck自身はローカルパス参照で常に最新の内容で動くため、
変更が最初に自分へ跳ね返るカナリアとして機能する。

リポジトリ差は`with:`の入力で吸収する。`runtime-setup`・`package-manager`・`node-version`が
ランタイム準備を、`build-env`がビルド検証用のダミー環境変数を、`verify-commands`が修正後の
検証手順の説明を、`prompts-ref`がプロンプト（`.github/prompts/ci-fix.md`）の取得元を決める。
Claude Codeへ渡すプロンプト本文は`.github/prompts/ci-fix.md`にあり、ワークフロー側で
`envsubst`により動的な値を埋めてから`$GITHUB_ENV`経由で渡す（`${{ }}`を含む文字列ブロックに
かかる21,000バイト上限を構造的に回避するため。#901で無人実行が半日停止した経路）。

develop→mainのリリースPR（head=`develop`）のCI失敗はこのワークフローの対象外。リリースPRのheadは
`develop`自体であり、`develop`への直接pushが禁止のためこのワークフローと同じ「対象ブランチへ
直接push」方式を適用できないこと、対応する単一のIssueが存在せずリトライ管理・報告先の前提が
コンフリクト解消・CI失敗解消のいずれとも異なることが理由。**この穴は後述の
「Issueに紐づかないPRの自動修復（#1293）」が埋めている**（#812が「別途検討」としていた部分）。

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
`wip-on-push`ジョブが報告する`Implementation`を打ち消して`Develop PR`を再報告する。

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

## Issueに紐づかないPRの自動修復（#1293）

バージョンバンプPR（`release/vX.Y.Z` → develop）とdevelop→mainのリリースPRは、上記2つの
ワークフローの対象外だった。どちらも対応する単一のIssueが無く、報告先・リトライ管理の前提が
合わないためである。`.github/workflows/claude-pr-repair.yml`（本体は
`reusable-claude-pr-repair.yml`）がこの2種類を受け持ち、**報告先を対象PR自身のコメント**に
置くことで差を埋める。プロンプトは`.github/prompts/pr-repair.md`。

### headへ直接pushできるかで2通りに分かれる

- **head が `develop` / `main`**（develop→mainのリリースPR）: 保護ブランチのため直接pushできない。
  headから`pr-repair/<PR番号>-<run_id>`ブランチを切ってそこで修復し、**head向けの新しい
  Pull Requestを作る**。リリースPRの場合、修復内容はまずdevelopへ入り、そのPRがマージされて
  初めて元のリリースPRへ反映される。**その新しいPRのマージは人が行う**（リリース進行中の
  developへ無人でマージを重ねないため）。修復を断念してPRが作られなかった場合、行き場の無い
  `pr-repair/*`ブランチが残らないよう、ジョブの最後にPRの無いブランチを削除する。
- **head がそれ以外**（バンプPR等）: 既存2ワークフローと同じくheadブランチへ直接pushする。

### 自動検知のトリガーを持たない

`workflow_dispatch`のみで、CI失敗・コンフリクトを検知して自動で走る経路は持たない。検知経路は
既存2ワークフローが持っており、そちらと二重に走らせないため。起動元はissue-deckの画面のボタン
（`POST /api/pull-requests/repair`）に限られる。**毎回人が押す前提のため、`claude-ci-fix.yml`が
持つようなリトライ上限は置いていない**（無限ループが構造上起きない）。

CI失敗の判定では、ワークフロー名を`CI`に決め打ちせず「このPRのheadコミットに対して
`pull_request`イベントで走ったrun」を全て見て、失敗しているものの`--log-failed`を最大3件まで
連結して渡す。CIのワークフロー名はリポジトリごとに異なりうるため（#1047の経路）。

## 画面のボタンからの起動（#1293）

自動検知は「詰まったことに気づいて走る」経路だが、検知の取りこぼし・断念後の再試行・そもそも
自動検知を持たないPR（上記）には起点が無かった。issue-deckの画面から任意のタイミングで
起動できるようにしたのがこの導線。

- **設置場所**: マージ待ちPR一覧のカード、PR詳細ペインのヘッダー、スマホのリリースシートの
  進捗の各段。**どこでもCI失敗時・コンフリクト時の両方を出す**（#1742）。一覧は当初`mergeable`を
  持たずCI失敗のボタンだけだったが、コンフリクト有無をCI状態と同じ1回のGraphQLで取れるように
  したため（`fetchPullRequestCiState`。[../code-map.md](../code-map.md)）、GitHub APIの消費を
  増やさずに揃えられた。コンフリクト中は同じ場所の「マージする」を出さない（押しても
  GitHubが受け付けないため）。
- **起動先の判定はサーバー側**（`src/lib/github/pull-request-repair.ts`の
  `resolveRepairDispatch`）。クライアントが持つbase/headを信用すると「Issue用のワークフローへ
  無関係なIssue番号を渡す」呼び方が成立してしまうため、APIでPRを取り直して判定する。
- **`workflow_dispatch`の受け口はデフォルトブランチのワークフロー定義から解決される。**
  issue-deckのデフォルトブランチは`develop`のため、新しいワークフローはdevelopへマージされる
  まで404になり、ボタンを押しても起動しない。
- **起動先のワークフローには`allowed_bots`に`issue-deck[bot]`が要る（#1328）。** この導線は
  GitHub Appのインストールトークンで`workflow_dispatch`するため、起動した実行のactorは
  操作したのが人間でも常に`issue-deck[bot]`になる。`claude-code-action`は自前の非人間アクター
  拒否（`checkHumanActor`）を`github.actor`だけで判定するため、`allowed_bots`に無いと
  `Workflow initiated by non-human actor: issue-deck (type: Bot)`で必ず失敗する。**この失敗は
  ワークフローが起動して途中まで進んだうえでのものなので、画面上はボタンが正常に働いたように
  見える**（起動自体は成功しているため）。#1293で導線を足した時点では
  `reusable-claude-conflict-resolve.yml`・`reusable-claude-pr-repair.yml`が`claude[bot]`のみ、
  `reusable-claude-ci-fix.yml`は指定自体が無く、3つとも押しても効かない状態だった。
  **今後この導線から起動するワークフローを増やすときは`allowed_bots`への追加を忘れないこと。**

## 走っていることを画面に出す（#2072）

CI失敗の自動修正は人の操作なしに走るが、issue-deckの画面と通知には赤い「チェック失敗」しか
出ていなかった。受け取った側からは**放っておけば片付くのか、自分で直すのか**が判断できず、
「失敗しか通知されない」状態になっていた（実例: PR #2068。`lint-and-build`の失敗から14秒後に
`claude-ci-fix.yml`が起動していたが、画面には何も出なかった）。

- **走っているワークフロー自身が報告する。** 3つの修復ワークフローが、対象PRを確定した直後に
  `POST /api/pull-requests/repair-runs`へ`status=running`、ジョブの最後（`if: always()`）に
  `status=finished`を送る。認証・「失敗してもワークフローを止めない」扱いは`POST /api/progress`と同じ
  （`PROGRESS_REPORT_SECRET`）。**この2ステップは`reusable-*.yml`側にあるため、他リポジトリへは
  参照タグ（`@workflows/vN`）を上げた時点で効く**（callerの変更は要らない）。
- **GitHub APIからは引けない。** `claude-ci-fix.yml`は`workflow_run`で起動するため、runの
  `head_branch`は`develop`・`head_sha`はdevelopのSHAで、**実行から対象PRへ辿る手段が無い**
  （PR #2068の実行で実測）。headコミットへcheck-runを立てて既存の`statusCheckRollup`へ
  相乗りさせる案もあるが、Checks APIはGitHub Appでしか書けず、callerごとに`checks: write`を
  足して回ることになるため採っていない。
- **保存するのは「いまの状態」だけ。** `PullRequestRepairRun`は1PR×1種別につき1行を上書きする
  （履歴はActionsとコメントに残る）。runnerごと落ちて終了の報告が届かない場合に備え、開始から
  `REPAIR_RUN_STALE_MINUTES`で失効させる。値は**GitHub Actionsのジョブの既定タイムアウト
  （360分）**に合わせてある——修復ワークフローは3本とも`timeout-minutes`を持たないため、
  それより短くすると長引いた実行でピルだけが先に消え、「何が起きているのか分からない」状態へ
  戻ってしまう。**この失効は最後の砦で、ふだん効かせるものではない**（下記「終了の報告は
  届かないことがある」）。
- **画面のボタンから起動した場合は、APIが起動した時点でも同じ行を書く**
  （`POST /api/pull-requests/repair`）。ワークフローが自分で報告するのは対象PRを再確認した後に
  なるため、押した直後の数十秒が空白になるのを避ける。
- 出るのは`RepairRunBadge`（マージ待ちPR一覧のカード・PR詳細ヘッダー・リリース進捗の各段）と
  通知ベル。**CI失敗の赤は消さず、その隣に重ねる**——失敗している事実は変わらないため。
  通知ベルだけは赤（`error`）をやめて`info`まで弱める（いま人が動けるものではないので、
  確認待ちの「CI実行中」と同じ扱い）。走っているあいだは同じ種類の修復ボタンを押せなくする。
- CI失敗のSignaly通知（`ci.yml`の`notify`ジョブ）も、develop向けの`issue-<番号>`ブランチの
  失敗であれば本文へ「自動修正を試みます」を添える。**このジョブはリポジトリごとの`ci.yml`に
  あるため、他リポジトリへは波及しない**（画面の表示だけが共通で効く）。

### 終了の報告は届かないことがある（#2165）

`status=finished`の報告に頼って表示を消すと、**コンフリクトが解消された後も
「コンフリクトを自動解消中（24分経過）」が最大6時間出続ける。** 報告が届かない経路が2つあり、
どちらもissue-deck側からは「まだ走っている」と区別できない。

- **ジョブが始まる前にキャンセルされる。** `concurrency`の`cancel-in-progress`で待機中のrunが
  落とされると、**ステップが1つも実行されない**ため`if: always()`のステップも動かない
  （実測: guchi-apps/myroomのrun 32582242123・32582049840・32582037606。いずれも
  `resolve-conflicts`ジョブが`cancelled`で`steps`が空）
- **配布済みのワークフローが報告のステップを持たない世代である。** callerは
  `@workflows/vN`でタグ固定するため、issue-deck側で足しても**配り直すまで届かない**
  （実測: myroomは`workflows/v25`を参照しており、v25の`reusable-claude-conflict-resolve.yml`は
  報告のステップを持たない。#2072の追加はv25より後）

**それでもピルは出る。** 「実行中」の行は起動した時点でissue-deck自身が書いている（画面の
ボタン・巡回起動）ため、報告を1通も受け取らないリポジトリでも表示だけは始まる。そこで
**報告ではなくPRの今の状態で消す**。

- 読み出しの時点で落とす（`visibleRepairRun`）。`conflict`は`mergeable`がtrue、`ci`は
  `ciState`が`success`になったら、その修復が直そうとしていた症状は消えている。未判定
  （`mergeable`がnull・CIがpending）は「消えていない」側へ倒し、走っている最中に消えないようにする。
  合流させているのはPR一覧・PR詳細・Issueの対応PR・リリース進捗の4つのAPIで、通知ベルも
  同じデータを読むためまとめて直る
- **行そのものも片付ける**（`settleResolvedConflictRepairRuns`）。表示だけ消すと`running`の行が
  残り、そのPRが再びコンフリクトしたときに巡回起動が`repair_running`で見送ってしまう。
  コンフリクトの巡回（`conflict-sweep-run.ts`）はコンフリクト有無を毎回取っているので、
  そのついでに解消済みのPRの行を`finished`へ倒す

## 本番デプロイの一時的な失敗の再実行（#2134）

mainへマージした後の本番デプロイ（`deploy.yml`）が失敗したとき、これを自動で拾う仕組みが
無かった。上の3つが働くのは**mainへ入る前のPR段階まで**で、デプロイが落ちたときに起きるのは
Signalyへの通知（`deploy.yml`の`notify`ジョブ）と画面の「デプロイ失敗」表示（#1579）だけ。
復旧は人が「本番へ再デプロイ」を押すまで始まらず、SSH断・ネットワーク・アプリの起動待ちの
ような**押し直せば直る失敗**でも、人が気づくまで本番が古いままになっていた
（起点は guchi-apps/question#28）。

`.github/workflows/deploy-retry.yml`（本体は`reusable-deploy-retry.yml`）が、この失敗を
**1回だけ**自動で再実行する。

### コードは直さない

やるのは`gh run rerun --failed`だけで、**同じmainをもう一度流す**。コードの修正が要る失敗は
対象外で、その場合は従来どおり失敗のまま人へ渡る。PR段階の自動修復とはリスクの性質が違う
（本番へ無人でコードを入れることになる）ため、#2134のスコープから外してある。

### 一時的な失敗かどうかは「失敗したジョブの名前」で切り分ける

失敗ログの文言はリポジトリごと・ツールのバージョンごとに変わるため、シグネチャの一覧を持つと
必ず腐る。代わりに`retryable-jobs`（既定`build,deploy`）に**失敗したジョブが全て含まれるとき
だけ**再実行する。

| ジョブ | 既定 | 理由 |
| --- | --- | --- |
| `tag` | 対象外 | 本番には一切変更が入っていないうえ、失敗の理由は「バージョンを上げ忘れて同名タグが別コミットに既にある」。**バージョンを上げない限り何度流しても同じところで落ちる** |
| `build` | 対象 | ネットワーク・レジストリ断で落ちることがあり、落ちても本番には何も入らない |
| `deploy` | 対象 | SSH断・アプリの起動待ちで落ちる。**再実行したいのは主にここ** |
| `release`・`notify` | 対象外 | ここまで来ていれば本番反映は済んでいる。再実行しても本番の状態は変わらない |

失敗ジョブが**ひとつでも**許可リストの外にあれば再実行しない（「`deploy`も落ちているが`tag`も
落ちている」で、直らないと分かっている再実行を打たないため）。失敗ジョブを1件も特定できない
とき（`startup_failure`）も再実行しない。判定できないほうへ倒れたときは常に「再実行しない」側
になる。

`deploy.yml`のジョブ名がこれと違うリポジトリでは、callerの`with:`に`retryable-jobs`を書いて
合わせる。書かなければ安全側（再実行しない）に倒れるだけで、誤って流れることはない。

### 上限が1回であることを、どこにも記録せずに保証する

**GitHubが持っている`run_attempt`をそのまま上限に使う。** `gh run rerun`は新しいrunを作らず
同じrunのattemptを増やすので、`run_attempt == 1`のときだけ再実行すれば、同じrunが2回以上
自動で流れることは構造上ありえない。

`claude-ci-fix.yml`は対象Issueの着手コメント数でリトライを数えているが、デプロイには対応する
IssueもPRも無く、数える場所が無い。**issue-deckのDBへ記録する案は採らなかった**——デプロイが
落ちているときにissue-deck自身が落ちている可能性があり、issue-deckのデプロイ失敗を拾えないので
は意味が無いため。

### `--failed`にする理由

`gh run rerun --failed`は失敗したジョブと、それに`needs`で連なるジョブだけを流し直す。
`deploy`だけが落ちた場合は`build`の成果物（artifact）をそのまま使って`deploy`から再開でき、
`release`・`notify`も一緒に流れるので、**成功したときの通知とGitHub Releaseの作成も従来どおり
行われる**。ここを全体の流し直しにすると、毎回`build`からやり直すことになる。

なお、`deploy.yml`の`tag`ジョブは同じHEADに同名タグがあれば`exit 0`で通過する（Create Git tag
ステップ）ため、同じmainの流し直しがタグ重複で止まることはない。

### 走っていることを通知と画面に出す

**失敗しか通知されない状態を作らない**（#2072と同じ問題）。再実行を起こした時点でSignalyへ
「デプロイ 自動で再実行中」を1件送り、リンク先は**再実行するデプロイのrun**にする
（`signaly-notify.sh`の`NOTIFY_RUN_URL`。未指定なら従来どおり通知元のrunを指す）。

通知は**1Passwordからの補完を通さない**——サービスアカウントの日次レート制限を使い切ると
フリート全体のデプロイが止まる（#1302）ため、デプロイ失敗のたびに読みに行かない。
`SIGNALY_WEBHOOK_URL`は#2255でorganization secretへ寄せたため、organization配下のリポジトリは
何も設定しなくても解決できる。`.github/scripts/signaly-notify.sh`を置いていないリポジトリでは
**通知が出ないだけ**で、再実行そのものは行われる。

画面（「ブランチとPRの流れ」）では、`run_attempt`が2以上のとき
`BranchFlowDeployState.autoRetried`が立ち、バッジの文言が変わる。

| 状態 | 文言 |
| --- | --- |
| 実行中 | 自動で再デプロイ中 |
| 失敗 | 再デプロイしても失敗（＝1回やり直しても駄目だった。人が見る番） |

**再実行は同じrunのattemptを増やすだけなので、`createdAt`も`event`も初回のまま変わらない。**
再実行されたことを画面で言える材料は`run_attempt`しかない（人がGitHubの画面から再実行した
場合も同じく2以上になるが、「1回やり直している」点は同じで、画面で言いたいことも変わらない）。

### 自動検知だけで、画面からの手動起動は持たない

人が押す導線は既に「本番へ再デプロイ」（`POST /api/repositories/deploy` → `deploy.yml`の
`workflow_dispatch`）があり、そちらは新しいrunを最初から流す。`deploy-retry.yml`に
`workflow_dispatch`を足すと、同じことをする経路が2つになる。

### 配布するときの注意

配布経路は下の「不足しているcallerの配布」と同じ（`requires`は`deploy.yml`）。ただし
**`vps`・`subpc`へ配るかは配布のときに判断する**——あの2つは実機のインフラ設定を流す
リポジトリで、#2134でも自動再実行に含めるかを別扱いにしている。

## 直らなかったデプロイ失敗を、Issueにして残す（#2236）

`deploy-retry.yml`の自動再実行で直らなかった失敗は、そこから先へ進まない。**そのとき残るのは
流れて消える通知1件と、その画面を開いた人にしか見えない赤いバッジだけ**で、人が気づいて
「本番へ再デプロイ」を押しに行くまで本番は古い版のまま残る。

issue-deckが**失敗したまま止まっているリポジトリを巡回して見つけ、追跡用のIssueを1件立てる**。

| | |
| --- | --- |
| 巡回の起動 | サブPCのpollerが1巡ごとに`POST /api/repositories/deploy-failure-sweep`（コンフリクト巡回#2116と同じ形） |
| 実際に巡回する間隔 | issue-deck側が決める（`DEPLOY_FAILURE_SWEEP_INTERVAL_MINUTES`・既定5分・0で無効） |
| 起票の条件 | mainの`deploy.yml`の最新runが`completed`かつ`failure`／`timed_out`で、**最後に動いてから猶予（`DEPLOY_FAILURE_ISSUE_GRACE_MINUTES`・既定10分）が過ぎている**こと |
| 判定 | [`src/lib/deploy-failure.ts`](../../src/lib/deploy-failure.ts)の`decideDeployFailure`（純関数） |
| IO | [`src/lib/github/deploy-failure-sweep-run.ts`](../../src/lib/github/deploy-failure-sweep-run.ts) |

### なぜGitHub Actions側で立てないのか

**立てるべきかどうかを、落ちた実行それ自身は判断できない。** `deploy-retry.yml`の再実行は
同じrunのattemptを増やすだけなので、1回目の失敗の時点でIssueを立てると、そのあと再実行が
成功した場合に「もう直っているIssue」が開いたまま残る。「失敗のまま一定時間が過ぎた」ことを
言うには失敗の**後**を見る必要があり、それを見られるのは外から巡回する側だけになる。

加えて`deploy.yml`は14リポジトリに配られている。起票の作法（ラベル・本文・重複の防止）を
各リポジトリのワークフローへ配り直すより、issue-deckに1か所置く方が揃えやすい。

### 1リポジトリにつき同時に1件

二重起票を防ぐ鍵は**失敗した`deploy.yml`のrun id**（DBの`DeployFailureIssue`）。

- 同じrunを追いかけているIssueが開いていれば、何もしない
- **直らないまま次のリリースが来た**（別のrunが落ちた）ときは、Issueを立て直さず開いている
  1件へコメントを書き足し、追跡先を新しいrunへ移す。立て直すと同じ症状のIssueが並ぶ
- 後から走ったデプロイが**成功**したら、コメントを添えて自動でクローズする。キャンセルでは
  閉じない（人が止めたものを「直った」と扱わない）
- **人が画面から先に閉じることがある。** DBの記録だけを信じると次の失敗で二度と立たなく
  なるので、開いている行を見つけたときだけGitHubの実物を1回見て、閉じられていればDB側も畳む

### ラベルは既存のものだけを使う

付けるのは`30.bug`と`80.Priority: High`で、**新しいラベルは作らない**。新設すると14リポジトリへ
配り終えるまで機能が半端に効く状態が続くため。**そのリポジトリに定義があるラベルだけ**を
付ける（存在しないラベルを渡すとGitHubがIssueの作成ごと弾く。`gh label list | grep -qx`
ガード#975と同じ考え方）。

画面がデプロイ失敗Issueを見分けるのも、ラベルではなく**本文の先頭に埋めた不可視マーカー**
（`<!-- deploy-failure: {...} -->`）による。Issueの本文はissue-deckのDBへ同期済みなので、
パネルを出すのに追加のAPI呼び出しが要らない。

### 拾えない失敗が1つある——issue-deck自身の`deploy`ジョブの失敗

`deploy.yml`の`deploy`ジョブは、配布物の展開・`.env`更新・`pnpm install --prod`・
`prisma migrate deploy`を済ませ、**`pm2 delete issue-deck`で旧版を落として新版を起動した後**に
60秒のヘルスチェックを回す（`.github/workflows/deploy.yml`）。つまり`deploy`ジョブが失敗した
時点で、issue-deck自身は**旧版も新版も応答していない**可能性が高い。pollerが叩く受け口も
落ちているため、**この巡回はissue-deck自身の`deploy`失敗を起票できない。**

- 拾えるのは、**他リポジトリの失敗すべて**と、issue-deck自身については**本番サーバーに
  触れていない失敗**（`build`・`tag`）
- issue-deck自身の`deploy`失敗は、従来どおりSignalyの通知が入口になる。issue-deckが復帰した
  後も最新runが失敗のままなら、そこで初めて起票される
- ここまで拾うにはGitHub Actions側（`deploy-retry.yml`と同じ場所）に置く必要があり、#2134が
  「issue-deckのDBへ記録する案は採らなかった」のと同じ理由。設計が変わるので#2236の範囲から
  外してある

### なぜissue-deckのDBへ記録するのか（#2134と結論が違う理由）

#2134は再実行の上限をissue-deckのDBに持たせず、GitHubの`run_attempt`を使った。**ここで
DBを使うのは、判定の置き場所ではなく「起票したことを取りこぼさない」ため。**

起票済みかどうかを、同期済みの`Issue`（タイトルが`[デプロイ失敗] `で始まるopenなもの）で
判定する案もあるが、**その同期はGitHubのwebhook配送に依存する。** このリポジトリでは
`pull_request(opened)`のイベントが1本も配送されなかった実例がある（guchi-apps/myroom#191。
上記「issue-deckからの巡回検知」）。同じことが`issues(opened)`で起きると、巡回のたびに
同じ失敗のIssueが積み上がる。作成と同時にDBへ1行残せば、webhookが落ちても二重起票にならない。

**代わりにGitHub側の実物も1回だけ見る。** DBが`open`でも人が画面から先に閉じていることが
あるため、開いている行を見つけたときだけ`GET /repos/.../issues/<番号>`で状態を確かめ、
閉じられていればDB側も畳む。

### 押せる場所を、失敗が見えている場所に置く

「本番へ再デプロイ」は#2020から「ブランチとPRの流れ」画面のリポジトリの節にあるが、そこは
失敗の表示と離れた行で、PR詳細とIssue詳細には入口が無かった。失敗しているときだけ、同じ帯
（[`deploy-failure-alert.tsx`](../../src/components/dashboard/deploy-failure-alert.tsx)）を3か所に出す。

| 画面 | 置き場所 | 見出し |
| --- | --- | --- |
| ブランチとPRの流れ | **リポジトリの節（レールの凡例の行のすぐ下）** | 本番デプロイが失敗しています |
| Pull Request詳細 | 「デプロイ失敗」ピルの下 | このPRの変更は本番へ出ていません |
| Issue詳細（自動起票分） | 本文より上 | 本番デプロイが失敗しています |

ボタンの実体は`RepositoryDeployButton`のままで、**確認ダイアログ（押すと本番へ出るため必ず
挟む）と`POST /api/repositories/deploy`の呼び出しを3画面ぶん書き分けない。**

**ブランチ画面で帯を「落ちた版の束」に置かない。** 束は「次のリリースに乗る分」があると
畳まれる（`visibleGroups`）ので、直らないまま次のリリースが動き出した瞬間に、いちばん見せたい
失敗の帯が画面から消える。#2020が「本番へ再デプロイ」を束へ置かなかったのと同じ理由で、
リポジトリの節に置く。**帯を出しているあいだ、凡例の行の「本番へ再デプロイ」は出さない**
——同じ操作が同じ画面に2つ並ぶのを避けるため（押す口は帯の中の1つだけになる）。

**手動の出し直し（`event`が`workflow_dispatch`）が落ちた場合は帯を出さない。**
出し直しの失敗はその版が本番へ出ていないことを意味しないため（版の見出しの「本番反映」を
取り消さない`inProduction`の判定と揃える）。

## 配布状況と、不足しているcallerの配布（#1948・#1475）

**自動修復のcallerは、そのリポジトリの`.github/workflows/`に置かれていなければ起動できない。**
`workflow_dispatch`の受け口はファイルの実在で解決されるため、無いリポジトリでは画面のボタンを
押してもGitHub APIが404を返し、押すまでそれが分からなかった（`/api/pull-requests/repair`は
この404だけ専用の文言に置き換えている）。実測では、フリートのうち3リポジトリしか持って
いなかった（issue-deck・dayspan・shopping-list。2026-08-18時点の配布状況は
[../supported-repositories.md](../supported-repositories.md)「不足しているcallerの配布状況」）。

配布は**issue-deckの画面（設定＞フリート運用＞共有ワークフローのバージョン）**から行う。

- 検知は共有ワークフローの参照タグと同じGraphQL取得に相乗りしており、追加のAPI消費は無い
  （`collectWorkflowTags`が読む`.github/workflows/`のTreeのファイル名を使う）。判定は
  `missingRepairWorkflows`（`src/lib/workflow-tags.ts`）で、**そのリポジトリで意味を持つものだけ**を
  不足として挙げる——`claude-ci-fix.yml`・`claude-conflict-resolve.yml`は
  `claude-issue-dispatch.yml`を、`claude-pr-repair.yml`は`claude-issue-dispatch.yml`と
  `release-develop-to-main.yml`を、`deploy-retry.yml`は`claude-issue-dispatch.yml`と
  `deploy.yml`を**すべて**持つリポジトリが対象。
- **`claude-issue-dispatch.yml`はどのcallerの`requires`にも入っている**（#2303）。下の配布
  スクリプトが参照タグと`with:`の値をそのcallerから写すため、無ければ`fail`で落ちて1つも
  配れないからで、不足として挙げるとボタンを押した時点で必ず失敗する。参照タグの配布が
  #2303で`vps`・`subpc`まで対象を広げたことで、実際に起こりうる状態になった（あの2つは
  `release-develop-to-main.yml`・`deploy.yml`を持つ）。**条件は`REPAIR_WORKFLOW_SPECS`の
  `requires`にだけ書き、関数側に特例を足さない**——同じ`requires`をPR詳細の文言
  （`resolveMissingState`。`src/lib/github/repair-workflow-cache.ts`）も読むので、片方だけ
  変えると「一覧には出ないのに、PR詳細は設定＞フリート運用から配れますと案内する」
  行き止まり（#1960）が復活する。この2件へ配るなら手で配る
  （[../supported-repositories.md](../supported-repositories.md)「画面の配布ボタンの対象外
  なので手で配る」）。
- **この配布経路は自動修復専用ではない**（#1475）。`claude-review-develop.yml`——develop向けPRの
  自動マージ可否を判定する唯一の経路——も同じ一覧・同じボタンから配る。自動修復ではないが
  「置かれていないと機能が丸ごと働かない」点が同じで、判定も`REPAIR_WORKFLOW_SPECS`に1行
  足すだけで済むため。画面の見出しは「不足・破損しているワークフロー」、配布PRのタイトルは
  「不足しているワークフローを追加する」。
- **置いてあるだけでは足りない。壊れているcallerも同じ一覧・同じボタンで作り直す**（#2330）。
  `guchi-apps/asset-manager`の`claude-ci-fix.yml`は`workflows: - "CI\r"`という閉じないYAMLの
  まま置かれており、developへpushするたびGitHubが
  「This run likely failed because of a workflow file issue」で即失敗するrunを作っていた
  （30回連続。ジョブが1つも無いのでログも残らない）。**ファイルの実在しか見ていなかったため
  画面には「配布済み」として消えており、押しても直せなかった。**
  - 壊れ方の元は**配布先のCIワークフローがCRLF**だったこと。`name: CI`から名前を抜くと
    `CI\r`になり、それを雛形の`__CI_WORKFLOW__`へ差し込むと引用符の途中に改行が入る。
    抽出側の`tr -d '\r'`は#2134で入ったが、**それ以前に配られたファイルはそのまま残っていた**
  - 判定は`brokenRepairWorkflows`（`src/lib/workflow-tags.ts`）と、配布スクリプトの
    `validate_generated`の2か所にあり、**条件はCR（`\r`）と未展開のプレースホルダ
    （`__[A-Z0-9_]+__`）の2つで揃えてある**。片方だけ直すと、画面が「壊れている」と出し
    続けるのに配布は素通りする。**YAMLとしての解析はしない**——配布とは無関係な書き換えまで
    壊れている扱いになり、上書きで消してしまう
  - 配布スクリプトは既存ファイルを無条件でスキップしていたのをやめ、**壊れているときだけ
    作り直す**。作り直しは既存ファイルを上書きするため、コミットメッセージとPR本文では
    「追加」と「作り直し」を別の行に出し、PR本文の注意点に
    「そのリポジトリだけで足した`verify-commands`・`build-env`は消える」と書く
  - 生成した結果も配る前に`validate_generated`へ通す。**直しに来た配布が同じ壊れ方の
    ファイルを作り直して置くだけ**になるのを防ぐ
- ボタンは`propagate-repair-workflows.yml`を起動し、`.github/scripts/propagate-repair-workflows.sh`が
  リポジトリごとにPRを作る。callerの中身は`.github/templates/callers/`の雛形から生成し、
  **参照タグ（`uses:`・`prompts-ref`）と`runtime-setup`・`package-manager`・`node-version`は
  そのリポジトリの`claude-issue-dispatch.yml`から写す**（写す入力を3つに限るのは、
  再利用ワークフローが宣言していない入力を渡すと読み込み自体が失敗するため）。
  **`claude-review-develop.yml`にはこの3つを写さない**——
  `reusable-claude-review-develop.yml`が宣言していないため、渡すと読み込みごと失敗する。
  写す値が要るかどうかは雛形に`__WITH_INPUTS__`があるかで決まる。
- **`claude-review-develop.yml`を配るときは、配布先の前提が揃っているかを確かめて警告する**
  （#1475）。`Allow auto-merge`が有効か、`develop`にブランチ保護があるかを読み、
  欠けていればワークフローのログとPR本文へ残す。**保護が無いと自動マージは成立しない**——
  判定の時点でPRは「既にマージ可能」なので`gh pr merge --auto`が断られ、
  `auto-merge-fallback`が毎回`00.check-user`を付けるだけで終わる。
- **設定そのものはここでは変えない。** `WORKFLOW_PAT`は Contents / Issues / Pull requests /
  Actions / Workflows / Metadata だけで**Administration を持たない**ため、
  `PATCH /repos/{repo}`（`allow_auto_merge`）もブランチ保護APIも通らない。
  `propagate-workflow-tag.sh`が`|| true`付きで有効化を試し続けていたが、**12リポジトリ中8件が
  `false`のまま**で、失敗が一度も表に出ていなかった。設定はorg owner本人の`gh`で
  `scripts/setup-develop-auto-merge.sh`を一度だけ実行して揃える（必須チェック名は
  **ワークフローのジョブ名から推測せず**、直近のdevelop向けPRで実際に成功したcheck runと
  突き合わせて一致したものだけを使う。実在しない名前を必須にすると永久に埋まらず
  マージ不能になるため、突き合わせに失敗したら保護を作らない）。
- **保護の有無は`branches/develop`の`protected`で見る。** `branches/develop/protection`は
  必須チェック名まで返す代わりにAdministrationが要り、配布のトークンでは読めない。
- **`verify-commands`・`build-env`は配らない。** リポジトリごとに違い機械的に決められないため、
  必要なら配布後に手で足す（issue-deck・dayspanのcallerが実例）。
- **`workflow_run`はワークフローの「名前」で購読する。** 雛形の購読先は配布先の`ci.yml`
  （無ければ`test.yml`）の`name:`から埋める（`deploy-retry.yml`は`deploy.yml`の`name:`）。
  名前が変わると黙って発火しなくなる。**`deploy-retry.yml`は名前を取れなければ配らない**——
  既定値で埋めると、置いてあるのに一度も発火しないcallerが残り、そのことに誰も気づけない。
  **ワークフローファイルがCRLFのリポジトリがある**（asset-manager）ため、読むときにCRを
  落とす。落とさないと名前の末尾にCRが残り、購読先としても必須チェック名としても一致しない。
- **配布PRは自動マージしない。** 自動マージの例外（#1602）は`@workflows/vN`の機械的な置換に
  限られ、新しいワークフローファイルの追加はGitHub Actionsの変更そのものにあたるため、
  各リポジトリでPRを確認してマージする。配布PRが既にopenのリポジトリは、次に押したときの
  対象から外れる（同じリポジトリへ2本目を作らないため。タグ配布と同じ仕組み）。
- **配布しても、マージされるまでボタンは効かない。** `workflow_dispatch`の受け口は配布先の
  デフォルトブランチの定義から解決されるため。

## ワークフロー以外の配布物を配る（#2240）

`.github/scripts/signaly-notify.sh`は、**各リポジトリの`.github/scripts/`へコピーして使う運用**の
ため、issue-deck側を直しても自動では行き渡らない。#2237・#2239で「通知が届かなくても`exit 0`で
返す」形に直したが、届いていないリポジトリでは**デプロイが成功しているのにrunだけが赤い**状態
（Signalyが止まっている間）が残り続ける。2026-08-24時点で同じスクリプトを持つのは16リポジトリで、
**16件の個別Issueを立てるのは#2009で避けると決めた形**のため、配る仕組みに載せた。

配布は上のcaller配布と**同じパネル**（設定＞フリート運用＞共有ワークフローのバージョン）の
「共有スクリプト」から行う。押すと`propagate-shared-files.yml`が
`.github/scripts/propagate-shared-files.sh`をリポジトリごとに呼ぶ。

- **配布元は`.github/templates/`の雛形ではなく、issue-deck自身の実物。** callerは配布先ごとに
  参照タグ・`with:`を差し込んで生成するため雛形が要るが、こちらは中身をそのまま配る。写しを
  置くと二重管理になり、**実物を直したのに配られるのは古い写し**という食い違いが起こりうる。
  issue-deck自身がこのスクリプトを`ci.yml`・`deploy.yml`から使っている（＝壊れればこの
  リポジトリのCIで先に分かる）ことも、実物を正にする根拠になる。配布元と配布先でパスは同じ。
- **配るのは既に置いてあるリポジトリだけ。** `signaly-notify.sh`を呼ぶのは`ci.yml`・`deploy.yml`
  側のステップなので、スクリプトだけ新規に置いても誰も呼ばない。呼び出し側ごと入れるのは
  「そのリポジトリにCI・デプロイ通知を導入する」作業で、機械的な配布とは別物。
- **判定は「有るか無いか」ではなく中身が同じか**（callerとの一番の違い）。検知は参照タグと
  同じGraphQL取得に相乗りしており、リポジトリごとのクエリに配布物のBlobを1つ足すだけで済む。
  配布元は`main`から読む——配布ワークフローは`ref: main`で起動し`actions/checkout`が`main`を
  取るため、`develop`を基準にすると画面の件数と配られる中身が食い違う。
- **配布先の独自の変更は上書きで消えうる。** 実際`guchi-apps/subpc`のコピーには、そのリポジトリ
  だけの`NOTIFY_NOTE`（反映は成功したが再起動などの操作が残っていることを通知へ足す）が入って
  いる。**対象からは外さず**（独自の変更があるリポジトリこそ修正が届いていない）、画面に
  「独自の変更あり」を出し、消える記述をPR本文へ書き出して人が読む形にする。
- **「しか無い記述」は行ではなく語で見る**（`hasLocalSharedFileContent`と、スクリプト側の同じ
  判定のawk）。行で比べると、配布元で書き換わっただけの行（`run_url=`・`curl -fsS \`など）が
  「消える行」として引っかかり、**実測で16件中16件が該当**して目印にならなかった。語（識別子・
  変数名・コマンド名）で見ると`subpc`だけが残る。語がすべて配布元にもある独自の変更は検出
  しないが、これは目印であって保証ではなく、実際に消えるものはPR本文で人が読む。
- **自動マージしない。** caller配布と同じ理由に加えて、上書きで独自の変更を消しうるため。
  更新PRが既にopenのリポジトリは次に押したときの対象から外れる（同じリポジトリへ2本目を
  作らないため。タグ配布・caller配布と同じ仕組み）。
- **配れるパスの許可リストは3か所にある**（`SHARED_FILE_SPECS`・ワークフローの入力検証・
  スクリプトの`ALLOWED_FILES`）。食い違うと、画面から配ろうとしたファイルが黙ってスキップ
  されるか、起動そのものが弾かれる。`src/lib/workflows/propagate-shared-files.test.ts`が
  3か所の一致を見ている。
- **配布物のコピーに加えて、`deploy.yml`・`release.yml`への1行追加も運ぶ**（#2391）。
  リリース通知を専用チャンネルへ向ける`SIGNALY_RELEASE_WEBHOOK_URL`は、GitHub Actionsの
  secretの性質上ワークフローが`env:`へ渡さないとスクリプトから読めず、スクリプトを配るだけ
  では効かない。そこで**`NOTIFY_KIND: リリース`の行の隣へ1行足すだけ**の編集を同じPRに
  含める（既に入っていれば何もしない）。ここを増やすときは**リポジトリごとの中身に依存
  しない編集か**を確かめること——丸ごと配れないファイルを部分編集する例外で、条件分岐を
  足し始めると配布先ごとの挙動を追えなくなる。
- **`.github/workflows/`も触るようになった**（#2391。以前はここが`.github/scripts/`だけ
  だった）。3つの配布はブランチもPRも別なので同時に走らせても壊れないが、**タグ配布と
  この配布が同じ`deploy.yml`を触る**ため、両方openのまま片方をマージするともう片方が
  コンフリクトしうる。順に押して片付けるのが無難。concurrency groupは3つとも別のまま。

## CI/デプロイ通知（Signaly）の作法

**#2280でセッションの状態通知は削除したが、CI・デプロイ・リリースの結果通知は残っている**
（`.github/scripts/signaly-notify.sh`）。以下はそちらだけに掛かる話で、
[session-notify.md](session-notify.md)には無い。

### リリースだけ宛先と見た目を変える（#2391）

`NOTIFY_KIND`が`リリース`のときだけ、送り先・見出し・fields・本文を切り替える。判定は
スクリプトの`is_release`1か所に閉じ込めてあり、呼び出し側は`SIGNALY_RELEASE_WEBHOOK_URL`を
渡すかどうかだけを決める。

| 変わるもの | リリース | CI・デプロイ |
|---|---|---|
| 送り先 | `SIGNALY_RELEASE_WEBHOOK_URL`（空なら`SIGNALY_WEBHOOK_URL`） | `SIGNALY_WEBHOOK_URL` |
| 成功の絵文字 | 🚀 | ✅ |
| fields | App / Version / Repository / Commit / Release / Run | 従来どおり |
| 本文（`message`） | `.github/release-notes.md`の中身 | 付けない |

- **フォールバックを必ず残す。** 専用URLが空ならこれまでのチャンネルへ送る。配布先のワーク
  フローがまだ1行を持っていなくても、organization secretが未登録でも、**通知そのものは
  消えない**。secretの登録・スクリプトの配布・ワークフローの1行追加を、どの順で進めても
  壊れない状態にしておくのが目的
- **Type・Branch・Actor・Job・Eventはリリースでは出さない。** 専用チャンネルでは毎回同じ値に
  なり、読む手がかりにならない。代わりにGitHub Releaseへのリンクを出す
- **本文はバージョンが一致したときだけ載せる。** `.github/release-notes.md`の先頭の見出し
  `# v<バージョン>`と`NOTIFY_VERSION`を突き合わせ、違えば本文なしで送る。リリースの流れの外で
  ファイルが取り残されたとき、**古い文面を新しいリリースの通知へ貼るほうが、本文が無いことより
  悪い**ため。上限1500文字で切る（1件で通知一覧が埋まらないように）
- **本文はプッシュ通知の本文にもなる。** Signalyは`message`をそのままPushへ載せるので、
  1行目に変更内容が来るよう「変更内容 → 空行 → `**使い方**`」の順で書く
- **他リポジトリへ効かせるには配布経路が2つ要る**（#2429）。本文を*読む*
  `signaly-notify.sh`は「共有スクリプト」の配布で配るが、本文を*書く*
  `reusable-release-develop-to-main.yml`は`@workflows/vN`のタグ固定で参照されているため、
  **タグを切って配るまで配布先では`.github/release-notes.md`が生成されない**。
  片方だけ配ってもエラーにはならず、**本文の無いリリース通知が届くだけ**なので気付けない
  （実際、スクリプトは全17リポジトリへ行き渡っていたのに`.github/release-notes.md`を
  持つのはissue-deckだけ、という状態が`workflows/v28`を切るまで続いた）。**確かめ方は
  配布先の`.github/release-notes.md`の有無**で、スクリプトの版数を見ても分からない
- **Signaly側に手を入れる余地は無い。** 受け口は`POST /webhook/{channel_id}`だけで、
  `{title, message, level, color, fields}`をそのまま保存・表示する。リリースの判定も
  バージョンの照合も本文の切り詰めも全部送信側（`signaly-notify.sh`）にあり、
  アプリ名・リポジトリ名での分岐は受信側にも送信側にも無い

### 通知の障害でrunを赤くしない（#2237）

`signaly-notify.sh`は**何が起きても`exit 0`で返す**。

- v4.33.0のmainマージでは、`tag`・`build`・`deploy`・`release`が全て成功しているのに通知の
  `curl`が503で落ち、`Deploy to Production`のrunが失敗として残った（run 32721175959）。
  **通知はデプロイの結果の記録であって、デプロイの成否そのものではない**
- 送信は`--retry 2 --retry-delay 2`付きで行う。`--retry`はタイムアウトと408・429・500・502・
  503・504を一時エラーとみなすので、Signaly自身のデプロイ中に当たった503はここで拾える
- それでも届かなければ`::warning::`だけを残す。**気付けるのはrunの警告だけ**なので、
  webhookのURLが恒久的に壊れた場合はここに出続ける
- **失敗時にcurlのstderrは出さない。** 接続に失敗したときのメッセージにはwebhookのホスト名が
  載り、GitHubのマスクは完全一致でしか効かないため、runのログへ接続先が残ってしまう。
  代わりに`%{http_code}`だけを出す（接続できなかった場合は`000`）
- 呼び出し側のステップにも`continue-on-error: true`を付ける（`ci.yml`・`deploy.yml`・
  `release.yml`・`reusable-deploy-retry.yml`）。**スクリプトは各リポジトリの
  `.github/scripts/`にコピーして使う運用**で、古いコピーを置いたままのリポジトリでは
  スクリプト側の`exit 0`が効かないため、ワークフロー側でも守る
- 境界は`scripts/signaly-notify.test.mjs`で固定してある（503を返すwebhookに対して終了コード0）

### fieldsの値にリンクを載せるときの制約（#1234・#1247）

**Signalyのfieldsの値でリンクになるのは`[表示名](URL)`のマスクドリンク記法だけで、生URLを
置いても自動ではリンクにならない。** そのうえで、次の2つを守らないと表示が壊れる。

1. **URLに`_`を含めない**（含む場合は`%5F`へパーセントエンコードする）
2. **1つの値にリンクを2つ以上入れない**

理由はSignaly側のレンダラ（`frontend/app.js`の`renderFieldValue`）の処理順にある。
`[表示名](URL)`を`<a href="..." target="_blank" ...>`へ置換した**あとで**`_..._`を`<em>`へ
変換するため、**生成後のHTMLに残る`_blank`の`_`が、値の中の他の`_`と対になる**。対になった
時点でhrefとtarget属性ごと壊れる。マスクドリンク1つにつき`_blank`の`_`が1個増えるので、
「値に残る`_`が2個以上」が壊れる条件になる。

現在の`signaly-notify.sh`が出す`[Workflow Run](...)`はURLに`_`を含まないため、この問題は
起きていない。**`_`を含みうる値（セッションIDなど）をfieldsへ足すときだけ効いてくる。**

## 未配布のリポジトリでは修復ボタンを押せなくする（#1960）

配れるようにしても、**配る前・新しく連携したリポジトリ・配布PRがマージされるまでの間**は、
押せるのに404で起動しないボタンが出たままになる。そこで起動先ワークフローの実在を取得時に
確かめ、無ければボタンを無効化して理由（と配り先である設定＞フリート運用）を添える。

- **ボタンは消さずに無効化する。** 消すと「配れば使える」ことが画面から分からなくなるため
  （#1948の計画時点でユーザーと合意した方針）。
- 判定は`fetchRepairWorkflowAvailability`（`src/lib/github/repair-workflow-cache.ts`）で、
  **修復ボタンを出す種類（`repairKindsFor`が返した種類）だけ**を問い合わせる。結果は
  `releaseWorkflowExists`と同じくプロセス内に10分キャッシュするため、CI失敗のPRが並んでいても
  GitHub APIの消費はごく小さい。同じワークフローを見る種類（バンプPR・リリースPRのCI失敗と
  コンフリクトはどちらも`claude-pr-repair.yml`）は1回にまとめる。
- 種類ごとに起動先が違うため、判定も**種類ごと**に持つ（`RepairWorkflowAvailability`）。
  `claude-ci-fix.yml`だけ配られている、といった状態ではCI修正だけ押せる。
- **「これから配れる（`missing`）」と「配布の対象ですらない（`unsupported`）」を分ける。**
  配布の一覧は`requires`を持つリポジトリしか対象にしないため（上節）、例えば
  `release-develop-to-main.yml`はあるが`claude-issue-dispatch.yml`が無いリポジトリ
  （2026-08-18時点の`guchi-apps/vps`・`guchi-apps/subpc`）では、`issue-<番号>`のPRに出る
  CI修正ボタンの起動先を配れない。そこへ「設定＞フリート運用から配れます」と案内すると
  行き止まりになるので、無いと分かったときだけ前提ファイルの有無も確かめて文言を変える。
- **未配布（偽）のキャッシュは1分と短くする。** 配布PRがマージされた瞬間に偽から真へ変わる値で、
  10分持つと「配ったのにボタンが押せない」時間ができる。逆向き（真→偽）は起こらないので、
  配布済みの側は10分のままでよい（`ISSUE_RUN_NEGATIVE_CACHE_TTL_MS`と同じ考え方）。
- **判定に失敗した（404以外のエラー）種類は押せるままにする。** 権限・障害で無効化すると
  「配ってあるのに押せない」状態になるため。押した先の404を専用文言に置き換える
  `POST /api/pull-requests/repair`の処理は、最後の砦としてそのまま残している。
- 経路は3つ（`/api/pull-requests`・`/api/pull-requests/detail`・`/api/repositories/release`）で、
  画面側は`PullRequestRepairButtons`が1か所で表示を受け持つ。一覧APIでは**PR1件ずつの変換
  （`toOpenPullRequest`）ではなく、summaryが揃ってから別の一巡で埋める**——CI状態の取得を
  まとめ取りへ組み替える予定（#1962）と同じ関数を奪い合わないため。
