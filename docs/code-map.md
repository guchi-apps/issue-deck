# コードの地図

**いつ読むか**: このリポジトリのコードを初めて触るとき。どこに何があるかを掴みたいとき。

重複を避けるため、他が一次情報源のものはここに書かない。

- スタック・セットアップ・コマンド一覧: [../README.md](../README.md)
- 運用ルール（ブランチ・ラベル・共有知識）: [../CLAUDE.md](../CLAUDE.md)
- GitHub上の操作が誰の名義になるか: [attribution.md](attribution.md)
- Actions側のトークンと自己ループ防止: [actions-token-model.md](actions-token-model.md)
- 無人実行フローの全体像: [multi-agent-workflow.md](multi-agent-workflow.md)・[multi-agent/](multi-agent/)

## ディレクトリ

```
src/
  app/
    api/            Route Handler。画面からのデータ取得・更新はすべてここ経由
    auth/callback   Supabase Authのコールバック。Userレコードの作成とトークン保存
    dashboard/      メイン画面
    github/setup    GitHub Appインストール後の受け口
  components/
    dashboard/      画面固有のコンポーネント（mobile/ にモバイル専用）
    ui/             shadcn/uiの生成物。手で書き換えない
  hooks/            use-* のクライアントフック。データ取得・更新はここに集約する
  lib/
    github/         GitHub APIとの境界。コンポーネントから直接叩かない
    claude/         Claude APIを使う機能（要約・提案・本文整形）
    supabase/       client / server / middleware / admin / github-oauth
    crypto/         ユーザートークンの暗号化
  proxy.ts          リクエスト前段の処理（後述）
prisma/schema.prisma
scripts/            開発・CI用スクリプト（dev.sh ほか）
deploy/             PM2の ecosystem.config.js
```

規約として守られていること。

- **GitHub APIの呼び出しは `lib/github/` を経由する。** コンポーネントやページから直接`fetch`しない。
- **ユーザー本人のトークンを使う呼び出しは
  [`lib/github/with-user-github-token.ts`](../src/lib/github/with-user-github-token.ts) を通す。**
  トークン未保存時の409応答と、期限切れ時のリフレッシュ・再暗号化をここで一元的に扱っている。
  個別のRoute Handlerで復号処理を書き足さない。
- **ロジックは純粋関数として `lib/` に切り出し、隣に `*.test.ts` を置く。** コンポーネントに
  埋め込むとテストできなくなる。既存の `issue-status.ts` / `workflow-status.ts` /
  `search-query.ts` などがこの形。
- `components/ui/` はshadcnの生成物なので、変更したい場合は生成物を直接編集せず
  ラップするコンポーネント側で対応する。

## `middleware.ts` は無い。`src/proxy.ts` を見る

Next.js 16 で `middleware.ts` は `proxy.ts` にリネームされた。Supabaseのセッション更新は
[../src/proxy.ts](../src/proxy.ts) が `lib/supabase/middleware.ts` の `updateSession` を呼んでいる。
`middleware.ts` を探しても見つからないのはこのため。

## データの流れ

- **Issueの一次情報源はGitHub、MySQLはキャッシュ。** `lib/github/sync-issues.ts` が取得結果を
  `Issue` テーブルへupsertする。画面の一覧はDBを読む。
- **GitHub → DBの取り込み経路は2つ。** `/api/webhooks/github`（HMAC署名を検証）で受けるプッシュ型と、
  `POST /api/sync/issues`（画面の再同期ボタン、`hooks/use-issue-sync.ts`）で明示的に走らせるプル型。
- 画面の更新は別の話で、`hooks/use-issue-polling.ts` が10秒間隔で `/api/issues`（＝DB）を読み直す。
  ポーリングしてもGitHubには問い合わせないため、Webhookが届いていない変更はここでは拾えない。
