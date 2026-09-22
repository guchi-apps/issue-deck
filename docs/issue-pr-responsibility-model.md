# Issue・PRの責任モデルと開発ライフサイクル

**いつ読むか**: Issueを起票する・分解するとき。PRを作成する・レビューするとき。
「このIssueはもう完了か」「このPRでIssueが閉じるか」を判断するとき。

issue #3334 の設計ドキュメント。IssueDeckにおけるIssueとPull Requestの関係は個別機能として
段階的に実装されてきたが、全体を貫く責任モデルと運用規則が明文化されていなかったため、
既存の実装・運用ルールを1つの文書へ集約する。

**このドキュメントは新しい仕組みを作るものではない。** ほとんどの規則は既に別々の場所
（`CLAUDE.md`・各種`docs/`・実装エージェント用プロンプト）で実装・運用されている。ここでは
それらを1箇所から見渡せるようにし、実装または既存状態へのマッピングを明記する。

画面上でIssue詳細・PR詳細のどちらが何の操作を持つか（マージ・修正依頼などの操作責任の分離）は
#3333 で別途定義した（`src/components/dashboard/issue-pull-request-list.tsx`のコメント
「Issue詳細は『何を完了させるか』、PR詳細は『変更をどう統合するか』」参照）。このドキュメントは
それより一段上の、Issue・PRという概念そのものの責任と状態を扱う。

## 基本原則

- **Issueは「何を・なぜ作るか」の契約**
- **PRは、その契約を「どのように実現したか」の証拠**
- GitHubをIssue・PR・コード・レビュー履歴の正本とする
- IssueDeckは、IssueとPRの関係、進捗、次に必要な操作を分かりやすく表示する
- **PRがマージされたことと、Issueの完了は同義にしない**

## IssueとPRの責任

| 項目 | Issueの責任 | PRの責任 |
|---|---|---|
| 目的 | 解決したい課題・利用者価値 | Issueを満たす変更の提供 |
| 内容 | 要件、完了条件、対象外、制約 | 実装方法、変更点、影響範囲 |
| 判断主体 | ChatGPT＋ユーザー | 実装エージェント＋レビュー担当 |
| 技術詳細 | 実装を制約するために必要な事項 | 設計判断と採用理由 |
| 検証 | 何を満たせば完成か | テスト結果、画面、動作証跡 |
| 完了 | すべての完了条件を満たしたとき | レビュー後にマージされたとき |

## 担当ごとの責任

| 担当 | 責任 |
|---|---|
| ChatGPT（AIDE経由の起票を含む） | 要件整理、Issue起案、完了条件、対象外、優先順位の整理 |
| ユーザー | 仕様、UX、重要なトレードオフ、最終的な完了の判断 |
| 実装エージェント | Issueの理解、実装、テスト、PR作成 |
| レビューエージェント | Issueとの整合、品質、影響範囲、セキュリティの確認 |
| IssueDeck | Issue・PRの関連表示、進捗判定、次の操作の提示、レビュー・統合の起点 |
| GitHub | Issue、PR、コード、コメント、レビュー履歴の正本 |

## Issue・PRの分解規則

- 原則として、1 Issueは1つのユーザー価値を扱う
- 原則として、1 PRは1つの独立してレビュー可能な変更を扱う
- 小規模なIssueは1 Issue・1 PRで完結させる
- **大規模なIssueは親Issueと子Issueへ分解する。** 分割の基準・手順（承認済み分割計画からの
  サブIssue作成、`分割元: #<元Issue番号>`の記法、元Issueのクローズ）は
  [docs/multi-agent/labels.md](multi-agent/labels.md)「実装範囲が広いIssueをサブIssueに分割する」が正
- **1 Issueに複数PRが必要な場合、それぞれのPRの役割と順序はIssue詳細の対応PR一覧
  （`IssuePullRequestList`）で確認できる。** 複数PRは主に「1セッション＝1ブランチ＝1 Issue」という
  運用上の制約（[docs/multi-agent/branching.md](multi-agent/branching.md)「セッション中に作った
  新しいIssueは、そのセッションで実施しない」）により、並行ではなく**逐次**（実装→追加対応→
  コンフリクト解消、のように後続セッションが同じブランチへ積み増す）で発生する
- 実装中に見つかった別の課題は現在のPRへ混ぜず、新しいIssueとして分離する
  （各実装エージェント用プロンプトの「往復が積み上がっても見通しが立たないのは、Issueが
  大きすぎるサイン」節が既にこれを運用している）
- PRだけで仕様を変更せず、先にIssueの要件・完了条件を更新する
- コード上の単純な修正・コンフリクト解消は同じPRで処理し、新しいIssueを作らない
- 仕様判断・要件変更・大幅な設計変更が必要な場合は、PRをBlockedとして元Issueへ判断を戻す
  （`00.check-user`＋`01.check-blocked`を付けてIssueコメントで相談する運用。
  [docs/multi-agent/labels.md](multi-agent/labels.md)参照）

