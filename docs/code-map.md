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
    issues/new      Issue作成画面を別ウィンドウで開くためのページ（#1728）
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
- **画面に出す絶対時刻の整形は
  [`lib/format-date-time.ts`](../src/lib/format-date-time.ts)だけを通し、日本時間で出す**（#1977）。
  `toLocaleString("ja-JP")`や`getHours()`は**実行環境のタイムゾーン**で整形するため、UTCで動く
  本番VPS・subpc・CIでは9時間ずれた時刻になる。サーバー描画とブラウザ描画で結果が食い違うので、
  ハイドレーションの警告としても出る。`eslint.config.mjs`の`no-restricted-syntax`が
  `toLocaleDateString`・`toLocaleTimeString`・`new Date(...).toLocaleString`と
  `getHours()`などのローカルタイムの読み出しを禁止しており、例外は`format-date-time.ts`だけ。
  日付の境界（同じ日か・何曜日か）の判定も`toJstParts`・`isSameJstDay`を通す。
  - **変換できない時刻をそのまま出す場合は、どのタイムゾーンの値かを文字列に書く。**
    ホバーで出す完全な日時（`formatDateTimeFull`）は「（日本時間）」を添えている。
  - 相対表現（`formatRelativeDate`の「3時間前」）は差分の計算なのでこの規約の対象外。
    DB・API応答・スクリプトが受け渡すISO文字列はUTCのままでよい（表示ではないため）。
- **画面の現在地を表すURLクエリの更新は
  [`hooks/use-history-navigation.ts`](../src/hooks/use-history-navigation.ts)の`navigateParams`
  だけを通し、`router.push`/`router.replace`を使わない**（#1597）。App Routerの
  `router.push`はRSCのリクエストを伴い、`/dashboard`は認証Cookieを読む動的ページで
  クライアントのRouter Cacheに残らないため、クエリを1つ変えるたびに`DashboardPage`
  （Issue全件のDB取得を含む）がサーバーで再実行される。`useSearchParams()`はその応答が
  返るまで更新されないので、Issueを選んでからハイライトが動くまでその往復を待つことになる。
  `navigateParams`はネイティブのHistory API（Next.jsがパッチ済みの
  `window.history.pushState`/`replaceState`）でクエリだけをクライアント側で更新する。
  **前提は「そのクエリをサーバー側で読んでいないこと」**で、`/dashboard`のページは
  `searchParams`を受け取っていない。サーバーでクエリを読むようになったら、この前提が壊れる
  （URLを変えても表示が更新されない）ため、`navigateParams`を`router.push`へ戻すか
  必要なところに`router.refresh()`を足すこと。
  なお、この更新はReactのトランジション（低優先度の更新）として入るので、**一覧の選択
  ハイライトはURLの反映を待たずに出す**（`issue-list.tsx`・`pull-request-list.tsx`が押された
  行を自分でも持ち、正の選択が追いついたら捨てる）。待つと、右カラムの再描画が終わるまで
  押した行が反応しない。
- **PR詳細の開き方は2つあり、入口ごとに決まっている**（#2149）。「ユーザーの確認待ち」に並ぶ
  マージ待ちPRのカードだけが**その場に重ねて開く**（`prmodal`クエリ＋
  [`pull-request-detail-dialog.tsx`](../src/components/dashboard/pull-request-detail-dialog.tsx)）。
  確認待ちは上から順に片付ける場所で、1件開くたびにPR一覧画面へ移ると続きを見るのに毎回
  戻る操作が要るため。左メニューのPull Request一覧・ブランチ画面・通知ベル・本文中の参照
  リンクからは、従来どおりPRペイン（`pane=pull-requests`＋`pr`）へ遷移する。
  - **重ね表示の開閉も`prmodal`クエリが正で、stateでは持たない。** 重ね表示の中にアプリ内
    リンク（ヘッダーの「Issue #N」・本文とコメントの参照）があり、stateで持つと押したときに
    下の画面だけが遷移して重ね表示が残る。クエリなら遷移側で`prmodal`を落とすだけで
    「閉じて遷移」になり、戻る操作で重ね表示ごと戻ってくる。落とすのは
    [`use-reference-navigation.ts`](../src/hooks/use-reference-navigation.ts)・
    [`use-mobile-screen.ts`](../src/hooks/use-mobile-screen.ts)の`navigate`・
    `use-issue-filters.ts`のビュー／ペイン切り替えの3か所で、**現在地を進める経路を足したら
    ここでも落とす**。
  - **`pr`クエリと共用しない。** `pr`はスマホのPR詳細画面（`mscreen=pull-requests`）が
    使っており、共用すると「一覧の上に重ねる」と「画面を差し替える」の条件が重なる。
  - ヘッダーの材料（`PullRequestSummary`）を一覧と詳細APIのどちらから採るかは
    `resolvePullRequestHeader`（[`lib/pull-request-list.ts`](../src/lib/pull-request-list.ts)）
    に集約してあり、PRペインと重ね表示で共用する。
- **Issue一覧の上に並ぶ「〜が n件あります。」の入口バーは、`issue-list.tsx`の
  `COUNT_BAR_*`定数を使う**（#2107）。手作業アシスタント・「次にやること」・「まとめて実行」の
  3本が同じ作りで、**入りきらない幅ではボタン側が次の行へ落ちる**（`flex-wrap`＋テキストの
  `basis-48`＋ボタン側の`ml-auto`）。**1行固定の`flex`へ戻さない**——中央カラムは手で狭められる
  （#381）ため、縮められるものが`flex-1`のテキストしか無くなると幅0まで潰れ、1文字ずつ縦に
  並ぶ。右が「自動実行 n / m」バッジとボタンの2つになる手作業のバーで最初に起きる。
  **伸ばす指定は`flex-1`ではなく`grow`にする**——`flex-1`は`flex`ショートハンドなので
  `basis-48`と同じ`flex-basis`を奪い合い、どちらが勝つかがTailwindのCSS出力順に依存する。
  折り返しはjsdomでは再現できないため、指定が残っているかは`issue-list.test.tsx`が
  クラスで見張っている。
- **Issue一覧の行は「カード全面に敷いた選択用の`<button>`」と本文が兄弟**（#1915。
  `issue-list.tsx`の`renderIssueRow`）。行に操作（リンク・ボタン）を足すときは、
  **本文側（`pointer-events-none`）の中で`pointer-events-auto`を付けて置く**。
  以前のように本文ごと`<button>`で包むと、その中にリンクを置けない——不正なHTMLになるうえ、
  押すとIssueの選択まで走る。枠線・選択ハイライト・ホバーは`<li>`側に付いている。
  - **その行のRemote Controlのボタンを強調するかの判定は
    [`lib/remote-control-attention.ts`](../src/lib/remote-control-attention.ts)の
    `shouldEmphasizeRemoteControl`だけが持つ**（#1964。`question-attention.ts`・
    `manual-step-attention.ts`と同じ形）。**ボタンを出す条件（`summarizeIssueSession`の
    `remoteControlUrl`）とは別物**なので、ボタンの側で両方を組み立てない。中身は
    `isSessionWaitingInput`と`checkUserReason`・`isSessionRemovableCheckUserReason`を
    合成するだけで、条件を書き下ろさない——入力待ちは`ALIVE`のときだけ、理由は
    `00.check-user`とのANDでしか読まない、という既存の担保を二重に持たないため。
    **強調は枠線と文字のamberだけで、中は塗らない**（同じ形の行が縦に続く一覧では、
    塗りつぶしたボタンが1つあるだけで視線を奪う）。色は右上のバッジ
    （`WorkflowStepBadge`）の確認待ちと同じamberを使い、同じ行の中で同じ意味に別の色を当てない。
- `components/ui/` はshadcnの生成物なので、変更したい場合は生成物を直接編集せず
  ラップするコンポーネント側で対応する。
- **Issueの作成フォームは、ダイアログでも別ウィンドウでも
  [`create-issue-dialog.tsx`](../src/components/dashboard/create-issue-dialog.tsx)1つだけ**（#1728）。
  `presentation`（`dialog` / `window`）で外枠（見出し・フッター・オーバーレイの有無）だけを
  差し替え、項目・操作の流れ・作成後の動きは共通のまま使う。**別ウィンドウ用にフォームを
  もう一つ作らない**——以降の変更を2か所へ入れ続けることになり、片方だけ古くなる。
  別ウィンドウのページは[`app/issues/new/page.tsx`](../src/app/issues/new/page.tsx)、
  ウィンドウとしての振る舞い（受け渡し・閉じ方・作成の通知）は
  [`create-issue-window.tsx`](../src/components/dashboard/create-issue-window.tsx)が持つ。
  `window.open`では状態を直接渡せないため、書きかけの内容はlocalStorage経由で一度だけ渡す
  （[`lib/issue-create-window.ts`](../src/lib/issue-create-window.ts)。下書きの自動保存
  （`use-issue-draft`）とはキーも意味も別物で、あちらは人が「復元する」を選ぶもの）。
  作成したIssueは`BroadcastChannel`で元のデッキへ伝えて一覧へ加えるが、
  **選択中のIssueは動かさない**（[`lib/issue-broadcast.ts`](../src/lib/issue-broadcast.ts)）。
  伝わらなくても一覧のポーリング（10秒）で現れるので、失敗しても作成は止めない。
- **作成フォームの項目は「種別 → リポジトリ → タイトル → 内容 → ラベル」の順で、
  担当者は`m-guchi`固定**（#1929）。スマホ（393×852）で操作ボタンまで一画面に収めるための
  並びで、「どこへ」→「何を」→「詳しく」の順に読める。担当者の選択欄は出さず、
  **作成時に定数を送る**（画面の状態としても下書きとしても持たない）。`/api/issues/meta`が
  返す割り当て可能ユーザーは見ない——取得の失敗・遅延がそのまま「担当者なしのIssue」になり、
  欄が無い以上そのことに画面から気づけないため。**縦を詰めるための省略は、
  画面から読み取れないことだけ残す**——リポジトリの補足文は質問のとき（選択肢が減っている
  理由）だけ、見出しの説明文は質問のときだけ出し、Issueの説明文は`sr-only`で残す
  （消すと`DialogContent`の説明が無くなりRadixが警告する）。
  入力欄の下の「画像を添付」「音声入力を整理」は添付サムネイルと同じ行に並べ、
  プレビューへの切り替えはこのフォームでは出さない
  （[`mention-textarea.tsx`](../src/components/dashboard/mention-textarea.tsx)の
  `showPreviewToggle` / `toolbarExtra`。コメント欄・Issue編集では既定のまま出る）。
- **画像を拡大して見せるのは[`image-preview-dialog.tsx`](../src/components/dashboard/image-preview-dialog.tsx)だけで、`target="_blank"`で別タブに開かない**（#2065）。
  このアプリはホーム画面へ追加して使う（`app/manifest.ts`の`display: "standalone"`）。
  **その起動のしかたではタブもアドレスバーも無く、別タブで開いた画像を閉じて元の画面へ戻る
  導線が画面から消える。** 画像に入口を足すときは、本文・コメント
  （[`markdown-body.tsx`](../src/components/dashboard/markdown-body.tsx)）でも入力欄の添付
  サムネイル（[`mention-textarea.tsx`](../src/components/dashboard/mention-textarea.tsx)）でも
  このダイアログを通す。別タブで開く導線はプレビューの下辺のリンクとして残してある。
  - **全画面に重ねるものは、背景を押して閉じる判定を自分で持つ。** Radixの
    `onPointerDownOutside`は「Contentの外側」を見るが、Contentが画面全体を覆っていると
    外側が存在しない。プレビューは画像そのもの以外のクリック（`event.target`が余白か）で閉じる。
  - **スマホの戻る操作で閉じたい重ね表示は、開いている間だけ履歴を1つ積む**
    （[`hooks/use-history-dismiss.ts`](../src/hooks/use-history-dismiss.ts)）。積まないと
    戻る操作が下の画面へ効き、閉じたつもりが現在地まで変わる。深さの数え方は
    [`lib/history-stack.ts`](../src/lib/history-stack.ts)に合わせ、閉じた時点で
    `history.back()`により自分が積んだぶんを片付ける。
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
  **非表示が効く範囲は左メニュー・PR一覧・「ブランチ」画面・Issue作成の選択肢までで、
  Issue一覧と各ビューの件数には効かない**（#367以来の挙動。区分の説明文でもそう書いている）。
- **設定画面は「開いた区分のぶんだけ」読み込む**（#2022）。以前は設定を開いた時点で5本
  （レート制限・API使用量・Claude使用量・GitHubの障害状況・PAT一覧）が走り、さらに
  「フリート運用」を開くと共有ワークフローのタグ照会と同期履歴が走っていた。今は
  **区分を開くまで取りに行かない**という原則で2か所に分けている。
  - [`hooks/use-settings-data.ts`](../src/hooks/use-settings-data.ts)は`statusActive`
    （「状態」区分を開いているか）を受け取り、使用量・レート制限をそのあいだだけ取る。
    **障害状況とPAT一覧だけは先読みのまま**——どちらも区分を開かずに出す警告バッジの材料で、
    遅らせるとバッジが出ない。
  - フリート運用の3区画は
    [`settings/lazy-fleet-panel.tsx`](../src/components/dashboard/settings/lazy-fleet-panel.tsx)の
    カードで畳み、**押した時点で初めて中身をマウントする**（中のセクションはマウント時点で
    取りに行くため、マウント＝通信になる）。**閉じてもアンマウントしない**（`hidden`で隠すだけ）
    ——開閉のたびに同じ取得が走るのを避け、入力中の対象キーも残す。見出しは各カードが持ち、
    中のセクション側には置かない（同じ文言が2行並ぶ）。
  **PATのカードだけは畳んでも取得が減らない**（上のとおり先読みするため）。減るのは描画だけで、
  代わりに期限切れの件数をカードの見出しへ出して、開かずに気づけるようにしている。
- **設定の「フリート運用」でリポジトリを並べる一覧は
  [`fleet-repository-row.tsx`](../src/components/dashboard/fleet-repository-row.tsx)の行を使う**（#1952）。
  シークレット同期・共有ワークフローのタグ・自動修復ワークフローの3つが同じ画面で隣り合うため、
  行の作り（狭い画面は「名前」「結果」の2段・広い画面は1行・長い文言は段を改めて折り返し・
  行の境目に罫線）をここへ寄せる。**アイコンとリポジトリ名を`truncate`＋`ml-auto shrink-0`で
  並べ直さない**——長い文言がスマホ幅で画面の外へ出て読めなくなる（#1942で片方だけ直した結果、
  同じ画面で行の作りが割れていた）。
- **更新履歴（設定の「更新履歴」区分・#1764）に手で書き足さない。** データは
  [`lib/changelog.ts`](../src/lib/changelog.ts)の`APP_CHANGELOG`で、リリースのたびに
  `package.json`の`"version"` lifecycleスクリプト
  （[`scripts/version-changelog.mjs`](../scripts/version-changelog.mjs)）が、共有ワークフローの
  生成した`RELEASE_CHANGELOG`（何が変わったか）と`RELEASE_USAGE`（どう使うか・#1729）を
  配列の先頭へ足す。**バンプ時に依存はインストールされないため、このスクリプトはNode標準
  モジュールだけで書き、`preversion`は作らない。** 表示は
  [`settings/changelog-section.tsx`](../src/components/dashboard/settings/changelog-section.tsx)で
  PC・スマホ共通。**バージョン表示（`app-version-button.tsx`）は区分の外**（PCは左タブ最下部・
  スマホは一覧最下部）に置く——アカウント区分の中にあった頃は開かないと見えなかった。
- **枠の消費を出すバーは[`usage-meter.tsx`](../src/components/dashboard/usage-meter.tsx)を使う**（#1651）。
  設定の「状態」区分にあるClaudeプラン使用量（`claude-usage-card.tsx`）とGitHub API使用量の
  レート制限（`github-rate-limit-list.tsx`）が共通で読む。**使用量を左から右へ伸ばし、経過時間は
  同じバーの上に立つ縦の目盛りで示す。** 以前は残量を描いていたので消費が進むほどバーが縮み、
  経過時間も別の細いバーとして下に並んでいた。**片方だけ旧表示に戻さない**——同じ画面に
  「伸びるバー」と「縮むバー」が混在すると、どちらの向きで読むのかが行ごとに変わる。
  shadcnの`Progress`は`overflow-x-hidden`で端が欠けるため目盛りを重ねられず、この用途では使わない
  （構成比を出す`github-api-usage-list.tsx`の内訳バーは枠の消費ではないので`Progress`のまま）。
  リセットの絶対時刻は下段の幅に収まらないため画面には出さず、`title`（ツールチップ）にだけ置く。
- **一覧を下へ引っ張って更新する操作は[`use-pull-to-refresh.ts`](../src/hooks/use-pull-to-refresh.ts)に集約する**（#1893・#1947・#1958・#2182）。
  判定と時間の定数は[`lib/pull-to-refresh.ts`](../src/lib/pull-to-refresh.ts)へ集約し、
  引っ張ったときの表示は[`pull-to-refresh-indicator.tsx`](../src/components/dashboard/pull-to-refresh-indicator.tsx)が持つ。
  `onPullToRefresh`を渡した画面だけで有効になり、渡しているのはスマホのIssue一覧2画面・PR一覧
  （#1947）・ブランチ画面（`BranchFlowView`。#1958）・スマホのホーム（#2182）。
  **取り直す中身が画面ごとに違うのは「ユーザーの確認待ち」とスマホのホームだけ**で、確認待ちは
  Issueに加えてマージ待ちPRも取り直し（#2175。後述）、ホームはIssue・PR・リリース状況の3つを
  取り直す（#2182。後述）。**描画を一覧ごとに書かない**——文言・色・戻りのアニメーションが片方
  だけ変わると、同じ操作なのに画面ごとに見え方が違うことになる。
  **取り直しの完了を待てない画面は、画面側の取得中フラグを`isRefreshing`として渡す**（#1958）。
  ブランチ画面の`refresh`は取り直しの合図を出すだけの同期関数で、待っても取得の完了とは無関係に
  返るため、渡さないと数秒かかる取得の途中で「更新中…」が消える。フックはフラグが立つのを
  待ってから下りるのを待つ（立たない・下りないときはそれぞれ上限で表示だけ戻す）。
  **端末標準の「引っ張って更新」は使えない**——`app/layout.tsx`が`overscroll-none`＋`body`の
  `fixed inset-0`でドキュメントを固定しているため（#607）。ホーム画面から起動したPWAには
  ツールバーも無く、一覧の画面には更新の手段が無かった（`MobileReloadButton`はホームだけ）。
  実装で外せない点が3つある。**Reactの`onTouchMove`ではなく`{ passive: false }`のネイティブ
  リスナーを張る**（Reactはルートでpassive登録するため`preventDefault()`が効かない）。
  **`preventDefault()`するのは「縦方向かつ下向き」に動いている間だけ**——方向判定
  （`use-swipe-back.ts`と同じ式）は横が明確に優位でない限り縦と見なすので、条件を「縦」だけに
  すると一覧の先頭から上へ読み進めるスクロールごと止まる。**タッチを受けるのはスクロール領域
  （`<ul>`）ではなくそれを包む枠**で、`<ul>`は0件で消えるため直接付けると空の一覧を更新できない。
  取り直すのは`GET /api/issues`（`use-issue-polling.ts`の`refresh`）と実行状況、および
  「ユーザーの確認待ち」に限り`GET /api/pull-requests`（#2175）までで、
  **GitHubからの再同期（`POST /api/sync/issues`）はしない**。再同期はDBの全件を突き合わせ直す
  重い経路で、指を下ろすたびに走ってよい操作ではない（設定の「フリート運用」に置いてある）。
  PRの取得も1回でリポジトリ数ぶんのGitHub APIを呼ぶが、ETagの条件付きGETを通しているため
  変化が無い間は304でレート上限を消費しない（`lib/github/conditional-request.ts`）。
  **ホーム（`mobile-home-screen.tsx`）だけは`useNotificationState`の`refresh`を渡す**（#2182）——
  ホームに出ている数字はIssue一覧・PR一覧・リリース状況の3つから来ており、Issueだけを取り直すと
  「ブランチ」行やPRの件数が古いまま残って、更新したのに変わらない画面になる。ベル右上の
  「更新」ボタンと同じ経路で、`isFetching`をそのまま`isRefreshing`として渡す。リリース状況の
  取得はGitHub APIを使う（通常は5分間隔）ぶん消費は増えるが、押した回数ぶんしか走らない。
  **サブPCのカードの取り直し（`dispatch.refresh`）はホーム側で足す**——実行状況はこの画面が
  自分で取っているもので、ベルの`refresh`には入っていない。**ヘッダーの`MobileReloadButton`は
  残す**（引っ張る方は数字だけ、ボタンはページ全体の再読み込み＝新しいビルドへの追従）。
  **一覧の先頭に固定するセクション（`IssueList`の`pinnedSection`）も、その枠の中に置く**（#2175）——
  「ユーザーの確認待ち」に並ぶマージ待ちPR（#1613）は画面の上半分を占めることがあり、枠の外に
  置くとそこを下へなぞってもタッチが届かず「引っ張っても何も起きない」ことになる。引っ張りに
  追従する`translateY`も`<ul>`ではなく固定セクションごと包む要素へ掛ける（片方だけ下げると、
  引いている最中に固定セクションと一覧の境目が割れて見える）。
  **確認待ちの一覧では、引っ張ったときにIssueとマージ待ちPRの両方を取り直す**（#2175）——
  このビューではPRの自動更新を止めている（`usePullRequests`へ間隔を渡すのはPR画面とブランチ画面
  だけ）ため、Issueだけ取り直すと画面の上半分は開いた時点のまま残る。呼ぶかどうかの判定は
  `MobileIssuesScreen`が持ち（他のビューで呼ぶと1回でリポジトリ数ぶんのGitHub APIを使う）、
  指で引けないPCは`MergePendingPullRequests`の見出しに置いた「更新」から同じ`refreshFromPull`を
  呼ぶ。