- **コメントはキャッシュせず、都度GitHub APIから取得する**（`/api/issues/comments`）。
- **Issueの親子関係（GitHubネイティブのサブIssue）もキャッシュせず、詳細を開いたときだけ取得する**
  （`/api/issues/sub-issues`・[`lib/github/sub-issues-api.ts`](../src/lib/github/sub-issues-api.ts)）。
  DBへ持たせるとGitHub Appの`sub_issues` Webhookイベント購読の追加（GitHub App設定の手作業変更）と
  スキーマ変更が要るのに対し、得られるのは詳細1回あたり1クエリぶんの節約でしかない。子の
  `projectStatus`だけはDBキャッシュから合流させ、進捗の内訳を出す（`lib/sub-issue-progress.ts`）。
  **一覧にはバッジを出していない**（IssueごとにGraphQLを1回叩くN+1になるため）。運用は
  [multi-agent/labels.md](multi-agent/labels.md)。
- **Issueの進捗はGitHub Projects v2のStatusで持ち、進捗ラベルはフォールバック。**
  判定は必ず [`lib/issue-progress.ts`](../src/lib/issue-progress.ts) の `resolveProgressStatus`
  を通す（Status名を直接見ない）。Statusは`projects_v2_item`
  Webhookと再同期（`lib/github/sync-project-status.ts`）で`Issue.projectStatus`へ入り、
  未登録なら`null`のままラベルから解決する。Projects v2はGraphQLのみのため境界は
  [`lib/github/projects-api.ts`](../src/lib/github/projects-api.ts)。
  Projectの場所は`PROJECT_V2_OWNER`・`PROJECT_V2_NUMBER`で指定し、**未設定なら
  Project連携を一切行わない**。設計の一次情報源は
  [progress-status-architecture.md](progress-status-architecture.md)（#991）。
- **人が進捗を直接動かす入口は、Issue詳細の右パネル（プロパティ）の「進捗」セレクト**（#1350）。
  ラベル・担当者と並ぶ位置にあり
  （[`components/dashboard/issue-properties-panel.tsx`](../src/components/dashboard/issue-properties-panel.tsx)。
  PCの常時表示パネルと狭い画面の「プロパティ」シートが同じコンポーネントを使う）、
  `POST /api/issues/progress-status`へ投げる。**この経路は実行を起動しない。**
  GitHub Projectsのカンバンでカードをドラッグした場合と違い、書くのがissue-deck自身の
  GitHub Appで、かつ`reportProgressStatus`がDBキャッシュを同時に更新するため、
  `projects_v2_item` Webhookを受けた`maybeDispatchFromProjectStatus`が`isOwnAppSender`と
  「遷移前後が同じ」の両方で止まる。実装の起動は「実装を開始」ボタンに一本化したままにしている
  （プルダウンの選択だけで無人実行が始まると誤操作の影響が大きいため）。
  失敗理由の日本語化は[`lib/progress-report-message.ts`](../src/lib/progress-report-message.ts)に
  切り出してある（`lib/github/report-progress.ts`は`db`込みでクライアントからimportできない）。
- **Projectへの書き込み経路は`POST /api/progress`の1本だけ。** ワークフローもローカル実行も
  Projectを直接更新せず、このAPIへ`ProgressStatusKey`を報告する
  （[`lib/github/report-progress.ts`](../src/lib/github/report-progress.ts)）。Projects v2の
  書き込み権限を持つのをissue-deckのGitHub Appだけに閉じるための一本化で、認証は共有シークレット
  `PROGRESS_REPORT_SECRET`。**呼び出し側はこのAPIの失敗で処理を止めない**取り決めのため、
  取りこぼしは再同期（`reconcileProjectStatusesFromLabels`）がラベルを正として是正する。
- **Projectへの「アイテムの追加」もissue-deckが行う。** GitHubのAuto-addはプランごとに
  設定できるリポジトリ数の上限があり（Freeは1、Teamでも5）対象リポジトリ全体に届かないため。
  報告時に未登録なら載せ、再同期では`hasClaudeWorkflow`が真のリポジトリのopenなIssueを
  まとめて載せる（`addMissingProjectItems`）。
