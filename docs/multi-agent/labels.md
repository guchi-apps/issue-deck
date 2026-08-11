# Issueラベルによる状態管理とトグル

ラベルの状態遷移、各種の要否トグル（計画フェーズ・プレビュー・スクリーンショット・マージ前確認）、サブIssue分割、自動マージ可否の判定。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

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

このワークフローは**トリガー定義のみ**を持ち、ジョブ本体は`.github/workflows/reusable-issue-labels.yml`（`on: workflow_call`）へ切り出してある（#940）。他リポジトリへ展開する際は、ワークフローをコピーするのではなく**issue-deck側のこの実体をタグ固定で参照する薄いcallerを置く**（[docs/cross-repo-setup-guide.md](../cross-repo-setup-guide.md)「再利用可能ワークフローの参照」を参照）。issue-deck自身はローカルパス参照で常に最新の内容を使うため、変更が最初に自分へ跳ね返るカナリアとして機能する。

呼ばれる側でも`github`コンテキストはcaller（呼び出し元リポジトリ）のものになるため、ジョブ定義は呼び出し元を意識した書き換えを必要としない（#939で実測）。

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

分割とは別に、計画提示ステップは調査中に見つかった元Issueのスコープ外の関連事項（追加対応すべき別件・副作用や懸念点など）を、承認フローを経ずにその場で新規Issueとして起票してよい（元Issue自体の実装承認とは独立。#735）。分割が「元Issueのスコープを割る」ものであるのに対し、これは「元Issueとは別の関連事項を独立Issueとして提案する」もので、本文に「起点: #<元Issue番号>」を含め、`70.confirm`ラベルを付与したうえで1回あたり目安3件までに留める。

## 開発環境プレビュー要否をIssueラベルでトグルする

開発サーバー（`pnpm dev`）のポート割り当て自体はコストがないため、ラベルの有無に関わらず常に`.env.local`に`PORT=4000 + Issue番号`を設定する。ラベルは「画面確認をPR作成前の承認ゲートにするかどうか」を制御する。

- ラベル `23.preview-required` の有無で`start-issue.sh`が生成するプロンプトの文言が分岐する。
  - **ラベルなし（デフォルト）**: 実装エージェントは、画面に関わる変更を行った場合PR本文の「確認方法」に開発サーバーのURL（`http://localhost:<ポート>`）とアクセス手順を記載するだけで、承認待ちなしにそのままPR作成まで進める。
  - **ラベルあり**: PRを作成する**前**に、実際に開発サーバーを起動してURLをユーザーに提示し、画面を確認してもらったうえで明示的な承認を得てからPRを作成する（`21.plan-required`と同様の承認ゲート）。
- 承認の得方は実行形態により異なる。
  - **ローカル実行**: 実際に到達可能な開発サーバーが起動しているため、`21.plan-required`と同じ考え方で
    PRを作成する**前**に提示・応答待ちのゲートとして機能する。提示後にそのまま応答を止めて、
    ユーザーからの返信（承認）を待つ。
  - **GitHub Actions実行（無人）**: ワークフロー終了と同時にdevサーバーも消えるため、実装エージェント
    自身が確認物を用意することはできない。この制約により、以前はPR作成自体をブロックして
    `00.check-user`を付与し停止していたが、`24.screenshot-required`と同様の理由（確認ゲートをPR作成前
    ではなくdevelopへのマージ前に移す）で#813にてPR作成をブロックしない方式に変更した。#832で
    Fly.io Machines上のプレビュー環境（#826・#830・#831）への接続が完了してからは、PR作成後に
    `claude-issue-dispatch.yml`の`deploy-preview`ジョブが実装ブランチを実際にデプロイし、
    `notify-preview-url`ジョブが実際に開けるプレビューURLを完了報告コメントとは別のコメントとして
    Issueへ通知する（詳細はdocs/preview-environment.md参照）。developへの
    マージ前確認は後述の「developへのマージ前確認要否をIssueラベルでトグルする」の`risk-check`
    ジョブがゲートする。

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
    このコメントはPR作成・push直後（実装エージェントがスクリーンショットを撮影する前）に
    自動投稿されるため、投稿時点ではスクリーンショットがまだ添付されていない。ユーザーが
    このコメントだけを見てスクリーンショット未添付だと誤解し、再度添付を催促してしまう
    事象が起きたため（#859）、コメント文言自体に「撮影完了後に別コメントとして画像が
    追加投稿される」旨を明記した（#862）。
  - `23.preview-required`が付いている場合も同様に`risk-check`ジョブが常に`00.check-user`を
    付与する（#813）。無人実行ではPR作成前にプレビュー画面を提示できないため、確認ゲートを
    develop向けPRのマージ前に移した（詳細は「開発環境プレビュー要否をIssueラベルでトグルする」参照）。
  - 一度きりの`00.check-user`の手動付与と異なり、PRが複数回pushされる場合（追加修正・
    コンフリクト解消の自動push等）でも、そのPRが存在する間はIssueにラベルを付けたままにして
    おけば毎回のpushで確実に確認ゲートがかかる。
  - 「実装を開始」ダイアログのチェックボックス（`src/lib/github/start-implementation.ts`の
    `START_IMPLEMENTATION_OPTIONS`）にも「マージ前に確認が必要」として追加済みで、`21.plan-required`
    等と同様にダイアログから選択して付与できる（#366）。

