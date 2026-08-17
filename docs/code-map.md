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
- `components/ui/` はshadcnの生成物なので、変更したい場合は生成物を直接編集せず
  ラップするコンポーネント側で対応する。
- **Issueの作成フォームは、ダイアログでも別ウィンドウでも
  [`create-issue-dialog.tsx`](../src/components/dashboard/create-issue-dialog.tsx)1つだけ**（#1728）。
  `presentation`（`dialog` / `window`）で外枠（見出し・フッター・オーバーレイの有無）だけを
  差し替え、項目・2ステップの流れ・作成後の動きは共通のまま使う。**別ウィンドウ用にフォームを
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
  **この2つに同じ値を両方出さない**のが分け方の要点（サマリーは読むだけ・編集は折りたたみ）。
  `IssueDetailSection`の開閉状態は`issue-detail.section.<id>`のlocalStorageで**セクションごとに1つ**
  持つため、PC・スマホで同じ`id`を使う（端末が違えばストレージも別で、同じ端末なら同じ設定が効く）。
  **積んだジョブの状態（`DispatchJobStatus`）はカードが出すので、`StartLocalSessionButton`へは
  `showJobStatus={false}`を渡す**（両方出すと「順番待ち」が同じ画面に2つ並ぶ）。
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
  （質問はIssue作成に続けて`@claude 質問: `コメントを投稿）だけ。**本文の内容から種別を
  自動判定してはいけない。** 誤判定は押した本人から見えないまま、質問のつもりの本文が実装
  Issueとして無人実行に乗る（逆もある）ため、押した時点で確定する形にしている。
  **横断質問（#1454）はここに混ぜず、
  [`cross-repo-question-dialog.tsx`](../src/components/dashboard/cross-repo-question-dialog.tsx)
  として独立した入口（ヘッダーの「横断質問」）に残す。** 回答するのがGitHub Actionsではなく
  サブPCの質問セッションで、リポジトリの絞り込み条件（ワークフロー不要）も実行先の選択も
  別物になるため。
