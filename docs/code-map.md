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
    dashboard/      画面固有のコンポーネント（mobile/ にモバイル専用、settings/ に設定画面）
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
deploy/             PM2の ecosystem.config.js（メモリ設定の根拠は docs/production-memory.md）
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
- **設定画面に項目を足すときは`components/dashboard/settings/`の該当区分へ入れる**（#1539）。
  区分は[`settings-sections.ts`](../src/components/dashboard/settings/settings-sections.ts)が唯一の定義で、
  PCの設定ダイアログ（[`settings-dialog.tsx`](../src/components/dashboard/settings/settings-dialog.tsx)）と
  スマホの設定画面（[`mobile/mobile-settings-screen.tsx`](../src/components/dashboard/mobile/mobile-settings-screen.tsx)）が
  同じ配列と同じセクションコンポーネントを読む。**片方の画面にだけ項目を足さない。**
  区分は機能の性質で割っており、**保存を押すまで効かない設定値は「実行設定」、押した瞬間に
  GitHub Actionsが走る操作は「フリート運用」**へ入れる。混ぜると「保存ボタンがどこまで効くのか
  分からない」という元の状態に戻る。読み取り系のデータ取得は
  [`hooks/use-settings-data.ts`](../src/hooks/use-settings-data.ts)へ集約する。
  **「表示」区分（#1552）はそのどちらでもない「ユーザーごとの画面の見え方」**で、
  切り替えた時点で即座に効き、GitHubには何も起こらない。中身はリポジトリの表示・非表示
  （[`settings/repository-visibility-section.tsx`](../src/components/dashboard/settings/repository-visibility-section.tsx)）で、
  実体は既存の`HiddenRepository`。**切り替える口は左メニュー（`sidebar-nav.tsx`）・スマホの
  リポジトリ画面（`mobile-repos-screen.tsx`）・この区分の3か所あるが、状態を持つのは
  `IssueDeckShell`の`repositories`だけ**なので、どこで変えても他へその場で伝わる。
  一括操作（すべて表示・すべて非表示）だけは`PUT /api/repositories/hidden`にまとめ、
  1件ずつのトグルは従来の`POST`/`DELETE`のまま。件数の数え方と一括の対象決定は
  [`lib/repository-visibility.ts`](../src/lib/repository-visibility.ts)へ寄せる。
  **非表示が効く範囲は左メニュー・PR一覧・「ブランチとPRの流れ」・Issue作成の選択肢までで、
  Issue一覧と各ビューの件数には効かない**（#367以来の挙動。区分の説明文でもそう書いている）。
- **`input` / `textarea` / `select` の文字サイズをスマホ幅で16px未満にしない。** iOS Safariは
  font-sizeが16px未満の入力欄にフォーカスが入ると画面全体を自動で拡大し、一度拡大すると
  元に戻らない（#1442）。小さくしたい場合は `text-base md:text-sm` のように`md`以上に限定する。
  `cn()`へ`text-sm`を渡すとtailwind-mergeがベースの`text-base`を消してしまう点に注意。
  取りこぼし対策として、[`app/globals.css`](../src/app/globals.css) に`md`未満で16pxを
  下回らせないルールを置いている。

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
- **開発環境のDBは既定で空。データを入れる経路は`pnpm db:seed:dev`だけ**（#1473）。
  実データが入らないのは仕様ではなく`.env.local`のGitHub App設定がCIダミー値のままだからで、
  同期を何度走らせても`Repository`は0件のまま。`scripts/seed-dev-db.sh`がCI用のシード
  （`scripts/ci-seed-user.mjs`・`scripts/seed-ci-db.mjs`）をローカルから投入し、ログイン画面の
  「開発用ダミーユーザーでログイン」（`src/lib/dev-login.ts`・`/api/dev/login`）で入る。
  **全worktreeが同じ`app_issue_deck_dev`を共有する**ので投入は1回でよい。ダミーで埋まるのは
  DBを読む画面だけで、GitHub APIを都度叩く経路（下記のPR一覧・サブIssue）は空のまま。
  線引きは[multi-agent/local-quick-start.md](multi-agent/local-quick-start.md)
  「開発サーバーにデータが出ないとき」。