## Claude Reviewの実行要否を`risk-check`でゲートする（#992）

`claude-review`ジョブ（Claude Codeによる意味的レビュー）は、当初はdevelop向けPRの作成・更新の
たびに無条件で実行していた。しかし実際のdevelop向けPRは2〜5ファイル・数十〜200行程度の小規模で
低リスクな変更が大半を占めており（本Issue検討時点の直近18件では14件・約78%がパスパターンに
一切該当しない小規模変更だった）、そのすべてにClaude Codeの実行コストをかけるのは費用対効果が
低い。そこで`risk-check`ジョブが`needs-review`出力を返し、`claude-review`はそれが`true`のときだけ
実行する形に変更した。

`needs-review`が`true`になる条件は以下のいずれかを満たす場合。

| 条件 | 理由 |
|---|---|
| 一次判定（機械的リスク判定）に該当した | 変更内容そのものがリスクカテゴリに触れている。人間が確認する際の判断材料としてレビュー結果が要る |
| 差分が大きい（10ファイル以上 **または** 500行以上） | 複数領域にまたがる変更は、パスパターンに引っかからなくても影響範囲の読解が要る |
| 対応Issueに共有知識への追加提案コメント（`<!-- shared-knowledge-proposal -->`）がある | 提案の審査は`claude-review`だけが行う。スキップすると`shared-knowledge-propose.yml`の起点となる`<!-- shared-knowledge-verdict:approved -->`コメントが投稿されず、提案が永久に未審査のまま残る |
| 対応Issueに既に`00.check-user`が付いている | ユーザーが確認待ちの状態であり、判断材料としてレビュー結果が役立つ |
| 対応Issue番号を特定できない（ブランチ名が`issue-<番号>`規約外） | この場合`auto-merge`自体もスキップされる。安全側に倒してレビューを実行する |

差分規模の算出では`pnpm-lock.yaml`・`package-lock.json`をファイル数・行数の双方から除外する。
自動生成されるlockファイルは依存を1つ追加しただけでも数百行動くため、除外しないと
「依存を1つ足しただけの小さなPR」が常に差分規模の閾値を超えてしまう。

設計上の注意点は次の3つ。

- **差分規模は`00.check-user`の判定には影響させない。** 差分が大きいことは「レビューを読みたい」
  理由にはなるが「マージを止める」理由ではないため、`risk-check`内では機械的リスク判定の
  フラグ（`RISKY`）とレビュー実行ゲートのフラグ（`NEEDS_REVIEW`）を別々に持っている。
  閾値超過だけでは`00.check-user`は付かず、レビュー結果が問題なければそのまま自動マージされる。
- **`auto-merge`ジョブは`claude-review`がskipされても進む必要がある。** `needs`の既定動作では
  依存ジョブがskipされると後続もskipされるため、`auto-merge`の`if`で
  「`claude-review`が`success`または`skipped`」を明示的に許容している。`failure`のときは
  従来どおり自動マージしない。