- **PR一覧（`/api/pull-requests`）はキャッシュせず都度GitHub APIから取得する。**
  Issueと違い`PullRequest`テーブルもWebhook購読（`pull_request`イベント）も持たない。
  無人実行はPR作成から自動マージまでが短く、openなPRは常時0〜数件しか存在しないため
  （#1058の調査時点で全連携リポジトリ合計0件）、DBキャッシュを持つ効果より
  スキーマ・Webhook設定を増やさない方が勝つと判断した。
  取得コストは「対象リポジトリ数 + draft以外のopen PR数」回のAPI呼び出しで、母集団が広いぶん
  1回が重い。そのため**自動ポーリングを持たせていない**（画面を開いたときと手動更新のみ。
  `hooks/use-pull-requests.ts`）。
- **左メニューにPRの件数を出すため、PRペインを開いていなくてもダッシュボードのマウント時に
  1回だけ取得する**（#1389）。件数を出すのは「処理中のPR」「完了したPR」だけで、
  **「全てのPR」には出さない**（母集団が`scope`＝「openだけか、直近のクローズ済みまで含むか」に
  依存し、「全PR数」として読める数にならないため）。件数は
  [`lib/pull-request-list.ts`](../src/lib/pull-request-list.ts)の`computePullRequestNavCounts`が
  数え、渡すのは一覧と同じ母集団（マージ済みで伏せたPRとリポジトリ絞り込みを適用し、状態別
  ビューは適用する前）にする。取得前は0ではなく件数そのものを出さない。
  取得コストを増やさないため、PRペインを開いていない間の`scope`は`open`に固定し（既定の
  `prview`が`all`のため、そのまま渡すと毎回クローズ済みまで取りに行ってしまう）、
  **一度`all`まで広げた母集団はペインを離れても狭めない**（`open`は`all`の部分集合なので、
  狭める向きで取り直すのは消費にしかならない）。
- **左メニューのPR項目は状態別の3ビューで、母集団を決めるのは「全てのPR」だけ**（#1312）。
  ビュー定義は[`lib/pull-request-views.ts`](../src/lib/pull-request-views.ts)、判定は
  [`lib/pull-request-list.ts`](../src/lib/pull-request-list.ts)の`filterPullRequestsByView`。
  「処理中のPR」（CI待ち・ドラフト・CI状態不明）と「完了したPR」（CIがsuccess/failure）は
  **同じopen取得の結果をクライアント側で絞るだけ**なので、切り替えてもGitHub APIを叩き直さない。
  「全てのPR」だけが`?scope=all`でクローズ済みも取りに行き、そのぶん増えるのはリポジトリあたり
  1回（`state=closed&sort=updated`を1ページ・30件、**closedのCI状態は取得しない**）。
  マージ済みかどうかは一覧APIが返す`merged_at`から決める（単体取得の`merged`は一覧に無い）。
  並び順も「全てのPR」だけ更新が新しい順で、他は作成が古い順＝滞留が長い順。
  マージ済みPRの一覧を「直近30件」を超えて遡りたくなった時点で、キャッシュ層の追加を再検討する。
- **PRの本文・コメント（`/api/pull-requests/detail`）も同じくキャッシュせず、PRを選んだ・
  画面内のリンクからPRを開いたときだけ取得する。** 会話コメント・レビュー・レビューコメントの
  3エンドポイントを
  [`lib/github/pull-request-events.ts`](../src/lib/github/pull-request-events.ts) が1本の時系列へ
  統合する。こちらも自動ポーリングは無い（`hooks/use-pull-request-detail.ts`）。
  ヘッダー表示用の`summary`（タイトル・ブランチ・状態・CI状態）もあわせて返す。
  **「処理中」「完了」ビューの一覧はopenのPRしか持たないのに、画面内のリンクからはマージ済み・
  クローズ済みのPRも開けるため**（#1260）、一覧の項目が無い経路でもヘッダーを描けるようにしている。一覧から
  選んだ場合は一覧の項目を優先して使うので、選んでから表示までの速さは変わらない。
  一覧・詳細の両方が[`lib/github/pull-request-summary.ts`](../src/lib/github/pull-request-summary.ts)
  の`toPullRequestSummary`で同じ形に揃える。
