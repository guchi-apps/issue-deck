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

## develop向けPRのCodexレビュー（#3917・#3990）

develop向けPRの自動レビューは、既存のClaude Codeに加えてCodexも同じ実行条件で確認する。CodexはGitHub Actions内で実行しない。公式の`openai/codex-action`はAPIキー課金になるため、サブPCで`codex login`済み（ChatGPTサブスクリプション）のCodex CLIを使う。

### 経路（#3990）

**状態の正本はIssueDeckの`DispatchJob`（`kind=PR_REVIEW`）**。かつてはActionsがPRコメントへ要求印を残して結果コメントが付くまで30秒×60回（最大30分）ポーリングし、サブPCが全リポジトリのopen PRを巡回して印を拾っていたが、これは廃止した（結果待ちだけのためにGitHub-hostedのrunnerを最大30分保持し、サブPC停止・巡回失敗・Codex実行中を区別できなかったため）。

```text
PR作成 / push → claude-review-develop.yml
  risk-check → review-provider（Claudeモードならここで終わり。Codexは起動しない）
  codex-review ジョブ: POST /api/dispatch/pr-review {action: request}（積んで即終了。結果は待たない）
        実行できるサブPCが無い → 409。その場で失敗（理由つき）して auto-merge を止める
  auto-merge ジョブ: POST /api/dispatch/pr-review {action: status} を読む
        pending → ラベル・コメント・自動マージを何も反映せず保留して終了
        done    → 判定（lgtm / needs-check / changes-requested）で通常の最終判定
        failed  → 自動マージせず 00.check-user ＋ 01.check-blocked（理由つき）
        stale   → PRのHEADが進んでいる。何も反映しない（新しいHEADのrunが判定する）

サブPC poller が PR_REVIEW を claim（QUEUED → CLAIMED）→ tmuxで start-codex-pr-review.sh --run
  → レビューのスクリプトが running（生存報告）→ succeeded/failed を /api/dispatch/report へ報告
  → PRへレビュー本文と判定印（issue-deck-codex-review-verdict）を投稿（人が読む記録・parser互換）

確定の報告（または巡回 POST /api/dispatch/pr-review/resume-sweep）
  → 同じrunの auto-merge ジョブだけを再実行（POST /actions/jobs/{id}/rerun）
  → auto-merge が最新のDispatchJobの状態を読み直して、最新HEADについて最終判定をやり直す
```

- **状態は`QUEUED` / `CLAIMED` / `RUNNING` / `SUCCEEDED` / `FAILED` / `TIMEOUT`（＋`CANCELED`=古いHEAD）で区別する。** PR詳細の「サブPCのAIレビュー」に、状態・host・モデル・開始時刻・失敗理由が出る。
- **起動前の失敗も30分待たず原因が分かる。** 実行できるホストが無ければ積む時点で拒否、積んだが取りに来ないものは`QUEUED`のまま5分で`TIMEOUT`（`DISPATCH_CONTROL_QUEUE_TIMEOUT_MS`）、起動後にスクリプトが落ちれば`on_exit`が`failed`を報告する。どれも`auto-merge`の再実行で`failed`として読まれ、自動マージせず人へ渡る。
- **二重レビューの防止。** `activeKey`は`pr_review:<repo>#<PR>@<head SHA>:<agent>`。同じPR・HEAD・agentの未完了・判定済みがあれば積み直さない（Actionsの再実行は最新のジョブを返し、再開先のrunIDだけを付け替える）。失敗・取り消し後の再依頼だけが新しいジョブを作る。
- **古いHEADの結果をマージ判定に使わない。** 新しいHEADを積むと、同じPR・agentの待機中（`QUEUED`）の古いジョブを`CANCELED`にする。走り出したものは止めないが、結果は`headSha`が違うので使われない。`auto-merge`も現在のPRのHEADと突き合わせ、再実行はHEADが一致するときだけ行う（再実行は同じ`concurrency`グループに入り、新しいHEADの実行中のrunをキャンセルしかねないため）。
- **`auto-merge`の再実行が、GitHub-hostedのrunnerを結果待ちで保持しない再開手段。** 比較した選択肢は、(1) 報告時の`workflow_dispatch`（callerへトリガーの追加配布が要る）、(2) check/statusを契機にするworkflow（同上）、(3) IssueDeckでの最終判定（auto-mergeの複雑な判定をサーバーへ複製することになる）。**既存のGitHub App（`actions: write`）で、callerの変更なしに、取得済みの`needs`出力を引き継げる**ジョブ単位の再実行を採った。runが実行中だと再実行できないため、巡回（pollerが毎巡`resume-sweep`を呼ぶ）で取りこぼしを拾う。10回失敗・24時間経過で諦める際は、PRへ理由を投稿する。
- **Claudeモード・Codexモードとの整合（#3988）。** Claudeモードは通常CI＋Claudeレビューのみでcodex-reviewジョブは`skipped`（状態は`skipped`）。Codexモードは通常CI＋`PR_REVIEW(agent=codex)`で、Claudeレビューは起動しない。通常のCI（build/test/lint）はAIプロバイダーと無関係に実行される。
- **移行。** 移行前の実装が残した判定印が同じHEADにあれば、新しいジョブを積まず、その判定をそのまま使う（二重に実行しない）。要求印（`issue-deck-codex-review-request`）はジョブキューとしては使わず、巡回（`--sweep`）も削除した。移行前のワークフローのrunがpoll中のPRは、そのrunがタイムアウトした後に再実行（またはpush）すれば新しい経路に載る。