- **そのダイアログは2ステップで、既定は「内容を書く」だけ**（#1605）。開いた直後に出るのは
  種別と本文の入力欄で、リポジトリ・タイトル・ラベル・担当者は画面に無い。「次へ」を押すと
  `POST /api/issues/quick-suggest`が本文からリポジトリ・タイトル・ラベルを決め、値が入った
  確認ステップ（＝従来のフォームそのもの）へ移る。ステップの初期値と遷移条件は
  [`lib/quick-issue.ts`](../src/lib/quick-issue.ts)（`resolveInitialQuickStep`・
  `canProceedFromInput`）。
  **確認を飛ばして作成する経路を作ってはいけない。** リポジトリを外したまま作ると、押した本人から
  見えないまま別リポジトリへIssueが立ち、そのリポジトリの無人実行の母集団に入る。**逆に、推定の
  失敗で作成を止めてもいけない**——トークン未設定（501）・生成失敗のときは値が空のまま確認
  ステップへ進む（入力ステップの「自分で入力する」も同じ行き先で、こちらはClaudeを呼ばない）。
  推定APIの中身は「Claudeでリポジトリを決める → そのリポジトリのラベルを取る →
  既存の`generateIssueSuggestion`でタイトル・ラベルを作る」の3段で、
  **ラベル候補がリポジトリごとに違うため1回のClaude呼び出しにまとめられない**。
  リポジトリの推定材料は[`lib/claude/repository-suggest.ts`](../src/lib/claude/repository-suggest.ts)が
  組み立てる「リポジトリ名＋直近のopen Issueのタイトル数件」で、`Repository`に`description`を
  足さずに済ませている。**タイトルはリポジトリごとに引く**（#1710）。全リポジトリ合算で
  更新の新しい順に読むと、Issueの多いリポジトリが枠を占め、材料の量の偏りがそのまま推定の
  偏りになる。**候補一覧に無いフルネームは採らない**（`pickSuggestedRepositories`）。
  **推定は1件に決め打ちせず、確からしい順に最大3件返す**（#1710）。確認ステップでは選択中の
  ものを先頭にしたチップとして並べ、1タップで選び直せる（`buildRepositoryChoices`・
  `selectableSuggestedRepositories`）。**リポジトリ別の画面から開いた場合も推定は行う**——
  画面が渡すのは「その画面を開いていた」という事実だけで、書いた内容が別のリポジトリの話で
  あることは普通に起きる。渡された値は選択状態のまま`表示中のリポジトリ`と示し、推定結果は
  候補として並べる。
  **入力ステップでもリポジトリだけは先に指定できる**（#1733）。既定は「自動で決める（内容から）」で、
  選ばなければ上記のまま何も変わらない。選んだときだけ`repositoryPinned`が立ち、**APIは
  リポジトリの推定（Claude 1回＋リポジトリごとのIssueタイトル取得）をまるごと省いて**
  タイトル・ラベルの生成へ直行する。確認ステップでは候補チップも`自動`／`表示中のリポジトリ`
  バッジも出さない——押しても変わらない候補や、本人が選んだ値に付く「自動」は、選んだ側から見ると
  自分の指定が効いていないようにしか読めない。**「人が選んだ」と「画面から渡された」を混ぜないこと**が
  この分岐の要で、画面側は`hasPickedRepository`、API側は`repositoryPinned`で区別する。
  選択肢の並びは入力ステップと確認ステップで共通（`RepositorySelectItems`）。
  **種別（Issue／質問）だけはこの自動化の対象外**で、上のとおり自動判定しない。
  Claudeが入れた値には`自動`バッジを出し、人が触った項目からは外す。**バッジは`Label`の外に置く**
  （中に入れるとアクセシブルネームが「タイトル自動」になり、項目名で引けなくなる）。
  **ラベルが1つも決まらなかったときは、その旨を画面に出す**（#1710）。空欄と「決められなかった」
  は見分けが付かず、ラベルの付かないIssueがそのまま作られていた。
- **入力ステップで本文テンプレートを選べる**（#1745。
  [`lib/issue-templates.ts`](../src/lib/issue-templates.ts)）。機能追加・改善／見た目・不具合の3種で、
  **入るのは見出しだけの骨組み**（説明文は入れない——消し忘れがそのままIssue本文に残る）。何を書くかは
  選択中のチップの下の1行（`hint`）で示す。種別ラベルの分布と実際のIssueの書き方から、
  「あるものを変える」（`51.improvement`・`62.design`）を1つにまとめ、「無いものを作る」（`50.feature`）と
  「意図どおり動かない」（`30.bug`・`40.unexpected`）を分けている。
  **入力欄は1つのまま**で、項目ごとに分ける形（GitHubのIssueフォーム風）にはしない——画像の貼り付け・
  `#123`の補完・下書きの自動保存・別ウィンドウへの引き継ぎ・推定APIへの本文渡しを項目ぶん作り直すことになり、
  得られるのは記入欄の見た目の差だけになる。
  **自分で書いた内容は黙って消さない。** 骨組みのまま（または空）なら確認せず入れ替え、書いた内容が
  あるときだけ置き換えの確認を出す（判定は`resolveTemplateChange`に寄せ、画面側は結果を状態へ移すだけ）。
  **「使わない」チップは置かず、選択中のチップの押し直しで外す**——4つ目を足すとスマホ幅（本文幅 約329px）で
  1行に収まらない。**骨組みのままでは「次へ」を押せない**（`isUnfilledTemplateBody`）。見出しだけを材料に
  推定させると、確認ステップに内容と関係の無いリポジトリ・タイトル・ラベルが並ぶ。
  **テンプレートは推定に渡さない**（`/api/issues/quick-suggest`は無変更）。本文に入る見出し自体が
  ラベル推定の手がかりになるため、APIとプロンプトを触る必要が無い。**種別が「質問」のときは出さない。**