- **Issue画面の「対応PR」は複数持てる。マージボタンはPRの行の中だけに置く**（#1339）。
  対応PRの番号はIssueコメント中のPR URLから拾い（[`lib/github/pull-request-link.ts`](../src/lib/github/pull-request-link.ts)の
  `extractPullRequestLinks`）、**1件も見つからないときだけ**Timeline APIのcross-referenceへ
  フォールバックする（`/api/issues/pull-request-link`）。タイトル・状態・CI状態は番号を渡して
  `GET /api/issues/pull-requests`で引き、消費はPR1件あたり1リクエスト（openかつdraftでなければ
  CI状態を足して2）。**コメント中のPR URLは単なる言及も混ざるため**、PR側から推定した対応Issue番号
  （`extractLinkedIssueNumber`）が別のIssueを指すものは
  [`lib/issue-pull-requests.ts`](../src/lib/issue-pull-requests.ts)の`selectIssuePullRequests`が落とす
  （推定できない`null`は残す）。**マージはIssueではなくPRに紐づく操作なので、ボタンは
  [`components/dashboard/issue-pull-request-list.tsx`](../src/components/dashboard/issue-pull-request-list.tsx)
  の各行の中だけにあり、画面上部の操作列・スマホのヘッダーには置かない。** 「コメント欄まで
  下げなくても押せる」という#1288の要件は、この一覧をIssue本文より上に置くことで満たしている。
  ポーリングするのはマージ待ち かつ CI実行中のときだけで、CIが確定したら自分で止まる
  （`hooks/use-issue-pull-requests.ts`）。
- **詰まったPRの修復は、画面から`POST /api/pull-requests/repair`でGitHub Actionsを起動する**
  （#1293）。ボタンは「CI失敗を自動修正」「コンフリクトを自動解消」の2種類で、マージ待ちPR
  一覧・PR詳細・ロケットアイコンのリリース進捗に出る。**どのワークフローを起動するかの判定は
  サーバー側**（[`lib/github/pull-request-repair.ts`](../src/lib/github/pull-request-repair.ts)）
  で、`issue-<番号>`のdevelop向けPRは既存の`claude-ci-fix.yml`・`claude-conflict-resolve.yml`へ、
  Issueに紐づかないPR（バンプPR・develop→mainのリリースPR）は新設の`claude-pr-repair.yml`へ
  振り分ける。設計は[multi-agent/auto-repair.md](multi-agent/auto-repair.md)。
- **画面内のIssue・PRリンクはGitHubへ飛ばさず、IssueDeckの中で開く**（#1260）。リンクは
  `<a href="https://github.com/...">`のまま出しておき、
  [`components/dashboard/github-reference-link.tsx`](../src/components/dashboard/github-reference-link.tsx)
  が通常クリックだけを奪ってアプリ内遷移に差し替える（Ctrl/⌘クリック・中クリックはGitHubを開ける）。
  遷移の実体は`IssueDeckShell`の`openReference`だけが持ち、Markdown本文の中のような深い位置へは
  contextで配る（`github-reference-navigation.tsx`）。**providerが無い場所では素の外部リンクに
  戻るだけ**なので、ダイアログ単体のテストでも壊れない。GitHubは`/issues/<番号>`でPRも開けるため、
  Issue参照はまずDBキャッシュのIssueを探し、無ければPRとして開き直す。PC（`pane`・`pr`・`issue`）と
  スマホ（`mscreen`・`missue`）は現在地の持ち方が別なので、**両方を1回のURL更新で
  進める**（`hooks/use-reference-navigation.ts`。2回に分けると後の1回が前の1回の変更を落とす）。
  「GitHubで開く」ボタン・Actionsの実行ログ・GitHub Appのインストールは、アプリ内に対応する
  画面が無いため外部リンクのまま残している。
