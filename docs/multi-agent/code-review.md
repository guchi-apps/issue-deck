# リポジトリ全体のコードレビュー

画面から1リポジトリまるごとのコードレビューを走らせ、指摘をカードで読んでIssueにする仕組み（#698）。
Claude Codeの`/code-review`に当たるものを、フリートの盤面（issue-deck）の側へ置いたもの。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

**画面には「コードレビュー」と名の付くものが2つあり、これはそのうちの片方**（#2914）。

| | 何を見るか | どこに出るか |
| --- | --- | --- |
| リポジトリ全体のレビュー（このドキュメント・#698） | 1リポジトリまるごと。指摘1件＝1カードで「Issueを作成」まで持つ | レビューIssueの詳細（`CodeReviewPanel`） |
| develop向けPRの自動レビュー（#2849） | そのPRの差分。判定と本文を読み、そのまま修正依頼へ渡す | PR詳細（`PullRequestReviewFindings`・`PullRequestFixIssueBar`。#3333）。設計は[docs/code-map.md](../code-map.md)の「developへマージする直前は…」 |

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

「コードレビュー」ビューは、**未実装などの他のビューと同じく、既定ではオープンのIssueだけ**を
並べる（#3141）。完了の合図はcloseなので、読み終えたレビューは一覧から外れる。

- **close済みのレビューは一覧に出ない。** `LABEL_FILTER_PRESETS`の`code-review`は`state`を
  持たず（既定＝open）、`IGNORE_FILTER_VIEWS`に入っているので、状態の絞り込みを「すべて」に
  しても既定へ戻る（質問ビューと同じ）。読み返すときは「すべてのIssue」（状態=すべて）と
  GitHubから読む。**#2855では過去の結果を読み返す場所として`state: "all"`にし、「未完了は全部＋
  完了した新しい20件」（`limitCodeReviewHistory`）と件数の内訳（`未完了N件`）を持たせて
  いたが、#3141で戻して両方とも削除した**
- 左メニュー・スマホのビュー切替の数字と一覧のヘッダーの件数は、どちらも並んでいる行数
  （＝open）になる（保留中は`保留中N件`を添える）
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

## 全指摘が対応済みなら自動でcloseする（#3216）

一覧の完了の合図はclose（#3141）だが、行が`対応済み n/n`になっても人がcloseするまで一覧に
残っていた。**画面が「対応済み」と数えたものと同じ判定で、巡回がレビューIssueを`completed`で
閉じる**——閉じたものは上の仕様どおり一覧から外れ、閉じるときに理由をコメントで残す。

- **相乗りする先は進捗の巡回**（`runProgressSweep`。約5分間隔・poller経由。
  [subpc-dispatch.md](subpc-dispatch.md)）。専用のエンドポイントもpollerの呼び出しも足していない。
  判定は`code-review-close-sweep.ts`（純関数）、IOは`code-review-close-sweep-run.ts`
- **閉じる条件は、結果が返っていて、指摘が1件以上あり、その全部が起票済みでcloseされていること**
  （`summarizeCodeReviewFindingProgress`の`resolved === total`。画面のチップと同じ関数）。
  `指摘なし`（0件）は閉じない。**判定の弱点も画面と同じ**で、見出しを書き換えたIssueは「未起票」、
  `not planned`のcloseも「対応済み」に数える。画面で`対応済み`と出ているものだけを閉じる、を優先し、
  自動closeのためだけに厳しい別判定を持たない（行の見た目と食い違うため）
- **探し先はissue-deckのDB。** 開いている`[レビュー] `Issueと、指摘の見出しに一致するIssueのstateは
  DBから引く。結果の要約は画面と同じプロセス内キャッシュ（`code-review-report-cache.ts`）を共用し、
  キャッシュに無いときだけコメントを取る