### GitHub上の記録と判定の扱い

サブPCでは`codex login`済みのCodex CLIを読み取り専用・一時worktreeで実行するため、ChatGPTサブスクリプション枠を使い、実装中のworktreeやPRブランチを変更しない。結果は同じSHA付きの判定印としてPRへ投稿され（状態の正本はDispatchJobで、判定印は人が読む記録・既存parser・リリース集約との互換のために残す）、ClaudeまたはCodexのどちらかが`needs-check`・`changes-requested`なら自動マージを保留する。サブPCが応答しない、Codexが失敗する、判定を読み取れない場合も安全側で保留する。

PR本文の`issue-deck-verification:start review=...`にはClaudeとCodexの総合判定を書く。要修正、要確認、取得失敗、LGTMの順で優先し、各レビューの個別判定は節の箇条書きに残す。Codexの結果待ちの間は総合判定を確定させず（`review=unavailable`・「⏳ Codexレビューの完了待ち」）、完了後に`auto-merge`が再実行されて最終の判定に書き換わる。PR詳細とリリースPRの指摘本文も、同じコミットに対する各レビュー元の最新コメントから要修正・要確認を優先して選ぶ。後から届いた別のレビュー元のLGTMで指摘を隠さないため。

Codexが`changes-requested`の場合も、後継Issueや新しいPRは作らない。#4043以降は、安全な最新指摘に限り自動修正へ渡す。人がPR詳細から「PRを自動修正」を開始する経路も、同一head SHAに対する要修正コメントを既存の`issue-<番号>`ブランチへ渡し、修正後は同じPRを再レビューする。修正担当と条件は末尾の「実装担当に合わせたレビュー指摘修正（#4043）」を参照。PR詳細はこの過程をレビュー中・要修正・修正中・再レビュー中・レビューOK・マージ待ちとして表示する。

### デプロイの順序

この仕組みはサブPCの`poller`（`DISPATCH_POLLER_VERSION` 31）と本番のissue-deck（`/api/dispatch/pr-review`・DBマイグレーション）の両方が揃って動く。**サブPCは`develop`、本番は`main`で動く**ため、`develop`にだけ入っている間は、pollerが`prReview`を申告しても本番がまだ受け取れない。順序は「①`main`へのリリースで本番のAPI・マイグレーションを出す → ②サブPCのチェックアウトを更新して再起動（画面の「更新して再起動」）」。①より前に②をすると、巡回（`--sweep`）が無くなったpollerだけが先に新しくなり、旧ワークフロー（要求印）のPRが結果を得られない。その間のPRは`codex-review`が失敗して確認待ちになる（安全側）。