## Refs／Closesの使い分け（このリポジトリでの上書き）

一般的なGitHub運用では「途中PRは`Refs #123`、Issueを完了させる最終PRだけ`Closes #123`」という
使い分けをする。**issue-deckはこの一般則を採用しない。**

- **develop向けPRでは`closes #番号`/`fixes #番号`を一切使わない**（`CLAUDE.md`「PR本文
  テンプレート」）。developへマージした時点ではIssueをcloseしない運用のため、GitHubの
  自動クローズキーワードを使うと意図せずIssueが閉じてしまう。Issueが実際に閉じるのは
  `main`へ反映され、issue-deck自身が`main-pr-merged`等の経路でcloseするときだけ
  （[docs/progress-status-architecture.md](progress-status-architecture.md)参照）
- コード側もこれに合わせており、`src/lib/pull-request-list.ts`の`extractLinkedIssueNumbers`は
  `Closes`・`Refs`・`Fixes`を区別せず、本文・タイトル中の`#番号`をすべて「対応Issue」または
  「関連Issue」として一律に扱う（先頭1件が対応Issue、以降は関連Issueとして画面へ出る）
- **代わりに、「このPRでIssueが完結するか」はPR本文の「Issueを閉じるPRか、途中PRか」欄で
  明示する。** 実装エージェントはこの欄の末尾へ`<!-- issue-deck-pr-role:closing -->`
  （最終PR）または`<!-- issue-deck-pr-role:interim -->`（途中PR）を書く
  （`src/lib/github/pull-request-role.ts`）。Issue詳細の対応PR一覧はこのマーカーを読み、
  「最終PR」「途中PR」のバッジとして表示する（`IssuePullRequestList`。#3334で追加）
- マーカーが無いPR（この規則の導入前に作られたPR等）はバッジを出さないだけで、表示や判定が
  壊れることはない（後方互換性は「既存Issue・PRとの互換性」節を参照）

## 状態モデル

### Issue

**唯一の正はGitHub Projects v2のStatus**（`ProgressStatusKey`。
[docs/progress-status-architecture.md](progress-status-architecture.md)が設計の一次情報源）。
このIssueの起票時に検討した7段階の概念モデルは、追加のStatus値を増やさず既存の8段階へ
次のようにマッピングする。

| 概念モデル | 意味 | 実装（`ProgressStatusKey`） |
|---|---|---|
| 検討中 | 要件または重要な判断が未確定 | `ready`（Project未着手）＋`70.needs-decision`または`00.check-user`ラベル |
| Ready | 実装可能な情報と完了条件が揃っている | `ready` |
| 実装中 | 実装セッションが稼働中、または関連PRがまだReady for reviewではない | `planning`・`implementation` |
| レビュー中 | Ready for reviewの関連PRが存在する | `develop-pr`（PRオープン〜マージ前） |
| 確認待ち | PRはマージ済みだが、利用者確認・実機確認・本番確認などが残っている | `develop`または`release`（マージ済み）＋Issue本文の完了条件チェックリストに未消化項目がある |
| 完了 | すべての完了条件を満たしている | `done` |
| Blocked | 依存Issue、仕様判断、権限、外部作業などを待っている | 上記いずれかのStatus＋`00.check-user`＋`01.check-blocked` |

**「確認待ち」に専用のStatus値を割り当てない理由**: `develop`・`release`は「最新のPRがどう
なっているか」を表すものとして既に設計されており（
[docs/progress-status-architecture.md](progress-status-architecture.md)「`Develop PR`・
`Develop`は最新のPRの状態であり、Issueの完了ではない」）、追加対応で同じStatusへ往復するのは
正常な挙動として扱われている。ここへ「確認待ち」を独立のStatus値として割り込ませると、
GitHub Projectsのフィールド定義を全リポジトリで変更する必要が生じ、影響範囲がこのIssueの
「対象外: 各リポジトリ固有の例外を、このIssueだけで完全に統一すること」を超える。代わりに、
Issue本文の「完了条件」をGitHubのタスクリスト記法（`- [ ]`）で書けば、Issue詳細画面は
既にこれをインタラクティブなチェックリストとして表示する（`use-issue-task-list.ts`。もともと
手作業Issueの「やること」消し込み用だが、書式は汎用でどのIssueでも機能する）。**PRがマージ済み
（Status＝`develop`／`release`）なのにこのチェックリストへ未チェックの項目が残っていれば、
それが「確認待ち」の実体である。**

### Pull Request

`Draft → レビュー待ち → 修正要求／承認 → Merged`。CI待ち・レビュー実行中・コンフリクト・
Blocked・Closedは別軸として表示する。