- **現在地はURLクエリが正で、履歴を積むのは現在地が変わる操作だけ**（#1396）。URL更新は
  [`hooks/use-history-navigation.ts`](../src/hooks/use-history-navigation.ts)の`navigateParams`に
  集約し、画面遷移（スマホの`mscreen`・`missue`、PCの`view`・`pane`・`prview`・`pr`・`issue`）は
  `router.push`、絞り込み条件（`q`・`state`・`labels`・`assignee`・`sort`・`repos`、スマホの
  絞り込みシート内の操作）は`router.replace`にする。**絞り込みまで積むと、戻る操作が条件の
  巻き戻しに費やされて前の画面へ着かない**（特に`q`は1文字ごとに積まれる）。結果が今のURLと
  同じ更新は行わない（同じURLを積むと戻る操作が2回必要になる）。
- **PC版の選択中Issueも`issue`クエリが正**（#1396）。stateで持つとIssueを開く操作が履歴に
  載らず、戻る操作でアプリの外へ出る。`IssueDeckShell`の`selectedIssue`は
  `issues`＋`issue`クエリからの派生値で、ポーリングや編集の結果は`issues`の更新だけで追従する
  （**選択中Issueに個別の更新処理を足さない**）。`?issue=<id>`で直接開けるのは#688から。
- **アプリ内の「戻る」（ヘッダーの戻るボタン・右スワイプ）は、自分が積んだ履歴があれば
  `router.back()`で巻き戻す**（#1396）。押すたびに新しいエントリを積むと、戻る操作が往復を
  積み上げるだけになりブラウザ・OSの戻るが前の画面へ着かなくなる。共有URLで詳細画面をいきなり
  開いた場合は巻き戻せる履歴が無く、そこで`router.back()`を呼ぶとアプリの外へ出てしまうため、
  戻り先を計算して遷移するフォールバックを残してある。判別に使う深さは
  [`lib/history-stack.ts`](../src/lib/history-stack.ts)が数え、**ズレは必ずフォールバック側
  （アプリの外へ出さない側）に倒れる**ようにしている。ダイアログ（Issue作成・編集・設定）は
  履歴に載せない。戻る操作で入力中の本文が消える方が損失が大きいため。
- **サブPCへのディスパッチはpull型で、書き込み経路は`/api/dispatch/*`の1本。** 画面はジョブを
  `DispatchJob`へ積むだけで、サブPCのpollerが`POST /api/dispatch/claim`で取りに来る（VPSが
  tailnetに参加しておらず、Tailscale SSHにforced commandが無いためpush型は採れない。#1176）。
  **ジョブの`succeeded`は「tmuxセッションが立った」までで、実装の完了ではない**（以降の進捗は
  Project Statusが持つ）。その後のセッションは`DispatchSession`が持ち、**tmuxのメタデータ
  （poller）とフック（#1219）の両方から埋まる**。入力待ちとRemote ControlのURLはフック側で、
  受け口は`POST /api/dispatch/sessions/activity`（pollerの一括報告とは別。あちらは含まれない
  行を`GONE`へ倒すため）。**セッションの終了だけは`run-issue-session.sh`のtrapが
  `POST /api/dispatch/sessions/ended`へ即時に報告する**（#1321。pollerの巡回は最大75秒遅れ、
  #1311の起動抑止がそのぶん解けないため。trapを通らない経路はpollerが従来どおり拾う）。
  画面は状態を様子より優先する（`lib/dispatch/issue-session.ts`）。
  **`21.plan-required`のセッションが提示した計画は、`ExitPlanMode`の`PreToolUse`フックから
  `POST /api/dispatch/sessions/plan`へ流れ、Issueのコメント＋`00.check-user`になる**
  （#1342。組み立ては`lib/dispatch/session-plan.ts`。GitHubへ書く経路は`session-escalation.ts`と
  同じで、ラベルを外してよいかの印はホスト側の`<セッション名>.plan`が持つ）。
  `23.preview-required`のセッションは開発サーバーを`tailscale serve`でtailnetへ出し、そのURLも
  同じ経路で報告する（#1265。**出すのはFQDNのみ。serveはHostヘッダーで振り分けるため生IPは404**）。
  立ったセッションの停止（`C-c`）・終了（`kill-session`）も同じキューを通る（#1332。`DispatchJob.kind`。
  **pollerはセッション名を`repositoryFullName`/`issueNumber`から組み立て直して突き合わせ、
  受け取った名前をtmuxへ渡さない**）。タイムアウトは定期実行を持たず、enqueue・claim・一覧取得のたびに
  `expireStaleDispatchJobs`が掃く遅延評価。**セッション本数の上限（#1361）で待っていることは、
  pollerが申告する`maxSessions`/`liveSessions`から画面に出す**（#1394。文言は
  `lib/dispatch/queue-summary.ts`。**割り当ての判定はpoller側のままで、issue-deckは表示にしか
  使わない**）。「どのリポジトリを起動できるか」はサブPCが申告し、
  判定は受け口とpollerが`scripts/lib/local-repo-resolve.sh`で共有する。設計は
  [multi-agent/subpc-dispatch.md](multi-agent/subpc-dispatch.md)。