- **PR一覧（`/api/pull-requests`）はキャッシュせず都度GitHub APIから取得する。**
  Issueと違い`PullRequest`テーブルもWebhook購読（`pull_request`イベント）も持たない。
  無人実行はPR作成から自動マージまでが短く、openなPRは常時0〜数件しか存在しないため
  （#1058の調査時点で全連携リポジトリ合計0件）、DBキャッシュを持つ効果より
  スキーマ・Webhook設定を増やさない方が勝つと判断した。
  取得コストは「対象リポジトリ数 + draft以外のopen PR数」回のAPI呼び出しで、母集団が広いぶん
  1回が重い。そのため**自動更新は「完了したPR」ビューを表示している間だけ**にしている
  （10秒間隔。それ以外のビューとPRペイン外は画面を開いたときと手動更新のみ。
  `hooks/use-pull-requests.ts`。#1531）。
- **10秒間隔で回せるのは、GitHubへの取得がETagの条件付きGETを通っているから**（#1531。
  [`lib/github/conditional-request.ts`](../src/lib/github/conditional-request.ts)）。
  GitHubのREST APIは`If-None-Match`付きのリクエストが`304 Not Modified`を返したとき、
  **その分をレート制限に計上しない**。素で10秒ポーリングすると26リポジトリ×360回/時で
  インストール当たりの上限（5,000回/時）を約2倍超過し、PR一覧だけでなくIssue同期・CI状態・
  マージまで巻き添えで失敗する。通しているのはPR一覧（`fetchOpenPullRequests` /
  `fetchClosedPullRequests`）とCI状態（`fetchRefCiState`のcheck-runs）の2経路で、
  変化が無い間の消費は実質ゼロになる。キャッシュはプロセス内メモリのLRU（上限500件。
  check-runsのURLはhead SHAごとに増えるため）で、`api-usage`と同じく単一プロセス前提。
  **キャッシュの古さが表示に出ることはない**——毎回GitHubへ問い合わせており、本文をキャッシュから
  返すのはGitHub自身が「変わっていない」と答えたときだけ。キーはURLのみでトークンを含めないが、
  権限の無いリポジトリには304ではなく404が返るため、別インストールの内容は漏れない。
  **304は使用量（`api-usage`）にも計上しない**ので、設定画面の「GitHub API使用量」の
  `pull_request_list`は実際に消費した回数を表す。
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
- **スマホのフッターは「ホーム／Issue／PR／設定」で、タブのidは`mscreen`の値そのもの**（#1436）。
  「Issue」タブのidが`repos`なのはそのためで、開くのはリポジトリ一覧（→リポジトリ別Issue一覧）。
  全リポジトリ横断のIssue一覧（`mscreen=issues`）はフッターから外し、ホームの「概要」
  「よくつかうフィルター」「保存したフィルター」からのドリルダウンだけにした（点灯するタブは
  ホーム。判定は[`lib/mobile-nav-tab.ts`](../src/lib/mobile-nav-tab.ts)）。**PRタブから開くときの
  ビューは`in-progress`で、`DEFAULT_PULL_REQUEST_VIEW`（`all`）は変えていない。** 既定を`all`に
  しているのは画面内リンクからマージ済みPRを直接開く経路（#1260）のためで、そこを`in-progress`に
  すると開いたPRが一覧の母集団から外れる。画面内のタブでのビュー切り替えはIssue一覧のタブと
  同じく履歴を積まない（`selectPullRequestView`）。
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
- **「ユーザーのマージが必要です」の判定は
  [`lib/pull-request-list.ts`](../src/lib/pull-request-list.ts)の`requiresUserMerge`だけを通す**
  （#1469）。develop向けPRを「自動マージしてよい」「ユーザーのマージが必要」のどちらかへ確定
  させるのは`claude-review-develop.yml`と、その経路を持たないリポジトリ向けの保険
  （`reusable-issue-labels.yml`の`develop-pr-opened`。#1470）で、**どちらも結論をPRではなく
  対応Issueの`00.check-user`として書く**。PR一覧・PR詳細はGitHub APIからPRを取るだけでは
  これを知れないため、[`lib/pull-request-check-user.ts`](../src/lib/pull-request-check-user.ts)が
  IssueのDBキャッシュを1クエリ引いて`PullRequestSummary.linkedIssueCheckUser`へ合流させる
  （**GitHub APIの消費は増えない**）。develop→mainのリリースPRは`kind`だけで常に対象、
  バージョンバンプPRはAuto-mergeで入るため対象外。理由別のラベル（`01.check-merge`。
  [multi-agent/labels.md](multi-agent/labels.md)）が入ったら、差し替えるのはこの関数の中だけ。
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
- **「ブランチとPRの流れ」（`pane=flow`・スマホは`mscreen=flow`）は、新しく取りに行くのを
  ブランチの存在確認だけに絞る**（#1455）。IssueとPRの対応・ブランチに対するPRの状態を1画面で
  俯瞰する画面で、Issueは既存のDBキャッシュ、PRは既存の`/api/pull-requests`の結果をそのまま使い、
  **PRからは分からない「そのブランチが実在するか」だけ**を`GET /api/branch-flow`で取る
  （[`lib/github/branches-api.ts`](../src/lib/github/branches-api.ts)）。消費は**リポジトリあたり
  1回**（GraphQL。ブランチの存在確認と`main...develop`の差分を1クエリに相乗りさせる）。
  **ブランチ一覧は列挙しない。** RESTの一覧はアルファベット順・1ページ100件で、ブランチが
  溜まったリポジトリでは全部読むのに何回もかかるうえ、読めた範囲が名前の並び次第になる
  （この設計を決めた時点でissue-deckには670のブランチが残っていた。#1478で掃除して
  `delete_branch_on_merge`も有効にしたが、**ブランチ数に依存しない作りのままにしてある**）。
  代わりに
  **進行中のIssueに対応するブランチ（`issue-<番号>`）だけをGraphQLのエイリアスで名指しして引く**。
  **自動ポーリングは持たず**、画面を開いたときと更新ボタンのときだけ走る
  （`hooks/use-branch-flow.ts`。一度取った内容は画面を離れても保持する）。
  この画面を開いている間はPR一覧の母集団を`all`にする——マージ済みのPRまで見ないと
  「どのバージョンで本番へ出たか」を出せないため。組み立ては
  [`lib/branch-flow.ts`](../src/lib/branch-flow.ts)の`buildBranchFlow`で、
  **レーンはPRのheadブランチと、実在が確認できた作業ブランチの和集合**で作る。
  **「マージ済みなのにブランチが残っている」は状態として持たない**——設計時は`delete_branch_on_merge`が
  無効で数百本が該当し、出しても情報にならなかった。掃除の仕組みは#1478が持つ（この画面は
  ブランチの後始末を扱わない）。
  **IssueとPRの対応は1対1に限らない。** 同じIssueでもブランチが違えばレーンは分かれ（レーンの
  キーはブランチ名）、1本のPRが複数のIssueを扱う場合は`PullRequestSummary.linkedIssueNumbers`
  （`extractLinkedIssueNumbers`が確度の高い順に全参照を返す）の2件目以降を「関連Issue」として
  同じレーンに並べる。**本文の`#番号`には単なる言及も混ざるため、2件目以降は「対応」ではなく
  「関連」と呼ぶ。** 関連として画面に出したIssueは「ブランチもPRも見つからないIssue」へ
  重複させない。
  **画面はリポジトリ単位で畳み、既定は全リポジトリが1行**（#1510）。8リポジトリを扱う画面なのに
  1画面へ2件しか入らず、動きの無いリポジトリまでフルサイズのカードで「何も無い」と言っていた
  （カードを省く`isQuiet`はレーンの総数で判定しており、畳んだ完了レーンしか無いリポジトリを
  静かとみなさなかった）。**動きの無いリポジトリも隠さず1行で並べる**——畳むようになったことで
  隠す理由が場所ではなくなり、隠す方が「集計から漏れていないか」を確かめられなくなる。
  初回に自動で開くのは**手が要るものだけ**（CI失敗・ユーザーのマージ待ち・リリース中。
  `BranchFlowRepositorySummary`）で、以降の再取得ではユーザーの開閉を上書きしない。
  **展開した中身は「バージョンへ何が合流したか」の流れ図**（#1510）。`main`と`develop`の
  2本の縦レールに対し、**横線1本がリリース（develop→mainのマージ）**で、その下にぶら下がる枝が
  その版に乗った変更になる（`BranchFlowReleaseGroup`）。既定で出すのは**未リリースの束と
  ひとつ前の版まで**で、それ以前は「さらに前のバージョンを表示」で開く。この形にしたことで
  「developへマージ済み」「main未反映」「vX.Y.Zで本番反映」のピルは**どの横線の下にいるか**が
  表すようになり、レーンに残るピルは上段（マージ待ち・PR未作成・クローズ）だけになった。
  レールが占める幅は固定（PC 3.35rem・スマホ 2.6rem）なので、スマホでも横スクロールは出ない。
  **`behindBy`（mainにあってdevelopに無いコミット数）は出さない。** develop→mainをマージコミットで
  入れる運用ではリリースのたびに必ず1つ増え、中身は全部`Merge pull request … from guchi-apps/develop`
  になる（issue-deck本体で72件）。異常を示すバッジの形なのに行動につながらないため落とした。
  マージコミットを除いて数える案はコミット一覧を引く必要があり、この画面の前提（取得を増やさない）
  と噛み合わないので採らなかった。
  **手作業Issue（`71.manual-step`）は本文から起点Issueを推定してレーンへぶら下げる**（#1510）。
  GitHubネイティブのサブIssue関係はDBへキャッシュしておらず（`/api/issues/sub-issues`はIssue詳細を
  開いたときだけ取る）、持たせるにはGitHub Appの`sub_issues`Webhook購読の追加とスキーマ変更が要る。
  手作業Issueは本文の`## 関連`へ起点Issueの番号を書く決まりなので、DBキャッシュにある`body`と
  ラベルだけで足りる（`extractManualStepOrigin`）。**本文の先頭から最初の`#番号`を拾うのは誤り**で、
  `## 前提条件`に別Issueへの参照が入るため見出しの中だけを読む。一般のサブIssueは表示しない。
  **この画面からリリースworkflowを起動できる**（#1510）。押してよいかの判定は
  `BranchFlowRepository.canTriggerRelease`（リリース用workflowがある・openなリリースPRが無い・
  openなバンプPRが無い・未リリースの変更がある）で決まる。
  **「リリース用workflowがある」は`release-develop-to-main.yml`の実在で判定する**（#1538）。
  当初は`claude-issue-dispatch.yml`の有無（`Repository.hasClaudeWorkflow`）で代用していたが、
  この2つは一致しない——Claude運用には載っていてもリリースフローを持たないリポジトリ
  （例: clip-hive）でボタンが出てしまい、押すとdispatchが404で失敗した。判定はヘッダーの
  ロケットボタンと同じ`releaseWorkflowExists`（プロセス内に10分キャッシュ）を`GET /api/branch-flow`
  から通し、結果を`RepositoryBranchStatus.hasReleaseWorkflow`として返す。**取得できていない
  リポジトリはfalse（＝出さない）へ倒す。** さらに`POST /api/repositories/release`側でも起動前に
  同じ判定を行い、workflowが無ければ`release_workflow_missing`を返して日本語の文言を出す
  （キャッシュが古い場合の保険。GitHubの生の404本文からは何が足りないのか読み取れないため）。
  起動そのものはヘッダーのロケットボタンと同じ`POST /api/repositories/release`で、
  [`lib/release-request.ts`](../src/lib/release-request.ts)の`requestRelease`に寄せて2か所が
  同じ結果になるようにしてある。**流れ画面が持つのは起動と、取得済みのPRだけで成立する操作と、
  本番デプロイの状態まで。** バンプPR作成→develop反映→PR作成→mainへマージの4段の進捗は
  ヘッダー側（`ReleaseProgress`）に残す——ここで全部を追うと取得を増やさない前提が崩れる。
  **本番デプロイだけを例外にしているのは、PRの情報だけでは誤ったことを言ってしまうから**（#1579）。
  リリースPRがマージされた瞬間に束の見出しが「◯/◯に本番反映」へ変わっていたが、見ているのは
  mainへマージされた事実だけで、そこから`deploy.yml`が数分走り、失敗すればmainに入ったまま
  本番へは出ない。**デプロイが済むまで「本番反映」と書かない**ようにし、実行中・失敗・待ちを
  束の見出しと畳んだ1行に出す（デプロイ中・失敗のリポジトリは初回に自動で開く）。
  取得は専用の軽いエンドポイント`GET /api/branch-flow/deploy`（mainブランチの`deploy.yml`の
  最新run 1件。`fetchLatestDeployWorkflowRun`）で、**リリース用workflowを持つリポジトリだけ**を
  対象にする。判定（`lib/branch-flow.ts`の`resolveDeployState`）は**直近のリリースPRのマージ時刻と
  runの開始時刻の比較だけ**で、追加の照合は要らない。runが取得できない（`deploy.yml`が無い等）
  場合は状態を出さず従来表示のままにし、**実行が現れないまま15分が過ぎた「デプロイ待ち」も
  打ち切る**（mainへのpushでデプロイしないリポジトリで永久に待ちと言い続けないため）。
  **この画面で唯一の自動更新がここ**（`hooks/use-deploy-status.ts`。デプロイが動いている間だけ
  30秒ごと）。消費が釣り合うのは、リポジトリあたりREST 1回であることと、
  `fetchLatestWorkflowRun`がETagの条件付きGETを通す（変化が無ければ304でレート制限を消費しない）
  ため。ブランチ状況とPR一覧は従来どおり手動更新のまま。
  **一度起動したら、バンプPRが現れるまでボタンを押せなくする**（#1548）。起動からPRが現れるまでの
  数十秒は`canTriggerRelease`がtrueのまま残り、その間の連打がworkflowの多重起動になっていた
  （既存のバンプPRがあれば作成はスキップされるが、バージョン判定のClaude実行は毎回走る）。
  起動時刻は端末のlocalStorageへ置き、判定は[`lib/release-trigger-guard.ts`](../src/lib/release-trigger-guard.ts)。
  **10分で失効させる**のは、workflowが失敗してバンプPRが1本も作られなかったときにボタンが
  二度と押せなくなるのを防ぐため。サーバー側に押下を記録しないのは、問い合わせるとこの画面の
  前提（取得を増やさない）が崩れるから。ヘッダー側は取得済みの`phase`・runで同じ判定ができるため、
  そちらは進行中なら起動ボタンを無効にする。
  **mainへのマージもこの画面から行える**（#1548）。束の見出しのマージボタンは一覧・詳細と同じ
  `PullRequestMergeButton`（`POST /api/issues/pull-request-merge`。merge commit）で、
  `mergeWarnings`がbase`main`のPRに「本番デプロイが走る」警告を必ず返すため確認ダイアログを通る。
  マージ成功後は「マージ済み」で無効のまま残す——再取得が終わるまでの数秒に押せると、
  2回目のマージ要求が飛ぶため。
  **バージョンバンプPR（`release/vX.Y.Z`→develop）はレーンではなく幹として描く**（#1548）。
  レーンとして扱っていたころは、バンプPR本文に並ぶ「今回のリリース対象issue」を
  `linkedIssueNumbers`が拾い、無関係なIssueが対応Issue・関連としてぶら下がっていた。
  openなバンプPRは未リリースの束の`bumpPullRequest`に入り、束の版もそのブランチ名から決まる。
  マージ済みのバンプPRは表示しない（どの版で本番へ出たかは束の見出しが表しているため）。
  この行のマージボタンは**Auto-mergeが効いていないとき（＝滞留しているとき）だけ**出す。
  **「どのバージョンで本番へ出たか」は、追加の取得をせずPRのマージ時刻だけで決める。**
  develop→mainのリリースPRはマージ時点のdevelopをそのままmainへ入れるので、作業PRが
  developへ入った後**最初にマージされたリリースPR**がその変更を運んだことになる。版はその
  リリースPRのタイトル（`v3.17.0をmainへリリースする`。文面は
  `reusable-release-develop-to-main.yml`が作る）から取る。クローズ済みPRの取得は直近30件で
  打ち切っているが、作業PRが取得できていればその後のリリースPRも必ず取得できている
  （後からマージされたPRの方が更新が新しく、先に切り捨てられない）ため、「後続のリリースが
  無い＝本番未反映」と読んでよい。リリースPRを1件も取得できていないときだけ判定不能として
  「バージョン不明」を出す（誤った版を出さないため）。
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
- **リリースの進捗を出す経路は2本ある。リポジトリ1件の詳細と、全リポジトリ横断のサマリ。**
  詳細は`GET /api/repositories/release`（`hooks/use-release-status.ts`）で、ロケットアイコンの
  ポップオーバー・モバイルのリリースシートが使う。1回でGitHub APIを7〜8回消費するため、
  開いている間だけポーリングする。横断のサマリは`GET /api/repositories/release-pending-merges`
  （`hooks/use-repository-release-statuses.ts`）で、PCヘッダーのロケットアイコンのバッジと
  **モバイルのリポジトリ一覧のバッジ**（#1117）が共有する。**状態の4値への畳み込み
  （`idle`/`progressing`/`action_required`/`error`）と表示文言は、どちらの経路も
  [`lib/github/release-button-status.ts`](../src/lib/github/release-button-status.ts)の
  `summarizeReleaseStatus`・`describeReleaseStatusBadge`だけを通す**（画面ごとに分岐を書くと
  同じ状態が別の言葉で出る）。横断のサマリは**版数（`package.json`）を取りに行かないため
  `release_pending`（developだけbump済みでdevelop→mainのPRが未作成）を判定しない**。
  リポジトリあたり2リクエスト増えるのに対し、その状態はほぼ常にリリースworkflowのrunが
  実行中か失敗として現れるため。`idle`のリポジトリは応答に含めない。
  **マージ待ちPRを「要操作」（オレンジ強調）にする基準は、バンプPR・develop→mainのリリースPRの
  どちらも「CIが`pending`でなくなった時点」で揃えている**（#1433）。PRが作られた直後はまだ
  マージできないため、押しても弾かれる操作を強調して促さない。`unknown`（`Checks: read`が無い・
  取得失敗）は「要操作」のまま残す（CI状態が取れないだけでマージの導線が消えないように）。
  なおリリースPRのheadは`develop`そのもので、そのcheck-runsにはCI以外のワークフローも混ざる
  ため、developで無関係なワークフローが走り出すと一時的に「実施中」へ戻る。
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
  **ローカル実行のコメントをActions同等にする残り2件も同じ経路で書く**（#1119）。起動直後の
  受付コメントは`run-issue-session.sh`が`POST /api/dispatch/sessions/started`へ投げ
  （`lib/dispatch/session-start.ts`）、**Issueに何も記録が残らないまま終わったセッション**には
  終了時に締めのコメントを書く（`lib/dispatch/session-wrapup.ts`。`/sessions/ended`とpollerの
  巡回の両方から呼ばれるが、**自分のマーカーを「記録あり」に数えるので投稿は1回**。
  `00.check-user`は付けない）。インストールトークンの取得は
  `lib/dispatch/installation-token.ts`に寄せてある。
  `23.preview-required`のセッションは開発サーバーを`tailscale serve`でtailnetへ出し、そのURLも
  同じ経路で報告する（#1265。**出すのはFQDNのみ。serveはHostヘッダーで振り分けるため生IPは404**）。
  **複数リポジトリ横断の質問もこのキューで流す**（#1454。`kind`は`CROSS_REPO_QUESTION`）。
  Actionsは1リポジトリしかチェックアウトしないため横断できず、サブPC限定の導線になる。
  質問Issueは記録先リポジトリ（既定は名前が`question`のもの）に普通のIssueとして作り、
  ランチャー（`scripts/start-cross-repo-question.sh`）は**worktreeを作らず**、実行できる
  全リポジトリを`--add-dir`で読み取り用に渡す（書き込み系ツールは`--disallowedTools`で封じる）。
  回答は既存の`QA_ANSWER_MARKER`付きコメントで返るので、「回答待ち」の表示とワンボタンクローズが
  そのまま働く。
  立ったセッションの停止（`C-c`）・終了（`kill-session`）も同じキューを通る（#1332。`DispatchJob.kind`。
  **pollerはセッション名を`repositoryFullName`/`issueNumber`から組み立て直して突き合わせ、
  受け取った名前をtmuxへ渡さない**）。タイムアウトは定期実行を持たず、enqueue・claim・一覧取得のたびに
  `expireStaleDispatchJobs`が掃く遅延評価。**セッション本数の上限（#1361）で待っていることは、
  pollerが申告する`maxSessions`/`liveSessions`から画面に出す**（#1394。文言は
  `lib/dispatch/queue-summary.ts`。**割り当ての判定はpoller側のままで、issue-deckは表示にしか
  使わない**）。**順番待ちは`DispatchJob.queuePriority`（既定0）で先頭へ上げられる**
  （#1541。`POST /api/dispatch/<id>/prioritize`。払い出しも画面も`queuePriority`降順→`createdAt`昇順で、
  **見えている順番と走る順番を一致させる**。任意の並べ替えは持たない）。
  「どのリポジトリを起動できるか」はサブPCが申告し、
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
  **画面（`capture-pane`）の内容は読まない**。**PRを作り`11.local`も外した引き渡し済みの
  セッションも畳む**（#1541。猶予は`SESSION_HANDOFF_IDLE_MINUTES`。畳まれても
  `run-issue-session.sh`の`--continue`で前回の会話の続きから再開できる）。設計は
  [multi-agent/local-quick-start.md](multi-agent/local-quick-start.md)。
