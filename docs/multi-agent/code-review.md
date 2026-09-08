# リポジトリ全体のコードレビュー

画面から1リポジトリまるごとのコードレビューを走らせ、指摘をカードで読んでIssueにする仕組み（#698）。
Claude Codeの`/code-review`に当たるものを、フリートの盤面（issue-deck）の側へ置いたもの。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

**画面には「コードレビュー」と名の付くものが2つあり、これはそのうちの片方**（#2914）。

| | 何を見るか | どこに出るか |
| --- | --- | --- |
| リポジトリ全体のレビュー（このドキュメント・#698） | 1リポジトリまるごと。指摘1件＝1カードで「Issueを作成」まで持つ | レビューIssueの詳細（`CodeReviewPanel`） |
| develop向けPRの自動レビュー（#2849） | そのPRの差分。判定と本文を読み、そのまま修正依頼へ渡す | 対応PRセクションの中（`MergeApprovalActions`）。設計は[docs/code-map.md](../code-map.md)の「developへマージする直前は…」 |

材料も出す場所も別なので、片方を直すときにもう片方は動かない。

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
  → 「もう一度レビュー」→ 同じリポジトリで実行ダイアログを開き直す
```

## 記録はGitHubのIssue1件にする

**issue-deck側にレビュー専用のテーブルも取得口も作っていない。** レビュー1回につきIssueを1件立て、
指摘はそのIssueへのコメントとして返す。横断質問（#1454）と同じ形。

こうすると、**コメントのMarkdown描画・未読の印・スマホの詳細画面・順番待ちの取り消し**が
既存の仕組みのまま効く。DBに持つ形にすると、同じものをもう一式作ることになる。

**そのまま効かないものもある**（G1のレビューで指摘されたので明記しておく）。

| 付いてこないもの | 理由 | 代わりの受け方 |
| --- | --- | --- |
| セッションの状態報告 | フック（`session-notify.sh`）を付けない。実装セッション用の経路へ載せると、同じIssueに受付・締めのコメントが二重に出る（計画レビューと同じ） | 結果はIssueコメントとして残る（未読の印は付く）。固まった場合は下の実行時間の上限で必ず終わる |
| 走っているセッションの中止（`KILL`・`INTERRUPT`） | pollerが組み立て直すセッション名は`<repo>-issue-<番号>`で、`-code-review-`は照合に通らない | 順番待ち（`QUEUED`）のジョブは画面から取り消せる。走り始めたレビューは上限（既定45分）で終わる |
| `dispatchPendingAt`由来の「実行中」表示 | ジョブはセッションが立った時点で閉じるため、レビュー本体が走っている間は残らない | 依頼コメントに対する結果コメントの有無で「レビュー中」を出す（`isCodeReviewPending`） |
| 左メニュー・スマホのホームの「コードレビュー」の行に回るアイコン | 上と同じ理由。行が見ているのは一覧のデータで、そこにコメントは載っていない | 一覧の行のバッジ（後述「一覧に結果を出す」）と、開いたIssueの「レビュー中」表示で読む。**「質問」の合図（丸・回るアイコン・吹き出し）を流用しない**——同じ枠に並んでいるだけで、質問の回答待ちのあいだレビューの行まで回っていた（#2325。判定は`resolveQuestionNavSignals`へ寄せてある） |

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

## 一覧に結果を出す（#2855）

「コードレビュー」ビューは**過去のレビュー結果を読み返す場所**として扱う。

- **close済みのレビューも並べる**（`LABEL_FILTER_PRESETS`の`code-review`が`state: "all"`）。
  完了の合図はcloseなので、openだけに絞ると読み終えたレビューが画面から消える。
  ヘッダーの件数には未完了のぶんを内訳として添える（`formatCodeReviewListCount`）
- **並べるのは「未完了は全部＋完了した新しい20件」**（`limitCodeReviewHistory`。
  `src/lib/issue-stats.ts`）。**窓を持たせないと、一覧・左メニューの件数・下の取得の3つが
  同時に上限を失う**——過去を含める他のビューはどちらも窓を持っている（「最近追加した」は
  24時間、「直近本番に反映した」は最新リリース）。日数ではなく件数なのは、レビューを回す
  間隔がまちまちで、しばらく回していない期間に一覧が空になるため。切り詰めたぶんは
  「すべてのIssue」（状態=すべて）とGitHubから読める
- **行に結果のバッジを出す**（`重大 1`・`中 3`・`軽微 2` ／ `レビュー中` ／ `指摘なし` ／
  `結果なし`）。指摘の本文と「Issueを作成」は今までどおりIssue詳細の`CodeReviewPanel`が持ち、
  行に出すのは「重いものが何件あるか」だけ
- バッジの見た目は`code-review-result-badges.tsx`に1つだけ置き、詳細のパネルも同じものを使う。
  片方に書くと、同じ「重大」が場所によって違う色で出る
- **重要度の隣に指摘の対応状況を出す**（#2868。`CodeReviewProgressBadge`）。件数だけでは
  「その指摘を起案し終えたのか」が行から読めないため、`未起票 6件`／`対応 2/6`＋バー／
  `対応済み 2/2`の3通りで進み具合を出す。色は前提条件の進み具合（`manual-step-prerequisites.tsx`）
  と同じ使い分け（完了=emerald・進行中=amber・未着手=border）

```text
一覧（CodeReviewビュー・IssueList）
  → useCodeReviewReports（並んでいるレビューIssueぶんを1回だけ。ポーリングはしない）
  → GET /api/issues/code-review-reports?issues=owner/repo%23370,...
        プロセス内キャッシュ（code-review-report-cache.ts）にあればGitHubへ行かない
        無ければコメントを取り、summarizeCodeReviewComments で要約だけ返す
        要約には指摘の見出しも入る（本文は入らない）——対応状況の引き当てキー
  → 対応状況は一覧（IssueList）が手元のIssueから数える
        summarizeCodeReviewFindingProgress（引き当て先は絞り込み前の全Issue）
