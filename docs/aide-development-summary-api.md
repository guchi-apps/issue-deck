# AIDE向け開発状況サマリAPI

**いつ読むか**: AIDE（MCP）からissue-deckの進捗・要対応・予約・PR・本番反映の状況を読む連携を作る・結合試験するとき。#3999。

`GET /api/integrations/aide/development-summary`は、画面の左メニューと**同じ定義**で数えた件数を、全体合計とリポジトリ別内訳で返す読み取り専用API。AIDE側で進捗の判定を再実装しない。

## 認証と対象利用者

- `Authorization: Bearer <鍵>`。鍵は共有トークン`ISSUE_DECK_DEVELOPMENT_SUMMARY_TOKEN`（無ければ環境変数`AIDE_SUMMARY_SECRET`）。**他のAPIの鍵（`IMAGE_UPLOAD_SECRET`など）は流用しない。** 未設定は`503 not_configured`、不一致・欠落は`401 unauthorized`。鍵は応答にもログにも出さない。
- **対象利用者は呼び出し側で指定できない。** 共有トークン`ISSUE_DECK_AIDE_SUMMARY_USER`（無ければ`AIDE_SUMMARY_USER_LOGIN`）にGitHubログイン名を設定し、その利用者が連携しているリポジトリを母集団にする。未設定・該当なしは`503 user_not_configured`。`userId`などのクエリは無視する。
- 設定は設定画面の共有トークンへ登録する（[shared-token-api.md](shared-token-api.md)）。登録するまでAPIは503を返す。

## リクエスト

| クエリ | 既定 | 内容 |
| --- | --- | --- |
| `repositoryFullName` | なし | 指定すると`totals`・`byRepository`・要対応をそのリポジトリに絞る。母集団に無ければ`404 repository_not_found`。**集計は常に全リポジトリを参照集合にして行い、その後で絞る**（別リポジトリの前提を失わない） |
| `from` / `to` | 直近7日（`to`=今） | 完了集計の**半開区間`[from, to)`**。ISO8601（オフセット必須）か`YYYY-MM-DD`（`timezone`のその日の0時）。最大92日 |
| `timezone` | `Asia/Tokyo` | IANAタイムゾーン。日付だけの`from`/`to`の解釈に使う |
| `category` | なし | 指定すると要対応ではなく**その区分の詳細一覧**を返す（下記の区分名） |
| `limit` | 50（最大100） | 詳細一覧の1ページの件数 |
| `attentionLimit` | 10（最大100） | 要対応の上位項目の件数 |
| `cursor` | なし | 前の応答の`nextCursor`。一覧は`updatedAt`の新しい順 |
| `includePullRequests` / `includeDeployEvidence` | `true` | `false`でGitHubへの問い合わせを省く（該当項目は`unavailable`になる） |

不正な値は`400`（`invalid_from`・`invalid_period`・`invalid_category`など）。