既存実装へのマッピング（`src/lib/issue-pull-requests.ts`・
`src/components/dashboard/issue-pull-request-list.tsx`・`src/lib/pull-request-list.ts`）:

| 概念モデル | 実装 |
|---|---|
| Draft | `issuePullRequestStateLabel`が返す`draft` |
| レビュー待ち／修正要求／承認 | `AiReviewBadge`（`AI_REVIEW_SETTLED_LABEL`: レビュー完了／省略／失敗）・`MergeJudgementBadge` |
| Merged | `issuePullRequestStateLabel`が返す`merged` |
| CI待ち | `PullRequestCiStatusBadge`（`pending`／`in_progress`） |
| コンフリクト | `ConflictBadge`（`mergeable === false`） |
| Blocked | 対応Issueの`00.check-user`＋`01.check-blocked`（PR自体は「ユーザーのマージが必要」として`requiresUserMerge`が判定） |
| Closed | `issuePullRequestStateLabel`が返す`closed` |

### 状態判定上の注意

- PRがMergedでも、Issueに未完了条件があればIssueは「確認待ち」（`develop`／`release`＋
  未消化のチェックリスト）または「実装中」とする
- 複数PRがある場合、1本のPRがMergedになっただけではIssueを完了にしない（「Issueを閉じるPRか、
  途中PRか」バッジで、まだ閉じていないことを確認できる）
- 最終PR（`issue-deck-pr-role:closing`）がMergedでも、利用者確認や本番確認が必要ならIssueを
  自動クローズしない。Issueが閉じるのは`main`への反映（Status＝`done`）またはユーザー自身の
  クローズ操作のときだけ
- Issue状態とPR状態を同じフィールドへ押し込まず、別々に取得・判定・表示する（`ProgressStatusKey`
  と`IssuePullRequestStateLabel`は独立した型で、どちらもGraphQLの別のフィールドから読む）

## Issueテンプレート

最低限、次を持たせる。

- 背景・課題
- 目的・利用者価値
- 対象範囲
- 対象外
- 完了条件（GitHubのタスクリスト記法`- [ ]`で書く。「状態モデル」節の「確認待ち」判定と
  Issue詳細のチェックリスト表示の両方がこの書式に依存する）
- 制約・依存関係
- 確認が必要な判断
- 関連Issue
- 必要に応じて、画面・操作例・参考資料

**issue-deckはUI上のIssue本文テンプレート選択機能を持たない。** #1745で一度実装したが、
リポジトリ選択をユーザーが行う1画面構成へ変更した際、種別を押しただけで選んでいない値が
入る経路をなくすため#1884で廃止した（`src/components/dashboard/create-issue-dialog.render.test.tsx`
「本文テンプレートのチップを出さない」）。Issueの多くはChatGPT（AIDE経由の`aide_create_issue`）が
口述内容から起票するため、UIのフォーム選択ではなく**起票する側（ChatGPT・人・分割元Issue）が
従うべき本文構成の標準**として、上記フィールドをガイドラインで定める。

Issueの種類に応じたテンプレート差分は、既にある実例をそのまま踏襲する。UIの選択式に統一する
必要はなく、種類ごとに文書として最低限の構成が決まっていればよい。

| 種類 | テンプレート差分の実例 |
|---|---|
| 手作業 | [docs/multi-agent/manual-step-body-template.md](multi-agent/manual-step-body-template.md)（`71.manual-step`） |
| 新規アプリ立ち上げ | [docs/new-app-launch.md](new-app-launch.md) |
| 機能追加・不具合修正・調査 | 上記の共通ひな形をそのまま使う（専用の差分は無い） |

## PRテンプレート

最低限、次を持たせる。正は`CLAUDE.md`「PR本文テンプレート」節（develop宛PR向け。該当する場合の
み書けばよい項目は同節に注記あり）。

- 対応Issue
- Issueを閉じるPRか、途中PRか（`issue-deck-pr-role`マーカー。上記「Refs／Closesの使い分け」参照）
- 実装内容
- 実装上の判断と採用理由
- テスト結果（このリポジトリでは「テスト内容」の見出しで書く）
- 画面変更・動作証跡
- 影響範囲
- 未対応事項
- デプロイ・移行・ロールバック上の注意
- 確認方法
- 注意点

同じ内容は次のファイルにも複製されており、**PR本文テンプレートの文面を変えるときは全て揃える**
（`agent-language.sh`と同じ運用。[docs/multi-agent/prompts-and-models.md](multi-agent/prompts-and-models.md)参照）。

- `CLAUDE.md`（正）
- [docs/multi-agent/branching.md](multi-agent/branching.md)「実装エージェント」の責務
- `.github/prompts/implement.md`「責務」
- `scripts/prompts/implementation-agent.md`