- **ダイアログの中身が横幅を押し広げないよう、`DialogContent`は`grid-cols-[minmax(0,1fr)]`で
  列を止めてある**（#1710）。暗黙の`auto`トラックは最も長い中身に合わせて伸びるため、
  折り返さない長い文字列（畳んだ本文に出る画像URL等）が1つあるだけで列がその幅まで広がり、
  `w-full`の項目とフッターのボタンがまとめて画面外へ出る。スマホ幅で顕在化するが、
  原因は幅ではなく列の伸び方なので、幅の指定を足しても直らない。

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
- 画面の更新は別の話で、`hooks/use-issue-polling.ts` が10秒間隔で `/api/issues`（＝DB）を読み直す。
  ポーリングしてもGitHubには問い合わせないため、Webhookが届いていない変更はここでは拾えない。
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
- **左メニューに何をどの順で出すかは、ビューの一覧（`navViews`）とは別に持つ**（#1613。
  [`lib/nav-views.ts`](../src/lib/nav-views.ts)の`sidebarAttentionNavViews`・
  `sidebarQuestionNavViews`・`sidebarIssueNavViews`、
  [`lib/pull-request-views.ts`](../src/lib/pull-request-views.ts)の`sidebarPullRequestViews`）。
  `navViews`はスマホのスワイプ順と件数計算も見る配列なので、**そこから外すとURLごと消える**。
  左メニューから外した「最近追加した」「直近本番に反映した」「完了したPR」は
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
  - **左メニューの件数は確認済みも含めた総数のままで、色だけが変わる**（`NavCount`の
    `emphasis="unread"`＝数字の文字色）。塗りつぶしの丸（`emphasis="attention"`）は
    「人が動くまで進まないもの」（確認待ち・作業待ち）専用で、読めば済む質問を同じ強さで
    出すと、上から順に手を動かせば盤面が進むという並びの読み方が崩れる。件数の見た目は
    PC（`sidebar-nav.tsx`）とスマホ（`mobile-home-screen.tsx`）で共通の
    [`nav-count.tsx`](../src/components/dashboard/nav-count.tsx)に置く。
  - 総数と未確認の差は、手作業と同じく一覧のヘッダー（`3件・未確認1件`）で説明する。
- **手作業Issueが待っている相手の状況は、Issue詳細の手作業パネルの中に出す**（#1705。
  [`manual-step-prerequisites.tsx`](../src/components/dashboard/manual-step-prerequisites.tsx)）。
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
  取得コストは「対象リポジトリ数 + draft以外のopen PR数」回のAPI呼び出しで、母集団が広いぶん
  1回が重い。そのため**自動更新は「完了したPR」ビューを表示している間だけ**にしている
  （10秒間隔。それ以外のビューとPRペイン外は画面を開いたときと手動更新のみ。
  `hooks/use-pull-requests.ts`。#1531）。**ブランチ画面で自動更新を有効にしている間は、
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
  check-runを付ける。とくに`claude-review-develop.yml`は**CIの完了を待ってからレビューし、
  通ったらマージする**ワークフローなので、`wait-for-ci` → `risk-check` → `claude-review` →
  `auto-merge`のいずれかがPRの開いている間ずっと実行中で、**自動マージされるPRは一度も
  「CI通過」を表示できなかった**。CIが終わってから詳細画面の更新ボタンを押しても「CI実行中」の
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
  一覧に出すビューはPCの左メニュー（`sidebarIssueNavViews`）と揃える。外しているのは
  「直近本番に反映した」だけで（「本番反映待ち」は左メニューへ戻した#1743にあわせてこちらにも出す）、
  **既存のURLからはそのビューでも開かれうる**ため、現在のビューが一覧に無いときだけ末尾へ足す
  （足さないと選択中の表示もスワイプ移動先も失われる）。絞り込みが効いているかは色と件数バッジで示し、数えるのは件数を減らす条件だけ
  （[`lib/issue-filter-summary.ts`](../src/lib/issue-filter-summary.ts)）。並び順・グルーピングは
  同じシートにあっても数えない。
