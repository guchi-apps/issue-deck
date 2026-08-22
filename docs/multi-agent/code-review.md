# リポジトリ全体のコードレビュー

画面から1リポジトリまるごとのコードレビューを走らせ、指摘をカードで読んでIssueにする仕組み（#698）。
Claude Codeの`/code-review`に当たるものを、フリートの盤面（issue-deck）の側へ置いたもの。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## 経路

```text
画面「レビューを実行」（CodeReviewDialog）
  ├ レビューIssueを1件作成（[レビュー] <repo>（YYYY-MM-DD））
  ├ 依頼コメントを投稿（<!-- issue-deck-code-review -->）
  └ ジョブを積む（kind=CODE_REVIEW）
        → scripts/subpc-dispatch-poller.sh
        → scripts/start-code-review.sh
              origin/develop のスナップショットを読み取り専用で読む
              claude -p を1回（scripts/prompts/code-review-agent.md）
        → gh issue comment でレビューIssueへ結果を投稿
              （<!-- issue-deck-code-review-report -->）
  → 画面が結果コメントを読んで指摘カードにする（CodeReviewPanel）
  → カードの「Issueを作成」→ 埋まった新規作成ダイアログ
```

## 記録はGitHubのIssue1件にする

**issue-deck側にレビュー専用のテーブルも取得口も作っていない。** レビュー1回につきIssueを1件立て、
指摘はそのIssueへのコメントとして返す。横断質問（#1454）と同じ形。

こうすると、**コメントのMarkdown描画・未読の印・スマホの詳細画面・順番待ちの取り消し**が
既存の仕組みのまま効く。DBに持つ形にすると、同じものをもう一式作ることになる。

**そのまま効かないものもある**（G1のレビューで指摘されたので明記しておく）。

| 付いてこないもの | 理由 | 代わりの受け方 |
| --- | --- | --- |
| セッションの通知（Signaly） | フック（`session-notify.sh`）を付けない。実装セッション用の経路へ載せると、同じIssueに受付・締めのコメントが二重に出る（計画レビューと同じ） | 結果はIssueコメントとして残る（未読の印は付く）。固まった場合は下の実行時間の上限で必ず終わる |
| 走っているセッションの中止（`KILL`・`INTERRUPT`） | pollerが組み立て直すセッション名は`<repo>-issue-<番号>`で、`-code-review-`は照合に通らない | 順番待ち（`QUEUED`）のジョブは画面から取り消せる。走り始めたレビューは上限（既定45分）で終わる |
| `dispatchPendingAt`由来の「実行中」表示 | ジョブはセッションが立った時点で閉じるため、レビュー本体が走っている間は残らない | 依頼コメントに対する結果コメントの有無で「レビュー中」を出す（`isCodeReviewPending`） |

**記録先はレビュー対象のリポジトリで、選ばせない。** 横断質問が専用の`question`リポジトリを
既定にしているのは参照範囲が全リポジトリだからで、こちらは対象が1つに決まっている。
指摘とコードが同じ場所にある方が後から辿れる。

代償として、レビューを回すほど対象リポジトリのIssueが増える。そのぶんは
**「コードレビュー」ビュー**（`view=code-review`）へ寄せ、「未着手」「実行中」からは除外している
（`excludeCodeReviews`。質問Issueと同じ扱いで、実装フローに乗らないIssueが盤面に溜まらないようにする）。

## 結果の書式

画面が読むのは`parseCodeReviewReport`（[`src/lib/github/code-review.ts`](../../src/lib/github/code-review.ts)）。
指示しているのは[`scripts/prompts/code-review-agent.md`](../../scripts/prompts/code-review-agent.md)。

```markdown
<!-- issue-deck-code-review-report -->
読んだコード: guchi-apps/issue-deck origin/develop 9b25283b・2026-08-22

（総評）

### [重大] 指摘の見出し

- 種別: correctness
- 場所: src/lib/dispatch/dispatch-job.ts:412

（本文）
```

- **重要度は`重大`・`中`・`軽微`の3つだけ。** ほかの語で書かれた見出しは指摘として拾わない。
  段を増やすと、色も判断も1対1で対応しなくなる
- **機械可読のためのJSONブロックは持たせない。** 持たせると人が読まない塊がコメントに並び、
  書式が2つになって片方だけ崩れる。GitHubでそのまま読める形の中から読み取る
- **書式が崩れていても結果は隠さない。** 指摘を1件も拾えなかった場合は総評だけをパネルに出し、
  詳細はコメント欄で読む（パネルを作れないことを理由に、投稿された結果そのものを画面から消さない）

## プロンプトの解決順と、選べるリポジトリ