- **開発サーバーの回収は在庫を2通り持つ**（#1525）。PIDファイル（`.dev-servers/issue-<番号>.pid`）
  だけを見ていると、エージェントが手で起こし直した2本目は載らないため存在自体が見えない。
  `scripts/reap-dev-servers.sh`は`/proc`も走査し、動いているプロセスから入る経路を併せ持つ。
  **プロセスの特定はコマンドラインの部分一致で行わない**——`claude`はプロンプト全文をargvに持ち、
  Issue本文の`next-server`という記述に`grep`が当たった実績がある（#1523）。判定は
  `scripts/lib/dev-server.sh`の`dev_server_is_dev_command`（`/proc/<pid>/cmdline`をNUL区切りで
  読み、argvの位置で見る）。**systemd timerは新設していない**（周期ではなく在庫の問題なので、
  足すと同じ役が2つになる）。
- **他セッションのやり取りを読むのは`scripts/inspect-session.sh`だけ**（#1477）。人が叩いたときに
  1回だけ転記（`~/.claude/projects/<スラッグ>/*.jsonl`）を解決して端末へ畳んで出す読み取り専用の
  道具で、常駐せず、**読んだ結果から対象セッションへ何も送らない**。転記を読む処理をここと
  `session-notify.sh`の外へ広げないこと（Claude Codeの内部仕様に依存しているため）。設計は
  [multi-agent/session-inspect.md](multi-agent/session-inspect.md)。
  **`run-issue-session.sh`が同じ置き場を見るのは「`*.jsonl`が1つでもあるか」だけ**
  （#1541。`claude --continue`を付けるかの判定で、**中身は開かない**）。名前の導き方が変われば
  ヒットしなくなり、新規会話で始まるだけなので、上のルールの主旨（内部仕様への依存を広げない）は
  守れている。