- **Issue詳細の「いま何が起きているか」と補助情報は、PC・スマホで同じ部品を使う**（#1577・#1646）。
  進捗ステップ・積んだジョブ・セッションの様子・横断質問・回答待ち・実行のキャンセルは
  [`issue-status-card.tsx`](../src/components/dashboard/issue-status-card.tsx)へ、
  対応PR・子Issue・AI要約・プロパティは
  [`issue-detail-section.tsx`](../src/components/dashboard/issue-detail-section.tsx)の
  折りたたみへ入れる。**どちらかの画面にだけ状態表示を足さない。** 足すとPCとスマホで
  「何が起きているか」の答えが食い違い、片方でしか気付けない状態が生まれる。
  スマホ側で新たに増えたのは、上部の
  [`mobile/mobile-issue-summary-card.tsx`](../src/components/dashboard/mobile/mobile-issue-summary-card.tsx)（読む専用）と
  [`mobile/mobile-issue-properties-section.tsx`](../src/components/dashboard/mobile/mobile-issue-properties-section.tsx)（編集の口）で、
  **サマリーは読むだけ・編集は折りたたみ**が分け方の要点。同じ値を両方に出すのは、担当者と進捗の
  ように**畳んだ行が「変えられる場所はここ」と示す必要がある**ときに限る（#1920）。進捗はこれで
  読める場所が最大3つ（サマリーカード・実行状況カードのステップ表示・畳んだ行）になるが、
  **前の2つは読む専用で、変更の口を指せるのは畳んだ行だけ**。`ready`・`closed`ではステップ表示が
  出ないので2つに収まる。
  `IssueDetailSection`の開閉状態は`issue-detail.section.<id>`のlocalStorageで**セクションごとに1つ**
  持つため、PC・スマホで同じ`id`を使う（端末が違えばストレージも別で、同じ端末なら同じ設定が効く）。
  **積んだジョブの状態（`DispatchJobStatus`）はカードが出すので、`StartLocalSessionButton`へは
  `showJobStatus={false}`を渡す**（両方出すと「順番待ち」が同じ画面に2つ並ぶ）。
- **同じ状態を2か所で言わせない。誰が言うかは並べる側（`IssueStatusCard`）が決める**（#2057）。
  `WorkflowStatusSteps`・`CheckUserReasonNotice`・`IssueSessionStatus`・
  `MobileIssueSummaryCard`は、**どれも同じ材料（`00.check-user`＋`01.check-*`・
  `resolveIssueExecutionTarget`）から独立に文言を組み立てる**ため、素直に並べると1つの用件が
  4回出る（確認待ちのIssueで実際にそうなっていた: サマリーのバッジ・ラベルチップ
  `00.check-user`/`01.check-merge`・ステッパー下のバッジ・案内パネルの見出し）。
  子は「出せるかどうか」だけを知っていて「他に誰が言っているか」を知らないので、
  **判断は並べる側に置き、子には`showApprovalBadge`・`showExecutionTarget`・
  `excludeAttention`のような出し分けのpropを渡す。** 子の中で他の部品の有無を推測しない。
  - 状態そのものを表す**形（現在ステップの琥珀色・確認待ちのバッジ色）は消さない**。
    重複しているのは文字だけで、色は一目で読むための別経路。
  - **文言が「押すボタン」を名指しする場合は、その行き先に実在するか確かめる**。
    `01.check-merge`の上部案内は「直したい点があれば『修正を依頼する』」と書いていたが、
    そのボタンはコメント欄の承認カード（`comment-thread.tsx`）にしか無く、案内が送る
    上部の対応PRセクションには「マージ」しか無かった（`buttonsAway`と`buttonsHere`を
    分けているのはこのため）。
  - **押す先が無く、読んでも次の行動が変わらない表示は出さない。** 「実施順序 1
    前提はそろっている」がその例で、`IssueOrderSection`は前提待ちか被依存があるときだけ描く。
- **セッション・ホストの状態で見た目が変わるものは、`dispatch.isLoaded`が立つまで形を決めない**
  （#1666・#1810）。[`use-dispatch-state.ts`](../src/hooks/use-dispatch-state.ts)の
  `hosts`・`sessions`・`jobs`は**取得前も`[]`を返す**ため、受け取る側からは「1台も無い」
  「セッションが無い＝入力待ちではない」と区別が付かない。区別せずに描くと、開いた直後だけ
  必ず「無い側」の表示が出てからフェッチ完了で書き換わる。実際に、
  実装開始ボタンが「GitHub Actionsで開始」→「サブPCで開始」へ変わり（#1666）、確認待ちの案内と
  承認欄が「承認欄へ移動」「承認」「修正」→「Remote Controlで開く」へ変わっていた（#1810）。
  **`isLoaded`は取得に失敗しても`true`になる**ので、待ち続けて何も出ない状態にはならない。
  判定を持つ`resolveCheckUserGuidance`（`sessionStatePending`）と`ApprovalActions`
  （同名のprop）は、確定するまで**どちらの形も出さない**（推測で片方を出すより、一拍遅れて
  正しいものが出る方が害が小さい）。**マージ待ちだけは例外**で、判定材料がラベルとコメント
  なのでセッションの状態を待たない。
- **スマホのIssue詳細のヘッダーに操作を足さない**（#1646）。置けるのは`←`・タイトル・`★`・`⋯`だけで、
  それ以上並べると390px幅でタイトルが読めなくなる（以前は`▶`と`?`があり、タイトルに120pxしか
  残っていなかった）。**本文に同じ操作があるものはヘッダーに置かない**（`▶`は
  `canStartImplementation`が本文の全幅ボタンと同一条件で必ず二重になっていた）。増やす場合は
  `⋯`メニューへ入れる。**ダイアログを`⋯`から開くときはトリガーを`DropdownMenuItem`にせず**、
  親が`open`・`onOpenChange`を持つ（メニューが閉じるとトリガーごと外れ、ダイアログも消える）。
- **スマホの各画面の縦スクロール領域には`flex-1`を付ける**（#1664）。
  `flex flex-col overflow-hidden`な画面の中で、ヘッダーの下に置く`overflow-y-auto`の領域が対象。
  付け忘れても`flex: 0 1 auto`のまま縮小して収まるので**見た目の高さは変わらず、PCのブラウザでは
  何も起きない**。実害はiOSのホーム画面アプリ（standalone PWA）でだけ出る。高さが「中身の高さから
  縮んだ結果」として決まるため、ポーリングの更新や画像・コメントの読み込みで中身の高さが変わる
  たびにスクロール領域の箱ごと再レイアウトされ、スクローラの描画内容が失われる。**レイアウトは
  正しいのに背景も文字も描かれない領域が残り**、その後Reactが更新した一部（相対時刻など）だけが
  描き直される、という状態になる。ブラウザで再現しないのはURLバーの伸縮で全面の描き直しが
  頻繁に起こるため。付け忘れは
  [`mobile/mobile-screen-scroll-container.test.ts`](../src/components/dashboard/mobile/mobile-screen-scroll-container.test.ts)
  で検出する（`max-h-`で高さの上限を自前で持つ`SheetContent`や小さな枠は対象外）。
- **`input` / `textarea` / `select` の文字サイズをスマホ幅で16px未満にしない。** iOS Safariは
  font-sizeが16px未満の入力欄にフォーカスが入ると画面全体を自動で拡大し、一度拡大すると
  元に戻らない（#1442）。小さくしたい場合は `text-base md:text-sm` のように`md`以上に限定する。
  `cn()`へ`text-sm`を渡すとtailwind-mergeがベースの`text-base`を消してしまう点に注意。
  取りこぼし対策として、[`app/globals.css`](../src/app/globals.css) に`md`未満で16pxを
  下回らせないルールを置いている。
- **Issueの作成と単一リポジトリへの質問は同じダイアログ**（#1641。
  [`create-issue-dialog.tsx`](../src/components/dashboard/create-issue-dialog.tsx)）。先頭の
  「種別」（Issue／質問）で切り替え、**本文の入力欄・画像添付・`#123`のIssue補完・ラベル選択は
  どちらでも同じ部品**（`MentionTextarea`）を使う。種別で変わるのはタイトル（質問は
  `buildAskRepoQuestionTitle`で質問文から機械生成し、入力させない）・担当者の有無・
  リポジトリの絞り込み（質問は`claude-issue-dispatch.yml`導入済みのみ）・作成後の動き
  （質問はIssue作成に続けて`@claude 質問: `コメントを投稿）だけ。**本文の内容で種別を
  切り替えてはいけない。** 誤判定は押した本人から見えないまま、質問のつもりの本文が実装
  Issueとして無人実行に乗る（逆もある）ため、決めるのは押した人にする。
  **判定して「質問に切り替えますか」と提案するところまでは行う**（#1890）。「タイトル・ラベルを
  付与」が呼ぶ`POST /api/issues/suggest`の応答に`kind`（`issue` / `question`）が乗っており、
  `question`のときだけ種別の下に提案を出す。押さなければ従来どおりIssueとして作られ、
  押したときだけ`selectKind("question")`が走る（戻す口も同じ場所に残す）。判定の実体は
  [`lib/claude/issue-suggest.ts`](../src/lib/claude/issue-suggest.ts)で、**タイトル・ラベルの
  生成と同じ1回の呼び出しに相乗りさせる**——質問かどうかだけのために往復を増やさない。
  `kind`が欠けた・知らない値だった応答は`issue`扱い（`normalizeSuggestedKind`）で、
  提案を出さない側へ倒す。
  **横断質問（#1454）はここに混ぜず、
  [`cross-repo-question-dialog.tsx`](../src/components/dashboard/cross-repo-question-dialog.tsx)
  として独立した入口（ヘッダーの「横断質問」）に残す。** 回答するのがGitHub Actionsではなく
  サブPCの質問セッションで、リポジトリの絞り込み条件（ワークフロー不要）も実行先の選択も
  別物になるため。
- **そのダイアログは1画面で、項目はすべて最初から見えている**（#1884）。種別・リポジトリ・内容・
  タイトル・ラベル・担当者が縦に並ぶだけで、ステップも「次へ」も無い。#1605で入れた2ステップ
  （内容だけを書く`input` → 推定結果を確かめる`confirm`）と、そこに足された本文テンプレート
  （#1745）・リポジトリ候補チップ（#1710）・リポジトリの先指定（#1733）は**まとめて廃止**した。
  **リポジトリを内容から推定しない。** 初期値になるのは呼び出し側が渡す`defaultRepositoryFullName`
  （＝開いていた画面のリポジトリ）だけで、渡されなければ未選択のまま人に選ばせる。渡された値には
  `表示中のリポジトリ`バッジを添え、人が選び直した時点で外す——リポジトリ別の画面から開くと内容を
  読まずにその値が入るため、出どころを書かないと「Claudeが内容から決めた」と誤解される。
  推定していた`POST /api/issues/quick-suggest`と`lib/claude/repository-suggest.ts`は削除済み。
  **タイトル・ラベルは押したときだけ決まる**（`POST /api/issues/suggest`）。タイトルが空のあいだは
  主ボタンが「タイトル・ラベルを付与」になり、押すと**同じ画面の**欄が埋まる。埋まると主ボタンは
  「作成」へ戻り、やり直しはラベル欄の横の「付け直す」へ移る——**同じことをする口を2つ同時に
  出さない**。生成に失敗しても作成は止めない（空欄のまま自分で書ける）。
  Claudeが入れた値には`自動`バッジを出し、人が触った項目からは外す。**バッジは`Label`の外に置く**
  （中に入れるとアクセシブルネームが「タイトル自動」になり、項目名で引けなくなる）。
  **ラベルが1つも決まらなかったときは、その旨を画面に出す**（#1710）。空欄と「決められなかった」
  は見分けが付かず、ラベルの付かないIssueがそのまま作られていた。
  **種別（Issue／質問）が自動で切り替わることはない**（上のとおり。判定して提案するところまで・#1890）。
  質問はタイトルを`buildAskRepoQuestionTitle`で機械生成するため、付与ボタンも付け直すボタンも出さない。
  **操作ボタンは「キャンセル → 作成+実装開始 → 作成」の順にDOMへ置く。** フッター
  （`DialogFooter`・`WindowFooter`）はスマホで`flex-col-reverse`になるため、この順に置くと
  縦積みの一番上が主ボタン、**一番下がキャンセル**になる（#1884）。先頭に`sm:mr-auto`付きの
  ghostボタンを足すと、それが最下段に来てキャンセルが埋もれる。
- **ダイアログの中身が横幅を押し広げないよう、`DialogContent`は`grid-cols-[minmax(0,1fr)]`で
  列を止めてある**（#1710）。暗黙の`auto`トラックは最も長い中身に合わせて伸びるため、
  折り返さない長い文字列（畳んだ本文に出る画像URL等）が1つあるだけで列がその幅まで広がり、
  `w-full`の項目とフッターのボタンがまとめて画面外へ出る。スマホ幅で顕在化するが、
  原因は幅ではなく列の伸び方なので、幅の指定を足しても直らない。
- **「読み込み中」と「読み込めなかった」は、どちらも画面が名乗る**（#1978）。ホーム画面から
  起動したPWAにはタブもアドレスバーも無く、白いまま止まった画面が遅いのか終わっているのかを
  外から知る手段が無い。全画面のローディング（`AppLoadingScreen`）とスケルトンに重ねる帯
  （`LoadingStatusPill`）は[`components/loading-screen.tsx`](../src/components/loading-screen.tsx)、
  失敗したときの画面は[`components/app-error-screen.tsx`](../src/components/app-error-screen.tsx)に
  あり、`app/loading.tsx`・`app/dashboard/loading.tsx`・`app/error.tsx`・`app/global-error.tsx`が
  それぞれを差し込む。**待ち時間で文言を変える判断は
  [`lib/loading-screen-message.ts`](../src/lib/loading-screen-message.ts)だけが持つ**——
  全画面と帯で同じ区切り・同じ言い回しにするためで、コンポーネント側でしきい値を書かない。
  進捗率は出さない（サーバー側から分からないため、止まった数字は止まったアプリに見える）。
  **エラー画面はSSRのHTMLには出ず、クライアントで描かれる**ので、`curl`では確認できない
  （レンダリングテストか実ブラウザで見る）。
- **後から届くものの場所は、実物と同じクラスで組んだスケルトンで取る**（#2090）。スマホの
  ホームのサブPCのカードは`dispatch.hosts.length > 0`で出し分けていたが、`hosts`は取得前も`[]`
  なので、届くまでカードごと消えて下のメニューがカード1枚ぶん繰り上がっていた。出し分けは
  件数ではなく`useDispatchState`の`isLoaded`（**一度でも確定したか**。失敗しても立つ）で行い、
  確定するまでは[`dashboard/dispatch-host-panel.tsx`](../src/components/dashboard/dispatch-host-panel.tsx)の
  `CompactHostCardSkeleton`を1枚置く。
  - **高さは`min-h-*`の固定値ではなく、実物と同じクラスから取る。** Tailwind v4の任意値
    （`text-[10px]`など）はfont-sizeだけを設定し、行の高さは継承した`line-height: 1.5`を
    自分のfont-sizeへ掛けて決まる。したがって**同じクラスを同じ入れ子で並べれば、高さは
    自動的に一致する**。帯は既存の[`ui/skeleton.tsx`](../src/components/ui/skeleton.tsx)へ
    `text-transparent`と実物と同じ文字列を渡して作る（文字が行の高さと横幅を決め、
    `bg-muted`が帯に見せる）
  - **合わせられるのは1通りだけ。** 実物のカードは「応答なし（見出しのみ）」「最新（見出し＋
    使用率）」「遅れている（＋スクリプトの版が1行）」で高さが違い、どれになるかは取得するまで
    分からない。いちばん普通の1通りに合わせ、残りは差ぶん（約21px／約51px）動くのを許す
  - ずれを防ぐのは`dispatch-host-panel.test.tsx`の「高さを決めるクラスが実物と一致する」で、
    実物とスケルトンから高さに効くクラス（`text-*`のサイズ・`p-*`・`mt-*`・`gap-*`・`h-*`）を
    集めて多重集合として突き合わせる。片方だけ直すと落ちる
  - **`aria-hidden`＋`role="status"`の1行**にして、帯の下の文字を読み上げさせない
- **ホーム画面から起動する先は`/dashboard`**（`app/manifest.ts`の`start_url`。#1978）。
  `/`は`redirect("/dashboard")`するだけの通過点で、以前のように`/login`へ送ると
  middlewareが`/dashboard`へ折り返し、認証の確認を含む往復が毎回1回余計に増える。

## `middleware.ts` は無い。`src/proxy.ts` を見る

Next.js 16 で `middleware.ts` は `proxy.ts` にリネームされた。Supabaseのセッション更新は
[../src/proxy.ts](../src/proxy.ts) が `lib/supabase/middleware.ts` の `updateSession` を呼んでいる。
`middleware.ts` を探しても見つからないのはこのため。

## データの流れ

- **Issueの一次情報源はGitHub、MySQLはキャッシュ。** `lib/github/sync-issues.ts` が取得結果を
  `Issue` テーブルへupsertする。画面の一覧はDBを読む。
- **画面が使うIssueの識別子は`String(githubIssueId)`で、`Issue`テーブルの行id（cuid）ではない**（#1671）。
  `lib/github/issue-mapper.ts`の`dbIssueToDisplayIssue`が`id: String(row.githubIssueId)`で作り、
  URLの`?issue=`・`?missue=`もこれで引く（`hooks/use-reference-navigation.ts`）。**サーバー側から
  「このIssueを開くid」を返すときは、`select: { id: true }`ではなく`githubIssueId`を返すこと。**
  行idを返しても型は`string`で通り、リンクは描かれるが、押しても一覧のどのIssueにも一致しない。
  そのときPCは詳細ペインが閉じるだけ、スマホは`use-mobile-screen.ts`がホーム画面へ落とすため、
  「押しても遷移しない」という形でしか表に出ない（実行状況の行で実際に起きた）。
- **GitHub → DBの取り込み経路は2つ。** `/api/webhooks/github`（HMAC署名を検証）で受けるプッシュ型と、
  `POST /api/sync/issues`（画面の再同期ボタン、`hooks/use-issue-sync.ts`）で明示的に走らせるプル型。
- 画面の更新は別の話で、`hooks/use-issue-polling.ts` が10秒間隔で `/api/issues`（＝DB）を読み直す
  （間隔の定数は[`lib/auto-refresh.ts`](../src/lib/auto-refresh.ts)の`ISSUE_POLL_INTERVAL_MS`）。
  ポーリングしてもGitHubには問い合わせないため、Webhookが届いていない変更はここでは拾えない。
- **一覧のヘッダーに出す取得の状態は、3画面（Issue一覧・PR一覧・ブランチ）で同じ並び・同じ文言に
  そろえる**（#1797）。`◯件 ・ HH:MM時点 ・ 自動更新10秒間隔`で、**自動更新していないときも黙らず
  「手動更新のみ」と出す**——何も出さないと「自動更新していない」のか「この画面は状態を出さない」のかを
  見分けられない。文言は`lib/auto-refresh.ts`の`describeAutoRefreshState`（ヘッダー）と
  `describeRefreshButtonHint`（更新ボタンのツールチップ「今すぐ更新（自動更新10秒間隔）」）から
  配り、通知ベル・実行キューの更新インジケーター（`lib/refresh-status.ts`）も同じ言い方を使う。
- **Issue一覧の「HH:MM時点」の初期値は、サーバー側で描いた時刻をpropsで渡す**（#1797。
  `app/dashboard/page.tsx`の`issuesFetchedAt` → `useIssuePolling`の第2引数）。一覧の初期値は
  サーバー描画ぶんで、ポーリングが最初に取りに行くのは10秒後。クライアントで現在時刻を作ると
  初期描画がサーバーと食い違ってハイドレーションが崩れ、effectの中で置くのは
  `react-hooks/set-state-in-effect`（lint）が通さない。
- **コメントはキャッシュせず、都度GitHub APIから取得する**（`/api/issues/comments`）。
- **Issueの親子関係（GitHubネイティブのサブIssue）もキャッシュせず、詳細を開いたときだけ取得する**
  （`/api/issues/sub-issues`・[`lib/github/sub-issues-api.ts`](../src/lib/github/sub-issues-api.ts)）。
  DBへ持たせるとGitHub Appの`sub_issues` Webhookイベント購読の追加（GitHub App設定の手作業変更）と
  スキーマ変更が要るのに対し、得られるのは詳細1回あたり1クエリぶんの節約でしかない。子の
  `projectStatus`だけはDBキャッシュから合流させ、進捗の内訳を出す（`lib/sub-issue-progress.ts`）。
  **サブIssueはリポジトリをまたげるので、親子は必ず`repositoryFullName`とセットで扱う**（#1722）。
  進捗のDB引き当ても画面の行のキーも`owner/repo`＋番号で突き合わせること——番号だけだと、別リポジトリの
  子に**番号が一致する親リポジトリ側の無関係なIssueの進捗**が付く（実際にそうなっていた）。
  別リポジトリの親子の行にはリポジトリ名を添える（`resolveSubIssueRepositoryLabel`）。
  横展開の運用は[multi-repo-changes.md](multi-repo-changes.md)。
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
- **PCのIssue詳細は「固定ヘッダー → 実行状況カード → 折りたためる補助情報 → 説明・コメント」の
  4層**（#1577。[`components/dashboard/issue-detail.tsx`](../src/components/dashboard/issue-detail.tsx)）。
  積み上がった上部の表示を整理したもので、次の3点が判断の要る箇所。
  - **ヘッダー**（[`issue-detail-header.tsx`](../src/components/dashboard/issue-detail-header.tsx)）は
    スクロール領域の先頭で`sticky`。**実体のボタンとして置くのは主操作だけ**にし、「GitHubで開く」は
    アイコン、編集・クローズ・削除は`⋯`へ寄せる（増やすと折り返しで主操作の位置が動く。#998）。
    メタは`Open`・作成者・更新（相対時刻）だけで、**担当者と日付はプロパティパネルに置く**（重複を作らない）。
  - **実行状況カード**（[`issue-status-card.tsx`](../src/components/dashboard/issue-status-card.tsx)）は
    進捗ステップ・積んだジョブ・セッション・横断質問・Claudeの回答待ち・実行キャンセルを1枚に集める。
    **どれも無いIssueではカードごと描かない**ので、判定は各子コンポーネントと同じ関数
    （`getWorkflowStepIndex`・`findDispatchJobForIssue`・`findCrossRepoQuestionJobForIssue`など）を使う。
    片方だけ条件が変わると空の枠が残る。
  - **対応PR・親子Issue・AI要約は既定で畳む**
    （[`issue-detail-section.tsx`](../src/components/dashboard/issue-detail-section.tsx)）。開閉は
    `usePersistedState`で`issue-detail.section.<id>`へ保存し、**Issueごとではなくセクションごとに1つ**。
    **マージ待ち（`isMergeApprovalPending`）のときだけ対応PRを`forceOpen`で開く** — 押すべきものが
    畳まれていると気付けないため。**畳んでもデータ取得は止めない**（件数と内訳を畳んだ行に出すのに要る）。