- **サブPCで起動するリポジトリは、対象リポジトリ側に何も置かない**（#1224）。契約適合の
  `scripts/start-issue.sh`を持つリポジトリ（issue-deck自身）だけが自前のスクリプトで起動し、
  それ以外はissue-deck側の`scripts/generic-start-issue.sh`（汎用ランチャー）が起こす。
  ポート帯は`scripts/local-repo-ports.conf`、プロンプトは`scripts/prompts/generic-implementation-agent.md`。
  **画面の`canStartLocalSession`は「起動コマンドをコピー」のゲートに限定**しており、サブPC導線はサブPCの
  申告だけで判定する。設計は[multi-agent/generic-launcher.md](multi-agent/generic-launcher.md)。
- **起動したセッションの後始末はpollerの1巡に相乗りさせ、常駐プロセスを増やさない。**
  `scripts/reap-dev-servers.sh`が開発サーバーを（#1223）、`scripts/reap-sessions.sh`が作業の
  終わったtmuxセッションそのものを畳む（#1256）。判定材料は`scripts/lib/session-state.sh`が
  読み書きする状態ファイル（`~/.local/state/issue-deck/sessions/`。`run-issue-session.sh`が
  起動時の記述子を、`session-notify.sh`がフックの最後のイベントを書く）と、gitとGitHubの事実だけで、
  **画面（`capture-pane`）の内容は読まない**。設計は
  [multi-agent/local-quick-start.md](multi-agent/local-quick-start.md)。
- **個人設定（`~/.claude/CLAUDE.md`・個人skill）の実体は`guchi-apps/claude-config`にあり、
  両機は`~/.claude/`側をsymlinkにして同じファイルを見る**（#1190）。issue-deckが持つのは
  「取り残しに気づく手当て」だけで、`scripts/lib/personal-config-sync.sh`の
  `warn_personal_config_drift`を`start-issue.sh`・`generic-start-issue.sh`が起動前に呼ぶ。
  **警告するだけで起動は止めず、リポジトリが無い環境（Actions・セットアップ前）では
  黙って素通りする。** 設計は
  [multi-agent/personal-config-sync.md](multi-agent/personal-config-sync.md)。
- **エージェントの出力を日本語に揃える指示は、起動フラグとプロンプト本文の二層で持つ**（#1395）。
  文面の正は`scripts/lib/agent-language.sh`で、`run-issue-session.sh`・`start-reviewer.sh`が
  `--append-system-prompt`で渡す。そこを通らない無人実行のために、同じ文面を`.github/prompts/`・
  `scripts/prompts/`の「## 出力言語」にも置いている。**片方だけ変えない。** 設計は
  [multi-agent/prompts-and-models.md](multi-agent/prompts-and-models.md)。