- **ブランチの掃除はローカルとリモートで担当スクリプトが違う**（#1478）。ローカルのworktreeと
  ブランチは`scripts/cleanup-worktrees.sh`（#1100）が、GitHub上のリモートブランチは
  `scripts/cleanup-merged-branches.sh`が扱う。後者は「最新PRがマージ済み」かつ
  **ブランチの現在SHAがそのPRの`head.sha`と一致する**ものだけを消し、`develop`など名前で
  保護する。今後のぶんはリポジトリ設定`delete_branch_on_merge`（適用は
  `scripts/set-delete-branch-on-merge.sh`）が自動で消す。**リモートブランチを消すと無人実行の
  mode判定が変わる**点を含め、設計は[multi-agent/branching.md](multi-agent/branching.md)。
- **個人設定（`~/.claude/CLAUDE.md`・個人skill）の実体は`guchi-apps/claude-config`にあり、
  両機は`~/.claude/`側をsymlinkにして同じファイルを見る**（#1190）。issue-deckが持つのは
  「取り残しに気づく手当て」だけで、`scripts/lib/personal-config-sync.sh`の
  `warn_personal_config_drift`を`start-issue.sh`・`generic-start-issue.sh`が起動前に呼ぶ。
  **警告するだけで起動は止めず、リポジトリが無い環境（Actions・セットアップ前）では
  黙って素通りする。** 設計は
  [multi-agent/personal-config-sync.md](multi-agent/personal-config-sync.md)。