- **閉じると決めた後に、次の3つを確かめてから閉じる**（要約のキャッシュは最大5分遅れうるため）。
  (1)コメントを取り直し、**結果の後に再レビューの依頼が来ていない**こと
  （`findLatestCodeReviewReport`は最後の結果を返すので、再レビュー中でも旧結果が`reported`に見える）
  (2)取り直した結果の指摘の並びが判定時と同じであること (3)**人が開け直したことが無い**こと
  （`hasReopenedEvent`。開け直したものは閉じ直さず、プロセスが生きている間は確認も出さない）。
  確かめられなかったものは閉じず、次の巡回で引き直す
- 進捗の巡回の結果には`code_review_closed`として出る。見送りの理由のうち平常時に毎巡起きるもの
  （結果待ち・指摘0件・未対応あり）は数えず、閉じると決めた後に止まったものだけを`skipped`へ数える

## リポジトリ別のレビュー状況（#3092）

一覧の先頭に「リポジトリ別のレビュー」枠を置き、**どのリポジトリをいつレビューしたか**と
**前回のレビュー以降に入ったPRの件数**を並べる。一覧が時系列に並ぶだけでは、しばらく
レビューしていないリポジトリがどこか読み取れなかったため。枠は
従来の緑の帯（#698の起動口）を統合したもので、Issueが0件でも出る。**実行の入口は各行の「実行」だけ**で、
見出しに別の「レビューを実行」は置かない（#3125）。

- 1行が1リポジトリ。直近12週の帯に点（レビュー1回。白抜きは結果待ち）、前回の日付・経過日数・
  回数、前回以降に入ったPRの件数（**数字だけでグラフにしない**）、「実行」
- 載せるのは**いまレビューを実行できる（サブPCにチェックアウトがある）か、過去にレビューした
  ことがある**リポジトリで、左メニューで非表示にしたものは除く。並びは前回からの経過が長い順で、
  未実施が先頭。30日以上空いた行と未実施は橙
- **実施日はレビューIssueの作成日時で数え、状態で絞る前の全件（close済みを含む）から数える**
  （シェルが`codeReviewIssues`として渡す）。close済みで一覧から外れた古いレビューも実施の記録
- 行を押すと**そのリポジトリのレビューだけに一覧が絞られ**、各行に「前回から PR n件」（ひとつ前の
  レビュー〜そのレビュー。最初のレビューは「初回」）が出る。**このビューは上部の絞り込みが
  効かない作り（#1750）なので、選択はURLへ載せず一覧（`IssueList`）の中だけで持つ**
- **行の領域には高さの上限（`max-h-[45dvh]`）を置き、超えた分は枠の中でスクロールさせる**（#3113）。
  枠は`shrink-0`で、上限が無いと「すべて表示」で全行が画面を占めきり、下のレビュー結果の
  一覧が押し出されて見えなくなる（スマホで顕著）。見出し・「たたむ」は行の領域の外なので常に届く
- **たたんでいる間は行の一覧も凡例も出さず、見出しと「すべて表示（N件）」だけにする**（#3125。
  既定はたたんだ状態で、開閉は端末に覚える）。件数に関わらず同じ動きで、絞り込み中の行だけは
  解除できるようたたんでも残す。開くと一覧と「たたむ」が出る
- 行の「実行」で開くダイアログ（`code-review-dialog.tsx`）は**対象リポジトリを選ばせない**（#3125）。
  対象は開く時点で決まっているので名前だけを出す。サブPCにチェックアウトが無いリポジトリが渡っても
  押す前に断る
- 行の組み立ては`src/lib/code-review-repo-overview.ts`（純関数）、描画は
  `code-review-repo-overview.tsx`

**PRの件数は検索APIの`total_count`だけを読む**（`src/lib/github/merged-pr-count.ts`）。
一覧を引いて数えると、週100件近く入るリポジトリでは前回のレビューまで何ページも遡ることになる。

- 数えるのは**リポジトリの既定ブランチ（fleetでは`develop`）へマージされたPR**
  （`base:<defaultBranch>`）。develop→mainのリリースPRは中身の二重計上になるので数えない。
  **headでは除けない**——リリースPRのheadは今は`release-main/vX.Y.Z`で、以前は`develop`だった。
  リリース時にdevelopへ入るバージョン更新のPRは数に入る