- **起動スクリプトとセッション通知のフックが実際に動かすのは、worktreeではなく本体リポジトリの
  作業ツリー（`~/apps/issue-deck/scripts/`）のファイル**（#1274）。worktreeは毎回
  `origin/develop`から作られるのに、本体の作業ツリーを新しくするのは人の`git pull`だけなので、
  `scripts/`の修正はマージしただけでは反映されない。`scripts/lib/launcher-scripts-sync.sh`の
  `warn_launcher_scripts_stale`が起動前に差分を警告する（個人設定の警告と同じく、
  **警告するだけで自動pullはしない**）。経路の表は
  [multi-agent/session-notify.md](multi-agent/session-notify.md)。
- **ディスパッチの画面側（#1180）は`GET /api/dispatch`1本だけを見る。** 起動先の選択・選べない
  理由・積んだ後の状態表示が、この応答（ホストの申告・未完了ジョブ・直近24時間の終了ジョブ・
  同時実行数）で足りる。取得は`hooks/use-dispatch-state.ts`で、**未完了ジョブがある間だけ5秒
  間隔**（それ以外は60秒）。押してから起動が始まるまでポーリング間隔ぶん待つため、その間の
  状態が見えないと「押しても何も起きていない」ようにしか見えない。画面とAPIで判定が分かれない
  よう、選べない理由は`lib/dispatch/dispatch-job.ts`の純粋関数を両者が共有する（同ファイルは
  Prismaに触れないため、クライアントコンポーネントからimportできる。`lib/dispatch/jobs.ts`は
  できない）。
- **順番待ちのIssueは「未着手」ではなく「実行中」に出す**（#1347）。押してからサブPCの
  セッションが`Implementation`を報告するまで進捗Statusは`Ready`のままで、そのままだと
  起動済みのIssueが未着手ビューに居座り、そこから同じIssueをもう一度選んでしまう。
  Issue一覧（`lib/issues-for-user.ts`）が`DispatchJob.activeKey`（未完了の間だけ
  `owner/repo#番号`が入るunique列）を1本引いて`Issue.dispatchPendingAt`へ合流させ、
  振り分けは`lib/issue-stats.ts`の`filterIssuesByView`で行う（`qaAnswerPendingAt`と同じ形）。
  **Statusは書き換えない。変えるのは画面の振り分けだけ**で、進捗の唯一の正はProject Statusのまま。
  引く側を`lib/dispatch/pending-dispatch.ts`に分けているのは、`lib/dispatch/jobs.ts`が
  セッション経由でGitHub Appの認証（読み込み時点で`GITHUB_APP_*`を要求する）を引きずるため。
  Issue一覧にその資格情報を要求させない。
- 独自テーブルを持つのは、既読状態・お気に入り・クイックフィルタ・リポジトリの非表示など
  **GitHub側に存在しない情報だけ**。GitHubにある情報を二重に持たない。

## 画像はVPSのローカルディスクに置く

- `POST /api/issues/images` … ログイン必須。`uploads/images/` へUUID名で保存する。
- `GET /api/issues/images/[filename]` … **認証を要求しない。** GitHub.com側のIssue画面からも
  画像を表示できるようにするため。代わりにUUID形式のファイル名だけを許可して、パストラバーサルと
  ファイルの列挙を防いでいる。
- `uploads/` は`.gitignore`済みで配布物にも含まれず、`deploy.yml` のクリーンアップ対象にも
  入っていないため本番で永続する。**`deploy.yml` の `rm -rf` の行に `uploads` を足すと
  ユーザーがアップロードした画像が消える。**

## 画面のボタンは`@claude`コメントで動く

「実装を開始」「計画を承認」などのボタンは、ワークフローを直接起動するのではなく、
**Issueへ定型の`@claude`コメントを投稿する**ことで `claude-issue-dispatch.yml` のトリガーを踏む
（[`lib/github/start-implementation.ts`](../src/lib/github/start-implementation.ts)・
[`lib/github/approval-labels.ts`](../src/lib/github/approval-labels.ts)）。
ボタンの表示条件はIssueのラベルから判定する（[`lib/github/workflow-status.ts`](../src/lib/github/workflow-status.ts)）。