**`scripts/prompts/generic-implementation-agent.md`（他リポジトリ向け汎用ランチャー）は対象外。**
`{{PR_POLICY_INSTRUCTIONS}}`は`src/lib/prompts/pr-policy.ts`が生成する、対象リポジトリを問わない
最小構成（対応Issue・実装内容・テスト内容・確認方法・注意点）のままにする。`issue-deck-pr-role`
マーカーはissue-deck自身の`parsePullRequestRole`しか読まないため、issue-deckのコードを
持たない他リポジトリへこの指示を配ると、書いても誰も読まないマーカーを増やすだけになる
（このIssueの対象外「各リポジトリ固有の例外を、このIssueだけで完全に統一すること」に該当）。
同様に`docs/cross-repo-setup-guide.md`のPR本文テンプレートも他リポジトリへの最小構成の展開ガイド
であり、意図的にこの拡張フィールドを含めない（各リポジトリ固有の判断に委ねる）。

## IssueDeckへの実装状況

| 要件 | 状態 |
|---|---|
| Issue詳細に関連PRを一覧表示し、それぞれの役割・状態・順序を確認できる | 実装済み（`IssuePullRequestList`）。#3334でロールバッジを追加 |
| PR詳細に対応Issue、完了条件への対応状況、Refs／Closesの種別を表示する | 対応Issueは実装済み（`pull-request-detail`）。完了条件への対応状況はIssue詳細側のチェックリストを参照する運用とし、PR詳細への複製はしない（正が2箇所に割れるため） |
| 1 Issueに複数PRがある場合、途中・最終・マージ済み・未完了を区別する | マージ済み／未完了は`IssuePullRequestStateCounts`で実装済み。途中／最終は#3334でロールバッジを追加 |
| Issue状態とPR状態を別々に表示する | 実装済み（`ProgressStatusKey`と`IssuePullRequestStateLabel`は別系統） |
| PRマージ後、Issueに残っている完了条件や確認作業を表示する | Issue本文のタスクリスト表示（`use-issue-task-list.ts`）で実装済み。専用の「完了条件パネル」は設けず、Issue本文をそのまま使う |
| PRだけで要件が変更されている場合に気づける情報構造を検討する | 検討の結果、専用の仕組みは設けない。「PRだけで仕様を変更せず、先にIssueの要件・完了条件を更新する」という運用規則で担保し、レビューエージェントがIssueとの整合を確認する責務（「担当ごとの責任」表）に含める |
| Issue／PRの新規作成時にテンプレートを利用できるようにする | Issue側はUI選択式を持たず、本ドキュメントのガイドラインをChatGPT・実装エージェントが参照する形（上記「Issueテンプレート」参照）。PR側は実装エージェント用プロンプトが本ドキュメントの構成に従う |
| エージェント用プロンプト・共有ワークフローにも同じ規則を反映する | issue-deck自身のIssueを扱う`.github/prompts/implement.md`・`scripts/prompts/implementation-agent.md`を更新済み（#3334）。他リポジトリ向け汎用ランチャー（`scripts/prompts/generic-implementation-agent.md`）は対象外（上記「PRテンプレート」参照） |
| 既存リポジトリ固有のルールがある場合は、共通規則より固有ルールを優先できるようにする | `CLAUDE.md`「参照の優先順位」が既にこの構造（Issue本文＞`CLAUDE.md`＞リポジトリの`docs/`＞共有知識）を持つ。本ドキュメントもこの優先順位の下に位置する一次情報源として扱う |

## 既存Issue・PRとの互換性・移行方法

- **既存のIssue・PR本文を一括で書き換えない**（対象外）。新しい構成は今後作成・更新するもの
  から適用する
- **`issue-deck-pr-role`マーカーが無いPRは、単にバッジが出ないだけ**で、既存の判定（マージ
  可否・状態表示）には影響しない。後方互換は`parsePullRequestRole`が`null`を返すことで自然に
  成立する（型・APIレスポンスへの追加フィールドであり、既存フィールドの意味は変えていない）
- **Project Statusの8段階（`ProgressStatusKey`）は変更しない。** 上記の7段階モデルは概念上の
  整理であり、GitHub Projectsのフィールド定義・各ワークフローの報告先は変更不要
- **既存の`docs/multi-agent/branching.md`・`docs/cross-repo-setup-guide.md`等に残る同旨の記述は
  削除せず、本ドキュメントへの参照を添える形で残す。** 実装エージェントが読む場所（プロンプト）
  は分散しているため、正本を1箇所に決めて他は要約＋リンクにする方が、各プロンプトの独立した
  参照性を壊さない

## 対象外

- GitHub自体のIssue・PR仕様の変更
- すべての既存Issue・PR本文を一括で書き換えること
- 各リポジトリ固有の例外を、このIssueだけで完全に統一すること