- **セッションへ最初に渡す文面は`run-issue-session.sh`が組み立てる。** 渡すのはプロンプト
  ファイルの中身ではなく「そのファイルを読んで着手せよ」の1文（#1105）と、**概要・オプション・
  開発環境の3行**（#1559。`scripts/lib/kickoff-prompt.sh`）。**概要は先頭150文字までの抜粋で、
  本文全文は載せない**（`ps`に出るのを避ける#1405の判断を引き継ぐ）。オプションの日本語名は
  画面（`src/lib/github/start-implementation.ts`の`START_IMPLEMENTATION_OPTIONS`）と同じもので、
  ずれは`src/lib/prompts/kickoff-prompt.test.ts`が検出する。設計は
  [multi-agent/local-quick-start.md](multi-agent/local-quick-start.md)。
- **エージェントの出力を日本語に揃える指示は、起動フラグとプロンプト本文の二層で持つ**（#1395）。
  文面の正は`scripts/lib/agent-language.sh`で、`run-issue-session.sh`・`start-reviewer.sh`が
  `--append-system-prompt`で渡す。そこを通らない無人実行のために、同じ文面を`.github/prompts/`・
  `scripts/prompts/`の「## 出力言語」にも置いている。**片方だけ変えない。** 設計は
  [multi-agent/prompts-and-models.md](multi-agent/prompts-and-models.md)。