巡回側でPRのbase/head SHAを読むときは、`gh pr list --json baseRefOid`を使わない（#3943。`gh pr list`のJSONフィールドに`baseRefOid`は無い）。ジョブには積む時点（Actionsのイベント）の`base.sha`・`head.sha`が載るので、いまはpollerがGitHubへ問い合わせて取る必要が無い。develop向けのバージョンbump PRで残った未完了チェックは、同じhead SHAを使うmain向けリリースPRにも表示される。

## 経路

```text
画面「レビューを実行」（CodeReviewDialog）
  ├ レビューIssueを1件作成（[レビュー] <repo>（YYYY-MM-DD））
  ├ 依頼コメントを投稿（<!-- issue-deck-code-review -->）
  └ ジョブを積む（kind=CODE_REVIEW）
        → scripts/subpc-dispatch-poller.sh
        → scripts/start-code-review.sh（ジョブは running のまま）
              origin/develop のスナップショットを読み取り専用で読む
        → tmuxの中で scripts/run-code-review.sh（#4116）
              running の生存報告（60秒ごと）
              claude -p を1回（scripts/prompts/code-review-agent.md・上限つき）
        → gh issue comment でレビューIssueへ結果を投稿
              （<!-- issue-deck-code-review-report --> ＋ 実行の印）
        → ランナーが結果コメントの到達を確かめ、succeeded / failed / 時間切れ を報告
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
| セッションの状態報告 | フック（`session-notify.sh`）を付けない。実装セッション用の経路へ載せると、同じIssueに受付・締めのコメントが二重に出る（計画レビューと同じ） | **ランナーがジョブへ直接報告する**（#4116。下記「実行の追跡」）。結果はIssueコメントとして残る（未読の印は付く） |
| 走っているセッションの中止（`KILL`・`INTERRUPT`） | pollerが組み立て直すセッション名は`<repo>-issue-<番号>`で、`-code-review-`は照合に通らない | 順番待ち（`QUEUED`）のジョブは画面から取り消せる。走り始めたレビューは上限（既定45分）で終わる |
| `dispatchPendingAt`由来の「実行中」表示 | 実装セッション用の表示で、レビューIssueには使わない | ジョブ（`DispatchJob`）の状態と結果コメントから決める（`resolveCodeReviewRunStatus`。#4116） |
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
従来の緑の帯（#698の起動口）を統合したもので、Issueが0件でも出る。**実行の入口は「コードレビューを実行」ボタン1つ**で、
押すとリポジトリを選ぶモーダルが開く（スマホは下部シート、PC・iPadは中央のモーダル。#3529・#3719）。
各行に「実行」は置かない（#3125の「入口は1つ」を保つ）。

- 1行が1リポジトリ。直近12週の帯に点（レビュー1回。白抜きは結果待ち）、前回の日付・経過日数・
  回数、前回以降に入ったPRの件数（**数字だけでグラフにしない**）
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
- モーダルでリポジトリを選ぶと開くダイアログ（`code-review-dialog.tsx`）は**対象リポジトリを選ばせない**（#3125）。
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
| 実行時間 | `ISSUE_DECK_CODE_REVIEW_TIMEOUT_SECONDS`（既定2700秒＝45分・正の整数のみ）。`timeout`コマンドが無い・値が不正なら**起動しない**（#4116。以前は黙って上限なしで走らせ、「0で無効」も受け付けていた） |
| 指摘の件数 | プロンプトで目安10件。全部挙げるより重い順に並べる方が役に立つ |
| poller | `codeReviewCapable`を申告したホストにだけ配る。未申告（＝ランチャーが同期されていない）は「できない」側へ倒し、ダイアログの選択肢の側で理由を出す |

**参照スナップショットの置き場を分けているのが要点。** 横断質問・計画レビューのスナップショットは
起動のたびに別のコミットへ貼り替えられる。リポジトリ全体を読んでいる最中に足元が変わると、
指摘のファイル:行がその場でずれる。分けておけば、貼り替える可能性があるのは同じリポジトリの
別のレビューだけになり、その1点はランチャー側のガード（`code_review_sessions_alive_for`）で塞げる。

## 実行の追跡（#4116）

**状態の正は`DispatchJob`（`kind=CODE_REVIEW`の最新1件）と結果コメント。** 以前はpollerが
「tmuxが立った」時点でジョブを`SUCCEEDED`にし、その後の終了コード・時間切れ・投稿の成否は
どこにも残らなかった。画面は結果コメントの有無だけで「レビュー中」を出していたため、起動すら
していないレビューが何日も「レビュー中」に残った（下記「#4090・yoteiflow#1131の直接原因」）。

| 状況 | ジョブ | 画面（一覧のバッジ・詳細のパネル） |
| --- | --- | --- |
| 積んだ・受け取った | `QUEUED`・`CLAIMED` | 順番待ち |
| 走っている | `RUNNING`（ランナーの生存報告） | レビュー中（依頼・開始・最終更新・ホスト） |
| 結果コメントが届いた | `SUCCEEDED`（到達を確かめてから） | 重大n・中n…／指摘なし |
| `claude`が非0で終了・結果未投稿・投稿エラー | `FAILED`（理由とログの場所） | 失敗＋再実行 |
| 実行上限・生存報告が10分途絶（プロセス消失・ホスト停止） | `TIMEOUT` | 時間切れ＋再実行 |
| 同時実行の上限・同じレビューが動いている | `SKIPPED` | 見送り＋再実行 |
| 結果が無いのに`SUCCEEDED`（旧版pollerの起動時点の記録）・記録が無い | — | 状態不明＋再実行 |

- **判定は1つの純関数**（`resolveCodeReviewRunStatus`・`src/lib/github/code-review.ts`）。一覧は
  要約API（`GET /api/issues/code-review-reports`）がDBの最新ジョブを付けて決め、詳細は手元の
  コメントと同じAPIのジョブで決める。画面の`dispatch.jobs`は直近24時間ぶんしか持たないので、
  詳細の判定には使わない（要約が届くまでの埋め合わせだけ）。**依頼時刻の経過だけで時間切れ・完了を決めない**
- **結果の到達は実行の印で確かめる。** 結果コメントの2行目に`<!-- issue-deck-code-review-run:<ジョブID> -->`
  （プロンプトの`{{RUN_MARKER}}`）。印の無い結果（対象リポジトリ独自のプロンプト）は、その実行の
  開始以降に作られたものだけを数える。**印が最新のジョブと違う結果（再実行前の実行が遅れて
  返したもの）は、最新の実行の結果として数えない**
- **生成済みの結果は捨てない。** エージェントが投稿に失敗しても、最終応答に結果の全文があれば
  ランナーが印を付けて投稿し直す。投稿の前に毎回「もう届いているか」を確かめ、二重に付けない
- **報告の通信断から収束できる。** 終了の報告は間隔を空けて送り直す。届かずに`TIMEOUT`にされた後でも、
  ランナーの終了報告（`exitCode`付き）は`TIMEOUT`・起動時点の`SUCCEEDED`を上書きできる
  （`reportDispatchJob`。生存報告は終わったジョブを生き返らせない）。結果コメント自体が届いて
  いれば、ジョブの状態に関わらず`reported`になる
- **再実行は同じレビューIssueのまま**（`POST /api/code-review/rerun`）。先にジョブを積み（未完了の
  実行があれば`activeKey`で断る）、積めたら依頼コメントを足す。pollerは同名のtmuxセッションが
  生きていれば見送る。旧い結果・ログ・起票済みのIssueはそのまま残る
- 走り出したコードレビュー（`RUNNING`）は**実装セッションの起動枠に数えない**（`claimDispatchJobs`・
  `summarizeDispatchQueue`）。本数はpollerの`DISPATCH_MAX_CODE_REVIEWS`が絞る
- **本数の上限は生きているペインだけを数える。** ランチャーは異常終了時にペインを残す（`remain-on-exit failed`）

### #4090・yoteiflow#1131の直接原因（2026-10-07調査）

サブPCのpollerのjournal（UTC表記）に次が残っていた。

```text
Oct 06 22:10:56 ジョブ cmux8dpzv0800k161c8ol6rq6: guchi-apps/issue-deck #4090（CODE_REVIEW）
  コードレビューのセッションが上限（2本）に達しているため起動しませんでした（現在 2 本）。