- **スマホのフッターは「ホーム／Issue／PR／ブランチ」で、タブのidは`mscreen`の値そのもの**
  （#1436・#1638）。「Issue」タブのidが`repos`なのはそのためで、開くのはリポジトリ一覧
  （→リポジトリ別Issue一覧）。
  全リポジトリ横断のIssue一覧（`mscreen=issues`）はフッターから外し、ホームの「いまの状況」の
  カードとメニューからのドリルダウンだけにした（#1690。点灯するタブはホーム。判定は
  [`lib/mobile-nav-tab.ts`](../src/lib/mobile-nav-tab.ts)）。
  **4枠目は#1638で「設定」から「ブランチ」へ入れ替えた。** ブランチは日常的に開くのにホームから
  1段掘る必要があり（#1455）、設定は毎日押すものではない。**5つに増やさない**のは1タブあたりが
  98px→78pxまで詰まるためで、設定はホームのヘッダー右上（`mobile-home-screen.tsx`の歯車→
  `selectSettings`）へ移した。`mscreen=settings`のURLはそのまま生きており、その画面では
  `resolveBottomNavTab`が`null`を返して**どのタブも点灯させない**。**PRタブから開くときの
  ビューは`in-progress`で、`DEFAULT_PULL_REQUEST_VIEW`（`all`）は変えていない。** 既定を`all`に
  しているのは画面内リンクからマージ済みPRを直接開く経路（#1260）のためで、そこを`in-progress`に
  すると開いたPRが一覧の母集団から外れる。画面内のタブでのビュー切り替えはIssue一覧のタブと
  同じく履歴を積まない（`selectPullRequestView`）。