プロンプトは**対象リポジトリの`scripts/prompts/code-review-agent.md` → 無ければissue-deckの
同名のテンプレート**の順で解決する（実装セッション・計画レビューと同じ考え方）。計画レビューが
フォールバックに別名（`generic-plan-review-agent.md`）を使っているのと違い、**こちらは同じ
ファイル名をそのまま落とし先にしてある**——リポジトリごとに置き換えたいのは文面だけで、
汎用版と専用版で中身を分ける理由が無いため。名前が同じなので「汎用版が見つからず起動できない」
状態も作れない。

ダイアログのリポジトリの選択肢は`canCodeReviewRepository`で絞る。判定に使うのは画面が
持っているホストの申告（応答している・レビューに対応している・そのリポジトリを持っている）で、
`listDispatchRunnableRepositories`（リポジトリ一覧の印に使う、申告の和集合）は使わない。
**あちらは構成の表示のためにホストの死活を見ない**ので、選択肢の判定に使うと、サブPCが
落ちている間も選べてしまい押した後で断ることになる。

## 指摘の起票はエージェントに任せない

レビューのセッションには`gh issue create`を渡していない（`CODE_REVIEW_ALLOWED_TOOLS`）。
書けるのはレビューIssueへの結果コメントだけ。

**指摘をIssueにするかどうかは、結果を読んだ人がカードの「Issueを作成」で決める。** 押しても
その場では起票せず、対象リポジトリ・タイトル・本文を埋めた新規作成ダイアログが開くだけ
（実機設定の切り出し・#2021と同じ立場）。レビューの質は回ごとにばらつくので、自動で立てると
数十件のIssueが盤面へ積まれる方が損になる。

## 実行の制約

| 項目 | 値・理由 |
| --- | --- |
| 対象リポジトリ | サブPCにチェックアウトがあるものだけ（`repository_not_runnable`）。読むコードがそこにしか無い |
| 参照先 | `origin/develop`（無ければ`origin/main`）のスナップショット。置き場は`~/apps/issue-deck-worktrees/.code-reviews`で、横断質問・計画レビューとは分ける |
| 同時実行 | `DISPATCH_MAX_CODE_REVIEWS`（既定2）。セッション名が`-issue-`の規約から外れるため`DISPATCH_MAX_SESSIONS`には数えられない |
| 実行時間 | `ISSUE_DECK_CODE_REVIEW_TIMEOUT_SECONDS`（既定2700秒＝45分）。フックを付けていないので、固まっても誰も気づけない。上限で必ず終わる形にする |
| 指摘の件数 | プロンプトで目安10件。全部挙げるより重い順に並べる方が役に立つ |
| poller | `codeReviewCapable`を申告したホストにだけ配る。未申告（＝ランチャーが同期されていない）は「できない」側へ倒し、ダイアログの選択肢の側で理由を出す |

**参照スナップショットの置き場を分けているのが要点。** 横断質問・計画レビューのスナップショットは
起動のたびに別のコミットへ貼り替えられる。リポジトリ全体を読んでいる最中に足元が変わると、
指摘のファイル:行がその場でずれる。分けておけば、貼り替える可能性があるのは同じリポジトリの
別のレビューだけになり、その1点はランチャー側のガード（`code_review_sessions_alive_for`）で塞げる。

## セッション名

`<リポジトリ名>-code-review-<Issue番号>`。**実装セッションの`<リポジトリ名>-issue-<番号>`とは
別の形**にしてある（計画レビューと同じ理由）。pollerのセッション報告・本数の計上・停止／終了の
突き合わせはすべて`-issue-`の規約に依存しており、そこへ混ざると実装セッションのつもりで
レビューを畳むことになる。

## 変更したときに一緒に見る場所

- 種別を足す・変える → `prisma/schema.prisma`（`DispatchJobKind`と`DispatchHost`の`*Capable`）＋
  マイグレーション・`src/lib/dispatch/dispatch-job.ts`（種別の型・`parseDispatchJobKind`・
  `SESSION_LAUNCH_JOB_KINDS`・状態と拒否理由の文言）・`src/lib/dispatch/jobs.ts`
  （`toHostView`・払い出しの`launchKinds`・`announceDispatchHost`・積む関数）・
  `src/app/api/dispatch/route.ts`・`src/app/api/dispatch/hosts/route.ts`・
  `scripts/subpc-dispatch-poller.sh`（申告・種別の分岐・版数）。
  **`SESSION_LAUNCH_JOB_KINDS`の中身はテストにリテラルで写してある**
  （`jobs.test.ts`・`session-close.test.ts`の`kind: { in: [...] }`）ので、足すとそこも落ちる。
  落ちるのは正しい挙動で、**払い出しと枠の計算と取り消しが同じ集合を見ていること**の確認になる
- 結果の書式を変える → `scripts/prompts/code-review-agent.md`と`src/lib/github/code-review.ts`を**必ず両方**。
  片方だけ変えると、投稿はされるのにカードにならない（画面からは「レビュー中のまま」に見える）