- **セッションと一緒に動くスクリプト（`run-issue-session.sh`・`session-notify.sh`・
  `scripts/lib/`・`scripts/prompts/`）は、`origin/develop`から取り出した同期コピーから走る**
  （#1274・#1438）。worktreeは毎回`origin/develop`から作られるのに、本体の作業ツリー
  （`~/apps/issue-deck/scripts/`）を新しくするのは人の`git pull`だけで、`scripts/`の修正は
  マージしただけでは反映されなかった（#1438は、承認と同時に`00.check-user`を外すフック設定が
  生成されないという形でこれを踏んだ）。`scripts/lib/launcher-scripts-sync.sh`の
  `resolve_launcher_scripts_dir`が置き場所を決め、`warn_launcher_scripts_stale`が差分を警告する。
  **同期コピーを使うのは作業ツリーが単に古いだけのときに限り、未コミットの変更があれば
  そちらを優先する。作業ツリーには触れない（自動pullはしない）。** 入口の`start-issue.sh`と
  pollerは作業ツリーのまま。経路の表は
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
  同じく**質問Issueは「未着手」「実行中」ではなく専用の「質問」ビューに出す**（#1514）。質問Issueは
  Projectに載らずStatusが常に`Ready`扱いになり、回答を読んで承認した後は`00.check-user`も外れるため、
  ビューが無いとcloseするまで「未着手」に居座る。判定材料はタイトル接頭辞
  （`lib/github/ask-claude.ts`の`isAskRepoQuestionIssue`。`[質問] `と旧形式`質問: `の両方）で、
  ラベルにもStatusにも現れないため`NavView`の`questionOnly`/`excludeQuestions`という専用条件にしている。
  **`excludeQuestions`は`qaAnswerPendingAt`の特例より先に判定する**（順序が逆だと回答待ちの質問Issueが
  「実行中」へ抜ける）。「ユーザーの確認待ち」からは除外しない（回答が届いた合図なので出し続ける）。
  引く側を`lib/dispatch/pending-dispatch.ts`に分けているのは、`lib/dispatch/jobs.ts`が
  セッション経由でGitHub Appの認証（読み込み時点で`GITHUB_APP_*`を要求する）を引きずるため。
  Issue一覧にその資格情報を要求させない。
