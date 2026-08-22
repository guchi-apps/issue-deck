# PRコンフリクト・CI失敗の自動解消

develop向けPRがコンフリクトした場合、およびCIが失敗した場合の自動修復。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## 全体像

| 対象PR | CI失敗 | コンフリクト | 起動 |
| --- | --- | --- | --- |
| `issue-<番号>` → develop | `claude-ci-fix.yml`（#807） | `claude-conflict-resolve.yml`（#315） | 自動検知 + 画面のボタン |
| `release/vX.Y.Z` → develop（バンプPR） | `claude-pr-repair.yml`（#1293） | 同左 | 画面のボタンのみ |
| develop → main（リリースPR） | `claude-pr-repair.yml`（#1293） | 同左 | 画面のボタンのみ |

分かれ目は**対応する単一のIssueがあるかどうか**。ある場合は報告先・リトライ管理をIssueに置ける
ので既存2ワークフローが受け持ち、無い場合は報告先を対象PR自身のコメントに置く
`claude-pr-repair.yml`が受け持つ。

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
  戻ってしまう（`if: always()`はキャンセル時にも走るので、報告が届かないケース自体が稀）。
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
  `claude-issue-dispatch.yml`を持つリポジトリ、`claude-pr-repair.yml`は
  `release-develop-to-main.yml`を持つリポジトリが対象。
- **この配布経路は自動修復専用ではない**（#1475）。`claude-review-develop.yml`——develop向けPRの
  自動マージ可否を判定する唯一の経路——も同じ一覧・同じボタンから配る。自動修復ではないが
  「置かれていないと機能が丸ごと働かない」点が同じで、判定も`REPAIR_WORKFLOW_SPECS`に1行
  足すだけで済むため。画面の見出しは「不足しているワークフロー」、配布PRのタイトルは
  「不足しているワークフローを追加する」。
- ボタンは`propagate-repair-workflows.yml`を起動し、`.github/scripts/propagate-repair-workflows.sh`が
  リポジトリごとにPRを作る。callerの中身は`.github/templates/callers/`の雛形から生成し、
  **参照タグ（`uses:`・`prompts-ref`）と`runtime-setup`・`package-manager`・`node-version`は
  そのリポジトリの`claude-issue-dispatch.yml`から写す**（写す入力を3つに限るのは、
  再利用ワークフローが宣言していない入力を渡すと読み込み自体が失敗するため）。
  **`claude-review-develop.yml`にはこの3つを写さない**——
  `reusable-claude-review-develop.yml`が宣言していないため、渡すと読み込みごと失敗する。
  写す値が要るかどうかは雛形に`__WITH_INPUTS__`があるかで決まる。
- **`claude-review-develop.yml`を配るときは、配布先のリポジトリ設定も揃える**（#1475）。
  `Allow auto-merge`を有効化し、`develop`にブランチ保護（必須ステータスチェック）が無ければ
  作る。**保護が無いと自動マージは成立しない**——判定の時点でPRは「既にマージ可能」なので
  `gh pr merge --auto`が断られ、`auto-merge-fallback`が毎回`00.check-user`を付けるだけで
  終わる。必須チェック名は**ワークフローのジョブ名から推測せず**、直近のdevelop向けPRで実際に
  走ったcheck runと突き合わせて一致したものだけを使う（実在しない名前を必須にすると永久に
  埋まらずマージ不能になる）。突き合わせに失敗したら保護は作らず、PR本文へ警告を残す。
- **`verify-commands`・`build-env`は配らない。** リポジトリごとに違い機械的に決められないため、
  必要なら配布後に手で足す（issue-deck・dayspanのcallerが実例）。
- **`workflow_run`はワークフローの「名前」で購読する。** 雛形の購読先は配布先の`ci.yml`
  （無ければ`test.yml`）の`name:`から埋める。名前が変わると黙って発火しなくなる。
  **ワークフローファイルがCRLFのリポジトリがある**（asset-manager）ため、読むときにCRを
  落とす。落とさないと名前の末尾にCRが残り、購読先としても必須チェック名としても一致しない。
- **配布PRは自動マージしない。** 自動マージの例外（#1602）は`@workflows/vN`の機械的な置換に
  限られ、新しいワークフローファイルの追加はGitHub Actionsの変更そのものにあたるため、
  各リポジトリでPRを確認してマージする。配布PRが既にopenのリポジトリは、次に押したときの
  対象から外れる（同じリポジトリへ2本目を作らないため。タグ配布と同じ仕組み）。
- **配布しても、マージされるまでボタンは効かない。** `workflow_dispatch`の受け口は配布先の
  デフォルトブランチの定義から解決されるため。

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