- **`always()`ではなく`!cancelled()`を使う。** `always()`はワークフローのキャンセル時にも
  ジョブを実行してしまう。本ワークフローは新しいpushが来ると古い実行をconcurrencyで丸ごと
  キャンセルする（#818）ため、`always()`にするとsupersededになった古い実行がauto-mergeを
  有効化してしまう。

判定結果（実行するかスキップするか、その理由、差分規模と閾値）は`risk-check`ジョブの
Job Summaryに出力される。スキップした旨をPRやIssueへコメント投稿はしない。低リスクPRは
そのまま自動マージされるため、毎回コメントが増えるとノイズになるだけだからである。

なお、この閾値（10ファイル / 500行）は`risk-check`ジョブの`env`（`REVIEW_FILE_THRESHOLD`・
`REVIEW_LINE_THRESHOLD`）で定義している。リポジトリごとにPRの粒度が違うため、
他リポジトリへ移植する際はここを調整する。


## ワークフローファイルを変更するPRではclaude-reviewが必ずスキップされる

`claude-code-action`には、**ワークフローファイルの内容がリポジトリのデフォルトブランチ
（issue-deckでは`develop`）の同ファイルと完全一致していなければ、Claudeの実行だけを
スキップする**という検証機構がある。ワークフローファイルを書き換えたPRから、そのPR自身の
内容でClaudeを動かせてしまうと任意のプロンプト・任意の権限で実行できてしまうため、
それを防ぐためのもの。

そのため`.github/workflows/`配下を変更するPRでは、`claude-review`ジョブのClaudeステップが
次の警告を出して必ずスキップされる。

```
##[warning]Skipping action due to workflow validation: Workflow validation failed.
The workflow file must exist and have identical content to the version on the
repository's default branch.
```

**注意すべきなのは、このときステップもジョブも`success`で終わることである。** `claude-review`
ジョブが成功していても、レビューが実際に行われたとは限らない。実際に行われたかどうかは、
PRにレビューコメントが投稿されているか、あるいは「Claude使用量をJob Summaryに出力する」
ステップが`execution_file`が空でskipされていないかで判別する。

この挙動による運用上の帰結は次の2つ。

- **ワークフロー変更はマージ前に完全には検証できない。** ワークフローファイルへの変更が
  実際にClaudeの挙動へどう効くかは、デフォルトブランチへマージされて初めて確認できる。
  ワークフロー変更PRでは、Claudeを介さない部分（シェルスクリプトによる判定ロジック・
  ジョブ間の`needs`/`if`の依存関係など）をローカルで検証しておき、Claude側の挙動は
  マージ後の次のPRで確認する、という二段構えになる。判定ロジックのローカル検証方法は
  ステップの`run`を抽出して`gh`をスタブ化する形が使えるが、`env`の定義漏れはこの方法では
  捕まらないため、`env`にキーが存在することは別途確認する（#929で実際に見逃した）。
- **安全網は`risk-check`側が担保している。** `risk-check`は`.github/workflows/**`の変更を
  機械的リスク判定の対象にしており、ワークフロー変更PRには必ず`00.check-user`が付いて
  自動マージがスキップされる。したがって「レビューが行われないまま自動マージされる」
  事態にはならない。ワークフロー変更PRでレビュー結果が無いのは想定どおりの状態であり、
  人間の確認で代替する。