定型文やマーカーコメントを変更するときは、ワークフロー側のトリガー条件と対になっているため
両方を確認する。

**GitHub ProjectsでStatusを`Ready`から動かしても同じ`@claude`コメントが投稿される**（#991 Phase 3）。
起動するかどうかの判定は[`lib/github/project-status-dispatch.ts`](../src/lib/github/project-status-dispatch.ts)
に集約されており、ボタンとカンバンのドラッグが同じ関数を通る。ただし**コメントの投稿者は経路で
異なる**（ボタン＝操作した人間、ドラッグ＝issue-deckのApp）。ワークフローが投稿者のwrite権限を
検証するため、ドラッグ経路では`<!-- issue-deck:posted-by:<login> -->`で人間を復元させている。
`21.plan-required`ラベルがワークフローのmodeを決めるので、`Planning`へ動かすときはコメントより
先にラベルを書く。

## テスト

```bash
pnpm test        # lint + typecheck + vitest run
pnpm test:unit   # vitestのみ
```

`pnpm dev` は `next dev` の単純なラッパーではなく、[../scripts/dev.sh](../scripts/dev.sh) が
`.env.local` の読み込み・LAN内の別端末から見るためのポートフォワード設定・smeeによるWebhook中継の
起動を行う。`next dev` を直接叩くとGitHubからのWebhookがローカルに届かない。

`pnpm dev:develop`（[../scripts/start-develop-dev.sh](../scripts/start-develop-dev.sh)・#1289）は、
`develop`の最新状態を専用worktree（`~/apps/issue-deck-worktrees/develop`・detached HEAD）へ取り直し、
固定ポート`4000`で開発サーバーを常駐させる。Issueごとの開発サーバーが映すのは実装中のブランチだけで、
マージ済みが積み上がった`develop`を見る場所が別に要るため
（[multi-agent/local-quick-start.md](multi-agent/local-quick-start.md)「developの状態を開発サーバーで見る」）。

ポートフォワード設定（[../scripts/setup-lan-access.sh](../scripts/setup-lan-access.sh)）はWindowsの
管理者権限を要求するため、`ISSUE_DECK_SKIP_LAN_SETUP=1` が設定されている場合はスキップする
（ワンクリック起動経路でUAC待ちから戻らずdevサーバーが起動しなくなるため。#1094。詳細は
[multi-agent/local-quick-start.md](multi-agent/local-quick-start.md)）。

## 環境変数

`.env.local.example` が一次情報源。DB・Supabase・GitHub Appの3系統に分かれる。

既存のworktree（`~/apps/issue-deck-worktrees/issue-<番号>`）の`.env.local`には、`start-issue.sh`が
セッション再開時に本体の`.env.local`との差分キーを追記する（#1099）。本体さえ更新しておけば、
古いworktreeを開き直したときに自動で埋まる。

追加するときはローカルの`.env.local.example`だけでなく、1Password・`.github/secrets-manifest.tsv`・
`deploy.yml` の `env:` と `envs:`・サーバー側`.env`を書く`update_env`行まで更新する。
マニフェストへ追記したら`scripts/sync-github-secrets.sh`でGitHub側へ同期する（#1302）。詳細は共有知識の
[knowledge/deployment.md](https://github.com/guchi-apps/docs/blob/main/knowledge/deployment.md) を参照。

ワークフローが実行時に値を組み立てる経路は`.github/actions/load-secrets`（複合アクション）にある。
マニフェストを読んで、GitHubのsecret/variableと1Passwordのどちらからでも同じ環境変数を作り、
片方で解決できない項目はもう片方から補う（#1306）。供給元が揃っているかは
`.github/workflows/load-secrets-check.yml`を`workflow_dispatch`で実行すると確認できる。