- 検索APIは30回/分の制限がある。**ポーリングせず**、期間の組が変わったとき（ビューを開いた・
  レビューが増えた・リポジトリを選んだ）だけ引く。サーバー側のプロセス内キャッシュは、
  終わりのある期間（過去の区間）は持ち続け、「前回から今まで」だけ10分で捨てる。1回に受ける
  期間は25件まで。取れなかった行は「—」

```text
一覧（CodeReviewビュー・IssueList）
  → buildCodeReviewRepoRows（レビューIssueをリポジトリごとに束ねる）
  → useCodeReviewMergedPrCounts（期間の組が変わったときだけ）
  → GET /api/code-review/merged-pr-counts?range=owner/repo|from|to&range=...
        キャッシュにあればGitHubへ行かない
        無ければ search/issues?q=repo:X is:pr is:merged base:<既定> merged:A..B の total_count
```

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

### 無人実行を入れない枠のリポジトリは選ばせない（#3453）

**`docs`・`claude-config`・`vps`・`subpc`・`ideas`はレビューの対象外にしている。**（`ideas`は#3466で追加。構想の置き場でアプリのコードを持たない。） レビューは
「指摘→Issueを起案→そのIssueで実装して直す」流れの入口だが、この5つは無人実行を入れない枠
（[supported-repositories.md](../supported-repositories.md)）で、その流れを想定していない
（`docs`は格上げ判定エージェントが反映する共有知識、`claude-config`は`main`直行の個人設定、
`vps`・`subpc`は`main`へ入ると実機へ反映される設定）。サブPCにチェックアウトがあるため、
以前は選べてしまい、指摘から実装の当てが無いIssueが積まれていた。

判定は`resolveCodeReviewRejection`の`repository_excluded`で、**ホストの状態より先に見る**
（どのホストを選んでも押せるようにはならない）。画面の「実行」とAPI（`enqueueCodeReviewJob`）が
同じ関数を通るので、両方で断る。一覧は`src/lib/code-review-excluded-repos.ts`の固定リストで持つ
——`Repository`に種別の列は無く、`hasClaudeWorkflow`で絞ると`question`のような別の理由で
無人実行を入れていないものまで外れる。**同じ枠のリポジトリを増やしたら、このリストへも足す。**
過去にレビューしたものは、リポジトリ別の枠に「実行」の無い行として残る。

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
そのまま直列で作成する。**ラベルは自動で付き**（#3417。種別は`/api/issues/suggest`で指摘ごとに判定、優先度は重要度から。判定に失敗したら`51.improvement`。設定UIは無い）、担当者は付けない。「作成後に次の5時間枠へ予約する」をONにすると、作成した分を`POST /api/nightly-run`へ積む（実行先はリポジトリの担当ホスト、モデルは選択式）。予約の失敗はIssueの作成を巻き戻さず、押し直しで積み直せる。個別に直したい指摘があれば従来どおり
1件ずつの「Issueを作成」を使う。確認ダイアログを開く時点で軽微（`low`）は既定で選択を外す
——重大・中を優先して選ばせるための初期値で、選び直せば軽微も含められる
（`BulkCreateCodeReviewIssuesDialog`）。

## 実行の制約

| 項目 | 値・理由 |
| --- | --- |
| 対象リポジトリ | サブPCにチェックアウトがあるものだけ（`repository_not_runnable`）。読むコードがそこにしか無い。無人実行を入れない枠の5つは除く（`repository_excluded`。上記） |
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
- 自動closeの条件を変える → `src/lib/github/code-review-close-sweep.ts`（判定）・
  `code-review-close-sweep-run.ts`（IO）。**「対応済み」の数え方そのものは
  `summarizeCodeReviewFindingProgress`が持ち、画面のチップと共用**なので、そちらを変えると
  自動closeの対象も動く
- 一覧の結果表示を変える → `src/hooks/use-code-review-reports.ts`・
  `src/app/api/issues/code-review-reports/route.ts`・`src/lib/github/code-review-report-cache.ts`・
  `src/components/dashboard/code-review-result-badges.tsx`。**バッジの見た目はIssue詳細の
  パネルと共用**なので、色や文言を変えると両方に効く