- **PRの状態別ビューは3つあるが、左メニューに出すのは「すべてのPR」「実行中」の2つ**（#1312・
  #1613）。ビュー定義は[`lib/pull-request-views.ts`](../src/lib/pull-request-views.ts)、判定は
  [`lib/pull-request-list.ts`](../src/lib/pull-request-list.ts)の`filterPullRequestsByView`。
  **どのビューもopenなPRだけを出す。**「実行中」（CI待ち・ドラフト・CI状態不明）と「完了したPR」
  （CIがsuccess/failure）は**同じopen取得の結果をクライアント側で絞るだけ**なので、切り替えても
  GitHub APIを叩き直さない。「完了したPR」は左メニューから外したが`prview=completed`のURLは
  生きており、10秒ごとの自動更新（#1531）もそのまま。並び順は「すべてのPR」だけ更新が新しい順で、
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
  **「処理中」「完了」ビューの一覧はopenのPRしか持たないのに、画面内のリンクからはマージ済み・
  クローズ済みのPRも開けるため**（#1260）、一覧の項目が無い経路でもヘッダーを描けるようにしている。
  一覧・詳細の両方が[`lib/github/pull-request-summary.ts`](../src/lib/github/pull-request-summary.ts)
  の`toPullRequestSummary`で同じ形に揃える。
  **両方あるときは`fetchedAt`が新しい方を使う**（#1578。`issue-deck-shell.tsx`の
  `selectedPullRequest`）。一覧を無条件に優先していたころは、詳細ヘッダーの更新ボタンが
  詳細しか取り直さない（一覧は「完了したPR」ビューを見ている間しか自動更新されない）ため、
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
  初回に自動で開くのは**手が要るものだけ**（CI失敗・ユーザーのマージ待ち・リリース中。
  `BranchFlowRepositorySummary`）で、以降の再取得ではユーザーの開閉を上書きしない。
  **展開した中身は「バージョンへ何が合流したか」の流れ図**（#1510）。`main`と`develop`の
  2本の縦レールに対し、**横線1本がリリース（develop→mainのマージ）**で、その下にぶら下がる枝が
  その版に乗った変更になる（`BranchFlowReleaseGroup`）。既定で出すのは**次のリリースに乗る分まで**
  （未リリースの束＋まだdevelopへ向かっているレーン）で、本番へ出た版の束と「どの版で出たか
  特定できないレーン」は「リリース済みのバージョンを表示」で開く（#1586。#1510当初は
  ひとつ前の版まで出していたが、済んだ変更が「次に何が出るか」を押し下げていた）。
  **畳んだぶんに残る未完了の手作業（`71.manual-step`）だけは束の外へ出して常に見せる**——
  版が出た後も残る作業で、畳んだ束と一緒に隠すと画面のどこにも現れなくなるため。
  同じ理由で、畳んだリポジトリ行にも件数（`BranchFlowRepositorySummary.openManualStepCount`）を
  出す。**ただし初回に自動で開く条件には加えない**（手作業はこの画面で押すものではない）。
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
  流れ図が下へ押し出される。残りはリポジトリごとのボタンで開き、件数は見出しと畳んだ1行（「予定◯」）に出す。
  **手が要るものではないので、初回に自動で開く条件（`needsAttention`）には加えない。**
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
  束の見出しと畳んだ1行に出す（デプロイ中・失敗のリポジトリは初回に自動で開く）。
  取得は専用の軽いエンドポイント`GET /api/branch-flow/deploy`（mainブランチの`deploy.yml`の
  最新run 1件。`fetchLatestDeployWorkflowRun`）で、**リリース用workflowを持つリポジトリだけ**を
  対象にする。判定（`lib/branch-flow.ts`の`resolveDeployState`）は**直近のリリースPRのマージ時刻と
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
  起動時刻は端末のlocalStorageへ置き、判定は[`lib/release-trigger-guard.ts`](../src/lib/release-trigger-guard.ts)。
  **10分で失効させる**のは、workflowが失敗してバンプPRが1本も作られなかったときにボタンが
  二度と押せなくなるのを防ぐため。サーバー側に押下を記録しないのは、問い合わせるとこの画面の
  前提（取得を増やさない）が崩れるから。
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
  リポジトリあたりREST 2回（ETagで304なら消費0）＋draft以外のopen PRあたりGraphQL 1回で、
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
  リリースのマージ待ち・失敗／`00.check-user`／マージ待ちPR（左メニューの「完了したPR」と同じ
  母集団）／`71.manual-step`の4区分。
  - **判定は[`lib/notifications.ts`](../src/lib/notifications.ts)（純粋関数）に閉じ、新しい基準を
    作らない。** 文言・トーンは既存の`describeReleaseStatusBadge`・`CHECK_USER_REASON_TEXT`・
    `filterPullRequestsByView`・`computeManualStepReadiness`から得る。ここで独自判定を書くと、
    同じ状態が画面ごとに別の言葉で出る。
  - **`71.manual-step`は前提条件が満たされたものだけを出す**（#1801。判定は左メニューの
    「ユーザーの作業待ち」と同じ`computeManualStepReadiness`）。先行する変更が本番へ出るまで
    実行できない手作業まで並べると、ベルが「いま人が動けば盤面が進むもの」の集まりでなくなり、
    件数バッジも左メニューの件数（`actionable`だけを数える。#1763）と食い違う。前提待ちの
    手作業は「ユーザーの作業待ち」ビューに橙の時計付きで残るので、見えなくなるわけではない。
  - **追加のGitHub API消費はゼロ。** Issue・PRは`IssueDeckShell`が既に取得済みのものを受け取り、
    リリース状況はロケットが使っていた`useRepositoryReleaseStatuses`をそのまま引き継ぐ。
    **材料を用意するのは`NotificationProvider`だけ**（#1772。
    [`components/dashboard/notification-state.tsx`](../src/components/dashboard/notification-state.tsx)）。
    ベルを置く場所がPCの1か所ではなくなったため、各ボタンが自分でフックを呼ぶとポーリングが
    増える——PCのトップバーは`hidden md:flex`でCSSで隠れているだけで、スマホでもmountされたまま
    だからで、どちらのレイアウトかはJS側から判別できない。
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
  `run-issue-session.sh`の`--continue`で前回の会話の続きから再開できる）。**猶予待ちのセッションには
  「あと何分で畳むか」を状態ファイル（`.reap`）へ残し、pollerが`DispatchSession.reapAt`として
  運ぶ**（#1817。画面の文言は`lib/dispatch/issue-session.ts`の`describeSessionReap`。
  **判定を画面側へ写さない**——worktreeがcleanか・push済みかはホストにしか無く、写すと必ずずれて
  終わらないセッションに終了予告が出る）。**横断質問セッションは
  質問IssueがOPENのままでも放置で畳む**（#1648。猶予は`QUESTION_SESSION_IDLE_MINUTES`。
  こちらはcwdが質問Issue間で共有されるため会話を引き継がない）。設計は
  [multi-agent/local-quick-start.md](multi-agent/local-quick-start.md)。