- **1Password→GitHubのシークレット同期は、issue-deckが書くのではなく対象リポジトリのActionsを
  起動する**（#1309）。設定ダイアログの「1Password → GitHub のシークレット同期」から
  `POST /api/secrets-sync`が`sync-secrets.yml`を`workflow_dispatch`し、1Passwordの読み取りも
  GitHubへの書き込みも対象リポジトリのAction（`reusable-sync-secrets.yml`が
  `scripts/sync-github-secrets.sh`をそのまま実行する）の中で完結する。**issue-deckはSecretsを
  書けないままにする**——16リポジトリを操作する立場のため、書き込み権限を持たせると侵害時の
  影響範囲が全リポジトリのデプロイ用シークレットに広がる（`docs/cross-repo-automation.md`）。
  結果は`POST /api/secrets-sync/report`（認証は`PROGRESS_REPORT_SECRET`。進捗報告APIと同じ値）で
  戻り、`SecretSyncRun`に残る。**保存も表示も件数と失敗した項目名だけで、値も値の長さも持たない**
  （長さも手がかりになる）。判断は[`lib/secrets-sync.ts`](../src/lib/secrets-sync.ts)の純粋関数、
  DBとの往復は[`lib/secrets-sync-runs.ts`](../src/lib/secrets-sync-runs.ts)。
  **CLIから直接叩く経路とActions経由では、消費する1Passwordの枠が違う**——CLIは個人アカウントの
  セッションで枠を消費しないが、Actionsはサービスアカウント（アカウント全体で1,000件/日）を使う。
  そのため画面側にキーの絞り込み・確認ダイアログ・クールダウン（直近の成功から10分）を置いている。
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

**`00.check-user`が付いている理由（`01.check-*`。#1490）を読むのも`approval-labels.ts`1か所。**
`checkUserReason`が`00.check-user`とのANDでしか理由を返さないため、外し忘れた理由ラベルが単独で
残っていても画面は無視する。理由が読めないリポジトリ（ラベル未配布）ではnullになり、
`isMergeApprovalPending`・`requiresUserMerge`は従来どおりの推測へフォールバックする。
**理由ラベルを付ける側**は経路が3つに分かれ、ワークフローとプロンプトは`gh label list`と
突き合わせ、issue-deck本体は[`lib/dispatch/check-user-labels.ts`](../src/lib/dispatch/check-user-labels.ts)
を通す（付与エンドポイントは存在しないラベル名を渡すとその場で作ってしまうため）。
一覧は[multi-agent/labels.md](multi-agent/labels.md)「理由を表す`01.check-*`ラベル」。

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