- **人が進捗を直接動かす入口は、Issue詳細の「進捗」セレクト**（#1350・#1920）。中身・並び・注記は
  [`components/dashboard/issue-progress-select.tsx`](../src/components/dashboard/issue-progress-select.tsx)
  が持ち、**PCとスマホがこれ1つを共有する**——PCはラベル・担当者と並ぶ右パネル
  （[`issue-properties-panel.tsx`](../src/components/dashboard/issue-properties-panel.tsx)。常時表示の
  パネルと狭い画面の「プロパティ」シートが同じコンポーネント）、スマホは「プロパティ」の折りたたみ
  （[`mobile/mobile-issue-properties-section.tsx`](../src/components/dashboard/mobile/mobile-issue-properties-section.tsx)）。
  **片方の画面にだけ挙動や文言を足さない**（足すと「選ぶと何が起きるのか」の答えが端末で変わる）。
  投げ先は`POST /api/issues/progress-status`。**この経路は実行を起動しない。**
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
- **左メニューに何をどの順で出すかは、ビューの一覧（`navViews`）とは別に持つ**（#1613。
  [`lib/nav-views.ts`](../src/lib/nav-views.ts)の`sidebarAttentionNavViews`・
  `sidebarQuestionNavViews`・`sidebarIssueNavViews`、
  [`lib/pull-request-views.ts`](../src/lib/pull-request-views.ts)の`sidebarPullRequestViews`）。
  `navViews`はスマホのスワイプ順と件数計算も見る配列なので、**そこから外すとURLごと消える**。
  左メニューから外した「最近追加した」「直近本番に反映した」は
  viewクエリとしては生きており、既存リンクからは今までどおり開ける。
  並びは**最上段が「人が動くまで進まないもの」**（ユーザーの確認待ち・ユーザーの作業待ち）で、
  ここに他のビューを足すと「上から順に手を動かせば盤面が進む」という読み方が崩れる。
  **この`sidebar*`はスマホのホーム画面のメニューも使う**（#1690。
  [`mobile/mobile-home-screen.tsx`](../src/components/dashboard/mobile/mobile-home-screen.tsx)）。
  以前はホームだけ`navViews`から機械的に作った9項目の平坦な一覧で、PCとどちらが正なのか
  分からない状態だった。**片方を足せば両方に出る**のが今の形で、PC専用のまま残しているのは
  「リポジトリ（全件）」「ラベル」の2節だけ（スマホではそれぞれフッターの「Issue」タブと
  一覧の絞り込みシートが担う）。左メニュー下部にあった「よく使うフィルター」（保存した検索条件を
  並べる節）は、スマホから外した後もPCで使われていなかったため#1754で画面・API・
  `QuickFilter`テーブルごと削除した。
  「本番反映待ち」は#1613でIssueの節から外していたが、#1743で戻した（PC・スマホのホーム・
  スマホのIssue一覧の3か所すべてに出る）。**足す先は`sidebarIssueNavViews`で、
  `sidebarAttentionNavViews`ではない**——本番反映待ちで止まっているのはエージェントではなく
  リリースの実行で、要対応の枠へ入れると上記の並びの読み方が崩れる。ホームでは先頭の
  「いまの状況」のカードとメニューの両方から開けるが、これは「ユーザーの確認待ち」も同じ
  （カードは件数を見るサマリ、メニューは他のビューと並ぶ入口）。
- **検索欄の絞り込みは文字列の部分一致（[`lib/search-query.ts`](../src/lib/search-query.ts)）で、
  「AIで探す」を押したときだけ意味での絞り込みへ切り替わる**（#1788）。押すと表示中の一覧から
  新しい順に最大`ISSUE_SEARCH_CANDIDATE_LIMIT`件のタイトル・ラベル（**本文は送らない**）を
  `POST /api/issues/ai-search`→[`lib/claude/issue-search.ts`](../src/lib/claude/issue-search.ts)へ渡し、
  返ってきたIssueのidの集合で絞る（`matchesSearchQuery`の`aiMatchedIds`）。`label:`等のトークンは
  自由語と別に評価しているのでAI検索中もそのまま効き、AIへ渡すのはトークンを除いた自由語だけ
  （`extractSearchTokens`）。**候補は自由語で絞る前の集合から作る**——文字列一致で0件のときに押す
  機能なので、先に部分一致を掛けると候補まで0件になる。
  **1回ごとにClaudeのプラン枠を消費するため、呼ぶのはボタンを押したときだけ**（入力のたび・
  Enterキーでは呼ばない。`hooks/use-issue-ai-search.ts`）。`CLAUDE_CODE_OAUTH_TOKEN`が未設定なら
  APIが501を返し、画面はボタンを出さなくなる。結果はURLに載せず（プラン枠を使って得たものを
  リロードや共有で勝手に再現しない）、検索語を変えると破棄して通常の検索へ戻る。
  絞り込み条件としては`IssueFilterInput.aiMatchedIds`に載せ、**一覧・左メニューの件数・ラベルの
  件数がすべて同じ`applyIssueFilters`を通る**ため数字は食い違わない（#1689・#1750と同じ理由）。
- **未着手の着手順は「次にやること」が決める**（#1853。
  [`issue-order-dialog.tsx`](../src/components/dashboard/issue-order-dialog.tsx)）。「未着手」ビューの
  一覧の上のボタンを押すと、未着手のIssueのタイトル・ラベル・起票からの経過日数・**本文の先頭
  200文字**を`POST /api/issues/order`→[`lib/claude/issue-order.ts`](../src/lib/claude/issue-order.ts)へ渡し、
  着手順の上位5件と**実施しない方がよさそうなもの**（重複・陳腐化）を理由付きで受け取る。
  枠の扱い・501の扱い・候補に無いキーを採らない方針は「AIで探す」と同じ。
  - **ビューを増やさずダイアログにする。** 左メニューへ足すと、押すまで中身が空の項目が常設され、
    「上から順に手を動かせば盤面が進む」という並びの読み方（`sidebarAttentionNavViews`）が崩れる。
    入口の位置・PC/スマホ共通という作りは手作業アシスタント（#1826）に揃える。
  - **判定の母集団はユーザーの絞り込みを通さない**（`useIssueOrderGuide`が
    `filterIssuesByView(..., "not-started")`で作る）。左メニューの「未着手」と同じ数え方にするため
    （#1750と同じ理由）で、リポジトリを1つに絞って見ていても着手順は横断で決まる。
    **一覧の行数ではなくこの件数を入口のバーに出す**（`issueOrderCount`）。
  - **結果は保存しない。** 未着手の顔ぶれが変われば順番も変わり、保存すると古い順位が正しく
    見えてしまう。閉じれば消え、必要なら「決め直す」で取り直す（DBのスキーマも増やさない）。
  - **1位は自動でサブPCへ積める**（フッターのチェック。端末ごとに`issue-order.auto-start`へ保存）。
    積む手順は「まとめて積む」（#1266）と共有し
    （[`lib/dispatch/enqueue-issue.ts`](../src/lib/dispatch/enqueue-issue.ts)）、**積めたときだけ
    `11.local`を付ける**。**`dispatch.isLoaded`が立つまで積みに行かない**（#1666・#1810。取得前の
    `hosts`は`[]`で「1台も無い」と区別が付かず、待たないと必ず失敗する）。失敗しても自動では
    繰り返さない。**自動開始が有効なときは入口のボタンの文言を「順番を決めて開始」に変える**——
    押した瞬間に実装が積まれることが、押す前に読めないといけない。
  - **見送り候補をクローズもラベル付けもしない。** 重複・陳腐化の判定はタイトルと本文の冒頭からの
    推測でしかなく外れる。挙げるところまでを機械が担い、押せるのは開くことだけにする。
- **選んだIssueをまとめて実行する入口は一覧の上のバー**（#1266・#1993。
  [`bulk-dispatch-bar.tsx`](../src/components/dashboard/bulk-dispatch-bar.tsx)）。
  手作業アシスタント・「次にやること」と同じ位置に置くのは、**スマホの一覧が`IssueList`の
  ヘッダーを出さない**（`showHeader={false}`）ためで、ヘッダーに置くとPCからしか押せない。
  出すのは積めるIssueが2件以上あるときだけ（[`lib/dispatch/bulk-dispatch.ts`](../src/lib/dispatch/bulk-dispatch.ts)）。
  - **オプションは1回だけ選び、選んだIssueすべてへ同じように付ける。** チップは「実装を開始」
    ダイアログと共有し（[`start-option-chip.tsx`](../src/components/dashboard/start-option-chip.tsx)）、
    出すのは**選んだIssueで共通して選べるもの**だけ（`commonStartImplementationOptions`）。
    既定は全部OFFで、既に付いているラベルは外さない。設計と理由は
    [multi-agent/subpc-dispatch.md](multi-agent/subpc-dispatch.md)を参照。
- **「ユーザーの確認待ち」「ユーザーの作業待ち」「質問」「ブランチ」は、ユーザーの絞り込みを
  適用しない**（#1750）。左メニューの最上段2つと質問はビューの性質として
  [`lib/nav-views.ts`](../src/lib/nav-views.ts)の`ignoresIssueFilters`に持ち、判定は
  `navViewIgnoresIssueFilters`の1か所。**画面ごとに条件を書かない**——PCとスマホで書くと
  片方だけ直され続ける。落とすのはユーザーが指定した条件（キーワード・リポジトリ・状態・
  ラベル・担当者）だけで、**ビューの定義そのもの**（`00.check-user`・質問の接頭辞・既定の状態=open）は
  従来どおり効く。解決は[`lib/issue-stats.ts`](../src/lib/issue-stats.ts)の`resolveFiltersForView`で、
  **一覧・件数の両方が必ずここを通す**（片方だけ素の`filters`を使うと、左メニューの件数と一覧の
  件数が食い違う）。そのため`computeNavCounts`（絞り込み済みの2集合を受け取る形）は成立しなくなり、
  `computeNavCountsForFilters`（絞り込み前のIssueと条件を受け取り、ビューごとに解決する）へ
  一本化した。「ユーザーの確認待ち」に並ぶマージ待ちPRも同じ理由でリポジトリ絞り込みを掛けない
  （掛けると同じ一覧の中でIssueだけ全体・PRだけ絞られた状態になる）。
  **絞り込みが効かないことは画面に出す**（`IssueList`の`filtersIgnored`＝`hasIgnoredIssueFilters`）。
  黙って無視すると、キーワードやリポジトリを選んでも件数が変わらない理由が読めない。
  「ブランチ」はビューではないので画面側で同じ扱いにし、**選択中のリポジトリは絞る代わりに
  先頭へ寄せて（`orderRepositoriesBySelection`）展開する**（`BranchFlowView`の
  `expandedRepositoryFullNames`）。**開く向きにしか働かせない**——選択が外れたときに畳むと、
  見ていたリポジトリが勝手に閉じる。理由は、このアプリが複数リポジトリを横断で見るためのもので、
  「人が動くまで進まないもの」は全体で取りこぼしが無いかを確かめる場所だから。個々のIssue一覧・
  PR一覧がリポジトリで絞られるのは従来どおり。
  **PCで左右2ペインに分かれているとき（#2157）は「展開」ではなく「右ペインに表示」になる。**
  同時に出せるのは1件なので選択の先頭を右へ出し、ヘッダーの文言も「絞り込み中の◯件を展開」から
  「絞り込み中の先頭を表示」へ変える（選んだ数と右に出ているものが食い違って見えるため）。
  **右ペインに出しているリポジトリの正はURLではなく端末の記憶**（localStorage）で、URLの`repos`は
  「選択が変わった瞬間にその先頭を右へ出す」きっかけとしてだけ効く。`repos`は複数選択の絞り込み
  条件で、右に出す1件とは粒度が違うため、同じ意味のキーをURLへもう1つ増やさない。左ペインの
  並べ替え（`orderRepositoriesBySelection`）は分割後もそのまま効く。
- **メニューの行の「数字」と「オレンジの丸」は別のものを表す**（#2070）。数字は
  **押した先の一覧に並ぶ件数**、丸は**いま人が手を動かせるものがあるという合図**。数え方は
  [`lib/issue-stats.ts`](../src/lib/issue-stats.ts)の`computeNavCountsForFilters`に集約してあり、
  左メニュー・スマホのホーム・スマホの一覧のビュー切替が同じ数字を見る。
  - 例外は**「ユーザーの作業待ち」だけ**で、数字も`actionable`（いま実行できる手作業）にする
    （#1763）。前提待ちは「まだできない」ものなので、在庫に数えると手を動かせる数が読めない。
    総数との差は一覧ヘッダーの`formatManualStepListCount`（`2件・前提待ち2件`）で読む。
  - **「質問」は#1910で数字を未確認（回答が届いていて未読）へ差し替えていたが、#2070で戻した。**
    読み終えた質問しか無いと、質問が何件も開いたままでも`0`と出て「質問は無い」と読めていた
    （質問の確認済みは作業待ちの前提待ちと違い、「読んだがまだcloseしていない」＝人が片付ける
    余地が残っているもの）。未確認は`countUnconfirmedQuestions`をシェルで別に数え、丸を点ける
    判定と吹き出し（`formatQuestionNavTitle`）にだけ渡す。**総数は`navCounts`から引き、
    画面側で数え直さない**——数え直すと同じ行の数字と吹き出しが別の数え方になる。
- **「ユーザーの確認待ち」にはIssueだけでなく、ユーザーがマージするしかないPRも出す**（#1613。
  一覧の先頭に`MergePendingPullRequests`、選ぶ対象は`pullRequestsAwaitingUserMerge`）。
  develop→mainのリリースPRは対応Issueを持たないため、これが無いとどの確認待ちにも現れない。
  逆にdevelop向けPRは判定結果を対応Issueの`00.check-user`として書く（`requiresUserMerge`）ので、
  **対応Issueが同じ一覧に並ぶPRは除いて**二重表示を避ける。左メニューの件数も同じ数を足す。
  **PRを数に足す画面と、PRを一覧に出す画面は必ずセットにする**（#1713）。スマホは件数
  （ホームの「要対応」・メニューの「ユーザーの確認待ち」）にだけ足して一覧はIssueしか出して
  おらず、「2件と出ているのに開くと何も無い」状態だった。合流はスマホでは
  `MobileIssueListScreen`の`pinned`（固定表示する枠・件数・対象ビューを1つのpropで受け取り、
  ヘッダーの「N件」・下端のビュー行・ビュー選択シートの件数へ同じ数を足す）、PCでは`IssueList`の
  `pinnedSection`と`pinnedCount`が担う。
  - **並べるのは「いま押せば入るPR」だけ**（#2081）。CI実行中（`ciState`が`pending`）と自動マージ
    可否の判定中（`isMergeJudgementPending`）は`pullRequestsAwaitingUserMerge`が外す。前者は
    GitHubがマージを弾き、後者は画面がマージボタンを無効化する（#1968）ので、並べても開いた先に
    操作が無い。リリースPRを各リポジトリへ一斉に起票した直後は、この2つで一覧が埋まっていた。
    **CI失敗・コンフリクト・CI状態不明（`unknown`）は外さない**——待っても解消せず人が動くしか
    ないもので、`unknown`を外さないのは#1433のリリースボタンと同じ倒し方（状態が取れないことを
    理由にマージの導線まで消さない）。
  - **外したぶんは`pullRequestsWaitingForMergeChecks`が返し、枠の下の1行にだけ出す。**
    件数（左メニュー・ホームの「要対応」）には足さない。完全に消すと、対応Issueを持たない
    リリースPRはどこにも現れないまま数分後に突然6件現れる。件数から外して一覧の見出しへ
    内訳を出す手作業待ち（#1763）と同じ扱い。
  - **どちらの関数も母集団は`pullRequestsRequiringUserMerge`1つ**（`requiresUserMerge`＋二重表示の
    除外）。2つの数を足したものが従来の件数と必ず一致するようにするため、判定を2か所に書かない。
- **「ユーザーの確認待ち」の件数からは、エージェントがまだ動いているIssueを外す**（#2174。
  [`lib/check-user-attention.ts`](../src/lib/check-user-attention.ts)）。`00.check-user`を付ける側は
  エージェントが止まるのを待たないため、develop向けPRを作った直後（`01.check-merge`＋CI実行中・
  自動マージ判定中）やサブPCのセッションが作業を続けている間も確認待ちとして数えられ、開いても
  押せる操作が無いのにオレンジの丸が点いていた。上のPR側（#2081）と同じ扱いをIssue側へ広げたもの。
  - **判定材料は画面が既に持っているものだけ**——対応PRの`isMergeWaitingForChecks`（#2081と同じ関数）と、
    セッションの`isSessionActivelyWorking`（一覧のバッジの回転と同じ関数。
    [`lib/workflow-badge-activity.ts`](../src/lib/workflow-badge-activity.ts)）。GitHub APIの消費は増えない。
  - **GitHub Actionsの実行そのものは見ていない。** `useIssuesWorkflowRunning`は確認待ちのIssueを
    最初からポーリング対象から外しているため、確認待ちの間はActions側の材料が無い。無人実行で
    確認待ちになる場面はPRを伴うものが大半で、そちらはPR側の材料で拾える。
  - **一覧には今までどおり並べる**（PR側と違うのはここ）。差はヘッダーの`formatCheckUserListCount`
    （`2件・実行中1件`）で説明する。集合（`selectCheckUserRunningIssueIds`）は`IssueDeckShell`が
    1回だけ作り、左メニューの件数・一覧のヘッダー・ベル・確認待ちトーストへ配る——判定を
    呼び出し側ごとに書くと「メニューからは消えているのにベルには出ている」状態になる。
- **「ユーザーの作業待ち」（`71.manual-step`）は、いま実行できる件数だけを出す**
  （#1613で橙色の強調を、#1763で件数そのものを。
  [`lib/manual-step-attention.ts`](../src/lib/manual-step-attention.ts)）。
  手作業の多くは起点の変更が本番へ出るまで実行できず、総数のままだと数週間先まで実行できない
  ものが残っている間ずっと数が減らず、「いま手を動かせば片付く数」として読めない。判定は本文の
  `## 前提条件`・`## 関連`に書かれた参照
  （[`lib/manual-step-prerequisites.ts`](../src/lib/manual-step-prerequisites.ts)）の進捗で行い、
  **状態を特定できないものは実行できる側に数える**（見落とすより強調しすぎる方へ倒す）。
  - **数え方の差し替えは`computeNavCounts`（[`lib/issue-stats.ts`](../src/lib/issue-stats.ts)）
    1か所で行う。** 左メニュー・スマホのホーム・ビュー選択シート・リポジトリ別一覧の件数は
    すべてこの関数の結果を見ており、画面ごとに足し引きすると片方だけ古くなる。
    リポジトリで絞り込んだ一覧を数えるときは、`computeNavCountsForFilters`へ**絞り込み前の
    全Issue**を渡す（手作業Issueは別リポジトリのIssueを待っていることがあり、母集団から
    外れると「状態不明＝実行できる」に倒れる）。
  - **メニューの数（実行できる件数）と一覧の行数はわざと食い違う。** その差は一覧のヘッダー
    （`formatManualStepListCount`が作る`2件・前提待ち2件`）と、各行のアイコンで説明する。
    行のアイコンは[`issue-list.tsx`](../src/components/dashboard/issue-list.tsx)の
    `ManualStepReadinessIcon`で、判定は件数と同じ`computeManualStepReadiness`から引くので
    数と印が食い違わない。**渡す判定は絞り込み前の全Issueを母集団に作る**——「ユーザーの
    作業待ち」の一覧には手作業Issueしか並ばず、そこからは参照先のIssueを1件も引けない。
  - **内訳のホバー吹き出しは付けない**（#1763で削除）。数字がそのまま実行できる件数を指すため、
    同じことを言い直すだけになる。スマホはホバーできず、内訳を読めるのはヘッダーだけ。