- **worktreeの掃除も同じ1巡に相乗りさせる**（#1716）。pollerは`WORKTREE_CLEANUP_INTERVAL_MINUTES`
  （既定60分・0で無効）の間隔で`scripts/cleanup-worktrees.sh --yes`を呼ぶ。**足りなかったのは
  判定ではなく起点**で、スクリプトは#1100からあったのに実行の起点がどこにも無く、3日で181本・38GB
  溜まってルートFSが77%に達した。無人で回すための安全弁が2つあり、(1)起動の準備から30分が
  経っていないworktreeは触らない（`--min-age-minutes`。`start-issue.sh`が作ってからセッションの
  プロセスが立つまでの数分間は削除条件をすべて満たしてしまうため）、(2)残すworktreeの`.next`は
  消す（ビルド成果物で作り直せる。実測で163本が`.next/dev`だけで16GB）。設計は
  [multi-agent/branching.md](multi-agent/branching.md)「掃除を回す起点」。
- **開発サーバーの回収は在庫を2通り持つ**（#1525）。PIDファイル（`.dev-servers/issue-<番号>.pid`）
  だけを見ていると、エージェントが手で起こし直した2本目は載らないため存在自体が見えない。
  `scripts/reap-dev-servers.sh`は`/proc`も走査し、動いているプロセスから入る経路を併せ持つ。
  **プロセスの特定はコマンドラインの部分一致で行わない**——`claude`はプロンプト全文をargvに持ち、
  Issue本文の`next-server`という記述に`grep`が当たった実績がある（#1523）。判定は
  `scripts/lib/dev-server.sh`の`dev_server_is_dev_command`（`/proc/<pid>/cmdline`をNUL区切りで
  読み、argvの位置で見る）。**systemd timerは新設していない**（周期ではなく在庫の問題なので、
  足すと同じ役が2つになる）。
- **走っているセッション同士の関係を見るのは`scripts/fleet-status.sh`**（#1215）。tmux（一次情報源）・
  worktreeの分岐元SHA・未マージPRの変更ファイルを突き合わせ、**同じファイルを触っている組**を出す。
  既定は人が読む表、`--json`はプロンプトへの差し込み用。整形と重なりの判定は
  `scripts/lib/fleet-status.sh`の純粋関数にあり、tmux・gh・gitを叩くのは入口だけなので、
  出力を固定したfixtureで検証できる（`src/lib/fleet-status.test.ts`）。**LLMを使わず、
  画面（`capture-pane`）も読まない計器**で、判断はしない。計画が前提としたSHAからの変化を見せる
  `scripts/lib/plan-base.sh`（`<!-- plan-base: <SHA> -->`。**止めず、見せるだけ**）と対で、
  設計は[multi-agent/gates.md](multi-agent/gates.md)。
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
推定の経路は「新しいIssueを作成」ダイアログの「タイトル・ラベルを自動生成」と、その2ステップ化で
足された`POST /api/issues/quick-suggest`で、
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