実例: PR #1048（本ゲート機構の導入PR）の
[run 31477646748](https://github.com/guchi-apps/issue-deck/actions/runs/31477646748)。
`risk-check`が`.github/workflows/**`の変更を検知して`00.check-user`を付与し、ゲート判定は
`claude-review`を実行する側に倒れ、ジョブ自体も`success`で終わったが、Claudeの実行は
上記の検証機構でスキップされており、PRへのレビューコメントは投稿されていない。


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
- **CI完了待ち（`wait-for-ci`ジョブ）**: `risk-check`・`claude-review`はいずれも`wait-for-ci`ジョブに`needs`で依存しており、`ci.yml`（ワークフロー名`CI`）がそのPRのhead SHAに対して`completed`になるまで待ってから起動する。CIが`in_progress`のうちに`00.check-user`が付き、issue-deck画面上で時期尚早に「要確認」と見えてしまう問題を防ぐため（#810）。20秒間隔・最大60回（約20分）ポーリングし、タイムアウトした場合もジョブ自体は失敗させずそのまま後続へ進める（fail-open。失敗させると`risk-check`/`claude-review`がskipされ、レビュー自体が行われないまま放置される事故につながるため）。なお実際のマージ可否は`auto-merge`ジョブがGitHub Auto-merge機能（`develop`の`required_status_checks`でCI完了を待つ）に委ねているため、`wait-for-ci`の有無に関わらずマージの安全性自体は保たれる。
- **一次判定（機械的、`risk-check`ジョブ）**: `git diff --name-only origin/develop...HEAD` のパスを、上記カテゴリに対応するパターン（`prisma/migrations/**`, `.env*`, `.github/workflows/**`, `**/auth/**`）に照合する。`package.json`は変更前後の`dependencies`/`devDependencies`をNode.jsで比較し、メジャーバージョンが変わった依存があるかで判定する（パッチ・マイナー更新は対象外）。あわせて、共有知識リポジトリのcheckout先である`.shared-context/`（`.gitignore`済み）が差分に混入していないかも確認する。従来はこの確認を`claude-review`のプロンプトだけが担っていたが、`claude-review`は低リスクPRではskipされるようになった（#992）ため、機械判定側にも同じ確認を置いている。ヒットしたら対応Issueに`00.check-user`を自動付与する。
- **二次判定（`claude-review`ジョブ、意味的）**: パターンに引っかからない意味的リスク（例: 認可ロジックの変更だがファイルパスに`auth`が含まれない）をレビューエージェントが読解して判断し、該当時は同様に`00.check-user`を付与する。ただしこのジョブは全PRで実行されるわけではなく、`risk-check`ジョブの`needs-review`出力によってゲートされる（後述「Claude Reviewの実行要否を`risk-check`でゲートする」、#992）。
- **明示的指定（`risk-check`ジョブ、`22.merge-confirm-required`・`24.screenshot-required`ラベル）**: 変更内容によらず、対応Issueに`22.merge-confirm-required`または`24.screenshot-required`ラベルが付いている場合は常に`00.check-user`を付与する（「developへのマージ前確認要否をIssueラベルでトグルする」参照、#366・#567）。
- **`00.check-user`を両判定共通の「マージ保留」シグナルとして使う**: `auto-merge`ジョブは`risk-check`・`claude-review`の完了後、対応Issueに`00.check-user`が付いていないことだけを確認して`gh pr merge --auto --merge`（Auto-merge機能。リポジトリ設定で有効化済み）を実行する。判定ロジックとマージ可否判断を疎結合に保つことで、判定方法を追加・変更してもマージ側のロジックは変えずに済む。必須ステータスチェック（`develop`の`lint-and-build`）待ちのポーリングは自前実装せず、GitHub Auto-merge機能に任せる。
- **手動マージ時の`00.check-user`除去**: `00.check-user`が付いたPRは自動マージがスキップされ、人間がPRリンクから手動マージする運用になる。このマージ操作自体が確認完了を意味するため、`.github/workflows/issue-labels.yml`の`develop-pr-merged`・`develop-merge-sweep`・`main-pr-merged`の各ジョブは、状態遷移とあわせて`00.check-user`も除去する（#266）。
- **同一PRへの連続pushでのコメント重複防止**: 実装エージェントが追加修正等で同一PRに連続してpushすると、そのたびに`risk-check`ジョブが再実行される。ラベル自体はpushのたびに再付与して確認ゲートを確実に保つが、そのpush開始時点で対応Issueに既に`00.check-user`が付いていた場合はコメント投稿のみ省略する。実装がまだ進行中の段階で同内容の「developへのマージ前にユーザーの確認が必要」コメントが繰り返し投稿され、作業中なのか確認待ちなのか紛らわしくなる問題を防ぐため（#594）。