Oct 06 22:11:37 ジョブ cmux8e1da080kk161acll45qe: guchi-apps/yoteiflow #1131（CODE_REVIEW）
  コードレビューのセッションが上限（2本）に達しているため起動しませんでした（現在 2 本）。
```

- 「2本」は10月2日に利用上限（`You've hit your session limit`）で終了コード1で落ち、死んだペインだけが
  残っていた`aide-code-review-536`・`morrow-code-review-442`。`count_code_review_sessions`が
  `tmux list-sessions`の名前だけで数えていたため、以降のレビューが全部見送られた
- ジョブは`SKIPPED`で終わったが、画面の`dispatch.jobs`は終了後24時間で消え、パネルは結果コメントの
  有無だけを見ていたため「レビュー中」に戻った
- 2件ともサブPCに`.code-reviews/<repo>-<番号>.log`・プロンプトは無い（＝ランチャーは走っていない）。
  CLIの終了コード・GitHubへの投稿エラーは発生していない。本番DBのジョブ行は直接は読んでいない
  （journalのジョブIDとメッセージで確認）
- 復旧: 新版の画面で2件は「見送り」と理由＋「再実行」になる。死んだペインのセッションは、新版の
  pollerでは数えられず、同名のレビューを起こすときに畳まれる

### 配布順序と旧版の混在