```

**要約の判定はIssue詳細と同じ関数**（`findLatestCodeReviewReport`・`isCodeReviewPending`）を
通す。一覧と詳細で別の判定を書くと、行では「レビュー中」なのに開くと結果が出ている、という
食い違いが起きる。

**対応状況（#2868）の判定は「同じリポジトリに、指摘の見出しと完全一致するタイトルのIssueが
あるか」**で、詳細パネルの「#123 として起票済み」（`buildCodeReviewFindingIssueIndex`）と同じ規則を
使う。closeされていれば「対応済み」で、closeの理由（`not planned`＝見送り）は区別しない。
**タイトルを書き換えたIssueや、起票せず直接直した指摘は「未起票」のまま**で、正はGitHub側の
Issue——ここは表示のための当て推量。

**数えるのはサーバーではなく一覧（`IssueList`）で、引き当て先は絞り込み前の全Issue**
（`codeReviewFindingIssues`。母集団を渡す理由は`prerequisiteReadiness`と同じで、この一覧には
レビューIssueしか並ばない）。**サーバーで数えると、起票・closeしても行が古いまま残る**——
一覧が要約を取り直す合図はレビューIssueのコメント件数の変化だけで、指摘から起票したIssueの
作成・closeでは動かないため、いちばん効いてほしい「まとめてIssueを作成した直後」に効かない。
そのぶん**要約には指摘の見出しを載せる**（本文は載せない）。`allIssues`はclose済みも含む全件
（`getIssuesForUser`は状態で絞らない）なので、一覧の自動更新がそのまま行の数字に出る。

**取得はレビューIssueの数だけGitHubを叩く。** ポーリングはせず、`Issue.commentCount`
（webhookで更新される）が変わらない間はキャッシュから返す。結果が返るとコメントが1件増えるので、
一覧の自動更新がそれを拾った時点で取り直しになる（`issue-run-cache.ts`と同じ考え方）。
**左メニューの行に回るアイコンは相変わらず出さない**——あちらが見ているのは一覧のデータで、
そこにコメントは載っていない。

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

**「まとめてIssueを作成」（#2859）も、この「人が決める」線は変えていない。** パネルの
「まとめてIssueを作成」ボタンは、まだIssueにしていない指摘の一覧から選ぶ確認ダイアログを開くだけで、
選ぶところまでは人の判断に残す。違うのは選んだ後の動きだけで、1件ずつの「Issueを作成」が
新規作成ダイアログを開いてタイトル・本文を直せる余地を残すのに対し、こちらは選択した指摘を
そのまま（ラベル・担当者は付けずに）直列で作成する。個別に直したい指摘があれば従来どおり
1件ずつの「Issueを作成」を使う。確認ダイアログを開く時点で軽微（`low`）は既定で選択を外す
——重大・中を優先して選ばせるための初期値で、選び直せば軽微も含められる
（`BulkCreateCodeReviewIssuesDialog`）。

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

**逆に、`DispatchSession`の行でセッションの生存を確かめる処理からは外す必要がある**（#2443）。
報告されないぶん、探しに行くと代わりに同じIssueの実装セッションの行に一致してしまう。
判定はissue-deck側の`SESSION_REPORTED_JOB_KINDS`（`src/lib/dispatch/dispatch-job.ts`）を正とし、
種別ごとに書き分けない。実例は期限切れジョブの救済
（[subpc-dispatch.md](subpc-dispatch.md)「起動ジョブは落とす前にセッションを見る」）。

## 変更したときに一緒に見る場所

- 種別を足す・変える → `prisma/schema.prisma`（`DispatchJobKind`と`DispatchHost`の`*Capable`）＋
  マイグレーション・`src/lib/dispatch/dispatch-job.ts`（種別の型・`parseDispatchJobKind`・
  `SESSION_LAUNCH_JOB_KINDS`・`SESSION_REPORTED_JOB_KINDS`・状態と拒否理由の文言）・`src/lib/dispatch/jobs.ts`
  （`toHostView`・払い出しの`launchKinds`・`announceDispatchHost`・積む関数）・
  `src/app/api/dispatch/route.ts`・`src/app/api/dispatch/hosts/route.ts`・
  `scripts/subpc-dispatch-poller.sh`（申告・種別の分岐・版数）。
  **`SESSION_LAUNCH_JOB_KINDS`の中身はテストにリテラルで写してある**
  （`jobs.test.ts`・`session-close.test.ts`の`kind: { in: [...] }`）ので、足すとそこも落ちる。
  落ちるのは正しい挙動で、**払い出しと枠の計算と取り消しが同じ集合を見ていること**の確認になる
- 結果の書式を変える → `scripts/prompts/code-review-agent.md`と`src/lib/github/code-review.ts`を**必ず両方**。
  片方だけ変えると、投稿はされるのにカードにならない（画面からは「レビュー中のまま」に見える）
- 一覧の結果表示を変える → `src/hooks/use-code-review-reports.ts`・
  `src/app/api/issues/code-review-reports/route.ts`・`src/lib/github/code-review-report-cache.ts`・
  `src/components/dashboard/code-review-result-badges.tsx`。**バッジの見た目はIssue詳細の
  パネルと共用**なので、色や文言を変えると両方に効く