- **溜まった手作業は「手作業アシスタント」が1手順ずつ順番に案内する**（#1826。
  [`manual-step-guide-dialog.tsx`](../src/components/dashboard/manual-step-guide-dialog.tsx)）。
  本文はテンプレートで見出しの並びが決まっているのに、実行する人は「一覧を開く → Issueを開く →
  本文を上から読み直して、実行する場所とコマンドを自分で拾う」を件数ぶん繰り返していた。
  本文を「目的 → 手順1..n → 完了の確認」へ割り、**実行する場所（デバイス・ディレクトリ・
  ブランチ）のチップをどのステップでも同じ位置に出したまま**1手順ずつ出す。
  **デバイスは手順ごとに持てる**（#2052。手順の文頭の`（サブPC）`。無ければ`## 前提条件`の
  「実行するデバイス」が既定値で、そこに端末が複数書かれていれば既定値は決まらない）。
  - **解析は[`lib/manual-step-guide.ts`](../src/lib/manual-step-guide.ts)の純粋関数だけ**で、
    Claude APIのような推定を挟まない。実行するコマンドを推定で書き換える余地を作ると、
    手作業ではそのまま事故になる。**手順の判定は`lib/markdown-task-list.ts`の
    `TASK_LINE_PATTERN`を共有する**——別の正規表現を書くと、Issue詳細の「タスク 2 / 3 完了」と
    アシスタントの手順数が食い違う。
  - **案内するのは前提条件が満たされたものだけ**（`buildManualStepQueue`。件数・通知ベルと同じ
    `computeManualStepReadiness`）。ただし**Issue詳細から開いた1件だけは前提待ちでも外さない**——
    人が明示的に開いたものを、本文からの推定でしかない判定で締め出さない。
  - **入口は一覧の上に置き、ヘッダーには入れない**。スマホの一覧は`IssueList`のヘッダーを
    出さず（`showHeader={false}`）、画面側のヘッダーには操作を足さない決まり（#1646）のため、
    ヘッダーに置くとPCにしか出ない。Issue詳細側の入口は`ManualStepPanel`の「順番に進める」。
  - **新しい状態もAPIも持たない。** チェックの実体はIssue本文（`use-issue-task-list.ts`）、
    クローズは`ManualStepPanel`と同じ`PATCH /api/issues`。GitHubで付けても一覧で付けても
    アシスタントで付けても、書き換わるのは同じ1か所。
  - **サブPCで実行する手順は「承認して実行」で代行できる**（#1828。
    [`manual-step-run-panel.tsx`](../src/components/dashboard/manual-step-run-panel.tsx)・
    [`lib/manual-step-command.ts`](../src/lib/manual-step-command.ts)）。押すと既存の
    ジョブキューへ`MANUAL_STEP`のジョブが積まれ、サブPCのpollerが実行して終了コードと出力を
    画面へ返す（終了コード0のときだけチェックが付く）。**実行できるのは本文に書かれた
    コマンドだけで、画面から届いた文字列は照合にしか使わない**（サーバーとpollerが本文と
    独立に2回照合する）。設計は
    [docs/multi-agent/subpc-dispatch.md](multi-agent/subpc-dispatch.md#手作業アシスタントからの代行実行1828)。
  - **承認1回で最後まで流し、失敗したらClaudeが修正案を出す**（#1869。
    [`manual-step-autorun-panel.tsx`](../src/components/dashboard/manual-step-autorun-panel.tsx)・
    [`hooks/use-manual-step-autorun.ts`](../src/hooks/use-manual-step-autorun.ts)・
    [`lib/manual-step-autorun.ts`](../src/lib/manual-step-autorun.ts)・
    [`manual-step-fix-panel.tsx`](../src/components/dashboard/manual-step-fix-panel.tsx)・
    [`lib/claude/manual-step-fix.ts`](../src/lib/claude/manual-step-fix.ts)）。
    最初の画面に実行予定のコマンドを畳まずに並べ、承認すると手順1..n → `## 完了の確認方法`の
    コマンドまで1件ずつ流す。**新しい実行の口は作らず**、既存の`POST /api/dispatch`へ1件ずつ積む。
    - **自動実行の状態はDBが持ち、進めるのはサーバー**（#1882で変更。
      [`lib/manual-step-run.ts`](../src/lib/manual-step-run.ts)・`ManualStepRun`）。
      **アシスタントを閉じても・ブラウザを閉じても続く**（次の1件を積むのは代行実行の結果報告を
      受けたサーバー）。画面は状態を読んで出すだけで、**次を積まない**（両方が積むと二重に走る）。
      進み具合は「ユーザーの作業待ち」ビューの入口バッジとアシスタント本体で追う（#2073で
      実行キューの節は撤去した）。Issueはまたがない（次の手作業は承認し直す）
    - **入口バッジは押すと走っている実行を全部並べる**（#2119。
      [`manual-step-run-badge.tsx`](../src/components/dashboard/manual-step-run-badge.tsx)）。
      #1882のバッジは`.find`で先頭1件しか拾っておらず、複数走っていても2本目以降が画面のどこにも
      出ていなかった（`listManualStepRunViews`は最初から全件返している）。並びは**押す必要がある
      ものが上**（失敗 → あなたが実行 → 実行中。`sortManualStepRunsForList`）で、行を押すと
      そのIssueを先頭にしたアシスタントが開く。**一覧からは中断できない**——進み具合を見るために
      開いた小さな面に、押し間違いで実行が消える操作を並べない
    - **いつでも中断できる**（#1882）。次を積まないだけでなく走っている1件も止める——
      順番待ちは取り消し、走り出したものは`MANUAL_STEP_ABORT`のジョブでpollerが
      `systemctl --user stop`。**止められないpollerでは打ち切り（5分）まで待つことを画面に出す**
    - **失敗した手順・代行できない手順には「手元で実行する」を出す**（#1882。
      [`manual-step-where-to-run.tsx`](../src/components/dashboard/manual-step-where-to-run.tsx)）。
      接続 → 移動 → 実行の3行をまとめてコピーできる。**接続コマンドは本文の
      `## 前提条件`から拾ったものだけ**で、ホスト名から組み立てたりしない
    - **止まったら勝手に進めない**——失敗・代行できない手順・最後の確認のいずれでも止まり、
      クローズは人が押す
    - 失敗の診断は`POST /api/manual-steps/fix`。**送るのはジョブのidだけ**で、コマンドと出力は
      サーバーが読み直す。修正案の適用は必ず人が押し、押されたら**本文のコードブロックを
      差し替えてから**実行する（`replaceManualStepCommand`）。実行するのは常に本文のコマンド、
      という歯止めを崩さないため
    - **出力をClaudeへ送る同意は承認パネルのチェック1か所**（既定オン）。外すと自動では調べず、
      失敗の表示の「原因を調べる」を押したときだけ送る
  - **openな手作業の`## 完了の確認方法`は1日1回、人の操作なしに巡回する**（#2008。
    [`lib/manual-step-verification.ts`](../src/lib/manual-step-verification.ts)・
    [`lib/manual-step-verification-patrol.ts`](../src/lib/manual-step-verification-patrol.ts)・
    `ManualStepVerificationCheck`）。全部が終了コード0で終わったIssueには「完了済みの可能性」の
    印（`Issue.manualStepVerifiedAt`）が付き、一覧の行と`ManualStepPanel`に出る。
    **自動でcloseはしない**（終了コードしか見ていないため）。巡回するのは実行するデバイスの
    既定値がサブPCに決まり、**確認コマンドが読み取りだけだと読める**Issueに限る
    （`isReadOnlyVerificationCommand`）。動かす契機は`GET /api/dispatch`と結果報告の2つで、
    常駐プロセスは置かない。設計は
    [docs/multi-agent/subpc-dispatch.md](multi-agent/subpc-dispatch.md#完了の確認方法を定期巡回する2008)。
  - **本文の書式は起票時に機械検査する**（#2048。
    [`lib/manual-step-body-check.ts`](../src/lib/manual-step-body-check.ts)・
    `POST /api/manual-steps/body-check`・`reusable-issue-labels.yml`の`manual-step-body-check`）。
    タイトルが`[手作業]`で始まるIssueのopen・editedで、**画面のパーサーが読む書式から
    外れていないか**だけを見て、指摘をマーカー付きコメント1件として貼り直す。判定を
    ワークフローへ写さないのは「検査は通るが画面は読めない」食い違いを作らないため。
    **ラベルは付けず起票も止めない。** 雛形の正は
    [docs/multi-agent/manual-step-body-template.md](multi-agent/manual-step-body-template.md)で、
    `scripts/generate-prompt-templates.mjs`が起票側の3プロンプトへ差し込む
    （ずれはCIの`Prompt shared template sync check`が落とす）。設計は
    [docs/multi-agent/labels.md](multi-agent/labels.md#本文の書式は起票時に機械検査する2048)。
  - **現在地はIssueのidで持ち、並びの添字では持たない**。クローズした手作業がポーリングで
    一覧から外れると添字がずれ、次の1件を飛ばす。並び自体は開いた時点のスナップショット
    （`hooks/use-manual-step-guide.ts`）で、進めるたびに分母が減らないようにする。
  - **テンプレートに沿っていない本文（`hasTemplate: false`）を隠さない。** 手順に割れない
    だけなので、本文をそのまま1画面で出してクローズの出口だけ付ける。
  - **コマンドのコピーボタンを作らない。** 手順をMarkdownとして描けば、既存の
    `MarkdownBody`のコードブロック（#1726）がそのまま付く。
- **質問Issueの状態（回答待ち・未確認・確認済み）の判定は
  [`lib/question-attention.ts`](../src/lib/question-attention.ts)の`resolveQuestionState`だけが持つ**
  （#1796）。一覧の行のラベル（`issue-list.tsx`の`QuestionStateBadge`）・ヘッダーの内訳
  （`formatQuestionListCount`）・左メニューとスマホのホームの色（`countUnconfirmedQuestions`）が
  同じ関数を通す。**画面ごとに条件を書き足さない。**
  - **「未確認」は回答が届いていて未読のものだけで、回答待ちは含めない。** 未確認は
    *いま読める*ものを指す合図で、質問を投げた直後から点けると回答が返ってきたかどうかを
    そこから読めなくなる。未読の判定は既存の未読管理（`hasUnreadComments`＝行の青いドットと
    同じ。開いた時点で既読）に乗せる——質問だけ別の基準を作ると、同じ行の中でドットとラベルが
    食い違う。
  - **左メニューの丸は、確認待ち・作業待ちと同じ塗りつぶしのオレンジ
    （`NavCount`の`emphasis="attention"`）で、未確認が1件でもあれば点ける**（#1910）。数字の
    文字色だけを変える弱い強調（旧`emphasis="unread"`）は#1796の判断だったが、色だけでは未確認の
    回答に気づけず見落としていたため廃止した。**丸が点いている行は、上から順に手を動かせば
    消える**という読み方に揃える。
  - **ただし行に出す数字は未確認の件数ではなく、一覧に並ぶ件数（開いている質問の総数）**
    （#2070）。#1910では数字も未確認にしていたが、読み終えた質問しか無いと`0`と出て
    「質問は無い」と読めていた。内訳は行の吹き出し（`formatQuestionNavTitle`）と一覧ヘッダー
    （`formatQuestionListCount`）で読む。
    件数の見た目はPC（`sidebar-nav.tsx`）とスマホ（`mobile-home-screen.tsx`）で共通の
    [`nav-count.tsx`](../src/components/dashboard/nav-count.tsx)に置く。
  - **件数は「いま読める数」で、確認済みを含む総数ではない**（手作業の`actionable`（#1763）と
    同じ考え方。未確認が無ければ`0`になる）。総数との差は一覧のヘッダー（`3件・未確認1件`）で説明する。
  - **数え方の差し替えは`issue-stats.ts`の`computeNavCountsForFilters`で行い、画面側では行わない**
    （#1910）。`navCounts["question"]`はスマホの一覧のビュー切替（`mobile-issue-list-screen.tsx`）と
    ビュー選択シート（`mobile-issue-view-sheet.tsx`）にも出るため、画面ごとに数字を差し替えると
    左メニューの`1`と一覧の`3`が食い違う。手作業（#1763）と同じ置き場。
- **左メニュー・スマホのホームの「ブランチ」行には、リリース・デプロイが片付いていない
  プロジェクト（リポジトリ）の数を出す**（#2167。
  [`lib/release-activity.ts`](../src/lib/release-activity.ts)）。数えるのは**リポジトリ数**で、
  スマホのフッターの「ブランチ」タブのバッジ（マージ待ちPRの**本数**。#2055）とは単位が違う。
  材料は同じ`/api/repositories/release-pending-merges`で、**`status`が`idle`のリポジトリを
  APIが返さない**ため、返ってきた件数がそのまま「片付いていない数」になる。
  - **オレンジの丸（`NavCount`の`emphasis="attention"`）を点けるのは、人が操作するまで進まない
    ものがあるとき**——バージョンバンプPR・リリースPRのマージ待ち（`action_required`）と、
    リリース・本番デプロイの失敗（`error`）。実行中（`progressing`）だけなら点けない。
    **数字（片付いていない数）と丸（操作待ち）で意味が違う**ので、内訳は行の吹き出し
    （`describeReleaseActivity`）で読む——「質問」の行（#2070）と同じ形。
  - **吹き出しでは「実行中」と「失敗」を必ず書き分ける。** `error`の判定
    （`release-button-status.ts`の`hasFailed`）は`cancelled`・`skipped`も失敗として扱い、
    しかも次に成功する実行が現れるまで消えない。まとめて「実行中」と書くと、動いていない
    ものを動いていると言い続けることになる。**それでも`total`からは外さない**——丸の中に
    出るのが数字そのものなので、丸を点けたまま`0`にはできない。
  - **手作業（`71.manual-step`）は数えない。** 上の「ユーザーの作業待ち」が持つ別の項目で、
    両方の行に同じものが出ると、どちらを押せば片付くのか分からなくなる。
  - **左メニューで非表示にしたリポジトリは数えない。** APIの母集団は`archived: false`だけで
    絞っており非表示のものも返すが、この行を押して開くブランチ画面は`visibleRepositories`
    （`hidden`を除く）で組み立てられる。揃えないと「1件と出ているのに開いた先に無い」が起こる。
    通知ベル・フッターのバッジは従来どおり非表示も含めて出す（あちらは取りこぼしを防ぐ場所）。
  - **材料は`NotificationProvider`から`SidebarNav`・`MobileHomeScreen`が自分で読む**——
    これらを描く`issue-deck-shell.tsx`はProviderの親でフックを呼べず、propで配れない。
    新しく`useRepositoryReleaseStatuses`を呼ぶとポーリングが2本走る（フッターと同じ事情。
    #1772）。描画だけの`SidebarNavView`・`MobileHomeScreenView`を別に出してあるのは、
    Providerを立てずに件数を渡して試験するため。
  - **未取得（`null`）と0件は区別する。** 未取得のうちは数字を出さない。
  - **スマホでは「ブランチ」の数字が2か所に出る**（ホームの行＝リポジトリ数、フッターのタブ＝
    マージ待ちPRの本数）。`title`はタップ端末で読めないため、**この2つの違いはスマホの画面上
    だけでは説明できない。** それでもホームの行に出しているのは、ホームのメニューが
    「PCの左メニューと同じ配列・同じ並び」であることを前提に作られているため（#1690）。
    多くの状態では片方しか出ない（フッターのバッジは0件で消える）ので、食い違うのは
    「マージ待ち以外の理由で動いているリポジトリがある」ときだけ。
- **Issue間の実施順序は本文の`## 前提条件`に書き、待つ側と待たれる側の両方へ出す**（#2003。
  [`lib/manual-step-prerequisites.ts`](../src/lib/manual-step-prerequisites.ts)・
  [`lib/issue-dependents.ts`](../src/lib/issue-dependents.ts)）。順序を表せるのは手作業Issueが
  待っている相手だけで、しかも向きが一方向しか無かった（`guchi-apps/subpc`の#38/#39/#40のように
  **対応Issueとそのマージのほうが手作業を待つ**組み合わせでは、順序がPR本文の散文にしか残らない）。
  - **書く場所は`## 前提条件`の1か所。** 手作業Issueのテンプレートにすでにある見出しをどのIssueでも
    読むことにして、新しいラベルもスキーマ変更（`sub_issues`のWebhook購読）も足していない。
  - **`## 関連`の「起点」を前提として補うのは手作業Issueだけ**、かつ**相手が明示的に自分を前提として
    挙げていれば取り消す**（`collectPrerequisiteReferences`）。手作業Issueは起点へ紐付けて起票する
    決まりのため、順序が逆の組み合わせでは放っておくと互いを待ち、逆向きの待ちだけが画面に出る。
  - **逆向き（自分を待っている相手）は`## 前提条件`に書かれたものだけを辿る**
    （`computeIssueDependents`）。起点まで辿ると、実際には待っていない親Issueが並ぶ。
  - **一覧の行アイコンは前提を書いたIssueすべてに出すが、左メニュー「ユーザーの作業待ち」の件数と
    手作業の通知は手作業Issueのままにする**（`computeIssuePrerequisiteReadiness`と
    `computeManualStepReadiness`の使い分け）。あの数は「いま手を動かせば盤面が進む手作業が何件あるか」
    を答えるもので、一般のIssueを混ぜると別の数になる。
  - **手作業Issueは実装→develop→mainの3段階に載せない。** developもmainも通らず、進捗Statusは
    `Ready`のまま実行者がcloseするため、載せると通っていない道を通ったように見える。
- **手作業Issueが待っている相手の状況は、Issue詳細の手作業パネルの中に出す**（#1705。
  [`manual-step-prerequisites.tsx`](../src/components/dashboard/manual-step-prerequisites.tsx)）。
  手作業Issue以外では独立したセクション「実施順序」として出す（#2003。
  [`issue-order-section.tsx`](../src/components/dashboard/issue-order-section.tsx)。
  前提が残っている間は畳めなくする——畳まれていると、書いた側は出したつもりでも読む側が開くまで
  気付かない）。
  参照先のIssueは画面がすでに持っているキャッシュ（進捗）から引くので**GitHub APIを消費せず**、
  Issueとして見つからなかった番号だけ`/api/issues/pull-requests`でPRとして1回引く
  （[`hooks/use-manual-step-prerequisites.ts`](../src/hooks/use-manual-step-prerequisites.ts)。
  同じ番号空間にIssueとPRが同居するため番号だけでは区別できない）。**PRは実装→develop→mainの
  3段階に載せない**——`IssuePullRequest`はbaseブランチを持たず、マージ済みPRがdevelopまでなのか
  mainへ届いたのかを言えないため。左メニューの件数と同じ判定を通すので、**数と詳細が食い違わない**。
- **PR一覧（`/api/pull-requests`）はキャッシュせず都度GitHub APIから取得する。**
  Issueと違い`PullRequest`テーブルもWebhook購読（`pull_request`イベント）も持たない。
  無人実行はPR作成から自動マージまでが短く、openなPRは常時0〜数件しか存在しないため
  （#1058の調査時点で全連携リポジトリ合計0件）、DBキャッシュを持つ効果より
  スキーマ・Webhook設定を増やさない方が勝つと判断した。
  取得コストは「対象リポジトリ数（REST）＋ installationごとに数回（GraphQL。CI状態と
  コンフリクトをPRごとではなくエイリアスでまとめて引く。#1962）」で、母集団が広いぶん
  1回が重い。そのため**自動更新はPR画面（PCのPRペイン・スマホのPR画面）を開いている間だけ**に
  している（ビューによらず10秒間隔。ペイン・画面の外では画面を開いたときと手動更新のみ。
  `hooks/use-pull-requests.ts`。#1531・#1947）。**ブランチ画面で自動更新を有効にしている間は、
  そちらの間隔でもこの取得が回る**（#1767。両方の要求が重なったときは短い方。
  [`lib/auto-refresh.ts`](../src/lib/auto-refresh.ts)の`shorterAutoRefreshInterval`）。
- **10秒間隔で回せるのは、GitHubへの取得がETagの条件付きGETを通っているから**（#1531。
  [`lib/github/conditional-request.ts`](../src/lib/github/conditional-request.ts)）。
  GitHubのREST APIは`If-None-Match`付きのリクエストが`304 Not Modified`を返したとき、
  **その分をレート制限に計上しない**。素で10秒ポーリングすると26リポジトリ×360回/時で
  インストール当たりの上限（5,000回/時）を約2倍超過し、PR一覧だけでなくIssue同期・CI状態・
  マージまで巻き添えで失敗する。通しているのはPR一覧（`fetchOpenPullRequests` /
  `fetchClosedPullRequests`）で、変化が無い間の消費は実質ゼロになる。キャッシュはプロセス内
  メモリのLRU（上限500件）で、`api-usage`と同じく単一プロセス前提。
  **CI状態（`fetchRefCiState`）は#1578でGraphQLへ移したのでこの経路を通らない。**
  条件付きGETが使えなくなるが、消費先がRESTと別枠の5,000ポイント/時になり、PR1件あたりの
  問い合わせも最大3回（check-runsのページング）から1回に減るため、RESTの枠はむしろ空く。
  **キャッシュの古さが表示に出ることはない**——毎回GitHubへ問い合わせており、本文をキャッシュから
  返すのはGitHub自身が「変わっていない」と答えたときだけ。キーはURLのみでトークンを含めないが、
  権限の無いリポジトリには304ではなく404が返るため、別インストールの内容は漏れない。
  **304は使用量（`api-usage`）にも計上しない**ので、設定画面の「GitHub API使用量」の
  `pull_request_list`は実際に消費した回数を表す。
- **CI状態は「GitHubがそのコミットのChecksとして数えるもの」だけを見る**（#1578。
  [`lib/github/check-rollup.ts`](../src/lib/github/check-rollup.ts) → `fetchRefCiState`）。
  **RESTの`/commits/{sha}/check-runs`を使ってはいけない。** あれはSHAに紐づくジョブを分け隔てなく
  返すため、`issues`・`issue_comment`・`workflow_dispatch`・`workflow_run`・`schedule`で起動した
  無人実行のワークフローまで混ざる。issue-deckの`develop`は無人実行が常時走っており、リリースPR
  （headが`develop`そのもの）のheadコミットには**58件のワークフロー実行・218件のcheck-run**が
  ぶら下がっていて、GitHubがChecksとして数えるのは`pull_request`・`push`起動の**5件・27件**
  だけだった（v3.22.0のリリースPR #1573で実測）。残りまで集約していたため、無関係な自動化の
  キャンセル1件で「CI失敗」・実行中1件で「CI実行中」になり、GitHubの画面では成功・マージ可能なのに
  issue-deckだけが失敗を出していた。GraphQLの`Commit.statusCheckRollup`はGitHubの画面が出している
  ものそのもので、この選別を自前で再現しなくてよい（起動イベントで絞る自作フィルタは、GitHub Actions
  以外のチェック——外部CIのcommit status——を落とす）。集約の規則（未完了が1つでもあれば失敗より
  優先して`pending`）は`resolveCiStateFromCheckRuns`のまま変えていない。
- **そのうえで、issue-deckが配る運用自動化のcheck-runは集約に数えない**（#1799。
  `check-rollup.ts`の`NON_CI_WORKFLOW_FILES`）。`pull_request`・`push`起動に絞っても、残るのは
  CIだけではない——ラベル付け（`issue-labels.yml`）・自動レビューと自動マージ
  （`claude-review-develop.yml`）・コンフリクト自動解消・共有知識の提案なども同じheadコミットに
  check-runを付ける。とくに`claude-review-develop.yml`は**レビューして通ったらマージする**
  ワークフローなので、`wait-for-ci`・`risk-check` → `claude-review` → `auto-merge`のいずれかが
  PRの開いている間ずっと実行中で、**自動マージされるPRは一度も「CI通過」を表示できなかった**
  （当時はCIの完了を待ってからレビューする直列構成だった。#2066でレビューはCIと並行になったが、
  `auto-merge`が終わるまでcheck-runが残る点は変わらない）。CIが終わってから詳細画面の更新ボタンを押しても「CI実行中」の
  ままで、ボタンが効いていないように見えていた（#1799。PR #1798の実測では`lint-and-build`の
  完了が13:53:49・`ci.yml`のジョブが出揃ったのが13:53:55なのに対し、`review / auto-merge`の
  完了はマージ後の13:54:27）。同じ詰まりでマージボタンが押せなかった事例は
  [multi-agent/labels.md](multi-agent/labels.md)の「`00.check-user`はレビュー完了後に付ける」にもある。
  外すのはファイル名で分かる運用自動化だけで、`ci.yml`・`deploy.yml`・`version-tag-check.yml`
  などの検査系、リポジトリ固有のワークフロー、外部CIのcommit statusはそのまま数える
  （**知らないものは数える**側へ倒し、CIを見落とさないようにする）。除いた結果が空になる場合は
  除く前をそのまま使う——CIを持たないリポジトリでCI状態が一律「不明」になり、PRが
  「実行中」ビューから出られなくなるのを避けるため。
- **コンフリクト有無（`mergeable`）は、そのCI状態と同じ1回のGraphQLで取る**（#1742。
  `fetchPullRequestRollup` → `fetchPullRequestCiState`）。`mergeable`はRESTだとPRの単体取得でしか
  返らないため、PR一覧に出すとPR1件につき1回APIが増える——これが理由でPR一覧は長らく
  「CI通過」だけを出しており、**コンフリクトで実際には入らないPRが「入れられる」ように見えていた**。
  GraphQLの`PullRequest`は`mergeable`とheadコミットの`statusCheckRollup`を同じクエリで返すので、
  すでに消費しているCI状態の1回に相乗りさせれば消費は増えない。**PR番号を持つ経路
  （PR一覧・PR詳細・リリース進捗）はこちらを使い、番号を持たない経路（developブランチそのものの
  CI状態など）だけ`fetchRefCiState`を使う。**
  `mergeable`はGitHub側が非同期に計算するため判定中は`null`で、**`null`を「コンフリクトなし」と
  扱わない**（`ConflictBadge`も`repairKindsFor`も`false`のときだけ動く）。draftとclosedなPRでは
  そもそも取得しない（CI状態と同じ方針）。
  表示と操作は一覧・詳細・確認待ち一覧・リリース進捗・ブランチ画面で揃え、コンフリクト中は
  **「マージする」を出さずに「コンフリクトを自動解消」を出す**（`canMergeFromDeck`。押しても
  GitHubが受け付けないため）。自動解消の起動先は[multi-agent/auto-repair.md](multi-agent/auto-repair.md)。
- **Issue画面の「対応PR」も、PR画面と同じ状態を出す**（#2145）。同じPRなのに取得口が2つに
  分かれており（PR画面は`/api/pull-requests`＋`PullRequestSummary`、Issue画面は
  `/api/issues/pull-requests`＋`IssuePullRequest`）、**PR側へ状態を足してもIssue側は
  置いていかれる**。実際、PR画面が「コンフリクトあり」「コンフリクトを自動解消中」を出している
  PRで、Issue画面には「CI通過」しか出ず、押しても入らないマージボタンが並んでいた。
  Issue側もコンフリクト有無（`mergeable`）と修復状況（`repairRun`）を返し、バッジは
  `pull-request-badges.tsx`の同じコンポーネント（`ConflictBadge`・`RepairRunBadge`）を使う。
  **文言も揃える**——CI状態の言い回しがIssue側だけ「CI成功」だった。
  マージボタンの出し分けも`canMergeIssuePullRequest`を`canMergeFromDeck`と同じ判定にする。
  消費は増えない: `mergeable`は上のとおりCI状態と同じGraphQLに相乗りし（1件ずつの
  `fetchRefCheckState`をやめ、`fetchPullRequestCiStates`のまとめ取りにしたので**むしろ減る**）、
  `repairRun`はGitHubではなくDBを1回引くだけ。
- **CI状態の呼び名と見た目を持つのは`CiStateBadge`の1か所だけ**（#2150。
  [`components/dashboard/pull-request-badges.tsx`](../src/components/dashboard/pull-request-badges.tsx)）。
  以前は同じラベル表と同じピルがPR画面・Issue画面（`pull-request-ci-status.tsx`）・リリース進捗
  （`release-progress.tsx`）の3ファイルに複製されており、#2145で文言を「CI通過」へ揃えた後も
  複製そのものは残っていた（揃える前はIssue画面だけ「CI成功」だった）。Issue画面が持つ型は
  `PullRequestCiStatus`でPR画面の`CiState`と違うため、`PullRequestCiStatusBadge`は
  **型を戻して`CiStateBadge`へ渡すだけの薄い層**にしてある。状態や文言を足すときはここだけを触る。
- **「Claudeがレビューし終えたか」はCI状態とも判定全体とも別の軸として持つ**（#2150。
  `check-rollup.ts`の`toAiReview`→ `MergeJudgement.aiReview`、画面は
  `pull-request-badges.tsx`の`AiReviewBadge`）。判定ワークフローのcheck-runはCI状態の集約から
  外してあり（#1799）、判定全体（`mergeJudgement.state`）が`settled`になるのは`auto-merge`まで
  終わってから。そのため**CIが通った後にレビューだけが動いている窓**と、**差分が小さくて
  レビューが走らなかったPR**が、どちらも画面では「何も出ていない」になっていた。
  `claude-review`ジョブのcheck-runだけを見て、完了（`success`）・省略（`skipped`。
  `risk-check`の`needs-review`が偽）・失敗の3つに分けて出す。**実行中は出さない**——その
  言い回しは`MergeJudgementBadge`の「Claudeがレビュー中」が持っており、両方出すと同じことを
  2回言うことになる。**肩代わりジョブ（`claude-review-fallback`）は数えない**（`00.check-user`を
  付けるだけでレビューをやり直さないため）。取得は既存のGraphQLの応答から読むだけで、
  **GitHub APIの消費は増えない**。
- **対応PRのポーリングを止める条件は「CI実行中か」だけにしない**（#2145。
  [`hooks/use-issue-pull-requests.ts`](../src/hooks/use-issue-pull-requests.ts)の
  `isIssuePullRequestSettling`）。コンフリクトの自動解消と自動マージ可否の判定は**CIが通過した
  まま**動くため、CI実行中だけを見て止めると、解消が終わってもバッジが「自動解消中」で固まり、
  マージボタンも出てこない（Issueを開き直すまで気付けない）。**CIが確定した後にまだ動くものが
  あるか**で判断する。
- **左メニューにPRの件数を出すため、PRペインを開いていなくてもダッシュボードのマウント時に
  1回だけ取得する**（#1389）。件数は
  [`lib/pull-request-list.ts`](../src/lib/pull-request-list.ts)の`computePullRequestNavCounts`が
  数え、渡すのは一覧と同じ母集団（マージ済みとして先に反映したPRとリポジトリ絞り込みを適用し、
  状態別ビューは適用する前）にする。取得前は0ではなく件数そのものを出さない。
  **どのビューもopenなPRしか出さなくなったため（#1613）、PR一覧の`scope`は`open`に固定**で、
  `all`を要求するのは「ブランチとPRの流れ」を開いている間だけ（マージ済みPRとブランチの
  突き合わせに要る）。**一度`all`まで広げた母集団はペインを離れても狭めない**（`open`は`all`の
  部分集合なので、狭める向きで取り直すのは消費にしかならない）。
- **画面からマージしたPRは、取得を待たず「マージ済み」として反映する。伏せない**（#1756。
  [`lib/pull-request-list.ts`](../src/lib/pull-request-list.ts)の`applyOptimisticMerges`）。
  マージの成否は押した時点で確定しているのに、それが画面へ届くのは次のPR取得が返ってからで、
  そのあいだ「マージ待ち」のまま残る。**この数秒がもう一度押せると2回目のマージ要求が飛ぶ**
  （GitHubは405で弾き、画面にはエラーだけが残る）。以前は一覧から伏せていたが、伏せるのは
  PR一覧にとってしか正しくない——`IssueDeckShell`の同じ取得結果（`visiblePullRequests`と
  `crossRepositoryPullRequests`）をブランチ画面がレーンの組み立てに使っているため、
  PRが消えるとレーンが「PR未作成」に化けていた。
  マージ済みへ差し替えれば、PR一覧・件数からは今までどおり消え（openだけを通すため）、
  ブランチ画面のレーンは次のリリースの束へ移り、`canMergeFromDeck`がfalseになってボタンも消える。
  **寿命は「次の取得が返るまで」**で、マージできていなければ取得結果にopenのまま現れて元に戻る。
- **ブランチ画面のマージボタンは「ユーザーがマージするしかないPR」にだけ出す**（#1548・#1756。
  `branch-flow-view.tsx`）。判定はPR一覧と同じ`requiresUserMerge`＋`canMergeFromDeck`で、
  待てば自動で入るPR（Auto-merge有効・自動マージ対象）には出さない——押す必要が無いものまで
  押させることになるため。**リリースの束の見出しはPRの行とは別にボタンを持つ**ので、
  その下のPR行には`onMerged`を渡さない（渡すと同じPRのボタンが2つ出る）。
- **スマホのIssue一覧で絞り込みを操作する行は、画面の上ではなく下端（フッタータブのすぐ上）に
  置く**（#1645。[`mobile/mobile-issue-list-screen.tsx`](../src/components/dashboard/mobile/mobile-issue-list-screen.tsx)）。
  元は上部の横スクロールタブだったが、片手で持つと親指が届かず、押して開くシートは下から出るため
  視線と指が上下に往復していた。**現在のビューはボタン1つに畳み**、押すと
  [`mobile-issue-view-sheet.tsx`](../src/components/dashboard/mobile/mobile-issue-view-sheet.tsx)が
  全ビューを縦に並べる（横スクロールでは画面に2つ強しか映らなかった）。表示中のビュー名は
  ヘッダーの件数行にも出し、スクロール中でも何を見ているか確かめられるようにする。
  **ただしIssue以外も並ぶビューでは、見出し（1行目）そのものをビュー名にする**（#2081。判定は
  [`lib/nav-views.ts`](../src/lib/nav-views.ts)の`navViewIsUserActionList`＝「ユーザーの確認待ち」・
  「ユーザーの作業待ち」）。確認待ちにはユーザーのマージを待つPull Requestが混ざり、作業待ちに
  並ぶのは開発のIssueではなく人が実行する手順なので、見出しが「Issue」だと並んでいるものと
  食い違う。**判定はビューの性質としてここに持つ**——画面側で書くと片方だけ直され続ける
  （`ignoresIssueFilters`と同じ理由）。見出しをビュー名にしたぶん件数行からはビュー名が落ちる
  （`MobileIssueListScreen`が見出しと同じ言葉を重ねない）。リポジトリ別一覧は見出しが
  リポジトリ名のままなので、件数行のビュー名も今までどおり出る。
  一覧に出すビューはPCの左メニュー（`sidebarIssueNavViews`）と揃える。外しているのは
  「直近本番に反映した」だけで（「本番反映待ち」は左メニューへ戻した#1743にあわせてこちらにも出す）、
  **既存のURLからはそのビューでも開かれうる**ため、現在のビューが一覧に無いときだけ末尾へ足す
  （足さないと選択中の表示もスワイプ移動先も失われる）。絞り込みが効いているかは色と件数バッジで示し、数えるのは件数を減らす条件だけ
  （[`lib/issue-filter-summary.ts`](../src/lib/issue-filter-summary.ts)）。並び順・グルーピングは
  同じシートにあっても数えない。
- **スマホのPR一覧のビュー切り替えも、Issue一覧と同じ「下端の行＋左右スワイプ」にそろえる**
  （#1691。[`mobile/mobile-pull-requests-screen.tsx`](../src/components/dashboard/mobile/mobile-pull-requests-screen.tsx)）。
  元はヘッダー下の横スクロールタブで、同じ操作なのに画面ごとに置き場所が違っていた。
  ビュー選択のボトムシートはIssueと共通の
  [`mobile/mobile-view-sheet.tsx`](../src/components/dashboard/mobile/mobile-view-sheet.tsx)で、
  Issue側（`mobile-issue-view-sheet.tsx`）はアイコン・件数・強調するビューを渡すだけの包み。
  スワイプは`use-swipe-filter-view`をIssue一覧と同じ形で使い、隣のビューは
  [`lib/pull-request-views.ts`](../src/lib/pull-request-views.ts)の`getAdjacentPullRequestViewId`が決める。
  **一覧本体だけをスワイプに追従させる**ため、`PullRequestList`はスクロール領域だけに掛かる
  `listStyle`と下端に固定する`footer`を受け取る（ヘッダーごと動かすと、ヘッダーを持たないIssue一覧と
  見え方がずれる）。**縦の引っ張りは`listStyle`と別の要素へ掛ける**（#1947）——同じ要素へ両方の
  transformを書くと、ビュー切り替えの追従と引っ張りの追従が互いを打ち消す。
  **ヘッダーに「更新」ボタンは置かない**（#1947。PC・スマホとも）——スマホは下へ引っ張って更新でき、
  PR画面を開いている間はどのビューでも10秒間隔で自動更新するため、Issue一覧のヘッダーと同じ形に
  そろえた。**唯一の例外が「ユーザーの確認待ち」の先頭に固定したPRの節**（`MergePendingPullRequests`。
  #2175）で、そこには「更新」を置く——この決定の前提だった「PR画面を開いている間は10秒間隔で
  自動更新」が確認待ちでは成り立たず（`usePullRequests`へ間隔を渡すのはPR画面とブランチ画面だけ）、
  指で引けないPCには更新の手段が1つも無かったため。**PR画面のヘッダーへ広げないこと**——
  そちらは自動更新も引っ張りも効いており、外した理由がそのまま残っている。**引っ張って更新が呼ぶのは`usePullRequests`の`refreshFromPull`**——`refresh`は取得
  effectを張り直すため引っ張った直後に一覧が「読み込み中...」へ戻り、`refreshInBackground`は
  自動更新と重なると何もせず返る（空振り）うえ失敗も画面に出ない。更新ボタンを外した以上、
  引っ張った結果が嘘にならないよう、**飛んでいる取得があればその完了を待ち、失敗は`error`に
  出す**口を別に用意している。
  **ヘッダーの見出しはビュー名のまま**（「実行中のプルリクエスト」）で下端の行と重なるが、これは
  Issue一覧が見出しの行にもビュー名を出しているのと同じ意図——上は「いま何を見ているか」を
  スクロール中に見上げて確かめるためのもので、下は操作。**件数は`number | null`で、`null`は
  未取得を意味する**ので、行・ドット・シートのいずれでも`null`のときは数を出さない
  （0を出すと「PRが無い」と読めてしまう。`lib/pull-request-list.ts`）。
  **戻るスワイプは`origin === "home"`のときだけ**有効にする——PR一覧は経路によらず`onBack`が
  渡ってくるので、Issue一覧のように`onBack`の有無で分けるとタブから開いたときもホームへ抜ける。
- **スマホのフッターは「ホーム／Issue／PR／ブランチ」で、タブのidは`mscreen`の値そのもの**
  （#1436・#1638）。「Issue」タブのidが`repos`なのはそのためで、開くのはリポジトリ一覧
  （→リポジトリ別Issue一覧）。
  全リポジトリ横断のIssue一覧（`mscreen=issues`）はフッターから外し、ホームの「いまの状況」の
  カードとメニューからのドリルダウンだけにした（#1690。点灯するタブはホーム。判定は
  [`lib/mobile-nav-tab.ts`](../src/lib/mobile-nav-tab.ts)）。
  **#1951で入口をもう1つ足し、「Issue」タブのリポジトリ一覧（検索窓の直下）からも開ける。**
  どちらから来たかは`mfrom`＝`MobileIssuesOrigin`（`tab` / `home` / `repos`）が持ち、
  **戻り先（`goBack`のフォールバック）・戻る導線の有無・点灯するタブの3つがこの1つの値で決まる**
  （`repos`から来たときだけ「Issue」タブが点いたままリポジトリ一覧へ戻る）。
  **`home`と`repos`をまとめない**——まとめると、リポジトリ一覧から開いたのにホームへ戻る。
  行に出す件数は`navCounts.all`をそのまま渡す（左メニュー・ホームと同じ数え方。
  #367以来の挙動で**非表示リポジトリのIssueも含む**）。
  **4枠目は#1638で「設定」から「ブランチ」へ入れ替えた。** ブランチは日常的に開くのにホームから
  1段掘る必要があり（#1455）、設定は毎日押すものではない。**5つに増やさない**のは1タブあたりが
  98px→78pxまで詰まるためで、設定はホームのヘッダー右上（`mobile-home-screen.tsx`の歯車→
  `selectSettings`）へ移した。`mscreen=settings`のURLはそのまま生きており、その画面では
  `resolveBottomNavTab`が`null`を返して**どのタブも点灯させない**。
- **「ブランチ」タブのアイコンには反映待ちの件数を重ねる**（#2055。
  [`lib/release-merge-pending.ts`](../src/lib/release-merge-pending.ts)）。
  数えるのは**PRの本数**で、developへ（バージョンバンプPR `release/v…`）と
  mainへ（リリースPR `develop`）のマージ待ちの合計。**Issueの件数ではない**——進捗Statusの
  `Develop`・`Release`を数える「本番反映待ち」（左メニュー・ホームのカード）とは母集団が違う。
  **出すのは合計だけで、内訳は`title`・`aria-label`に入れる。** 1タブ98pxに内訳2つを並べると
  フッターを56px→68pxへ伸ばすことになり、5枠に増やせないのと同じ制約に当たる。
  材料は`NotificationProvider`が持つ`releaseStatuses`（`releaseMergePending`として配る）で、
  **新しく`useRepositoryReleaseStatuses`を呼ばない**——呼ぶと
  `/api/repositories/release-pending-merges`のポーリングが2本走る（#1772）。
  したがって**CI実行中のPRは数えない**（`pendingMerge`がCIの確定後にしか埋まらないため。
  #1433）。通知ベル・リポジトリ一覧のバッジと同じ判定で、ここだけ基準を変えると同じ状態が
  場所によって別の数になる。**未取得（`null`）と0件は区別する**——未取得のうちは何も出さない
  （0を出すと「待っているものが無い」と読めてしまう）。バッジの見た目は
  ベルと同じ`NotificationBadge`を使い回す。
  フッターは`NotificationProvider`の内側にあり、Providerを描く`issue-deck-shell.tsx`は
  その親でフックを呼べないため、**件数はpropで配らず`MobileBottomNav`が自分で読む**。
  描画だけの`MobileBottomNavView`を別に出してあるのは、Providerを立てずに件数を渡して
  試験するため。
- **PRタブから開くときの
  ビューは`in-progress`で、`DEFAULT_PULL_REQUEST_VIEW`（`all`）は変えていない。** 既定を`all`に
  しているのは画面内リンクからマージ済みPRを直接開く経路（#1260）のためで、そこを`in-progress`に
  すると開いたPRが一覧の母集団から外れる。画面内のタブでのビュー切り替えはIssue一覧のタブと
  同じく履歴を積まない（`selectPullRequestView`）。
- **PRの状態別ビューは3つで、左メニューにも3つとも出す**（#1312・#1613・#2120）。ビュー定義は[`lib/pull-request-views.ts`](../src/lib/pull-request-views.ts)、判定は
  [`lib/pull-request-list.ts`](../src/lib/pull-request-list.ts)の`filterPullRequestsByView`。
  **どのビューもopenなPRだけを出す。**「実行中」（CI待ち・ドラフト・CI状態不明）と「マージ待ち」
  （CIがsuccess/failure）は**同じopen取得の結果をクライアント側で絞るだけ**なので、切り替えても
  GitHub APIを叩き直さない。この2つでopenなPRを二分するため、件数の和は「すべてのPR」に一致する。
  **「マージ待ち」は#1613で左メニューから外し、#2120で戻した**（当時の表示名は「完了したPR」。
  ビューidは`completed`のままなので`prview=completed`のURLは一貫して生きている）。
  **10秒ごとの自動更新（`PULL_REQUEST_POLL_INTERVAL_MS`）は、元は「マージ待ち」
  ビューだけだったが、PR画面を開いている間はどのビューでも回すようにした**（#1531・#1947）。
  歯止めは「画面を開いている間だけ」「裏に回ったタブでは取りに行かない」の2つで、Issue一覧の
  ポーリングと同じ間隔・同じ止め方にそろえてある。**ただし1巡のコストは「消費0」ではない。**
  「リポジトリ数のREST（ETagの条件付きGETを通すので変化が無い間は304＝消費0）＋ draft以外の
  open PR数のGraphQL（`fetchPullRequestCiState`。条件付きGETが効かず毎回消費する）」で、
  10秒間隔なら毎時「360 × draft以外のopen PR数」ポイント（上限5,000ポイント/時）。共有
  ワークフローのタグ配布のようにPRが10件を超えて並ぶ局面で画面を開き続けると上限に触れうるので、
  **PR1件ごとのGraphQLを1回へまとめる改善を#1962として分けてある。**
  **値が同じでもIssue一覧のポーリング（`lib/auto-refresh.ts`の`ISSUE_POLL_INTERVAL_MS`）とは定数を
  分ける**——あちらは`GET /api/issues`（DBの読み取りだけ）で、`lib/auto-refresh.ts`冒頭の
  「1回の取得コストが重い画面ほど間隔を長くする」に従って片方だけ見直せるようにしておく。
  並び順は「すべてのPR」だけ更新が新しい順で、
  他は作成が古い順＝滞留が長い順。
  マージ済みPRを一覧で振り返りたくなった時点で、キャッシュ層の追加とあわせて再検討する
  （いまはIssue・ブランチ画面のリンクから個別に開く。#1260）。
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
  **「実行中」「マージ待ち」ビューの一覧はopenのPRしか持たないのに、画面内のリンクからはマージ済み・
  クローズ済みのPRも開けるため**（#1260）、一覧の項目が無い経路でもヘッダーを描けるようにしている。
  一覧・詳細の両方が[`lib/github/pull-request-summary.ts`](../src/lib/github/pull-request-summary.ts)
  の`toPullRequestSummary`で同じ形に揃える。
  **両方あるときは`fetchedAt`が新しい方を使う**（#1578。`issue-deck-shell.tsx`の
  `selectedPullRequest`）。一覧を無条件に優先していたころは、詳細ヘッダーの更新ボタンが
  詳細しか取り直さない（一覧はPR画面を開いている間しか自動更新されない）ため、
  CIが通った後に更新を押しても一覧を開いた時点の「CI失敗」バッジと「CI失敗を自動修正」ボタンが
  残り続けていた。
  **そのPRが本番へ出たかは、「マージ済み」の隣のバッジで出す**（#1814。`DeployStatusBadge`）。
  判定の材料も結論もブランチ画面と同じで、
  [`lib/pull-request-deploy.ts`](../src/lib/pull-request-deploy.ts)の
  `resolvePullRequestDeployStatus`が「作業PRのマージ時刻より後、最初にmainへ入ったPRがその変更を
  運んだ」（#1455と同じ前提）で運び手を決め、デプロイの成否は`resolveDeployState`（#1579）を
  そのまま通す。**2か所で違う結論を出さないよう、判定を写さずこの関数から呼ぶ。**
  取得は専用の`GET /api/pull-requests/deploy-status`（PR単体・mainへのクローズ済みPR一覧・
  `deploy.yml`の最新run）で、**マージ済みのPRを開いたときだけ**呼ぶ。詳細APIへ相乗りさせないのは、
  デプロイ中の取り直し（`hooks/use-pull-request-deploy-status.ts`。デプロイ待ち・実行中だけ30秒ごと）の
  たびに本文・コメント・レビューまで取り直さないため。**判定できないときは何も出さない**——
  `deploy.yml`が無いリポジトリ、取得した30件より古いリリースしか関係しないPR、15分待っても実行が
  現れないリポジトリでは、「未反映」と言い切らずバッジごと消す（ブランチ画面と同じ方針）。
  スマホのPR詳細は同じ`PullRequestDetail`を使うため、**片方の画面にだけ出す実装にしない**。
- **変更ファイル一覧（`/api/pull-requests/files`）は、詳細の折りたたみを開いたときだけ取りに行く**
  （#1987。[`pull-request-file-list.tsx`](../src/components/dashboard/pull-request-file-list.tsx)・
  [`hooks/use-pull-request-files.ts`](../src/hooks/use-pull-request-files.ts)）。既定は畳んだ状態で、
  そのあいだの消費はゼロ。畳んでいても見出しにファイル数と増減を出せるのは、詳細APIが既に返している
  `changedFiles`・`additions`・`deletions`を使っているため（**件数のために取得しない**）。
  一度取れたら畳んでも捨てず、PRの切り替えとヘッダーの「更新」でだけ取り直す。
  **開閉はPRごとではなくセクション単位で覚えるので、開いたままにしていれば別のPRを開くたびに
  1回消費する**（#1577のIssue詳細と同じ作法）。消費するかどうかを畳むかどうかで選べる点が
  「詳細APIへ相乗りさせて常に取る」形との違いで、同じPRを開き直すぶんはETagの条件付きGET
  （`githubFetchJsonWithEtag`）が304を返すためレート制限を消費しない。
  器を`IssueDetailSection`と共有していないのは枠の見た目が別物（角丸カード対、横幅いっぱいの帯）
  だからで、開閉の作法（`Collapsible`・セクション単位の保存キー）だけを揃えている。
  **ページングはせず100件（`PULL_REQUEST_FILES_PER_PAGE`）で打ち切る**——1PRを開くだけで何十
  リクエストも消費する方が害が大きく、そこまで並べても画面では読めないため、打ち切ったことを
  `truncated`で伝えてGitHubの「Files changed」へ誘導する。**差分そのもの（`patch`）は受け取らない**。
  この画面が答えるのは「どこを触ったPRか」までで、行単位の差分はGitHubに任せる。
- **mainへのPRのマージ確認ダイアログには「このリリースに含まれる変更」を並べる**（#2080。
  [`pull-request-merge-changes.tsx`](../src/components/dashboard/pull-request-merge-changes.tsx)・
  [`hooks/use-pull-request-changes.ts`](../src/hooks/use-pull-request-changes.ts)・
  `GET /api/pull-requests/changes`）。押した瞬間に本番デプロイが走るマージなのに、ダイアログには
  PR番号とブランチ名しか出ておらず、何を本番へ出そうとしているのかを確かめるにはGitHubのPRを
  開くしかなかった。材料は`GET /pulls/{number}/commits`から拾ったマージコミット
  （`Merge pull request #<番号> from <owner>/<ブランチ>`）で、ブランチ名`issue-<番号>`から対応Issueまで
  辿り、**タイトルはDBキャッシュ（`Issue`テーブル）から解決する**ためIssueの件数ぶんのリクエストは
  増えない（[`lib/pull-request-changes.ts`](../src/lib/pull-request-changes.ts)）。
  **PR本文の`## 対象issue`は使わない**——あれはPRを作った時点の一覧で、PRが開いているあいだに
  developへ入った変更が抜ける。出すのは`isProductionMerge`（`lib/pull-request-list.ts`。
  `mergeWarnings`が本番デプロイの警告を返すのと同じ判定）が真のPRだけで、develop向けPRの
  ダイアログでは取得もしない。100件（`PULL_REQUEST_COMMITS_PER_PAGE`）で打ち切る方針も、同じPRを
  開き直すぶんがETagの304になる点も変更ファイル一覧と同じ。**取得できなくてもマージは止めない**
  ——変更点は判断材料であって、マージの前提条件ではない。マージコミットが1件も無いリポジトリ
  （squash運用）ではコミットの件名をそのまま並べる。
- **「ブランチ」画面（`pane=flow`・スマホは`mscreen=flow`＝フッターの4枠目。#1638）は、
  新しく取りに行くのをブランチの存在確認だけに絞る**（#1455）。IssueとPRの対応・ブランチに対するPRの状態を1画面で
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
  走るのは画面を開いたときと更新ボタンのとき、そして**ユーザーが自動更新の間隔を選んでいれば
  その周期**（#1767。既定は自動更新しない。`hooks/use-branch-flow.ts`。一度取った内容は
  画面を離れても保持する）。
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
  **開いた直後は自動で展開しない**（#1932）。当初は手が要るもの（CI失敗・ユーザーのマージ待ち・
  リリース中）だけを初回に開いていたが、そのぶん初期表示が縦に伸び、1行に畳んで俯瞰する
  という画面の趣旨と食い違っていた。手が要ることはヘッダーの「手が要るもの◯件」
  （`needsAttention`）と畳んだ行のピルが伝え、開くかどうかは行のクリックか「すべて開く」で
  ユーザーが決める。**左メニューで選択中のリポジトリを開く動き（#1750）はこれとは別で残す。**
  **畳んだ行に出すピルからPRのマージ待ちは外した**（#2172）。文言（「ユーザーのマージが必要」）が
  長く、スマホ幅ではその行だけが2段に折り返していた。畳んだ行に残る琥珀はリリースのマージ待ち・
  手作業・CI失敗（赤）だけで、PRのマージ待ちは行を開いたPR行（`PullRequestLine`の
  `UserMergeRequiredBadge`とマージボタン）に出る。**`needsAttention`の数え方は変えていない**ので、
  件数に数えたぶんの一部はブランチ画面の行から探せない。どのリポジトリかは左メニューの
  「ユーザーの確認待ち」（`lib/nav-views.ts`・`pullRequestsRequiringUserMerge`）と
  PR一覧の「マージ待ち」（`lib/pull-request-views.ts`）で特定できるので、画面をまたげば導線は残る。
  **PCで幅が足りるときは左右2ペインに分ける**（#2157。`BranchFlowView`の`splitLayout`）。
  左は畳んだ1行の一覧のまま、選んだ1件の流れ図を右ペインへ出して独立にスクロールさせる。
  1カラムのまま行の下へ展開していたころは、横幅が余っているのに縦へ伸び、一覧と中身を
  同時に見られなかった。**分けるかどうかはウィンドウ幅ではなく、この画面が占めている幅の
  実測（`ResizeObserver`。`SPLIT_MIN_WIDTH`＝880px）で決める**——左メニューは畳めるうえ幅も
  変えられるので、同じウィンドウ幅でも中央に残る幅は倍近く違う。幅が足りないPCとスマホ
  （`splitLayout`を渡さない）は従来どおり行の下へ開く。**分割中は「すべて開く」を出さない**
  （同時に出せるのは1件のため）。右に出しているリポジトリと左ペインの幅は端末ごとに覚える
  （`issue-deck:branch-flow-selected-repository`・`issue-deck:branch-flow-list-width`。幅の
  ドラッグは左メニュー・Issue一覧と同じ`useResizableWidth`＋`ResizeHandle`）。
  **右ペインは別コンポーネントにせず、`RepositorySection`が中身を`createPortal`で送り込む。**
  行と中身を別々に組み立てると`useTriggerPending`（起動中）を2か所から呼ぶことになり、
  押した瞬間の書き込みが互いに伝わらない状態（#1955でわざわざ1か所へまとめたもの）が戻る。
  **実測で分岐するUIは、jsdomのテストでは既定で「狭い側」を通る**（#2157）。jsdomはレイアウトを
  持たず`getBoundingClientRect()`が常に0を返すため、幅を差し替えないテストは自動的に従来の
  折りたたみのままになり、既存のテストへ手を入れずに分岐を足せる。広い側を通したいテストだけ
  `vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")`で幅を差し替える
  （`branch-flow-view.test.tsx`の`mockWideLayout`）。**`ResizeObserver`はjsdomに無い**ので、
  生成側に`typeof ResizeObserver === "undefined"`のガードを置く（無いと`ReferenceError`で
  そのコンポーネントのテストが全滅する）。
  **畳んだ行のピルは、紫（待てば進む）と琥珀（あなたの番）で書き分ける**（#2038）。リリースが
  動いている間はCI実行中も、CIが終わって人のマージを待っている間も同じ紫の「リリース中」で、
  違いは回るアイコンの有無しか無かった（#1931）ため、一覧を流し見して自分の番のリポジトリを
  見つけられなかった。判定は`lib/branch-flow.ts`の`resolveReleaseMergeTarget`
  （→`summary.releaseMergeTarget`）で、基準は展開したときのリリースの見出しと同じ
  「CIが`pending`でなくなった時点」。**`failure`だけは待ちに数えない**——同じ行に赤の「CI失敗」が
  出るため、「直す必要がある」と「マージすればよい」を取り違えさせない（#1059と同じ優先順位）。
  auto-mergeが効いているバンプPRも待ちにしない（放っておけばdevelopへ入る）。文言は
  `lib/github/release-button-status.ts`の`releaseMergeTargetLabel`に寄せ、スマホのリポジトリ一覧・
  PCヘッダーのリリース状況と同じ言い方にする。琥珀のピルは`AttentionPill`が持ち、「手作業◯」
  「優先度 高」や開いたPR行の「ユーザーのマージが必要です」と同じ見た目にしてある
  （**この画面の琥珀は「あなたの番」**）。
  **ヘッダーの件数も「手が要るもの◯件」と「待てば進むもの◯件」に分ける**（#2038）。
  `needsAttention`はCI失敗・ユーザーのマージ待ち（#2172で行のピルは消したが件数には残す）・
  リリースのマージ待ち・デプロイ失敗だけになり、
  自動で進んでいるぶん（CI実行中のリリース・デプロイ中）は`isProgressing`が数える。両方に
  当てはまるリポジトリは「手が要るもの」にだけ数える——2つを足した数が画面に並ぶ行と合わなくなる
  ため。#1579がデプロイ中を「手が要るもの」へ含めていたのは、mainへマージしてから本番へ出るまでを
  見に来る手掛かりを残すためで、その役目は「待てば進むもの」が引き継ぐ。**畳んだ1行の
  「進行中 N件」（`activeLaneCount`＝レーンの本数）とは別物**なので、同じ言葉を使わない。
  **展開した中身は「バージョンへ何が合流したか」の流れ図**（#1510）。`main`と`develop`の
  2本の縦レールに対し、**横線1本がリリース（develop→mainのマージ）**で、その下にぶら下がる枝が
  その版に乗った変更になる（`BranchFlowReleaseGroup`）。既定で出すのは**次のリリースに乗る分まで**
  （未リリースの束＋まだdevelopへ向かっているレーン）で、本番へ出た版の束と「どの版で出たか
  特定できないレーン」は「リリース済みのバージョンを表示」で開く（#1586。#1510当初は
  ひとつ前の版まで出していたが、済んだ変更が「次に何が出るか」を押し下げていた）。
  **畳んだぶんに残る未完了の手作業（`71.manual-step`）だけは束の外へ出して常に見せる**——
  版が出た後も残る作業で、畳んだ束と一緒に隠すと画面のどこにも現れなくなるため。
  同じ理由で、畳んだリポジトリ行にも件数（`BranchFlowRepositorySummary.openManualStepCount`）を
  出す。**ただし「手が要るもの」の判定（`needsAttention`）には加えない**（手作業はこの画面で
  押すものではない）。
  この形にしたことで
  「developへマージ済み」「main未反映」「vX.Y.Zで本番反映」のピルは**どの横線の下にいるか**が
  表すようになり、レーンに残るピルは上段（マージ待ち・PR未作成・クローズ）だけになった。
  レールが占める幅は固定（PC 3.35rem・スマホ 2.6rem）なので、スマホでも横スクロールは出ない。
  **`behindBy`（mainにあってdevelopに無いコミット数）は出さない。** develop→mainをマージコミットで
  入れる運用ではリリースのたびに必ず1つ増え、中身は全部`Merge pull request … from guchi-apps/develop`
  になる（issue-deck本体で72件）。異常を示すバッジの形なのに行動につながらないため落とした。
  マージコミットを除いて数える案はコミット一覧を引く必要があり、この画面の前提（取得を増やさない）
  と噛み合わないので採らなかった。
  **まだブランチが無いIssueは「実装予定」として流れ図の上流に並べる**（#1704）。レーンはPRのheadブランチと
  実在する作業ブランチの和集合なので、着手前のIssueは画面のどこにも現れなかった。対象は進捗が
  `ready`・`planning`のopen Issueのうち、どのレーンにも現れていないもの（`lib/branch-flow.ts`の
  `PLANNED_ISSUE_PROGRESS_STATUSES`・`collectPlannedIssues`）。**`ready`まで含めるのは、計画が要らない
  Issueが`Ready`から直接実装へ入るため**で、`planning`だけに絞ると次に流れてくるものがほとんど映らない。
  **ブランチの存在確認（`ACTIVE_ISSUE_PROGRESS_STATUSES`）にはこの集合を足さない**——ブランチが無いのが
  正常な状態で、名指しで問い合わせてもGitHub APIの消費が増えるだけになる。
  並びは計画検討中 → 優先度（`80.Priority: High` → 無印 → `89.Priority: low`）→ 番号の新しい順で、
  **既定は3件まで**（`PLANNED_ISSUE_PREVIEW_COUNT`）。未着手はバックログ全体なので、全部出すと
  流れ図が下へ押し出される。残りはリポジトリごとのボタンで開き、件数は見出しと畳んだ1行に出す。
  **畳んだ1行の件数（実装予定・進行中・未リリース）はアイコンと数字だけで出す**（#1886・`SummaryCount`）。
  3つとも同じ灰色の文字だったため、右端まで読まないとリリース待ちなのか未着手なのか分からなかった。
  破線の丸（実装予定・灰）／枝分かれ（進行中・青）／上向き矢印（未リリース・紫）と**形でも区別が付く**ようにし、
  言葉は`title`と`aria-label`に持たせる。
  **手が要るものではないので、`needsAttention`（ヘッダーの「手が要るもの◯件」）には加えない。**
  枝と点は破線で描き、実在するブランチのレーンと見分けが付くようにする。
  **`orphanIssues`（ブランチもPRも見つからないIssue）とは別物**で、あちらは「実装中なのにブランチが無い」
  異常を隠さないための枠。手作業Issue（`71.manual-step`）は実装するものではないため実装予定に混ぜない。
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
  （例: clip-hive）でボタンが出てしまい、押すとdispatchが404で失敗した。判定は
  `POST /api/repositories/release`と同じ`releaseWorkflowExists`（プロセス内に10分キャッシュ）を`GET /api/branch-flow`
  から通し、結果を`RepositoryBranchStatus.hasReleaseWorkflow`として返す。**取得できていない
  リポジトリはfalse（＝出さない）へ倒す。** さらに`POST /api/repositories/release`側でも起動前に
  同じ判定を行い、workflowが無ければ`release_workflow_missing`を返して日本語の文言を出す
  （キャッシュが古い場合の保険。GitHubの生の404本文からは何が足りないのか読み取れないため）。
  起動そのものはスマホのリリースシートと同じ`POST /api/repositories/release`で、
  [`lib/release-request.ts`](../src/lib/release-request.ts)の`requestRelease`に寄せて2か所が
  同じ結果になるようにしてある。**PCでリリースを起動できるのはこの画面だけ**（#1614でヘッダーの
  ロケットボタンを通知ベルへ置き換えた）。**流れ画面が持つのは起動と、取得済みのPRだけで成立する
  操作と、本番デプロイの状態まで。** バンプPR作成→develop反映→PR作成→mainへマージの4段の進捗
  （`ReleaseProgress`）はPCでは出さず、スマホのリリースシートにだけ残る——ここで全部を追うと
  取得を増やさない前提が崩れる。PCで段階まで見たいときはGitHub Actionsの実行ログを開く。
  **本番デプロイだけを例外にしているのは、PRの情報だけでは誤ったことを言ってしまうから**（#1579）。
  リリースPRがマージされた瞬間に束の見出しが「◯/◯に本番反映」へ変わっていたが、見ているのは
  mainへマージされた事実だけで、そこから`deploy.yml`が数分走り、失敗すればmainに入ったまま
  本番へは出ない。**デプロイが済むまで「本番反映」と書かない**ようにし、実行中・失敗・待ちを
  束の見出しと畳んだ1行に出す（デプロイ失敗は`needsAttention`＝「手が要るもの◯件」、デプロイ中は
  `isProgressing`＝「待てば進むもの◯件」に数える。#2038）。
  取得は専用の軽いエンドポイント`GET /api/branch-flow/deploy`（mainブランチの`deploy.yml`の
  最新run 1件。`fetchLatestDeployWorkflowRun`）で、**`deploy.yml`を持つリポジトリだけ**を
  対象にする（#2020。元はリリース用workflowの有無で絞っていたが、再デプロイのボタンを足したことで
  リリースの束が無くても状態を出す先ができた。**ボタンを出す条件と同じ条件で絞る**——片方だけ
  `deploy.yml`を持つリポジトリが現れた瞬間に「押せるのに進捗が出ない」が起こるため）。判定（`lib/branch-flow.ts`の`resolveDeployState`）は**直近のリリースPRのマージ時刻と
  runの開始時刻の比較だけ**で、追加の照合は要らない。runが取得できない（`deploy.yml`が無い等）
  場合は状態を出さず従来表示のままにし、**実行が現れないまま15分が過ぎた「デプロイ待ち」も
  打ち切る**（mainへのpushでデプロイしないリポジトリで永久に待ちと言い続けないため）。
  デプロイ状況は**常に自動更新の対象**（`hooks/use-deploy-status.ts`。デプロイが動いている間だけ
  30秒ごと）。消費が釣り合うのは、リポジトリあたりREST 1回であることと、
  `fetchLatestWorkflowRun`がETagの条件付きGETを通す（変化が無ければ304でレート制限を消費しない）
  ため。
  **一度起動したら、バンプPRが現れるまでボタンを押せなくする**（#1548）。起動からPRが現れるまでの
  数十秒は`canTriggerRelease`がtrueのまま残り、その間の連打がworkflowの多重起動になっていた
  （既存のバンプPRがあれば作成はスキップされるが、バージョン判定のClaude実行は毎回走る）。
  起動時刻は端末のlocalStorageへ置き、判定は[`lib/trigger-pending-guard.ts`](../src/lib/trigger-pending-guard.ts)。
  **10分で失効させる**のは、workflowが失敗してバンプPRが1本も作られなかったときにボタンが
  二度と押せなくなるのを防ぐため。サーバー側に押下を記録しないのは、問い合わせるとこの画面の
  前提（取得を増やさない）が崩れるから。
  **起動中は畳んだ1行にも「リリース起動中」の紫のピルを出す**（#1955）。開いたときのボタンにしか
  出ておらず、畳むと押す前と同じ行に戻っていた。保持は[`hooks/use-trigger-pending.ts`](../src/hooks/use-trigger-pending.ts)が
  リポジトリ1件ぶんで1回だけ行い、行とボタンの両方へ配る——同じキーで`usePersistedState`を
  2か所から読むと、押した瞬間の書き込みが互いに伝わらないため。出すのは`canTriggerRelease`が
  trueの間だけにして、リリース完了後も10分残る起動時刻で古いピルが出ないようにしている。
  経過を見る時計（`hooks/use-now.ts`）は**起動時刻が入っている間だけ回す**——このhookは畳んだぶんも
  含めてリポジトリ全件でマウントされるため、既定のまま呼ぶと普段から全件で30秒ごとの再描画が走る。
  「手が要るもの◯件」（`needsAttention`）には数えない。**押す操作の有無ではなく、記録が端末ローカル
  だから**で、数えると同じ画面でも見る端末によって件数が食い違う。
  **この画面から本番デプロイだけをやり直せる**（#2020）。「本番へ再デプロイ」は`main`をそのまま
  出し直す操作（`deploy.yml`を`ref: main`・input無しでdispatchする）で、**リリースとは別物**。
  GitHubのSecretsや環境変数を変えると本番へ反映するのに`deploy.yml`を走らせる必要があるが
  （`deploy.yml`が本番の`.env`をまるごと書き直す）、それまで手段はdevelop→mainのマージだけで、
  出すコードが無いのにリリースを1回まわしていた。押してよいかは`canTriggerDeploy`
  （`deploy.yml`がある・デプロイが動いていない）で決まり、**未リリースの変更の有無は見ない**——
  developとの差分は出ないため、リリースの可否とは関係が無い。デプロイ中に押させないのは、
  `deploy.yml`の`concurrency`が`cancel-in-progress: true`で、重ねると走っている実行を打ち切るため。
  **置き場所はリポジトリの節（レールの凡例の行）で、リリースの束ではない。** 束は畳まれたり
  本番反映済みで隠れたりするので、束に付けると押したいときに画面から消える。
  ボタンは[`repository-deploy-button.tsx`](../src/components/dashboard/repository-deploy-button.tsx)、
  起動は`POST /api/repositories/deploy`（[`lib/deploy-request.ts`](../src/lib/deploy-request.ts)）。
  **一時的な失敗は、人が押す前に1回だけ自動で流し直される**（#2134）。`.github/workflows/deploy-retry.yml`
  （本体は`reusable-deploy-retry.yml`）が`Deploy to Production`の完了を`workflow_run`で購読し、
  失敗したジョブが`build`・`deploy`だけなら`gh run rerun --failed`する。**上限が1回であることは
  GitHubの`run_attempt`が保証する**（rerunは新しいrunを作らず同じrunのattemptを増やすため、
  `run_attempt == 1`のときだけ再実行すればよい。issue-deckのDBへは何も記録しない——デプロイが
  落ちているときにissue-deck自身が落ちている可能性があるため）。再実行は`createdAt`も`event`も
  変えないので、画面で言える材料は`runAttempt`だけ。2以上なら`BranchFlowDeployState.autoRetried`が
  立ち、バッジが「自動で再デプロイ中」「再デプロイしても失敗」になる。設計は
  [multi-agent/auto-repair.md](multi-agent/auto-repair.md)「本番デプロイの一時的な失敗の再実行」。
  **`deploy.yml`があっても`workflow_dispatch`を書いていないリポジトリがある**（portfolio）。
  ファイルの有無からは区別できない（GitHubのworkflow APIが起動条件を返さない）ため、dispatchが
  422で落ちた時点で`deploy_dispatch_unsupported`へ振り分け、「workflow_dispatchを足すと押せる」と
  出す——押し直しても直らないので、起動そのものの失敗と同じ文言にしない。
  起動から実行が現れるまでの数秒は、リリースと同じ仕組み（`useTriggerPending("deploy", …)`。
  失効は3分）でボタンを「デプロイ起動中…」にする。**そのあいだデプロイ状況のポーリングも続ける**
  （`hasUnseenDeployTrigger`）——押した直後は「まだ本番へ出ていない」材料が応答側に無く、
  そのままでは実行が現れても画面が「デプロイ成功」のまま止まる。
  **出し直しの実行を、版が本番へ出たかの判定に混ぜない**（#2020の計画レビュー指摘1）。
  デプロイ状態は最新のリリースの束にだけ乗り、`success`以外だとその版の見出しが「本番反映」から
  「mainへマージ」へ戻る。出し直しは**すでに出ている版をもう一度出しているだけ**なので、そのまま
  流すと走っている間と失敗した後に「出ている版が出ていない」表示になる。runの`event`
  （`push`＝リリースの本番反映／`workflow_dispatch`＝手動の出し直し）で区別し、
  `BranchFlowDeployState.manual`として渡して、**見出しの「本番反映」を取り消さない**。
  バッジの文言も「本番へ再デプロイ中」「再デプロイ失敗」と分ける——同じ「デプロイ失敗」でも、
  版が出ていないのか出し直しに失敗したのかで次にやることが違う。
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
- **ブランチ状況とPR一覧の自動更新は、ユーザーが間隔を選んだときだけ回る**（#1767。
  更新ボタンの右のメニューで「自動更新しない（既定）／1分／5分／10分」。選択は端末の
  localStorage（`issue-deck:flow-auto-refresh-interval`）に残り、間隔は
  [`lib/auto-refresh.ts`](../src/lib/auto-refresh.ts)が持つ）。**既定を「自動更新しない」に
  しているのは1巡の消費が重いから**——ブランチ状況はリポジトリあたりGraphQL 1回、PR一覧は
  リポジトリあたりREST 2回（ETagで304なら消費0）＋CI状態をinstallationごとにGraphQL 数回で、
  26リポジトリを1分間隔で回すとGraphQLだけで毎時1,600ポイント前後（上限5,000ポイント/時）になる。
  回すのは**この画面を開いていて、かつタブが前面にある間だけ**（`hooks/use-auto-refresh.ts`が
  Page Visibility APIで止め、前面へ戻った時点で次の周期を待たずに取り直す）。
  **自動更新の取得では読み込み表示（ボタンの無効化・「読み込み中...」）を出さず、更新アイコンの
  回転（`isRefreshing`）だけを出す。** 周期ごとに操作できなくなるのを避けつつ、画面が勝手に
  変わったときに何が起きたのかが分かるようにするため。失敗も画面に出さない（次の周期で回復する）。
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
  一覧・PR詳細・スマホのリリースシートの進捗に出る。**どのワークフローを起動するかの判定は
  サーバー側**（[`lib/github/pull-request-repair.ts`](../src/lib/github/pull-request-repair.ts)）
  で、`issue-<番号>`のdevelop向けPRは既存の`claude-ci-fix.yml`・`claude-conflict-resolve.yml`へ、
  Issueに紐づかないPR（バンプPR・develop→mainのリリースPR）は新設の`claude-pr-repair.yml`へ
  振り分ける。設計は[multi-agent/auto-repair.md](multi-agent/auto-repair.md)。
- **コンフリクトしたPRは、GitHubのイベントを待たずにissue-deck側から巡回して見つける**
  （#2116。判定は[`lib/github/conflict-sweep.ts`](../src/lib/github/conflict-sweep.ts)、IOは
  [`lib/github/conflict-sweep-run.ts`](../src/lib/github/conflict-sweep-run.ts)）。
  サブPCのpollerが1巡ごとに`POST /api/pull-requests/conflict-sweep`（認証は`DISPATCH_SECRET`）を
  叩き、連携済みリポジトリ全部のdevelop向け`issue-<番号>`PRのうちコンフリクトしているものへ
  `claude-conflict-resolve.yml`を`workflow_dispatch`する。**GitHub Actions側の自動検知は
  取りこぼす**——`pull_request(opened)`のイベントが1本も配送されないことがあり
  （guchi-apps/myroom#191）、安全網の`schedule`も15分の指定に対して実測24〜36分でしか走らない。
  **実際に巡回するかどうかを決めるのはサーバー側**（`CONFLICT_SWEEP_INTERVAL_MINUTES`・既定5分・
  0で無効）で、pollerは毎巡素直に呼ぶ。同じPRへは30分（`CONFLICT_SWEEP_RETRY_COOLDOWN_MINUTES`）
  空けるまで起動し直さず、対応Issueに`00.check-user`が付いていれば起動しない（自動解消を断念した
  ワークフローが付けるラベルなので、そのまま「人が見ると決めたもの」の目印にする）。
  設計は[multi-agent/auto-repair.md](multi-agent/auto-repair.md)「issue-deckからの巡回検知」。
- **自動修復が「いま走っているか」だけは、GitHubではなくissue-deckのDBが持つ**（#2072。
  `PullRequestRepairRun`と[`lib/github/pull-request-repair-run.ts`](../src/lib/github/pull-request-repair-run.ts)）。
  修復ワークフローは`workflow_run`で起動するため、runの`head_branch`・`head_sha`が対象PRでは
  なくデフォルトブランチを指し、**GitHub APIからは実行と対象PRを結び付けられない**。走っている
  側が`POST /api/pull-requests/repair-runs`（認証は`PROGRESS_REPORT_SECRET`）で開始・終了を
  報告する。PR一覧・PR詳細・リリース進捗はこれを`PullRequestSummary.repairRun`として受け取り、
  `RepairRunBadge`（`components/dashboard/pull-request-badges.tsx`）と通知ベルへ出す。
  終了の報告が届かなかった実行は開始から60分で失効させる。
- **リリースの進捗を出す経路は2本ある。リポジトリ1件の詳細と、全リポジトリ横断のサマリ。**
  詳細は`GET /api/repositories/release`（`hooks/use-release-status.ts`）で、**モバイルの
  リリースシートだけ**が使う（#1614でPCヘッダーのロケットを外したため）。1回でGitHub APIを
  7〜8回消費するため、開いている間だけポーリングする。横断のサマリは
  `GET /api/repositories/release-pending-merges`
  （`hooks/use-repository-release-statuses.ts`）で、通知ベル（後述。PC・スマホとも
  `NotificationProvider`が1回だけ取る）と**モバイルのリポジトリ一覧のバッジ**（#1117）が共有する。**状態の4値への畳み込み
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
- **通知ベルが、リポジトリ横断で「人の操作が要るもの」を見る唯一の場所**
  （#1614。[`components/dashboard/notification-button.tsx`](../src/components/dashboard/notification-button.tsx)）。
  PCはヘッダー右端、スマホは各画面のヘッダーの実行状況の右隣に置く（#1772）。
  元はリリース専用のロケットボタンだったが、リリースの起動・マージ・版の確認は「ブランチ」画面が
  同じものを持っていたため、**横断で拾えること**だけを残してリリース以外へ広げた。集めるのは
  リリースのマージ待ち・失敗／`00.check-user`／マージ待ちPR（左メニューの「マージ待ち」と同じ
  母集団）／`71.manual-step`の4区分。
  - **判定は[`lib/notifications.ts`](../src/lib/notifications.ts)（純粋関数）に閉じ、新しい基準を
    作らない。** 文言・トーンは既存の`describeReleaseStatusBadge`・`CHECK_USER_REASON_TEXT`・
    `filterPullRequestsByView`・`computeManualStepReadiness`から得る。ここで独自判定を書くと、
    同じ状態が画面ごとに別の言葉で出る。
  - **`71.manual-step`は前提条件が満たされたものだけを出す**（#1801。判定は左メニューの
    「ユーザーの作業待ち」と同じ`computeManualStepReadiness`）。先行する変更が本番へ出るまで
    実行できない手作業まで並べると、ベルが「いま人が動けば盤面が進むもの」の集まりでなくなり、
    一覧の行数も左メニューの件数（`actionable`だけを数える。#1763）と食い違う。前提待ちの
    手作業は「ユーザーの作業待ち」ビューに橙の時計付きで残るので、見えなくなるわけではない。
  - **件数バッジと一覧で母集団が違う。バッジ（とツールチップ）は手作業待ちを数えない**
    （#1936。`lib/notifications.ts`の`BADGE_EXCLUDED_GROUPS`・`countBadgeNotifications`）。
    手作業Issueは実行できる状態になってからも数日〜数週間openのまま残るため、数えると常時点灯し
    確認待ち・マージ待ちPRの増減に気づけない。**一覧からは外さない**（横断で手作業待ちを見られる
    場所は他に無い）ので、差は開いたときの見出し（`describeNotificationCount`の
    `1件・手作業待ち1件`）で説明する。
  - **追加のGitHub API消費は、閉じている間はゼロ**（開いている間だけ30秒ごとに取り直す。
    #1909。後述）。Issue・PRは`IssueDeckShell`が既に取得済みのものを受け取り、
    リリース状況はロケットが使っていた`useRepositoryReleaseStatuses`をそのまま引き継ぐ。
    **材料を用意するのは`NotificationProvider`だけ**（#1772。
    [`components/dashboard/notification-state.tsx`](../src/components/dashboard/notification-state.tsx)）。
    ベルを置く場所がPCの1か所ではなくなったため、各ボタンが自分でフックを呼ぶとポーリングが
    増える——PCのトップバーは`hidden md:flex`でCSSで隠れているだけで、スマホでもmountされたまま
    だからで、どちらのレイアウトかはJS側から判別できない。
  - **開いている間だけ30秒ごとに取り直し、右上に「いつ時点の内容か」を出す**（#1909。
    [`components/dashboard/notification-refresh-button.tsx`](../src/components/dashboard/notification-refresh-button.tsx)）。
    開いた時点で1回取り、以後30秒ごと（裏に回ったタブでは取りに行かず、前面へ戻った時点で
    取り直す。`hooks/use-auto-refresh.ts`）。**自動更新を持つのは開いた中身の側**——
    ポップオーバー・シートは閉じている間そもそも描かれないので、開いているかどうかを
    Providerへ伝える仕組みが要らない。取り直す先はベルの材料3つで、まとめて呼べるように
    `NotificationProvider`が`refresh`として配る。**PR一覧だけは`refreshInBackground`**
    （#1909。`refresh`だと取得effectが張り直されて`isLoading`が立ち、後ろに開いているPR一覧が
    30秒ごとに「読み込み中...」へ戻る）。**取れなかった周は「最後に取れた時刻」を進めない**
    ——進めると、取れていないのに「たった今更新」と出る。文言・配色（「12秒前に更新・30秒ごと」・
    取得中の回転・3周期落ちたら橙）と見た目は実行キュー（#1773）と共通で、
    [`lib/refresh-status.ts`](../src/lib/refresh-status.ts)と
    [`components/dashboard/refresh-indicator-button.tsx`](../src/components/dashboard/refresh-indicator-button.tsx)
    にある。
  - **同じ操作を2行に出さない。** リリースのマージ待ちとして出したPRと、確認待ちとして出した
    Issueに紐づくPRは、PRの区分から落とす（Issue詳細に`issue-merge-button.tsx`があるので
    操作は失われず、左メニューの「確認待ち」件数とも食い違わない）。
  - **自動で進行中のもの（`progressing`・Auto-merge有効でCI成功）は出さない。** 人が何も
    しなくてよいものを並べるとベルを開く意味が薄れる。
  - **TopBarの絞り込みには追随しない。** 横断で見る場所なので、Issue側と同じく絞り込み前の
    集合を渡す（`IssueDeckShell`の`notifiablePullRequests`）。
  - **スマホは中身を共有し、出し方だけを変える**（#1772。
    [`components/dashboard/notification-content.tsx`](../src/components/dashboard/notification-content.tsx)を
    PCのポップオーバーと[`components/dashboard/mobile/mobile-notification-button.tsx`](../src/components/dashboard/mobile/mobile-notification-button.tsx)の
    ボトムシートが共有する。実行キューの`dispatch-queue-content.tsx`と同じ三分割）。
    置き場所は**実行状況（#1638）を置いている画面すべての、その右隣**で、PCの並び
    （実行キュー → ベル → アバター）と同じ順序になる。**遷移先だけはスマホ側が自分で決める**
    ——PCは`pane`を切り替えれば済むが、スマホは`mscreen`を進めないと画面が変わらない。
    ホーム画面の件数・リポジトリ画面のリリースシートという従来の経路もそのまま残る。
- **アプリを閉じているときの確認待ちはPush通知で届く**（#838。
  [`lib/notifications/check-user-push.ts`](../src/lib/notifications/check-user-push.ts)・
  [`lib/notifications/push.ts`](../src/lib/notifications/push.ts)・[`public/sw.js`](../public/sw.js)）。
  ベルとトーストは画面を開いていないと見えないため、`00.check-user`が付いたIssueをOSの通知として
  届ける。登録・解除は設定の「通知」区分（`settings/notification-settings-section.tsx`。PCの
  ダイアログとスマホの設定画面が共有する）で、**購読は端末×ブラウザごと**に1行（`PushSubscription`）。
  - **ラベルが付いた瞬間には送らず、少し待ってから、そのとき残っているラベルを読んで送る。**
    鳴ってからでは取り消せないため。理由は2つで、(1) 実装エージェントがPR作成の直後に付ける
    `00.check-user`＋`01.check-merge`は、10分後に自動マージされてラベルごと消えることがある
    （#1709。トーストは保留で済むがOSの通知はそうはいかない）、(2) 理由ラベル（`01.check-*`）は
    `00.check-user`より後の別リクエストで付く（`dispatch/check-user-labels.ts`）ため、瞬間に読むと
    「確認待ち」としか言えない。待ち時間は既定3分、`01.check-merge`だけ15分
    （トーストの保留上限`CHECK_USER_TOAST_MAX_HOLD_MS`＝10分より長く取り、**自動で消えるものは
    鳴る前に消えている**状態にする）。24時間より古い確認待ちは送らずに畳む（機能を入れた直後や
    購読を後から足したときに、溜まっていたものが一斉に鳴らないように）。
  - **送信済みかどうかは`Issue.checkUserPushSentAt`**。`00.check-user`が付き直すたびに
    `checkUserLabeledAt`とセットでnullへ戻す（書き戻し口は`github/sync-issues.ts`の
    `upsertIssueRow`だけ）。「nullで、付与から待ち時間が過ぎたもの」が未送信の集合になる。
  - **常駐プロセスは置かない**（`runManualStepVerificationPatrol`と同じ方針）。巡回を呼ぶのは
    サブPCのpollerが30秒ごとに叩く`POST /api/dispatch/claim`——**ブラウザを開いていなくても回る
    唯一の定期経路**で、画面のポーリングに載せると閉じているときのための通知が閉じている間だけ
    止まる。GitHub Actionsの無人実行はサブPCを介さずにラベルを付けるため、Webhookの受け口
    （`api/webhooks/github`）にも同じ呼び出しを置いてある。どちらも失敗しても本来の処理は続ける。
  - **`public/sw.js`は`src/proxy.ts`のmatcherから除外する。** 除外しないと、Supabaseのセッションが
    切れた状態でのService Workerの更新チェックに`/login`のHTMLが返り、MIMEタイプ不一致で更新が
    落ちる（＝通知が届かなくなる）。`manifest.webmanifest`と同じ扱い。Service Workerは`fetch`を
    扱わない——キャッシュを持つと古い画面が残る事故と、認証済みの応答が漏れる事故を抱える。
  - **表示中のウィンドウがあるときは通知を出さない**（`sw.js`の`hasVisibleClient`）。同じ知らせを
    画面内のトースト（`check-user-toast-viewport.tsx`）が出しており、重ねるとどちらを押せばよいか
    分からない。タップして開くURLは`useReferenceNavigation.openIssue`と同じ形で、PC（`issue`）と
    スマホ（`mscreen`・`missue`）の両方の現在地を載せる。
  - **VAPID鍵（`VAPID_PUBLIC_KEY`・`VAPID_PRIVATE_KEY`・`VAPID_SUBJECT`）が未設定なら機能ごと
    無効**で、設定画面は「利用できません」を出す。**公開鍵も`NEXT_PUBLIC_`にせず実行時にAPIから
    返す**（ビルドし直さずに鍵を差し替えられる）。iOS・iPadOSはホーム画面に追加したとき
    （standalone起動）しかWeb Pushを許さないので、判定を「未対応」と分けて案内する
    （`lib/push-client.ts`の`detectPushAvailability`）。
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
- **PC版のヘッダー（`topbar.tsx`）にも同じ戻るボタンを置いている**（#1771）。**パソコンで
  アプリとして起動（PWA）するとブラウザのツールバーごと戻る矢印が消え、戻る操作の手段が画面上に
  無くなる**ため。呼ぶのはスマホと同じ`goBackOrFallback`で、**戻るの定義を増やさない**。
  押せるかどうかは`useCanGoBackInApp()`（`lib/history-stack.ts`の`subscribeHistoryStack`を
  `useSyncExternalStore`で読む）で、巻き戻せないときは**隠さずに押せない状態で残す**
  （消すとヘッダーの並びが左右にずれ、隣のサイドバー開閉ボタンの位置が変わる）。
  「更新」ボタン（`mobile-reload-button.tsx`）と同じく`display-mode: standalone`では
  出し分けない（判定に実機差があり、外すと要求そのものが満たされないため）。
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
  **その計画の承認・修正はIssue詳細の画面から送れる**（#2061。計画を投稿したフックが
  `GET /api/dispatch/sessions/plan/decision`を引いて返事を待ち、決まった内容をClaude Code自身の
  許可判定として返す。押す側は`POST /api/dispatch/plan-decision`。値の検証・表示の判定は
  `lib/dispatch/session-plan-request.ts`、DBは`lib/dispatch/plan-requests.ts`、画面は
  `components/dashboard/plan-approval-panel.tsx`。**`send-keys`は使わない**ので
  `docs/multi-agent/gates.md`の禁止に触れず、返事が決まらなければ端末に従来どおりの承認
  プロンプトが出る）。**押す先の案内もアプリの中へ向ける**——一覧の行は「計画を承認」を出して
  Remote Controlの強調（`lib/remote-control-attention.ts`）を下ろし、確認待ちの案内は
  `plan`ターゲットへスクロールさせる（`lib/github/check-user-guidance.ts`）。
  **パネルはPC版・スマホ版の両方の詳細に置く**（`plan-approval-mount.test.ts`が置き忘れを捕まえる）。
  **返事を待つあいだの1回のHTTP失敗で降りない**（#2108）。降りるのは届かない状態が
  `SESSION_PLAN_POLL_GRACE_SECONDS`（既定60秒）続いたときだけで、そのときは
  `POST /api/dispatch/sessions/plan/decision`で画面の待ちも畳ませる（畳ませないと、押しても
  誰も受け取らないボタンがカウントダウン付きで残る）。返事待ちを作るかどうかは
  **Issueコメントを投稿できたかとは切り離す**（パネルはDBに保存した計画本文を描くため）。
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
  ランチャー（`scripts/start-cross-repo-question.sh`）は**質問用のworktreeを作らず**、実行できる
  全リポジトリを`--add-dir`で読み取り用に渡す（書き込み系ツールは`--disallowedTools`で封じる）。
  **渡すのは本体チェックアウトではなく`origin/develop`のスナップショット**（#1583。
  `scripts/lib/question-refs.sh`が起動時に`fetch`し、`.questions/_refs/<owner>-<repo>`の
  detached worktreeを合わせる）。本体チェックアウトを更新する仕組みがどこにも無く、実測で
  最大29コミット遅れのコードを根拠に答えていたため。**本体の作業ツリーには触れず**、
  用意できなかったリポジトリだけ本体へ落として遅れコミット数を参照一覧に出す。
  回答は既存の`QA_ANSWER_MARKER`付きコメントで返るので、「回答待ち」の表示とワンボタンクローズが
  そのまま働く。
  **計画の関門（G1）のセッションも同じキューで流す**（#1855。`kind`は`PLAN_REVIEW`）。
  積むのは人ではなく**計画コメントの投稿**（`lib/dispatch/session-plan.ts`の`postSessionPlan`）で、
  この種別だけが自動で積まれる。画面（Issue詳細の承認カード）の「計画をレビュー」は補助の入口
  （`components/dashboard/plan-review-button.tsx`）。**動いているセッションを理由に断らない**
  （計画を出したセッションは承認待ちで生きているのが常態）。
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
- **そのホストで初めて開くリポジトリは、起こす前に止める**（#1838。`scripts/lib/claude-trust.sh`）。
  Claude Codeのフォルダ信頼確認（`Is this a project you created or one you trust?`）に答えるまで
  セッションは始まらず、その間はフックが1つも飛ばない（#1465）。`start-local-session.sh`・
  `generic-start-issue.sh`が`~/.claude.json`を**読んで**未信頼を見分け、worktreeを作る前に
  「本体チェックアウトで1回だけ答えてください」と出して止まる。**信頼は本体チェックアウトの
  パスに記録される**ためリポジトリにつき1回で済む。**書き換えはしない**（「信頼確認そのものは
  自動化しない」）。判定できないときは通す（fail open。`ISSUE_DECK_SKIP_CLAUDE_TRUST_CHECK=1`で
  丸ごと飛ばせる）。
- **起動したセッションの後始末はpollerの1巡に相乗りさせ、常駐プロセスを増やさない。**
  `scripts/reap-dev-servers.sh`が開発サーバーを（#1223）、`scripts/reap-sessions.sh`が作業の
  終わったtmuxセッションそのものを畳む（#1256）。判定材料は`scripts/lib/session-state.sh`が
  読み書きする状態ファイル（`~/.local/state/issue-deck/sessions/`。`run-issue-session.sh`が
  起動時の記述子を、`session-notify.sh`がフックの最後のイベントを書く）と、gitとGitHubの事実だけで、
  **画面（`capture-pane`）の内容は読まない**。**PRを作り`11.local`も外した引き渡し済みの
  セッションも畳む**（#1541。猶予は`SESSION_HANDOFF_IDLE_MINUTES`。畳まれても
  `run-issue-session.sh`の`--continue`で前回の会話の続きから再開できる）。**猶予待ちのセッションには
  「あと何分で畳むか」を状態ファイル（`.reap`）へ残し、pollerが`DispatchSession.reapAt`として
  運ぶ**（#1817。画面の文言は`lib/dispatch/issue-session.ts`の`describeSessionReap`。
  **判定を画面側へ写さない**——worktreeがcleanか・push済みかはホストにしか無く、写すと必ずずれて
  終わらないセッションに終了予告が出る）。**横断質問セッションは
  質問IssueがOPENのままでも放置で畳む**（#1648。猶予は`QUESTION_SESSION_IDLE_MINUTES`。
  こちらはcwdが質問Issue間で共有されるため会話を引き継がない）。設計は
  [multi-agent/local-quick-start.md](multi-agent/local-quick-start.md)。
- **worktreeの掃除も同じ1巡に相乗りさせる**（#1716・#2123）。pollerは
  `WORKTREE_CLEANUP_INTERVAL_MINUTES`（既定60分・0で無効）の間隔で
  `scripts/cleanup-worktrees.sh --all-repos --yes`を呼ぶ。**足りなかったのは
  判定ではなく起点**で、スクリプトは#1100からあったのに実行の起点がどこにも無く、3日で181本・38GB
  溜まってルートFSが77%に達した。**次に足りなかったのは範囲**で、起点を置いたあともissue-deckの
  worktreeしか見ておらず、汎用ランチャー（#1224）で起こした他リポジトリのworktreeが166本中153本
  まで溜まってルートFSが91%に達した（#2123。`--repo <owner/repo>`で1リポジトリ、`--all-repos`で
  `local-repos.conf`の全リポジトリ）。無人で回すための安全弁が2つあり、(1)起動の準備から30分が
  経っていないworktreeは触らない（`--min-age-minutes`。`start-issue.sh`が作ってからセッションの
  プロセスが立つまでの数分間は削除条件をすべて満たしてしまうため）、(2)残すworktreeの`.next`は
  消す（ビルド成果物で作り直せる。実測で163本が`.next/dev`だけで16GB）。設計は
  [multi-agent/branching.md](multi-agent/branching.md)「掃除を回す起点」。
- **`node_modules`の重複回収も同じ1巡に相乗りさせる**（#2124）。pollerは
  `NODE_MODULES_DEDUPE_INTERVAL_MINUTES`（既定1440分＝1日1回・0で無効）の間隔で
  `scripts/dedupe-node-modules.sh --yes --quiet`を呼ぶ。**掃除と違い同期実行しない**——走査は
  全リポジトリで15分前後かかり、同期にするとその間ジョブの取得が止まる（掃除の上限は5分）。
  `setsid`で別プロセスへ出し、多重起動はスクリプト側の`flock`が防ぐ。まとめてよいかの判定は
  `hardlink`(util-linux)、共有から外すディレクトリは`scripts/lib/node-modules-share.sh`が持ち、
  同じ判定を`generic-start-issue.sh`のシード（worktree作成時の`cp -al`）と共有する。設計は
  [multi-agent/branching.md](multi-agent/branching.md)「`node_modules`の実消費」。
- **開発サーバーの回収は在庫を2通り持つ**（#1525）。PIDファイル（`.dev-servers/issue-<番号>.pid`）
  だけを見ていると、エージェントが手で起こし直した2本目は載らないため存在自体が見えない。
  `scripts/reap-dev-servers.sh`は`/proc`も走査し、動いているプロセスから入る経路を併せ持つ。
  **プロセスの特定はコマンドラインの部分一致で行わない**——`claude`はプロンプト全文をargvに持ち、
  Issue本文の`next-server`という記述に`grep`が当たった実績がある（#1523）。判定は
  `scripts/lib/dev-server.sh`の`dev_server_is_dev_command`（`/proc/<pid>/cmdline`をNUL区切りで
  読み、argvの位置で見る）。**systemd timerは新設していない**（周期ではなく在庫の問題なので、
  足すと同じ役が2つになる）。
- **重いコマンド（テスト・ビルド）は機体全体で同時2本までに絞る**（#2076。
  `scripts/heavy-command.sh`）。`package.json`の`test:unit`・`build`が`flock`で枠を取ってから
  走る。既存の上限（`AppSetting.dispatchConcurrency`・`DISPATCH_MAX_SESSIONS`）は**ジョブの
  払い出しとセッション本数にしか効かず**、立った後の12本が同時にテストを始められた
  （1本でピーク3.24GiB・12スレッド）。枠の置き場はリポジトリの外
  （`${XDG_CACHE_HOME:-~/.cache}/heavy-command`）で、制約が機体にあるため他リポジトリと共有できる。
  1本あたりのワーカー数は`vitest.config.ts`が6に絞る。設計は
  [multi-agent/subpc-dispatch.md](multi-agent/subpc-dispatch.md)「立った後のセッションが走らせるものには上限が無い」。
- **走っているセッション同士の関係を見るのは`scripts/fleet-status.sh`**（#1215）。tmux（一次情報源）・
  worktreeの分岐元SHA・未マージPRの変更ファイルを突き合わせ、**同じファイルを触っている組**を出す。
  既定は人が読む表、`--json`はプロンプトへの差し込み用。整形と重なりの判定は
  `scripts/lib/fleet-status.sh`の純粋関数にあり、tmux・gh・gitを叩くのは入口だけなので、
  出力を固定したfixtureで検証できる（`src/lib/fleet-status.test.ts`）。**LLMを使わず、
  画面（`capture-pane`）も読まない計器**で、判断はしない。計画が前提としたSHAからの変化を見せる
  `scripts/lib/plan-base.sh`（`<!-- plan-base: <SHA> -->`。**止めず、見せるだけ**）と対で、
  設計は[multi-agent/gates.md](multi-agent/gates.md)。**`--root <dir>`で突き合わせ先のリポジトリを
  差し替えられる**（#1218）。GitHub Actionsの計画レビューは他リポジトリからも呼ばれ、そのとき
  このスクリプトは`.shared-prompts/`（issue-deck側のcheckout）に置かれるため、既定のままでは
  呼び出し元ではなくissue-deckの先端を出してしまう。
- **計画の関門（G1）は`.github/prompts/plan-review.md`（無人）と`scripts/prompts/plan-review-agent.md`
  （ローカル。持たないリポジトリは`scripts/prompts/generic-plan-review-agent.md`）の兄弟プロンプト**
  （#1218・#1855）。無人は`reusable-issue-dispatch.yml`の`mode=plan`で計画コメントの投稿直後に
  自動で走る。ローカルは入口が2つで、**計画コメントの投稿を契機に自動**（#1855。
  `lib/dispatch/session-plan.ts` → `DispatchJob`の`PLAN_REVIEW` → poller →
  `scripts/start-plan-review.sh`）と、`scripts/start-reviewer.sh --plan <Issue番号>`で人が起こす
  手動（引数なしは従来どおり成果物の関門G2）。どちらも`fleet-status.sh`の出力を差し込み、
  差し込み方は`scripts/lib/plan-review-prompt.sh`で共有する。
  **承認せず、PR操作もラベル操作も持たない**（`--allowedTools`から外してある。自動の入口も
  Actionsと同じ一覧を渡す）。設計は[multi-agent/gates.md](multi-agent/gates.md)「G1の実装」。
- **計画レビューのセッションは`<リポジトリ名>-plan-review-<番号>`で、実装セッションの
  `-issue-`規約から外す**（#1855）。pollerのセッション報告・本数の計上・停止／終了の突き合わせは
  すべて`-issue-`に依存しており、混ぜると計画レビューを実装セッションと取り違えて畳む。
  読むのは対象リポジトリの`origin/develop`のスナップショット（横断質問と同じ
  `scripts/lib/question-refs.sh`）で、**本体チェックアウトを占有しない**（G2の`gh pr checkout`と
  衝突しないため）。フックは付けない（`Stop`フックがそのIssueの`00.check-user`＝計画の承認待ちを
  外してしまうため）。積むのは`21.plan-required`が付いた計画だけ。
- **リポジトリ全体のコードレビュー（#698）は、計画レビューと同じ作りの別の種別**
  （`CODE_REVIEW`。`scripts/start-code-review.sh` ＋ `scripts/prompts/code-review-agent.md`）。
  画面の「コードレビューを実行」（`code-review-dialog.tsx`）がレビューIssueを1件立て、
  依頼コメントを投稿し、ジョブを積む。結果は**そのIssueへの1件のコメント**として返り、
  画面（`code-review-panel.tsx`）が`lib/github/code-review.ts`の`parseCodeReviewReport`で
  指摘カードにする。**結果の書式を変えるときはプロンプトとパーサーを必ず両方直す**
  （片方だけだと、投稿はされるのにカードにならず「レビュー中のまま」に見える）。
  指摘の起票はエージェントに任せず（`gh issue create`を渡していない）、カードの
  「Issueを作成」が**埋めた新規作成ダイアログを開くだけ**にしてある。設計は
  [multi-agent/code-review.md](multi-agent/code-review.md)。
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
  そちらを優先する。作業ツリーには触れない（自動pullはしない）。** 「単に古いだけ」の判定は
  **HEADがリモート追跡ブランチのどれかに含まれているか**で行う（#1583）。`origin/develop`の
  祖先であることを条件にしていた頃は、本体チェックアウトが`main`に乗っているだけで
  同期コピーが丸ごと無効化されていた（`main`のマージコミットは`develop`に含まれないため）。
  入口の`start-issue.sh`とpollerは作業ツリーのままだが、**横断質問のランチャーだけは
  同期コピーから自分を実行し直す**（#1583。pollerが本体の`scripts/`を直接起動するため、
  ランチャーの修正が人の`git pull`まで効かなかった）。経路の表は
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
  戻り、`SecretSyncRun`に残る。**保存も表示も件数と項目名だけで、値も値の長さも持たない**
  （長さも手がかりになる）。項目名は失敗・同期・スキップの3種類を残し、画面では行ごとの
  「内訳」で出す（#2022。件数だけでは「値を変えた項目が本当に入ったのか」を確かめられず、
  Actionsのログを開きに行くしかなかった）。**項目名を拾うのは共有ワークフロー側**
  （`reusable-sync-secrets.yml`がログの`ok`/`skip`/`FAIL`の行頭から取る）だが、
  **そのログを出すのは各リポジトリが実体で持つ`scripts/sync-github-secrets.sh`**で、
  タグでは配られない。したがって内訳が空になる経路は2つある——配布先が古いタグを参照している
  あいだと、そのリポジトリのスクリプトが書式を変えたとき。どちらも件数は正しいままなので、
  画面は「項目名が記録されていません」と明示する（0件と読み違えないため）。
  この事情があるので、`ok`/`skip`/`FAIL`と末尾の集計行は**スクリプト冒頭で契約として宣言している**。
  判断は[`lib/secrets-sync.ts`](../src/lib/secrets-sync.ts)の純粋関数、
  DBとの往復は[`lib/secrets-sync-runs.ts`](../src/lib/secrets-sync-runs.ts)。
  **CLIから直接叩く経路とActions経由では、消費する1Passwordの枠が違う**——CLIは個人アカウントの
  セッションで枠を消費しないが、Actionsはサービスアカウント（アカウント全体で1,000件/日）を使う。
  そのため画面側にキーの絞り込み・確認ダイアログ・クールダウン（直近の成功から10分）を置いている。
  **失敗の理由は、失敗したときだけログから消えていた**（#2049）。`run:`の既定シェルは
  `bash -e {0}`で、ステップ冒頭の`set -uo pipefail`は-uとpipefailを足すだけで**-eを打ち消さない**。
  同期スクリプトを素で呼ぶと非ゼロ終了の瞬間にステップが終わり、次行の`cat "$LOG"`にも件数の集計にも
  到達しない。スクリプトは1件でも失敗すれば必ず非ゼロで終わる作りのため、**成功したときだけログが出て、
  失敗したときは`##[error]Process completed with exit code 1.`しか残らない**という、いちばん困る形に
  なっていた（画面にも`同期=0 スキップ=0 失敗=0`としか出ず、「同期処理が始まる前に失敗しました」の
  判定にも誤ってかかった。実際には始まっていた）。終了コードは`|| rc=$?`で明示的に受け、
  失敗時は`::error::`の注釈にも失敗した項目名を出す。失敗経路は実際に走らせないと確かめられないため、
  [`scripts/reusable-sync-secrets.test.mjs`](../scripts/reusable-sync-secrets.test.mjs)が
  YAMLから`run:`本文を取り出し、同期スクリプトをスタブに差し替えて`bash -e`で実行する
  （`scripts/reusable-issue-labels.test.mjs`と同じ形）。
- 独自テーブルを持つのは、既読状態・お気に入り・クイックフィルタ・リポジトリの非表示など
  **GitHub側に存在しない情報だけ**。GitHubにある情報を二重に持たない。

## Prismaの`upsert`は「同時に2回来る」を吸収しない（#2154）

**複合ユニークキーに対する`upsert`はMySQLでは1文にならない。** PrismaはSELECTしてから
INSERTかUPDATEを選ぶため、同じキーへ同時に2本届くと**どちらも「無い」を見てINSERTへ進み、
片方が`P2002`（ユニーク制約違反）で落ちる**。実測で確認した（3本同時に投げて1本が500）。

同じキーへ複数の経路・複数のプロセスから書きうる受け口では、`upsert`を`try`で包み、
`P2002`を捕まえたら`update`へ回すこと（`lib/dispatch/session-artifacts.ts`の
`saveSessionArtifact`）。**`instanceof PrismaClientKnownRequestError`ではなく`code`で判定する**
——生成物の版が変わったときに静かに外れ、外れると「2回届いた方」が500として捨てられる。

**「同時に2回来る」は珍しくない。** セッションのフックは、issue-deck自身のworktreeでは
`--settings`（`run-issue-session.sh`）と`.claude/settings.json`（#1456）の両方に
`PostToolUse`が登録されており、1回の操作で2回走る。

## 画像・アーティファクトはVPSのローカルディスクに置く

- `POST /api/issues/images` … ログイン必須。`uploads/images/` へUUID名で保存する。
- `GET /api/issues/images/[filename]` … **認証を要求しない。** GitHub.com側のIssue画面からも
  画像を表示できるようにするため。代わりにUUID形式のファイル名だけを許可して、パストラバーサルと
  ファイルの列挙を防いでいる。
- `uploads/` は`.gitignore`済みで配布物にも含まれず、`deploy.yml` のクリーンアップ対象にも
  入っていないため本番で永続する。**`deploy.yml` の `rm -rf` の行に `uploads` を足すと
  ユーザーがアップロードした画像が消える。**
- **セッションが公開したアーティファクトも同じ置き場**（`uploads/artifacts/`。#2154）。
  受け取りは`POST /api/dispatch/sessions/artifact`（`DISPATCH_SECRET`。フックから）、配信は
  `GET /api/issues/artifacts/[id]`（**ログイン必須**——画像と違い、GitHub.com側から表示する
  必要が無い）。**claude.aiのページは`frame-ancestors 'self'`でiframeに入らない**ため、
  URLではなくHTMLの原本を運んで自分のオリジンから出し直している。
  組み立てとCSPは[`lib/artifact-document.ts`](../src/lib/artifact-document.ts)、保存と
  取り出しは[`lib/dispatch/session-artifacts.ts`](../src/lib/dispatch/session-artifacts.ts)。
  **中身はエージェントが書いた任意のHTML・JSなので、配信のCSPと画面のiframeの両方で
  `sandbox`し、`allow-same-origin`は付けない**（付けるとissue-deckのCookie・localStorageへ
  手が届く）。運用の全体像は
  [multi-agent/session-notify.md](multi-agent/session-notify.md)を参照。
- **入力欄（[`mention-textarea.tsx`](../src/components/dashboard/mention-textarea.tsx)）は、本文の
  末尾に連続する画像記法（`![alt](url)`だけの行）を「添付」として扱い、入力欄には出さずに
  サムネイルで横に並べる**（#1819）。呼び出し元へ渡す`value`は従来どおり画像記法込みの1本の
  文字列なので、下書きの保存も投稿も変わらない。**入力欄の表示と`value`がズレているのはここだけ**で、
  分解・合成は同ファイルの`splitAttachments` / `composeAttachments`が持つ。文章の途中に書かれた
  画像記法は本文の文字のまま残す（既存のIssue・コメントを編集で書き換えないため）。

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

**ラベル名の番号帯で「そのラベルをどう扱うか」を決める判定は
[`lib/issue-status.ts`](../src/lib/issue-status.ts)に集めてある。** 3つあり、用途が違うので
使い分ける。`isAttentionLabel`＝`00.`帯と`01.check-*`（一覧カードのラベル表示から外す）、
`isProgressLabel`＝それに廃止済みの`01.`〜`09.`ステップを足したもの（人が選ぶ対象から外す。
人が選べる範囲そのものは`lib/github/start-implementation.ts`の`isSelectableLabelName`が
実装オプション用ラベルも足して決める）、`isAutoAssignableLabelName`＝**Claudeがタイトルと
一緒に推定してよい範囲**（30〜89番台。71番台と番号プレフィックスの無いラベルを除く。#1662）。
推定の経路は「新しいIssueを作成」ダイアログの「タイトル・ラベルを付与」（＝タイトルが入っていれば
「付け直す」。#1884）が呼ぶ`POST /api/issues/suggest`だけで、
プロンプトの候補一覧・応答の後処理（[`lib/claude/issue-suggest.ts`](../src/lib/claude/issue-suggest.ts)）と
画面側のリセット範囲（`create-issue-dialog.tsx`の`mergeSuggestedLabels`）が同じ判定を通る。
どれか1つでもずれると、範囲外のラベルが付くか、人が選んだラベルが黙って消える。
**応答のラベル名は完全一致では突き合わせない**（`matchSuggestedLabels`・#1710）。候補一覧を
`- 30.bug: 不具合`の形で渡している以上、記号や説明が付いたまま返ることがあり、完全一致だけを
見ているとその場合にラベルが1つも付かない（タイトルだけが入った状態になる）。
理由は[multi-agent/labels.md](multi-agent/labels.md)「Claudeによるラベル自動付与の対象は30〜89番台に限る」。

**理由から「次にどこの何を押すか」を組み立てるのは
[`lib/github/check-user-guidance.ts`](../src/lib/github/check-user-guidance.ts)1か所**（#1663）。
Remote Controlを開くのか・対応PRをマージするのか・コメント欄の「承認」を押すのかは、理由
（`01.check-*`）と実行先（無人実行かローカルセッションか）で変わる。表示は
[`components/dashboard/check-user-reason-notice.tsx`](../src/components/dashboard/check-user-reason-notice.tsx)、
移動先の目印（`data-check-user-target`）と着地のハイライトは
[`lib/check-user-focus.ts`](../src/lib/check-user-focus.ts)。**idを使わないのは、PC版と
スマホ版の詳細が同時にDOMへ乗り、非表示側が選ばれてしまうため。**
Issue詳細の上部（`IssueStatusCard`）とコメント欄の承認カードの2か所へ**同じ内容を同じ体裁で**出す
（PC・スマホ共通）。

定型文やマーカーコメントを変更するときは、ワークフロー側のトリガー条件と対になっているため
両方を確認する。

**GitHub ProjectsでStatusを`Ready`から動かしても同じ`@claude`コメントが投稿される**（#991 Phase 3）。
起動するかどうかの判定は[`lib/github/project-status-dispatch.ts`](../src/lib/github/project-status-dispatch.ts)
に集約されており、ボタンとカンバンのドラッグが同じ関数を通る。ただし**コメントの投稿者は経路で
異なる**（ボタン＝操作した人間、ドラッグ＝issue-deckのApp）。ワークフローが投稿者のwrite権限を
検証するため、ドラッグ経路では`<!-- issue-deck:posted-by:<login> -->`で人間を復元させている。
`21.plan-required`ラベルがワークフローのmodeを決めるので、`Planning`へ動かすときはコメントより
先にラベルを書く。

## 画面の表示名を変えるときは、旧名を名指ししている記述を「置換」しない

このリポジトリのコメント・docsは、判定の母集団や自動更新の条件を**画面の表示名で説明している**
（「左メニューの『完了したPR』と同じ母集団」のように）。表示名を変えると、それらが画面に
無いものを指すようになるので、`grep -rn "<旧名>" src/ docs/`で全部引いてから直す。

**そのとき一括置換をかけない**（#2120）。「マージ待ち」への改名（旧「完了したPR」）で旧名を
引いたところ、`src/hooks/use-pull-requests.ts`・`src/lib/auto-refresh.ts`・
`src/components/dashboard/issue-deck-shell.tsx`・`docs/code-map.md`の「自動更新は『完了したPR』
ビューを表示している間だけ」が、**#1947（ヘッダーの「更新」ボタン廃止）の時点で既に事実と
違っていた**（実際はPR画面を開いている間ビューによらず回る）。名前だけ置換していれば、その
誤りが新しい名前で生き延びていた。旧名を名指ししている記述は「いま読んでも正しいか」を
確かめる単位として扱う。

例外は**出荷済みのリリースノート本文**（[`lib/changelog.ts`](../src/lib/changelog.ts)）。
公開済みの版の文面は書き換えない運用なので、一括置換をかけるならここだけ除外する。

## テスト

```bash
pnpm test        # lint + typecheck + vitest run
pnpm test:unit   # vitestのみ
```

**shadcn（Radix）の`Select`は、jsdomでそのままでは開けない**（#1733）。`hasPointerCapture`・
`setPointerCapture`・`releasePointerCapture`・`scrollIntoView`をテスト側で補ってから、
トリガーへ`keyDown`（`ArrowDown`）を送ると`role="option"`が出て`click`で選べる。補わないと
ドロップダウンが開かず、選択を伴う画面の挙動をテストできない（`create-issue-dialog.render.test.tsx`の
`stubPointerApisForSelect`が実装）。トリガーの表示値を読むだけなら
`getByRole("combobox", { name: ... })`の`textContent`で足り、補う必要は無い。

**`@testing-library/jest-dom`のマッチャは使えない**（#838）。パッケージは`devDependencies`に
入っているが、読み込むsetupファイルが無いため`toBeInTheDocument`・`toBeDisabled`は
`Invalid Chai property`で落ちる。存在は`toBeTruthy()`／`queryBy...`が`toBeNull()`、
無効判定は`getByRole<HTMLButtonElement>(...).disabled`で書く。

**Push通知（#838）の送信は、ローカルの偽Pushサービス相手に実際に流して確かめられる。**
`web-push`は**購読の`endpoint`のスキームに関わらずTLSで接続する**ので、受け口は`https`で立てる
必要がある（`http`で立てると`EPROTO ... wrong version number`になる）。自己署名証明書を作り、
`NODE_EXTRA_CA_CERTS=<cert.pem> pnpm dev`で開発サーバーを起こせば、`Content-Encoding: aes128gcm`と
`Authorization: vapid ...`が付いたPOSTが届くところまで見える。偽サービスに404/410を返させると、
失効した購読が`PushSubscription`から消えることも確認できる。

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

`.env.local.example` が一次情報源。DB・Supabase・GitHub App・Push通知の4系統に分かれる。

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