サブPCは`develop`、本番は`main`で動く。**順序は「①`main`へのリリース（本番の画面・API）→
②サブPCの「更新して再起動」（poller 33・ランチャー・ランナー）」**。マイグレーションは無い。

| 組み合わせ | 挙動 |
| --- | --- |
| 新サーバー＋旧poller | 起動時点で`SUCCEEDED`。結果が届けば`reported`、届かなければ「状態不明＋再実行」（永久の「レビュー中」にはならない） |
| 旧サーバー＋新poller | 起動後は`RUNNING`＋生存報告。`timedOut`は読まれず時間切れは`FAILED`になる。走り出したレビューが起動枠を1つ使う |
| 新サーバー＋新poller | 上の表どおり |

戻す場合はpollerを先に戻す（旧サーバーは`exitCode`付きの遅い報告を上書きに使わないだけで壊れない）。

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


## 実装担当に合わせたPRレビュー（#4037）

`issue-<番号>`のPRは、そのIssueで直近に開始した実装担当をレビューへ引き継ぐ。
ClaudeならActionsのClaudeレビュー、CodexならサブPCの既存PR_REVIEWジョブを使う。
主系設定を変えても既存の実装担当は変えない。明示的に別担当の実装を開始した場合は
新しい開始記録を優先する。同一開始時刻で担当が競合する場合や記録がない場合は、
推測でClaudeへ倒さずreview-providerを失敗させ、自動マージを止めてPRへ理由を残す。
Issueを持たないPRのみ従来の共通設定を参照する。低リスクのレビュー省略は維持する。

- サブPCのセッション報告時に`ImplementationRun`へ担当と`firstSeenAt`を保存する。
  `NOT_STARTED`は対象外。セッション回収後も記録を残す。生存報告の時刻は優先順位に使わない。
  Codexのthread情報が後着した場合は同じ開始記録の担当を補正する。
- Actionsでは実装・追加対応ステップの直前に認証付きAPIへ担当を記録する。
  run ID・attemptで再送を識別し、開始時刻を更新しない。記録できなければ実装を開始しない。
- 記録は開始した実行の担当であり、各コミットの著者やモデル名ではない。
  計画レビューや使用量の記録から担当を推測しない。