## 応答（既定）

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "...",
  "sourceUpdatedAt": "...|null",   // 同期済みIssueのうち最も古い同期時刻。1つでも不明ならnull
  "complete": true,                 // 取得できなかった項目も、完了履歴の不足も無いとき
  "stale": false,                   // 24時間以上同期されていない（または同期時刻不明）のリポジトリがある
  "staleRepositories": [],
  "unavailable": [],                // "pullRequests" | "pullRequests:partial" | "deployEvidence"
  "warnings": [],
  "scope": { "userLogin": "...", "repositoryFullName": null, "population": {...}, "period": {...} },
  "totals": { ... }, "byRepository": { "owner/repo": { ... } },
  "reservation": { ... }, "pullRequestsAvailable": true,
  "overlapNotes": [ ... ],
  "attention": { "items": [ ... ], "total": 12, "truncated": true, "nextCursor": "..." }
}
```

**欠損・取得失敗は`null`や`unavailable`で返し、0件で代用しない。** PRを取得できなければ`totals.pullRequests`は`null`、デプロイの証拠が無ければデプロイ状態は`deploy-unknown`。

### 項目（`SummaryItem`）

`kind`（`issue`/`pr`/`job`/`reservation`/`deployment`）・`id`（安定ID）・`category`・`repositoryFullName`/`owner`/`repo`/`number`・`title`・`url`・`reasonCode`（機械可読）・`reason`（人が読む理由）・`updatedAt`。

### 区分（`category`）と集計定義

| 区分 | 件数の単位 | 定義 |
| --- | --- | --- |
| `notStarted` | Issue | 画面の「未着手」。保留中・**予約実行に積まれたIssueは除外**（#3822） |
| `inProgress` | Issue | 画面の「実行中」（計画・実装・developPR対応）。`byProgress`に進捗別。実際の稼働ジョブ数ではない |
| `reserved` | 予約・Issue | 未起動（`QUEUED`）の次枠実行の予約。`reservations`とユニークな`issues`、エージェント別は`reservation.byAgent`。`reservation`に有効/無効・5時間枠の状態・起動を妨げる条件（`blockers`）。**枠はメモリ上の最後の値を読むだけで、取得しに行かない** |
| `checkUser` | Issue・PR | 画面の「ユーザーの確認待ち」。`issues`は**今対応できる数**、`byReason`は`01.check-*`の理由別、`excludedRunning`はエージェント稼働中で除外した数（項目の`reasonCode`は`agent-running`）。`pullRequests`は人のマージ待ちPR。保留中は除外 |
| `manualStep` | Issue | 画面の「ユーザーの作業待ち」。`actionableIssues`は前提を満たすもの、`waitingForPrerequisitesIssues`は前提待ち |
| `problems` | ジョブ・予約 | **最新の実行ジョブ1件**が`failed`/`timeout`/`stalled`（`CLAIMED`10分・`RUNNING`のheartbeat10分超）のIssue。閉じたIssue・後続ジョブがあるIssueは数えない（解消済みの過去失敗は混ぜない）。予約の起動を妨げる条件は`reservation-blocked` |
| `pullRequests` | PR | open PRの内訳。`open`が総数、`draft`、`reviewWaiting`（CI・自動マージ判定の完了待ち）、`mergeWaiting`（人のマージ待ち）、`fixWaiting`（自動レビューが要修正）、`ciFailed`、`conflict`、`unknown`（CI状態・コンフリクト有無が未取得）。**区分は重複しうる** |
| `deployment` | Issue | 画面の「本番反映待ち」。`awaitingMainIssues`（developに反映済み・main未反映）と`mainMergeInProgressIssues`（mainへのリリース中） |
| `recentCompletions` | Issue | `[from,to)`にcloseされたIssue。`reachedMain`（Status=Done）と`closed-*`（main未到達のclose・`not_planned`）を区別し、**単なるcloseを実装完了としない**。`deploySucceededIssues`は証拠があるときだけ |

### デプロイ状態の注意

main到達後のデプロイ状態は、リポジトリの`deploy.yml`の**最新1件の実行**とIssueのclose時刻の比較から推定する（`deploy-waiting`/`deploy-running`/`deploy-succeeded`/`deploy-failed`/`deploy-unknown`）。**mainへのマージを実デプロイ成功と呼ばない。** 最新より古い版の個別の成否は分からず、証拠が取れないときは`deploy-unknown`にする。

### 単位と重複

Issue・PR・ジョブ・予約は別の単位で、区分間で足し合わせない。1つのIssueが複数の区分に載りうる（例: 予約済みIssueは未着手から外れるが予約に載る）。1Issueに複数PRがあればPRの件数はPR単位、Issueの件数はIssue単位。`overlapNotes`にも同じ説明を返す。

### 母集団

`population`に、対象のリポジトリ数・Issue数・保留中の数と、**除外したアーカイブ済み・非表示のリポジトリ名**を返す。全体は画面の既定母集団（アーカイブ・非表示を除く連携済みリポジトリの全Issue）。リポジトリ別は**その内訳**で、手作業Issueの前提判定には除外前の全参照集合（全リポジトリ）を使う。確認待ちビューの「リポジトリフィルタを無視する」画面都合で全体を重複させない。

## 詳細一覧（`category=`）

`{ category, items, total, truncated, nextCursor, <共通の鮮度・scope> }`。`total`は全件数で、1ページの件数ではない。`nextCursor`を`cursor`に渡して続きを引く。要対応の上位項目（既定の応答の`attention`）は`problems`・`checkUser`（稼働中を除く）・`manualStep`（実行可能のみ）・`pullRequests`（`merge-waiting`/`fix-waiting`/`ci-failed`/`conflict`）を新しい順に並べたもので、`total`が全件数。

## 読み取り専用の担保

- ジョブの起動・予約の変更・既読化・AI推論をしない。**5時間枠は取得しない**（`peekClaudeWindowSnapshot`。推論リクエストで枠を開始しないため）。
- 停滞ジョブのTIMEOUT確定・期限切れの計画/質問要求の掃除は行わない（`listDispatchState`ほかの`sweepExpired: false`）。停滞は閾値で判定して`stalled`として返すだけ。
- 副作用として残るのは、共有トークンを読んだ記録（`SharedTokenUsage`。issue-deck自身の利用元で1件・60秒に1回）だけ。
- GitHubへの問い合わせは読み取りのみ。PR一覧は`GET /api/pull-requests`と同じ取得（installation単位のCI一括取得・ETag）で全体20秒、デプロイの証拠は完了があるリポジトリのみ並列4・各8秒で取る。応答にIssue本文・コメントは含めない。

## 結合試験の確認項目（AIDE#569）

1. 鍵なし401・誤った鍵401・未設定503。`userId`クエリを付けても対象利用者が変わらない。
2. `totals`が画面の左メニューの件数（未着手・実行中・確認待ち・作業待ち・本番反映待ち）と一致する。
3. `attention.total`と`attentionLimit`の関係（`truncated`・`nextCursor`で続きを引ける）。
4. PRを取得できないとき`totals.pullRequests`が`null`、`unavailable`に`pullRequests`が出る。
5. 期間の境界（`to`ちょうどのcloseは含まれず、`from`ちょうどは含まれる）と`timezone`、完了履歴が不足するときの`complete: false`。
6. 呼び出しの前後でジョブ・予約・AI利用枠・既読状態が変わらない。