- 移行前の実装は残っているDispatchSessionでも解決できる。既に回収済みで記録がない
  過去PRは手動確認へ渡す。PRの本文だけを書き換えて担当記録を偽装する経路は設けない。

### 配布・戻し方

先にmainへAPI・DB migrationをリリースし、サブPCのセッション報告が新しい記録を
保存する状態にする。その後、共有workflowタグを作成し、実装とレビューのcallerを
同じタグへ配布する。developに先に入った新workflowは本番API未配布の間、取得に失敗して
停止するため、初回リリースは手動で確認する。接続失敗を成功扱いにする暫定回避はしない。
戻す場合はworkflow参照を旧タグへ戻す。新しいテーブルは残してよく、既存データを削除しない。

CIのbuild/test/lint、CI失敗・レビュー指摘の自動修正担当はこの変更の対象外。
レビュー指摘の自動修正も#4043で実装担当を継承する。実行場所・導入順は次節を参照。

### 実装担当に合わせたレビュー指摘修正（#4043）

#4037の実装担当記録から修正担当も決める。Claude実装は従来のActions上のClaude、Codex実装は
サブPCのCodex CLI（ChatGPT購読認証）で実行する。Codex用APIキーは不要。担当不明・API障害・
対応サブPC不在ではClaudeへ切り替えず、理由を残して確認待ちへ戻す。
CI自動修正・コンフリクト解消・PR repairの実行担当は従来どおりClaudeのまま。

自動修正は、現在のHEADに対する各agentの**最新**レビューが `changes-requested` で、同じコメントに
`issue-deck-review-autofix:ok` がある場合だけ。古いコメントの安全印は使わず、`needs-check`・
安全印なし・`11.local`・`00.check-user`・2回のhandoff上限で停止する。同HEADへのworkflow再実行は
handoff回数を増やさない。`workflow_run`の購読名は現在の `Claude Code / Codex Review (develop向けPR)`
と旧名の両方を残す（購読はファイル名ではなく `name` で一致する）。

サブPC修正は読取専用の `PR_REVIEW` と分けた `REVIEW_FIX` ジョブ。対応能力 `reviewFixCapable` を
申告したオンラインホストだけへ依頼し、同時実行枠を使う。Actionsは依頼して終了し、修正中の表示は
DispatchJobを正として続く。画面が起動時に作る仮のrepair-runは依頼成功時に終了化し、遅れた
旧ジョブの終了で新しい修正中表示を消さない。失敗・時間切れはIssueへ通知し、確認待ちへ戻す。

- 実装LAUNCHと同じ活性キーを持ち、同じIssueへ二重に書込ジョブを積まない。
- 生存している実装セッションや実装・追加指示ジョブがあれば停止する。隔離したdetached worktreeを使い、既存のworktreeを変更しない。
- 起動時・commit前・push前にGitHubのHEAD、Issueラベル、最新レビュー本文を再検証する。
- Codexはファイル修正のみ。ラッパーが検証し、同じIssueブランチへ通常pushする。force push・rebase・新PR作成はしない。
- 現時点の自動検証対象は `package.json` に `lint` / `typecheck` / `test` のいずれかを持つリポジトリ。
  存在する検証を実行し、失敗・差分なし・検証手順なしならpushしない。依存・検証宣言の変更は確認待ち。
  Node以外など検証を特定できないリポジトリは自動修正を完了扱いにしない。
- Codexのモデル・推論強度はPRレビューと同じ `workflowCodexModel` / `workflowCodexReasoningEffort`。
- 同HEADの自動再送は重複ジョブを作らない。失敗後に人が新たに手動起動した別workflow runだけは再試行可能。

導入順は **#4037のAPI/DB → #4043のDB/API → サブPCのpoller更新 → caller/shared workflow**。
`REVIEW_FIX` enumとホスト能力列のマイグレーションを先に適用する。古いpollerには新ジョブを配らない。
workflow_runの購読変更はデフォルトブランチに入り、共有callerはリリース後のタグ配布で初めて有効になる。
APIを戻す場合は先にcallerを戻して新規依頼を止め、実行中の修正が終わってから戻す。
