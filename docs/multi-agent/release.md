# Phase 6: develop→mainのリリースフロー自動化

バージョンbump PRとdevelop→mainのリリースPR作成の自動化。実際のマージは人間が行う。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)


`.github/workflows/release-develop-to-main.yml`で実装済み（issue #55）。release-to-mainスキル
（`.claude/skills/release-to-main/SKILL.md`）が定める手順のうち、「1. バージョンを上げる」
「2. developへの反映（フィーチャーブランチ+PR）」「3. develop→mainのPRを作成する」までを
自動化する。手順4（実際のマージ、マージコミット必須）はCLAUDE.mdの自動マージ不可カテゴリ
（`develop`→`main`のマージ）に該当するため、これまでどおり人間が手動で行う。

## 状態判定

他に状態を保持せず、develop/mainそれぞれの`package.json`の`version`フィールドの比較だけで
判定する。

- **main版 == develop版**（まだ何もバンプしていない）: developとmainに差分があれば、
  develop向けのバージョンbump PRが無いことを確認したうえで新規に作成する。
- **main版 != develop版**（バンプPRが既にdevelopへマージ済み）: develop→mainのPRが無いことを
  確認したうえで新規に作成する。

## リリース内容は固定ブランチで凍結する（#2117）

**develop→mainのPRのheadは`develop`ではなく`release-main/vX.Y.Z`。** PRのheadは常にそのブランチ
の先端を追うため、`develop`をheadにすると**PRを作った後にdevelopへマージされた変更まで同じ
リリースでmainへ出る**。それらは更新履歴（`RELEASE_CHANGELOG`）にも対象issue一覧にも載って
いないため、「何が本番へ出たのか」がPRの内容と食い違う。内容を止めるには固定したrefが要る。

### 凍結点はバンプPRのhead（`$GITHUB_SHA^2`）

バンプPRを作るrun（T0）と、そのマージのpushで起きるdevelop→mainのPRを作るrun（T1）は別のrun
（`need_bump`と`need_main_pr`は排他）。**更新履歴・上げ幅はT0の`git diff origin/main
origin/develop`から作られ、バンプブランチもT0のdevelopから切られる。** T1のdevelop先端で凍結
すると、T0〜T1のあいだにdevelopへ入った変更（バンプPRのCI待ちのあいだにマージされたもの）が
更新履歴に載らないまま入ってしまう。

T1のpushイベントの`$GITHUB_SHA`はバンプPRのマージコミットで、**その第2親がバンプブランチの先端
＝T0のdevelop＋版上げ**にあたる。ここで凍結すると、更新履歴・対象issue一覧・mainへ出る内容の
3つが同じ時点を指す。

第2親が無い場合（squashマージ・`workflow_dispatch`での手動起動）と、そのコミットのバージョンが
developのバージョンと一致しない場合（`package.json`を変えた別のpushで起動した場合）は
`origin/develop`へフォールバックする。

### 対象一覧はプルリクエストが主、issueは従（#2774）

**リリースの中身の単位はプルリクエストで、issueはそこから導出する。** リリースPR・バンプPRの
本文には`## 対象プルリクエスト`と`## 対象issue`の2つの節が並び、前者が主。

| | 何を表すか | どう作るか |
| --- | --- | --- |
| プルリクエスト | 本番へ出る実装のまとまり | `origin/main..<凍結点>`の`git log --first-parent --merges` |
| issue | その実装がどの依頼に応えたか | 各PRのブランチ名`issue-<番号>`から導出し、openなものだけ残す |

**この作り方はgitだけで閉じており、外部への問い合わせが1回も要らない。** 以前はissue-deckの
`GET /api/progress?status=develop,release`で`Develop`・`Release`にいるissueを引いていたが、
盤面が1,600件を超えて1回の問い合わせに約40秒かかるようになり、呼び出し側の`curl -m 20`が必ず
時間切れになって一覧が丸ごと落ちていた（PR本文に「issue-deckへ問い合わせできず…HTTP 000」だけが
残る形。#2715・#2689のパターン3でIssueがopenのまま取り残された）。問い合わせ自体は#2774で
リポジトリ単位のGraphQLに変えて1秒未満になったが、**リリースPRの一覧はそもそも問い合わせない**。

Project Statusで探すのをやめたことで、T0〜T1のあいだにdevelopへ入ったissueが混ざる問題
（#2117でバンプPR本文からの引き継ぎで回避していたもの）も消える。凍結点`$GITHUB_SHA^2`は
「リリース対象のプルリクエストとissueを特定する」ステップが求め、PR作成ステップへ`freeze_sha`
として渡す（2か所で計算すると一覧と凍結内容が食い違うため）。

**書式は#2774以前と同じ。** `## 対象issue`の`- #<番号> <タイトル>`は`main-pr-merged`・
`release-verification.ts`・issue-deckの定期巡回が読む契約で、変えていない。
`## 対象プルリクエスト`の行は`- #<PR番号> <タイトル>（Issue #<番号>）`（バンプPRは
`（バージョンバンプ）`）。

マージコミットが無いリポジトリ（squashマージ運用）は件名の`(#番号)`からPR番号だけを拾い、
それも拾えなければ従来どおりバンプPRからの引き継ぎ→issue-deckへの問い合わせへ落ちる。

### 進捗の遷移とcloseの対象

- `main-pr-in-progress`（`Develop` → `Release`）は`opened`の1回だけが実質の掃き寄せになる。
  headが動かないので`synchronize`は発火しない。**リリースPRの作成後にdevelopへ入ったissueは
  `Develop`のまま残り、次のリリースで`Release`へ進む**（それがmainへ出る内容と一致する）。
- `main-pr-merged`（`Done`＋close）の対象は**リリースPR本文の`## 対象issue`に載った番号**。
  Project Statusで探すと、リリースに含まれないissueまで`Develop`として拾ってcloseしてしまう。
  `## 対象issue`が空なら、次に`## 対象プルリクエスト`の`（Issue #<番号>）`を見る（#2774。
  どちらも凍結範囲から作られているため、Statusより先に見てよい）。両方から1件も取れなかった
  場合だけ、従来どおり`Develop`/`Release`のStatusで探す（#2117以前のPR・手で作ったPR・
  PR作成時にissue-deckへ問い合わせできなかった場合の安全網）。

### リリースPRを出した後の修正は、バンプから作り直す（#3014）

`release-main/vX.Y.Z`はマージ時に自動削除される（`delete_branch_on_merge`）。そこへ直接修正を
pushすると、修正がmainにだけ残りdevelopから消え、次のリリースで巻き戻る。そのため自動修復
（`reusable-claude-pr-repair.yml`）は、headがこのブランチのとき修正の行き先（`FIX_BASE_REF`）を
`develop`にして**develop向けのPRとして出す**。人が見つけた修正も同じで、Issue→developのPRで入れる。

修正はリリースPR自体には反映されないので、developへ取り込んだうえで**issue-deckの「修正を入れて
作り直す」**を押す（PCの「ブランチ」画面の版の見出し／スマホのリリースシート。リリースPRが
開いている間だけ出る）。押すと次の順に進む。

1. `POST /api/repositories/release/rebuild`がリリースPRへ理由のコメントを残してcloseし、
   凍結ブランチを消してからリリースworkflowを起動する。**閉じてから起動する**——先に起動すると
   状態判定が「リリースPRが開いている」と見てスキップすることがある
2. workflowの状態判定は、`main版 != develop版`でリリースPRが無い**手動起動**のうち、developの版を
   作ったバンプPRのマージ（件名`Merge pull request #N from <owner>/release/vX.Y.Z`）の後に
   developへコミットが入っているものを**作り直し**と見て`need_bump`にする（`rebuild_from`に
   そのマージコミットを渡す）。後に何も入っていなければ従来どおりリリースPRだけを作る
3. バンプのステップが**mainへ出ていないバンプのマージを新しい順に全部**`git revert -m 1`で取り消し
   （更新履歴・`.github/release-notes.md`がバンプ前へ戻る）、そのうえで通常どおりバンプする。
   **作り直しを繰り返すとバンプは1回分とは限らない**（#4335。`release/v8.50.0`→`release/v8.50.1`と
   積まれた状態で直前の1回だけを戻すと8.50.0が残り、main 8.49.0と一致せず止まっていた）。対象は
   `origin/main..origin/develop`の本流（first-parent）上の`release/v*`のマージ（`rebuild_reverts`）で、
   本番へ出た版とタグには触れず、実装の変更はそのまま残る。全部戻してもmainと一致しないのは
   バンプPR以外で版を書き換えたコミットがあるときで、そのコミットを示して止める。上げ幅・
   更新履歴・使い方・対象一覧は修正込みの差分から作り直される。**版ファイルだけは取り消す版の
   まま据え置く**——上げ幅を引数に取るbump-command（signalyの`bump_version.py "$BUMP_KIND"`）は
   ファイル上の版から上げるため、mainの版へ戻すと次の繰り上げと結果が一致しない
4. **版は必ず取り消した版より上にする**（判定がv6.4.0でもv6.4.1。そのときはbump-commandへ
   `BUMP_KIND=patch`を渡し、判断根拠には判定どおりの上げ幅を残す）。同じ番号にすると差し引きで
   `package.json`が変わらず、バンプPRのマージが`push`（`paths: package.json`）を起こさないため、
   リリースPRが作られないまま止まる。取り消した版はタグも無く本番へ出ていないので欠番にしてよい

**画面の可否は目安で、判定の正はworkflow側。** 画面はリリースPRのheadとdevelopのcompareで
「後に入った変更」を出し、0件なら押せなくする。**その範囲にはバンプPR自身のマージ
コミットが必ず1件含まれる**（凍結点はバンプPRのhead＝マージの第2親）ので、バンプPR・リリースPRの
マージは数えない（`buildRebuildCandidate`）。数えると常に「変更あり」になる。ダイアログを開いたときに1回だけ取る
（「ブランチ」画面は追加のGitHub API取得をしない前提のため）。

制約:

- **作り直せるのはheadが`release-main/v…`のリリースPRだけ。** head=`develop`の旧世代のPRで
  ブランチを消すとdevelopが消えるため、画面にも出さず受け口でも弾く
- **参照タグが古い配布先では作り直しにならない。** 旧workflowは手動起動でもリリースPRを
  作るだけなので、修正は入るが更新履歴はバンプ時のままになる（今までの「閉じて起動し直す」と同じ）
- **バンプ後に更新履歴ファイルを手で直していると、取り消しが衝突して失敗する。** 失敗は
  リリース画面の「リリース準備に失敗しました」に出る（下記）。衝突したファイルをdevelopで戻してから
  「再開」で起動し直す（リリースPRは閉じたままなので、手動起動は同じ作り直しになる）
- 手でリリースPRを閉じて「リリースする」を押した場合も、後に変更があれば作り直しになる

**PRを選んで作り直す（#4335）。** 対応したリポジトリでは、上の手順の1〜2の代わりに、元の候補へ
選んだPRのマージ差分だけを足した状態からバンプする（元の候補は後継のリリースPRを作れてから閉じる）。
仕組み・検証・失敗時の扱いは[release-verification.md](release-verification.md)「PRを選んだ作り直し」を参照。

**ファイル差分0件の修正でも、祖先関係が要るなら取り込む（#4452）。** 選んだ修正（`cherry-pick -m 1`）が空になるのは
「内容が取り込み済み」と「mainの祖先を取り込むだけの修正」の2通りで、後者は元の候補とmainの競合を解く。空になったら
`origin/main`のうち候補に無く修正が祖先に持つコミットを調べ、無ければ「内容も履歴も取り込み済み」で止める（従来どおり
選択から外す）。あれば、その先端だけを第2親に`git merge -s ours --no-ff`で足す。**修正のマージコミットは足さない**
（選んでいないdevelopの履歴まで祖先になり、mainへのマージで未選択PRの変更が落ちる）。足す前に、履歴が運ぶmain側の変更
ファイルが修正と候補で同じ内容であることを確かめ、違えば`-s ours`でmainの変更を捨てるため止める。足した後の差分は0件・
新しい祖先はmain側だけであることも確かめる。このとき**内容の変わらない後継候補を作ってよい**のは、この履歴修復の場合だけ
（コード変更・空PRは足さない）。新しい候補は通常どおり新しいbase/headで統合検証・全体レビュー・CIを通し、旧候補の合格は流用しない。

**作り直しの履歴は、リリース作成中だけ表示・保持する（#4420）。** 履歴（`ReleaseRebuildEvent`）の保存・表示は
リポジトリ名で引く全リポジトリ共通の処理で、完了の判定と削除も共通。完了＝`main`へマージ済みのリリースPR
（`release-main/v*`）。iOSアプリのあるリポジトリ（`webview-ios-repos.ts`）は、そのマージコミットへTestFlight配布
済みタグ（`ios-testflight/<ビルド番号>`）が付くまで完了にしない（更新不要でタグが付かない版は、後の版の配布で
まとめて完了になる）。判定はサブPCのpollerが`POST /api/repositories/release/rebuild-history/sweep`を巡回して行い、
完了したリリースPR番号を`ReleaseRebuildHistoryCutoff`へ記録する。**境界以下の経過は表示せず、イベントも削除する**
（既に完了済みの分も次の巡回で消える）。完了したリリースPRは、main向けのclosed PRを番号の降順に1ページ100件で遡って探す。作り直しで閉じた候補がclosed PRに積もり、直近30件だけでは古い完了リリースへ届かず履歴が残り続けたため（#4474）。遡るのは、完了したリリースPRが見つかるか、残っている履歴の最小の元候補番号（それより古いリリースはどの経過も完了にできない）に達するまでで、上限は10ページ。`ReleaseFixSeries`は別機能が使うので消さず、境界で「操作経路不明」の補完だけを
止める。後継候補が境界を超えている作成中の経過・新しいリリースの経過は対象外。失敗・停止中の履歴は完了まで残る。

### リリース準備の失敗は、Issueではなくリリース画面に出す（#4335）

`release`ジョブが失敗すると、`notify-failure`は**run番号だけ**を`POST /api/dispatch/release-preparation`
（`action=failed`）へ送る。issue-deckはGitHubからrun・ジョブ・ログを取り直し、失敗した工程と
`##[error]`の行（機密除去済み）を`ReleasePreparationFailure`に記録する。リリース画面（PCのブランチ
画面・スマホのリリースシート）には「リリース準備に失敗しました」として、工程・エラー・実行ログ・
次の操作・「再開」（同じ上げ幅で起動し直す）が出る。

- **個別Issueへ`00.check-user`を付けない。** 以前はDevelop・ReleaseにいるIssue全件へ`00.check-user`＋
  `01.check-blocked`を付け、他の理由ラベルまで外していた。共通処理1件の失敗で全件が確認待ちになり、
  本当に人の判断を待つIssueと区別できなかった。Issueは本番反映待ちのまま保つ
- **原因を推測で案内しない。** 以前の通知が毎回添えていた「GitHub Actions側の障害の場合があります」は
  根拠が無いので出さない
- 準備が進んだrun（バンプPRかリリースPRを作れた）は`notify-prepared`が`action=prepared`で報告し、
  未解決の失敗を解決にする。同時に、**旧`notify-failure`が付けたと確認できるラベルだけ**を外す
  （`releaseFailureDerivedLabels`）。外すのは「`00.check-user`の最後の付与がbotで、同じ時刻帯にbotが
  リリース失敗の通知コメントを投稿している」「理由ラベルが`01.check-blocked`だけ」のときに限る。
  別の質問・承認で付け直されたもの、由来の分からないものは外さない
- 配布先は参照タグを上げるまで旧`notify-failure`のまま（ラベルを付ける）
- **解決は`notify-prepared`だけに依存しない**（#4450）。競合修復済みの候補など別経路で本番公開された場合に
  古い失敗が残らないよう、`reconcileReleasePreparationFailures`が、**失敗の記録より後にmainへマージされた
  `release-main/v*`のリリースPR**を証跡に`open`→`resolved`へ倒す（`resolvedRunUrl`にそのPR）。再照合は
  リリース表示の`GET /api/repositories/release/preparation`と、pollerが叩く`rebuild-history/sweep`の2経路。
  バージョン番号は使わない（同一バージョンの候補が複数あっても取り違えない）。作り直し由来の失敗は元候補以降の
  番号のPRに限る。GitHubを取得できないときは解決しない。限界: 失敗後にそれと無関係な候補がマージされた場合も
  解決になる（時刻が根拠のため）。記録は削除しない（保持・削除は従来方針で、#4420の履歴削除とは別）

### 準備中・準備失敗の間は「リリースする」を灰色にする（#4421）

`canTriggerRelease`はopenなリリースPR・バンプPRの有無しか見ず、作り直し（元のリリースPRを閉じてから
バンプPRが出るまで）のPRが0件の間も押せた。ブランチ画面は`GET /api/repositories/release/preparation`
（DBのみ。失敗の帯と同じ取得を`useReleasePreparation`で共有）の`failure`・`activeFixSeriesStatuses`から
`resolveReleasePrepState`（`src/lib/release-prep-state.ts`）で`idle`/`running`/`failed`を決め、
**押せる状態のときだけ**`release-preparing`（「リリース準備中」＋自動実行の案内）・
`preparation-failed`（帯の「再開」へ誘導。待機とは案内しない）を重ねる。

- **完全には無効にしない。** 見た目は灰色だが押せ、確認ダイアログのチェック後に起動できる（判定が外れても
  人が抜けられる。本番デプロイ失敗時の「修正リリース」と同じ作り）。個別ボタン・スマホのリリースシート・
  一括リリース（確認ダイアログの行ごとに準備状況を取り、準備中・失敗の行を含むときだけチェックを要求）で共通
- `running`は`ReleaseFixSeries`が`fix_merged`・`rebuilding`のとき。`fix-series` APIはリリースPR番号で引くため、
  元PRが閉じられた区間では使えず、リポジトリ単位で引く
- **本番マージ直後〜CI開始前の純粋な待機は記録が無く、`idle`になる。** 推測で「実行中」とは出さない（#4526）

**作り直しの前提になる「自動修復のPRをdevelopへ入れる」は自動では進まない**（#2230）。
`reusable-claude-review-develop.yml`の`identify-issue`は対応Issue番号をブランチ名
`issue-<番号>`からしか特定せず、自動修復が作る`pr-repair/<対象PR番号>-<run_id>`では番号が
空になる。その結果、最後の`auto-merge`ジョブが「対応Issue番号を特定できないため、自動マージを
スキップします。」で終わる。人がマージするのは設計どおりだが、**気づく手がかりは対象PRへ
投稿されるコメント1件しか無い。** 実際に#2230では、CIグリーン・コンフリクト無しの修復PRが
18時間openのまま放置され、そのあいだ`main`は`4.31.0`・`develop`は`4.32.0`で本番デプロイが
止まっていた。自動修復を起動したら、修復PRがdevelopへ入ったかまで見届けること。

**`deploy.yml`の実行履歴から診断しない。** `deploy.yml`は`main`へのpushでしか走らないため、
リリースPRが止まっている間は「直近すべて成功」に見え、本番も動いたままになる。見るべきは
`main`と`develop`の`package.json`のversion差と、base=mainのopenなPRのCI状態。

**気づく手がかりとしてPush通知が飛ぶ**（#2376）。`main`宛のリリースPRが「人が押す番」（CIが
終わっていて自動マージ可否の判定も走っていない）で残っていると、サブPCのpollerが叩く巡回
（`POST /api/repositories/release-merge-push-sweep`）がPush通知を出す。マージされないあいだは
既定6時間ごとに鳴り直す。**修復PR（`pr-repair/*`→develop）そのものは対象ではない**——通知が
出ているのは常に`main`宛のPRについてで、修復PRが止まっていることはその結果として現れる。
設計は[../code-map.md](../code-map.md)の「本番へのマージ待ちもPush通知で届く」。


### 本番マージ直後でも、時刻を理由に開始を止めない（#4599）

新しいリリース準備は**利用者の明示操作（`workflow_dispatch`）だけで始める**。本番(main)へのリリースPRを
マージした直後でも、未リリースの変更があり、openなPR・準備の失敗記録・進行中の修正系列が無ければ開始できる。
時刻（直近のmainマージからの経過）から「自動処理待ち」「実行中」を推定しない。かつて#4526で入れた
`awaiting-automation`・`isAwaitingReleaseAutomation`は、scheduleが次のバンプPRを出すまでの空白を埋める
推定だったため、scheduleの廃止とあわせて撤廃した。押せない理由は`release-preparing`（修正系列の記録）・
`preparation-failed`（失敗の記録）・`preparation-unknown`（記録を取得できていない）など、実状態のものだけ。

### ブランチ名を変えるときに揃える場所

`release/v`（バンプPR）と接頭辞が重ならない名前にしてある。重なると`classifyPullRequest`の判定順
でリリースPRが`version-bump`に落ちる。

| 場所 | 何をしているか |
|---|---|
| `reusable-release-develop-to-main.yml` | 凍結ブランチのpushとPR作成、既存リリースPRの検出 |
| `reusable-issue-labels.yml` | `main-pr-in-progress`・`main-pr-merged`のhead条件 |
| `reusable-claude-pr-repair.yml` | `FIX_BASE_REF`を`develop`に倒すcase |
| `src/lib/pull-request-list.ts` | `RELEASE_BRANCH_PREFIX`・`isReleaseHeadRef`・`classifyPullRequest` |
| `src/lib/release-branch.ts` | 候補ブランチの判定（旧方式`release-main/v*`・新方式`release-rc/<番号>`。#4495） |
| `src/app/api/repositories/release/rebuild/route.ts` | 作り直しで閉じてよい凍結ブランチの判定（#3014） |
| `src/lib/release-rebuild.ts` | 「後に入った変更」からバンプPR・リリースPRを除く判定 |

**head=`develop`の判定はどこにも残してある。** 共有ワークフローの参照タグが古いリポジトリでは
まだ`develop`をheadにしたリリースPRが作られるため、混在しても壊れないようにしている。

## バージョンを上げ忘れたまま main へ入るのを防ぐ（#1367）

`deploy.yml`の`tag`ジョブは`package.json`の`version`から`v<version>`タグを作る。同名のタグが
別のコミットに既に存在すると
`::error::Tag vX.Y.Z already exists on <SHA>, but HEAD is <SHA>.` で落ち、`build`・`deploy`は
`needs: tag`のためまとめて止まる。**mainへマージした後で初めて失敗が分かる**という失敗の仕方に
なり、本番デプロイが止まったまま残る（上記の自動化を使わず手動でリリースしたsolitaireで実際に
踏んでいる）。

これを`main`宛PRのCIで先に落とすのが`version-tag-check.yml`（本体は
`reusable-version-tag-check.yml`）である。判定は`deploy.yml`と同じで、`v<version>`タグが
HEAD以外のコミットに存在すれば失敗させる。バージョンが既存タグの最新より前の場合は警告のみ
（ビルドは壊れないため）。

- **main宛PRでのみ実行する。** featureブランチのバージョンは直前のリリースのままで、対応する
  タグが必ず存在するため、developへ広げるとdevelopへの全PRが赤くなる。
- **`deploy.yml`側のチェックは残す。** こちらはPRという経路にしか効かないため、最後の砦は
  あちらに置いたままにする。
- 上記の自動化（バンプPR → develop→mainのPR）を通る限りバージョンは必ず上がっているため、この
  チェックが落ちるのは手動でPRを作った場合か、バンプPRを飛ばした場合になる。

### 同じ形で落とす`deploy-config-check`（#2135）

「mainへマージした後に初めて分かる」失敗はタグの重複だけではない。`reusable-version-tag-check.yml`
には`deploy-config-check`ジョブがあり、`deploy.yml`を静的に読んで次の3つを同じタイミングで落とす。

1. **`appleboy/ssh-action`の`with.envs:`への追記漏れ。** `envs:`はSSH先へ転送する名前の
   ホワイトリストで、`env:`に定義しただけではリモートに存在しない。`${FOO:-}`のような既定値付き
   参照だと**空文字のまま`.env`へ書かれて起動してしまう**ため、気づくのが本番の実行時になる。
   `env:`・`with.envs:`・リモートスクリプトの3者を突き合わせ、集合がずれていれば落とす。
2. **`tar`の対象に実在しないパスがある。** gitは空ディレクトリを追跡しないため、`public/`を
   追跡していないリポジトリでは`tar: public: Cannot stat: No such file or directory`で`build`が
   落ちる。`.gitignore`済みのビルド生成物（`.next`など）は対象外。**除外の判定は
   `git check-ignore <path>`と`git check-ignore <path>/`の両方を試す**——`/.next/`のような
   ディレクトリ限定のパターンは、**対象がまだ存在しないとディレクトリだと分からず**
   `/`無しではマッチしない。この検査が走るのはチェックアウト直後でビルド前なので、片方だけだと
   ビルド生成物をそのまま誤検知する（**ローカルのworktreeには開発サーバーが作った`.next`が
   実在するため、手元で試すと再現しない**。#2135で実際に踏んだ）。
3. **`packageManager`のpnpmメジャー。** pnpm 11はNode 22.13以上を要求し、VPSのNode 20では
   依存インストールが`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`で落ちる（上限は`pnpm-major-max`で
   変えられる。既定は10）。

**判定できない形は黙って通す。** `deploy.yml`の書き方はリポジトリごとに違うため、`cd`を挟む
`run:`やGitHubの式・変数を含む`tar`の引数は検査せず、理由をログに残すだけにしてある。誤検知で
main宛PRを止める方が、見逃すより高くつく。検査本体（Python）は再利用可能ワークフローのYAMLへ
直接書いてある——他リポジトリから呼ばれたときcheckoutされるのは**呼び出し元**のリポジトリで、
issue-deck側の隣のファイルは読めないため。テスト（`scripts/reusable-version-tag-check.test.mjs`）は
そのYAMLから`run:`本文を取り出して実行するので、正はYAMLの1か所にある。

## 「何がどこまで検証されたか」をリリースPRに載せる（#2448）

develop→mainのマージは人が判断するのに、**その判断材料が画面のどこにも無かった。** 自動レビュー
（`claude-review`）の結果はPRコメントの散文にしか残らず、リリースPRからは「この中身のうち何件が
レビューを通っているのか」も「そもそもレビューが走ったのか」も読めない。

記録は**2段構え**で、リリース時にレビューを回し直すことはしない（差分が全Issueの和になるうえ、
済んだレビューを二重に払うことになる）。**例外は「記録のないPR」だけ**（下の「記録なしのPRはレビューを依頼する」）。

| 段 | 誰が | どこへ |
| --- | --- | --- |
| 1. 判定を残す | `claude-review`（レビューエージェント） | PRへのレビューコメント末尾のマーカー |
| 2. 節にする | `auto-merge`ジョブ | **develop向けPRの本文**の`## 検証結果` |
| 3. 集める | `reusable-release-develop-to-main.yml`の「対象issueの検証結果を集計する」 | **リリースPRの本文**の`## コードレビューの検証結果` |
| 4. 出す | issue-deckのPR詳細 | 本文より前に置く検証サマリーのパネル |

### 記録なしのPRはレビューを依頼する（#4092）

リリースPRの表で`? 記録なし`・`? 判定を取得できず`（unavailable）のままのPRは、記録の無いまま本番へ出ていた。
集計ステップ（`request_review`）が、**リリースPRの作成時に**次のとおり扱う。`skipped`（`.github/workflows/**`の
変更など、理由が記録済み）は対象外。

- **要否の機械判定**: 10ファイル以下・500行以下で、`prisma/migrations/`・`.env*`・`.github/workflows/`・`auth`・
  `package.json`・`.shared-context/`のどれにも触れないPRだけ「`— 不要（小規模・低リスクのため）`」。それ以外は依頼する
- **依頼**: `POST /api/dispatch/pr-review`（`agent: codex`）へ積む。**`runId`は渡さない**——マージ済みPRなので
  `resumePrReviewMerge`（`auto-merge`の再実行）は要らない。表は「`? レビュー依頼済み（結果待ち）`」
- **依頼できないとき**（`409`＝実行できるホスト無し・通信失敗・`APP_BASE_URL`未設定）は「`? 依頼できず（…）`」にして
  集計を続ける。PRを特定できない手動PR（headが`issue-<番号>`以外）は「`? 記録なし（PRを特定できず）`」
- **結果の反映**: PR_REVIEWはマージ済みPRの本文を書き換えない。そこで`REVIEW`が空のとき、**現在のHEADと同じshaの
  判定印コメント**（`issue-deck-(codex-)?review-verdict:`）から判定を読む（複数なら厳しい方）。反映は次の集計
  （リリースPRの作り直し）で行う
- **リリースPRのマージは止めない**（表示のみ）。結果待ち・要修正を見て人が判断する

### レビュー結果は、まずPRに残っている必要がある（#2488）

**この2段構えは、#2448を入れてから#2488まで一度も機能していなかった。** `claude-review`は
成功しているのに、レビュー結果のコメントがどのPRにも1件も無い状態が続いていた（直近50件の
マージ済みdevelop向けPRで0件。PR本文の`## 検証結果`はすべて`review=unavailable`、
リリースPR #2484の表は6行すべてが「実施なし」「記録なし」）。

原因は`reusable-claude-review-develop.yml`の`--allowedTools`に**`Bash(gh pr comment:*)`が
無かった**こと。プロンプトは「PRへのコメントとして投稿する」ことを求めているのに、道具が
無いので投稿できず、権限拒否として黙って落ちていた（実行ログには`permission_denials_count`が
残るだけで、ジョブは成功で終わる）。**prompt modeのclaude-code-actionは、結果を自分では
投稿しない。**

対処は3つ。

1. `--allowedTools`へ`Bash(gh pr comment:*)`を足す（`scripts/check-review-verdict-marker.sh`が
   CIで存在を確かめる）
2. **投稿が無ければワークフローが転記する**（ステップ「レビュー結果がPRに無ければ転記する」）。
   実行ログ（`execution_file`）の最後の応答をPRコメントとして投稿し、末尾へ
   `<!-- issue-deck-review-report sha=<head SHA> -->`を付ける。**判定マーカーは足さない**
   ——応答に含まれていればそのまま残るだけで、こちらで`lgtm`と書くのは、していないレビューの
   判定を作ることになる。集計側はこの印の付いたコメントも本文として拾う
3. 失敗の見え方を変える。道具の欠落は「レビューが走っていない」ではなく「結果が残っていない」
   として現れる。**`review=unavailable`が続いていたら、まずこの経路を疑う**

判定の分岐は`scripts/reusable-review-report.test.mjs`が`gh`をスタブに差し替えて実行する。

### 判定だけでなく、レビューの本文も載せる（#2488）

**`✅ 問題なし`・`⚠️ 要確認`という判定だけでは、レビューが何を指摘したのかが読めない。** 読むには
develop向けPRのコメントを1件ずつ開くことになり、10件を超えるリリースでは実質誰も開かない。
そこで3段目（集計）が、判定の表に加えて**レビューコメントの本文そのもの**をIssueごとの
折りたたみで表の下へ足す。

```markdown
<details>
<summary>#2441 の自動レビュー（✅ 問題なし）</summary>

<!-- issue-deck-review-detail:start issue=2441 -->

（レビューコメント本文。長ければ打ち切る）

[元のレビューコメントを開く](https://github.com/.../pull/2446#issuecomment-1)
<!-- issue-deck-review-detail:end -->

</details>
```

- **レビューは回し直さない。** 既に走った結果を、mainへ出すかを決める場所へ持ってくるだけ
  （リリース時に回し直すと差分が全Issueの和になり、済んだレビューを二重に払う）
- **拾うのは総評の判定マーカーが付いたPRコメントだけ。** 同じPRには実装者・自動修復・fallbackの
  コメントも並ぶため、「`claude[bot]`の最後のコメント」では別のものを引く
- **本文の長さには上限がある**（1件あたり60行・約4,000文字、全体20,000バイト）。GitHubのPR本文は
  65,536文字までで、超えるとリリースPRの作成そのものが失敗する。打ち切ったぶんは元コメントへの
  リンクに倒し、**表の行は必ず残す**（本文が載らないことと、検証されていないことは別）
- **本文が無い行もある。** ローカルのレビュー・統合エージェントがマージしたPRにはレビュー
  コメントが無く（`scripts/prompts/review-agent.md`はPR本文の節だけを書く）、従来どおり
  判定の行だけになる
- 画面（`VerificationSummaryPanel`）では行ごとの「レビュー内容」で開く。**既定は閉じたまま**——
  全部開いて出すと、内訳を先に読むための帯が本文と同じ長さになる
- 折りたたみのマーカーは書く側（リリースのワークフロー）と読む側（`release-verification.ts`）の
  契約で、ずれると**表だけが出て本文が出ない**。`scripts/check-review-verdict-marker.sh`が
  CIで突き合わせる。集計ステップのシェル自体は`scripts/reusable-release-verification.test.mjs`が
  `gh`をスタブに差し替えて実行する

### リリース単位の統合検証・全体レビューは別の仕組み（#4212）

上の集計は**個別PRの既存レビュー結果の転記**で、リリース全体の再レビューではない。固定内容に対する統合検証と全体AIレビューは
[release-verification.md](release-verification.md)を参照（個別と全体の責務は分けてあり、#4092の判定は全体レビューで置き換えない）。

### 修正Issueで直したPRは「修正済み」にする（#3634）

「要修正」の行から修正Issueを立てて（検証結果パネルの「修正をIssueにする」・PR詳細の
「修正Issueを起案」）その修正をdevelopへ入れ、「修正を入れて作り直す」でリリースを作り直しても、
**元PRの行は「要修正」のまま残っていた。** 3段目が読むのは元PRの本文の`## 検証結果`で、
マージ済みのPRの本文は誰も書き換えないため。

そこで3段目は、対象issueの本文から修正Issueの印（`対応PR: #<番号>`・`対象PR: #<番号>`。
どちらも起票の下書きが書く）を拾い、**その修正Issueが同じリリースの対象issueに入っている場合だけ**、
元PRの行を`✅ #<修正Issue> で修正済み（元の判定: 要修正）`に差し替える。

- **開いているリリースPRの検証結果パネルには、要確認・要修正の行があるとき作り直しの案内と
  「修正を入れて作り直す」を出す**（#3760）。凍結ブランチの本文は書き換えず（developの状態で✅に
  すると、mainへ出ない修正を根拠にマージ確認を素通りさせてしまう）、作り直しへ誘導するだけ
- 修正Issueがまだdevelopへ入っていなければ対象issueに載らないので、元PRは要修正のまま残る
  （修正が本番へ一緒に出ないのに「修正済み」とは言えない）
- 修正そのものの出来は、修正Issue自身の行（自分のPRの判定）で読める。元PRの行の折りたたみには
  元の指摘がそのまま残る
- 画面は先頭の`✅`で`ok`として読むので、マージ確認で止めない。**作成済みのリリースPRの本文は
  変わらない**ので、反映されるのは作り直した時点から
- 印の文言は下書き（`release-verification.ts`・`pull-request-fix-issue.ts`）とワークフローに
  またがる契約で、`scripts/check-review-verdict-marker.sh`が突き合わせる

### 確認して「対応しない」と決めた指摘は「確認済み」にする（#3739）

自動レビューが要確認・要修正でも、人が読んで対応しないと決めることがある。記録が無いと、
リリースのたびに同じ指摘がマージ確認で止める。検証結果パネルの⚠️・❌の行の
「確認済み・対応しない」（開いているリリースPRのみ。理由を添える）で記録する。

- **記録はdevelop向けPRのコメント。** `<!-- issue-deck-review-ack sha=<レビューしたコミット> by=<人> -->`
  （取り消しは`issue-deck-review-ack-revoke`）。DBには持たない（リリースのワークフローから読めないため）。
  書式は`src/lib/github/review-acknowledgement.ts`とワークフローの契約で、
  `scripts/check-review-verdict-marker.sh`が突き合わせる
- **開いているリリースPRの本文も、記録のときに書き換える**（表の該当セルと折りたたみの見出し）。
  本文は作成時に1回しか書かれず、画面もマージ確認もそこを読むため、書き換えないと押しても変わらない。
  次に作り直すリリースは、3段目がコメントから同じ記録を読んで`✅ 確認済み（元の判定: 要確認、記録: <人>）`にする
- **採用するのはissue-deckのApp botが投稿したコメントだけ。** PUBLICリポジトリでは誰でも同じマーカーを
  書けるため。ワークフローは`gh --json`（GraphQL）ではbotのloginが`issue-deck`で`[bot]`が付かず、
  通常ユーザーと見分けられないので、この読み取りだけRESTで`user.login == "issue-deck[bot]"`かつ
  `user.type == "Bot"`で絞る。記録のコメントは必ずinstallationトークンで投稿する
- **`sha`が一致する記録だけが効く。** 追いコミットで再レビューされると別のshaになり、前の記録は
  引き継がれない（直した後の新しい指摘を素通りさせないため）
- 画面は先頭の`✅`で`ok`として読むので、マージ確認では止めない

### 書式は3か所にまたがる契約

```markdown
<!-- issue-deck-verification:start review=lgtm risk=none -->
## 検証結果

- 自動レビュー: ✅ 問題なし（LGTM）
- 機械的リスク判定: 該当なし
- ユーザーの確認: 不要（自動マージの対象）
<!-- issue-deck-verification:end -->
```

- `review=`は`lgtm` / `needs-check` / `changes-requested` / `skipped` / `unavailable`、`risk=`は
  `none` / `hit`。**段を増やさない。** リポジトリ全体のコードレビュー（[code-review.md](code-review.md)）で
  重要度を3つに固定しているのと同じ理由で、増やすと色も判断も1対1で対応しなくなる
- **節は追記ではなく置き換え。** 開始・終了マーカーの間を落としてから足すので、同じPRへ何度
  pushしても節は1つのまま。PR本文の編集は`pull_request`の`edited`を起こすが、
  `claude-review-develop.yml`のトリガーに`edited`は無いので再帰しない
- **`skipped`は危険信号ではない。** 低リスクかつ小規模なPRでレビューを省くのは#992のゲートの
  設計どおりの動きなので、画面でも灰色で出す。赤やamberにすると本当に見るべき`要確認`が埋もれる
- **`skipped`になる経路は2つあり、`unavailable`と混ぜない。** #992のゲートで
  `claude-review`ジョブごとskipされた場合と、**ジョブはsuccessでもClaudeが動かなかった場合**
  （`.github/workflows/`配下を変更するPRでは、claude-code-actionの検証機構がClaudeの実行だけを
  飛ばす）。後者を`unavailable`（判定を残せなかった）と書くと、実施していないことが
  「取りこぼし」に見える。実行の有無は`claude-review`ジョブの`executed`出力
  （`steps.claude_review.outputs.execution_file != ''`）で判別し、理由はdevelop向けPRの本文へ
  添える。**リリースPRの表は`— 実施なし`までしか出さない**（理由は元のPRを開けば読める）
- **`merge-blocked`のマーカーは動かさない。** あちらは自動レビューが**対応Issue**へ投稿する
  理由コメントに付き、`auto-merge`がそこだけを読んで`00.check-user`を付ける（#2136）。
  総評の判定マーカーは**PRへのコメント**側に足す別の契約で、既存の読み取り経路は変えていない。
  **PRコメントを投稿するのはレビューエージェント自身**で、そのために`allowedTools`へ
  `Bash(gh pr comment:*)`が要る（#2488。「claude-code-actionが自分で投稿するので要らない」と
  書いていたのは誤りで、prompt modeのactionは結果を投稿しない）
- **head refが`issue-<番号>`のPRにしか節を書かない。** バージョンバンプPRの本文にある
  `## 対象issue`はdevelop→mainのPRを作るrunが引き継ぐ唯一の入力（#2117）で、リリースの配管
  そのもの。集計側も`issue-<番号>`のPRしか引くので、そこへ足しても誰も読まない
- **記録が無くても表は作る。** 共有ワークフローの参照タグを配る前にマージされたPRや、ブランチ名が
  `issue-<番号>`でないPRには節が無い。その行は「記録なし」と出す——表ごと消すと、
  **検証されていないことも読めなくなる**
- 記録に失敗してもリリース・マージは止めない（どちらのステップも`continue-on-error: true`）。
  記録の欠落より、マージが止まって人を呼ぶ方が高くつく

### 変更したときに一緒に見る場所

判定マーカーと節のマーカーは**書く側と読む側でずれても赤くならない**（黙って「記録なし」に
倒れる）。そのため`scripts/check-review-verdict-marker.sh`がCI（`docs-sync-check`）で次の6ファイルを
突き合わせる。**文字列を変えるときは全部を揃える。**

| 場所 | 何をしているか |
|---|---|
| `.github/prompts/review-develop.md` | 総評の判定マーカーをPRコメントへ残す指示 |
| `.github/workflows/reusable-claude-review-develop.yml` | マーカーを読み、PR本文へ節を書く |
| `.github/workflows/reusable-release-develop-to-main.yml` | 節を集めてリリースPR本文の表にする |
| `scripts/prompts/review-agent.md` | ローカルのレビュー・統合エージェントが同じ節を書く |
| `src/lib/github/release-verification.ts` | 画面が表とレビュー本文を読んでパネルにする |
| `src/lib/github/pull-request-review-verdict.ts` | マージ確認ダイアログが節から判定1本ぶんを読む（#2843） |

## バージョンの上げ幅の判定

issueのラベルではなく、main/develop間の実際のコード差分の内容から判定する。専用のClaude
Codeステップ（`claude-code-action`、`--json-schema`による構造化出力）が`git diff origin/main
origin/develop`・`git log origin/main..origin/develop`を確認し、semverに基づき
major/minor/patchのいずれかと判断根拠を返す。判定ステップ自体が失敗した場合や、返り値が
major/minor/patchのいずれでもない不正な場合はpatchにフォールバックする。

判断根拠はバンプPR（`release/vX.Y.Z`）本文の`## バージョンの判断根拠`に載るが、このPRは
CI通過後すぐ自動マージされて閉じる。develop→mainのリリースPRを作るrunが、マージ済みバンプPR
本文から同じ節を`gh pr list --head release/v$DEV_VERSION --state merged`で取り出し、
リリースPR本文にも引き継ぐ（#2978。mainへマージするかを人が判断する時点でも理由を読めるように
するため）。抽出時、バンプPR向けの固定文言（「このPR上でバージョンを修正してください」）は
除く——mainへのリリースPRは凍結ブランチ`release-main/vX.Y.Z`を直接直すことを禁じているため、
そのまま載せると同じ本文の中で案内が食い違う。**バンプPRの検索キーはバンプ判定時点のバージョン
（ブランチ名）だが、人がバンプPR上でバージョンを直接修正した場合はdevelopの実際のバージョンと
食い違い、見つからない。** 節ごと消すと判断根拠がいちばん問われるこのケースで何も言わずに
消えるため、取得できなかった旨の注記を`## バージョンの判断根拠`の下に残す。

### 同じステップが利用者向けの文言も作る

このステップは上げ幅の判定だけでなく、**同じ差分から利用者向けの文言を2種類**生成する。
どちらもバンプPRの本文に載り、`"version"` npm lifecycleスクリプトへ環境変数として渡って、
更新履歴表示を持つリポジトリが自前の画面に出す（受け取り方は
[docs/cross-repo-setup-guide.md](../cross-repo-setup-guide.md)）。

| 出力 | 環境変数 | 何を書くか | 空になる条件 |
|---|---|---|---|
| `changelog` | `RELEASE_CHANGELOG` | 何が変わったか（#800） | 判定失敗時 |
| `usage` | `RELEASE_USAGE` | どう使うか。どこを開く / 何を押す / どうなれば成功か（#1729） | 判定失敗時、**画面で使える変化が無いリリース** |

`usage`を足したのは、「機能が入ったのは分かるが、どこを押せば使えるのか分からない」を
リリース単位で解消するため。**Issue単位ではなくリリース単位にしてあるのは、届け先が
各アプリの更新履歴画面（バージョンごとに並ぶ画面）だから。**

`usage`だけは「画面で使える変化が無いリリース」で空になる契約にしてある。内部改善だけの
リリースで無理に手順を書かせると、読み手が毎回それを読んで空振りすることになるため。
空のときはPR本文にセクションごと出さない。

**画面に導線が無い変更は、`changelog`の段階で落とす**（#2508）。生成プロンプトには
「端末のスクリプト・CLI・CI/CDからしか使えない変更はchangelogに書かない」「usageは画面に
導線があると差分から確認できた操作だけを書き、書けない項目はchangelogごと落とす」を明記して
ある。`usage`側の「空にしてよい」条件だけでは足りない。#2506では、端末の
`scripts/start-issue.sh --agent codex`だけの経路（#2377）が4.44.0のchangelogへ載り、
changelogに書かれた以上usageも書くしかなくなった生成側が、画面に存在しない選択肢の操作手順を
推測で組み立てていた。
手で直すときのルールは`src/lib/changelog.ts`の冒頭コメントにあるが、**自動生成はそのファイルを
読まない**ため、同じ趣旨を生成プロンプト側にも置いている。**片方だけ直しても効かない。**

**issue-deck自身もこの契約の受け取り側になった**（#1764）。`package.json`の`"version"`
lifecycleスクリプト（`scripts/version-changelog.mjs`）が`src/lib/changelog.ts`の先頭へ
エントリを足し、設定 →「更新履歴」に出る。`changelog`は`changes`、`usage`は同じエントリの
`usage`として持つ（`changes`へ混ぜない）。バンプ時に依存はインストールされないため、
スクリプトはNode標準モジュールだけで書き、`preversion`は作らない。

**受け取り側を持たないリポジトリのために、共有ワークフローが`.github/release-notes.md`へも
書き出す**（#2391）。`"version"` lifecycleスクリプトを持つのはフリート16リポジトリ中7件
しかなく、残りでは生成した文面がバンプPR本文にしか残らなかった。バンプコミットにこの
ファイルを含めることで、**更新履歴画面を持たないアプリでもリリース通知の本文に変更内容が
載る**（[auto-repair.md](auto-repair.md)「リリースだけ宛先と見た目を変える」）。最新
リリースぶんだけを持ち毎回上書きするので、履歴の置き場は従来どおり各アプリの更新履歴ファイル。

### リリースの完了はissue-deckのPush通知でも届く（#2725）

リリース通知の宛先はSignalyだけだった（`deploy.yml`の`notify-release`が
`.github/scripts/signaly-notify.sh`を呼ぶ）。**フリート全体のリリースを画面で扱っている
issue-deck自身のPWAには届かない**ため、サブPCのpollerが叩く巡回
（`POST /api/repositories/release-push-sweep`）が新しいリリースを見つけてPush通知を出す。
**Signalyへの通知はそのまま残す**（宛先が1つ増えるだけ）。

- 見ているのは各リポジトリの`releases/latest`（draftとprereleaseを除く）で、**記録した
  タグと違うものが返ったときだけ鳴らす**。記録の無いリポジトリは鳴らさずタグだけ入れる
- 本文はSignalyと同じ`.github/release-notes.md`から取り、**見出しがタグと一致したときだけ
  載せる**（照合できなければ「表示できる更新内容がありません」）
- 「人が動かないと止まるもの」ではないため鳴らし直しはしない。止めたいときは
  `RELEASE_PUSH_SWEEP_INTERVAL_MINUTES=0`
- 設計は[../code-map.md](../code-map.md)の「リリース（本番反映）の完了もPush通知で届く」

### 画面から上げ幅を指定する（#1548）

**「生成されたPR上でバージョンを直接修正する」は実際には間に合わない。** バンプPRはCI通過後に
auto-mergeでdevelopへ入るため、PRが出てから直す時間がほとんど無い（`Allow auto-merge`を切るか
PRを閉じるところから始める必要がある）。そこで、**起動する時点で上げ幅を選べる**ようにしてある。

- 入口はissue-deckの画面2か所（PCは「ブランチ」画面の「リリースする」／スマホはリポジトリ画面の
  リリースシート）の確認ダイアログ。既定は`auto`で、選ばなければ従来どおり自動判定になる。
  **PCヘッダーのロケットボタンは#1614で通知ベルへ置き換えたため、そこからは起動できない。**
- 画面 → `POST /api/repositories/release`（`bumpKind`） → `workflow_dispatch`の`bump_kind` input
  → callerが`reusable-release-develop-to-main.yml`の`bump-kind`へ渡す、という一本道で届く。
- **指定があっても判定ステップは走らせる。** 上げ幅と一緒に利用者向けの更新履歴
  （`changelog` → `RELEASE_CHANGELOG`）と使い方（`usage` → `RELEASE_USAGE`）を作っている
  ため、飛ばすとどちらも空になる。
  指定値で判定結果を上書きし、判断根拠（PR本文の「バージョンの判断根拠」）には
  「issue-deckの画面から◯◯を指定しました（コード差分からの自動判定は△△）」を残す。
- 画面の選択肢に添える基準（major/minor/patchの説明）は`src/lib/semver-bump.ts`の
  `BUMP_KIND_CRITERIA`にあり、**判定プロンプトに書いてある基準と同じ文面**にしてある。
  片方を直すときはもう片方も揃える。
- **`bump_kind` inputを持たないcallerのリポジトリでは指定できない。** GitHubが422
  （`Unexpected inputs provided`）を返すため、画面は「上げ幅の指定に未対応です（自動判定で
  起動してください）」と出す。自動判定での起動はinputを送らないので、未配布のリポジトリでも
  今までどおり動く。

### 本番デプロイ失敗中の修正リリース（#3897・#3912）

直近の`main`の`deploy.yml`が`failure`または`timed_out`なら、通常の画面起動・API起動・
定時起動を止める。修正を`develop`へ取り込んだときは、画面の確認ダイアログで失敗中の起動を
明示的に許可するか、GitHub Actionsの`workflow_dispatch`で`allow_failed_deploy`を選ぶ。
画面の指定はAPIの`allowFailedDeploy`からcallerの`allow_failed_deploy`を経て、再利用可能
workflowの`allow-failed-deploy`へ渡る。入力を持たない古いcallerはGitHubの422になり、
画面にworkflowの更新が必要と表示される。新規アプリのcaller雛形は旧版の共有workflowタグを
参照するため、この入力を先行追加しない。共有workflowタグを更新するときにcallerも揃える。

**上書きが必要なのはリリースの開始時だけ。** バンプPRが`develop`へマージされると、
`package.json`の変更による`push`が別runを起動してリリースPRを作る。このrunには手動入力が
引き継がれないため、`need_main_pr=true`の`push`はデプロイ失敗中でも継続させる。
ここも止めると、上書きでバンプPRを作れてもリリースPRが作られず、修正を本番へ出せない。
デプロイ状況の取得に失敗した場合は、従来どおり誤ブロックを避けて続行する。

## トリガー

`workflow_dispatch`（手動実行）と**`package.json`の変更を伴う`develop`へのpush**の2つ。
**定期の`schedule`は持たない**（#4599で廃止。reusable側も`schedule`起動は何もせず終了するため、
タグ配布前の旧callerにscheduleが残っていても自動開始しない）。

```yaml
on:
  workflow_dispatch:
    inputs:
      # 上げ幅の指定（#1548）。これを持たないcallerでは画面から指定できない
      # （docs/supported-repositories.md「callerの`bump_kind`入力の配布状況」）。
      bump_kind:
        required: false
        type: choice
        default: auto
        options: [auto, patch, minor, major]
      allow_failed_deploy:
        required: false
        type: boolean
        default: false
  push:
    branches: [develop]
    paths:
      - package.json
```

通常のフィーチャーpushでは`package.json`が変わらないため、pushトリガーが発火するのは実質
**バンプPRがdevelopへマージされた瞬間だけ**である。この1回でdevelop→mainのPRを自動作成し、
「バンプPRをマージしたあと、もう一度手で起動する」という手間を省いている。

同時実行による二重作成を避けるため、`concurrency`グループで直列化している。

### 定期起動（schedule）と実行間隔の設定は廃止した（#4599）

#3404・#3416で入れた15分おきのscheduleと、設定＞実行設定の「リリース準備の自動実行間隔」
（`/api/settings/release-prep-interval`・`/api/release-prep/schedule`）は廃止した。利用者が
「20分より短い間隔で手動実行したい」「自動処理は不要」と決めたため（過去の#178の方針に戻る）。
`AppSetting.releasePrepIntervalMinutes`の列は旧値保持のため残すが、どこからも読まない。
**開始後の進行（CI・レビュー・版更新・PR作成、バンプPRマージ後のpush起動によるdevelop→main PR作成）は
イベント駆動のまま維持する。**

他リポジトリのcallerの`schedule`定義は各リポジトリ側にあるため、共有タグを上げただけでは消えない。
reusableが`schedule`起動を即終了するので自動開始はしないが、callerからの`schedule`削除は
既存のタグ配布（画面の「新しいタグを切って配る」）と別Issueで追跡する。

### pushトリガーで起動したときは、ワークフローファイルもdevelop側のものが使われる

`workflow_dispatch`は起動時に`--ref`でどのブランチのワークフローファイルを使うか選べるが、
pushトリガーは当然`develop`のものになる。**ジョブが対象コードとして`ref: develop`を明示的に
チェックアウトするのとは別の話**なので、混同しないこと。

これはリリースフロー自体を変更した直後に効いてくる。#1010（進捗ラベルの廃止）のリリースでは、
対象issueの取得をラベル検索から`GET /api/progress`へ変えたが、その変更はまだ本番へ反映されて
いなかった。develop→mainのPRを旧版（ラベル検索）で作るつもりで`--ref main`を使おうとしたところ、
バンプPRのマージがpushトリガーで**develop側の新版を先に起動**し、そちらがPRを作成した。結果、
問い合わせ先の本番APIがまだ存在せず（HTTP 405）、PR本文の対象issue一覧が空になった。

リリースフローや進捗の取得方法自体を変更する場合は、**バンプPRをマージした時点で新版が動く**
ことを前提に段取りを組む。

## Xcodeで実機へ反映するリポジトリ（#3468）

`guchi-apps/aide-ios`は、`main`へマージしても何も起きない。Mac miniでXcodeビルドして実機へ
入れるまで反映されないため、**「`main`にある版＝Xcodeで実機に入れた版」と運用で定義する。**

- `main`へ入れるのはMacの`scripts/xcode-release.sh`だけ。`develop`の先端をXcodeで開き、実機へ
  入れたあと実機で確認してSSHに`release`と入力すると、develop→mainのリリースPRを**ビルドしたコミットを指定して**マージする
  （`gh pr merge --merge --match-head-commit <SHA>`）。その間に`develop`が進んでいればマージは
  失敗し、ビルドしていない版が`main`へ入ることは無い
- **順序は「バンプPRを`develop`へマージ→バンプ済みの先頭をXcodeでビルド→最後に`main`へマージ」**
  （#3495）。バージョンを確定させてからビルドするので、実機に入る版が最終版になり、`main`への
  マージとビルドの時点もずれない。ビルドとマージを同時に走らせる案は、GitHub Actionsのmacosランナーが
  署名なしのシミュレータ向けまでしか作れず実機へ入れられないため採らない。`MARKETING_VERSION`と
  `version.json`の同期、`xcode-release.sh`がバンプ済みか確認して止まること、マージ後のタグ付けは
  aide-ios側の変更（issue-deckでは実施しない）。バンプの起動は、画面に「リリースする」を出さない
  ため`gh workflow run release-develop-to-main.yml --repo guchi-apps/aide-ios`（またはActions画面）で行い、
  ブランチ画面の説明文にも書いてある。バンプが要るのは`main`へ入れるたびに1回で、バンプ後に
  `develop`へ入った変更も同じ版番号でビルドされる
- ブランチ画面は、[src/lib/device-build-repos.ts](../../src/lib/device-build-repos.ts)に載った
  リポジトリだけ表示を変える。`main`の先頭（`/api/branch-flow`の同じGraphQLに相乗りで取る）を
  「実機に入っている版」として出し、「本番未反映」「本番反映」を「実機未反映」「実機反映（Xcode）」
  へ置き換え、**`main`へのマージボタンと「リリースする」を出さない**（画面からマージすると、
  ビルドしていない版が実機に入ったように記録されるため）。代わりにMacで打つコマンドと
  ビルド対象の`develop`の先頭を出す。接続確認、キーチェーン解除、最新の`develop`への更新、
  実機確認後の`release`入力までを順番に案内する。Mac側のビルド・接続・実機確認の状態は
  GitHubからは取れないため、IssueDeckで成功扱いにせず、画面で手動確認の手順として示す
- **採らなかった案。** 画面に「実機に入れた」ボタンを置いてDBへ記録する案は、GitHub上の事実と
  別の正ができるため採らなかった。移動するgitタグで表す案は、`main`とタグの2つを見比べる必要が
  残るため採らなかった

### 「リリース」画面（スマホ）にも同じ案内を出す（#3579）

ブランチ画面だけでなく、リポジトリのロケットボタンから開く「リリース」画面
（`MobileReleaseSheet`・`ReleaseProgress`）にも`aide-ios`向けの案内を出す。文言・コマンドは
[`components/dashboard/device-build-instructions.tsx`](../../src/components/dashboard/device-build-instructions.tsx)
へ切り出し、ブランチ画面・リリース画面の両方がこれを参照する（1箇所を直せば両方に効く）。

- **`release_pending`段（バンプPRがdevelopへ入った後、develop→mainのPRがまだ無い状態）は、
  `aide-ios`では自動では進まない定常状態。** `release-develop-to-main.yml`は
  `workflow_dispatch`だけで`push`トリガーを持たず、develop→mainのPRは`xcode-release.sh`が
  実機確認後に作成・マージを一度に行う。そのため`ReleaseProgress`はこの段を「PR作成中」の
  スピナーではなく「Macでのビルド待ち」という注記に差し替え、`useReleaseStatus`のポーリングも
  この段を進行中とみなさない（`isDeviceBuild`を渡す）
- **シートを開くロケットボタン（`mobile-repo-issues-screen.tsx`）も同じ理由で直す。**
  `summarizeReleaseButtonStatus`は素の`release_pending`を`progressing`（回転アニメーション）に
  畳むため、`isDeviceBuild`を渡して`idle`へ落とす。`release-pending-merges/route.ts`
  （通知・他画面のバッジの元）は元々この段を`releasePending: false`で除外しており、影響しない
- **develop→mainのPRが実際に開いている間（`release_pr_open`）も、「タップしてmainへマージ」の
  導線は出さない。** 参照リンクと、Macのスクリプトがマージする旨の注記だけにする
- **リリースworkflowの手動起動ボタン（「リリースworkflowを起動」）も出さない。** ブランチ画面と
  同じ理由で、バンプは`gh workflow run release-develop-to-main.yml --repo guchi-apps/aide-ios`
  で行う運用のまま

### WebViewでネイティブアプリを包むリポジトリ（`guchi-apps/myroom`。#3579）

`myroom`のkurashio iOSアプリ（`ios/`、myroom #526・#528・PR #529）は`aide-ios`と違い、`main`
へのマージ（Web側の変更）は`deploy.yml`がそのまま本番へ反映する。`ios/`やアプリアイコンを
変えたときだけ、Mac miniでXcodeを開いて実機へ入れ直す必要がある。

- 対象リポジトリと手順は
  [`lib/webview-ios-repos.ts`](../../src/lib/webview-ios-repos.ts)に固定リストで持つ
  （`device-build-repos.ts`と同じ判断。単に`ios/`フォルダがあるだけの対象外リポジトリを
  誤って拾わないため）
- **Web側の変更か`ios/`側の変更かは自動判定しない。** `ReleaseStatus`には変更ファイルの情報が
  無く、判定にはGitHub compare APIの追加呼び出しが要る（1回の取得で既に7〜8回消費している）。
  「Webだけ更新（再ビルド不要）」と「アプリ本体の入れ直し（Xcode操作が要る）」の2種類の手順を
  並べて示し、どちらに当たるかは利用者が判断する
- リリース画面には`aide-ios`と違って通常どおりの進捗（バンプPR→develop反映→mainへマージ→
  本番デプロイ）を出したうえで、上記の案内を追加で表示する。`main`へのマージ自体は画面から
  行ってよい（Web側は正しく反映されるため、`aide-ios`のような抑止はしない）

### kurashioのiOS変更判定・TestFlight配布結果の表示（#3626）

kurashioとyoteiflow（yoteiflow#961・#3737。kurashioと同じ契約）は`ios-testflight.yml`（ワークフロー名`iOS TestFlight`、kurashio#591）が、リリースごとにiOS更新の
要否を判定し、必要なら署名・ビルド・アップロード・処理待ち・内部グループ配布を実行する。リリース画面
（`MobileReleaseSheet`）の「iOS配布（TestFlight）の結果」欄がそれを**Webのデプロイとは別に**表示する。

- 取得は`GET /api/repositories/ios-testflight`（`webview-ios-repos.ts`の対象だけ）。直近3件のrun、各runの
  ジョブ・ステップ、判定ジョブの注釈（`::notice::`の文面＝更新要否・スキップ理由）、配布済みの印のタグ
  `ios-testflight/<ビルド番号>`の最大値を返す。**ワークフローが無いリポジトリでは欄ごと出さない**
- 段階（変更判定・署名・ビルド・アップロード・処理待ち・内部グループ配布）は、**ジョブ・ステップの名前に
  含まれる語（日英）で推定する**（`lib/ios-testflight-status.ts`）。ワークフローの構成は向こうが決めるため、
  当たらない段階は「—」（不明）で、成功と偽らない。ステップ名を変えるときはここの正規表現も見る
- 更新不要でビルドを作らなかったrunは「iOS更新は不要と判定」と表示し、失敗と区別する
- **ステップサマリー（`$GITHUB_STEP_SUMMARY`）はGitHub REST APIで取れない**ため本文は出さず、runへのリンクで
  代える。スキップ理由を画面に出したいときは、判定ジョブが`::notice::`で理由を出力する
- **失敗したまま止まったiOS配布は、issue-deckが巡回して`[iOS配布失敗]`Issueとして起票する**（#3745。起票のみで自動修正はしない）。仕様は[auto-repair.md](auto-repair.md)「iOS配布の失敗も同じ形で起票する」

### ブランチ画面のリリース束からiOS配布を起動・確認する（#3644）

ブランチ画面の、mainへマージ済みのリリース束（`webview-ios-repos.ts`のリポジトリのみ）に「iOS配布」欄を出す
（`ios-release-group-panel.tsx`）。**Webの本番デプロイとは別の行**で、iOSの成否をWebに混ぜない。

- **自動起動（kurashio・yoteiflowの`ios-testflight-trigger.yml`）は残す。** 画面の「iOSへ配布」は自動で走らなかった場合・
  失敗した場合の手動起動で、`ios-testflight.yml`を`--ref main`＋`inputs.sha`で`workflow_dispatch`する
- **配布済み・ビルド番号はタグから引く。** runの`head_sha`は起動時のmain先端で束のコミットと一致しないため、
  `ios-testflight/<N>`タグが指すコミットと束のmergeコミットを照合する（`deliveredBuildForSha`）。古い束にも効く
- **起動できるのは「mergeコミット＝いまのmain先端」の束だけ。** それ以外はrunと束を対応づけられないので操作しない
  （任意の束から起動するには、kurashio側の`run-name`にSHAを入れる必要がある）
- `POST /api/repositories/ios-testflight`は対象SHAをクライアントから受け取らず、リリースPR番号から引く。
  マージ済み・main先端・Webデプロイ成功（`deploy.yml`の`head_sha`一致のrun）・未配布・実行中なし
  （`checkIosDispatchable`）をサーバーで確かめ、満たさなければ409。dispatchはrun IDを返さないため、
  同一リポジトリへの60秒以内の再POSTも弾く
- **更新不要と判定された版は「手動で配布」で判定を飛ばして配布できる**（#3840）。`POST`に`force: true`を付けると
  `workflow_dispatch`の`inputs.force="true"`を渡す。**各アプリの`ios-testflight.yml`が`force`入力を宣言している
  必要があり**（未宣言だとGitHubが422）、その場合は`force_unsupported`（409）を返して画面が「未対応」と案内する。
  サーバーはその版のrunが完了・成功（更新不要で終わった）ときだけ受け付ける（`force_not_needed`）。
  ワークフロー側は`force`が真ならdetectで`needed=true`として扱う
  **手動配布のrunが失敗すると「再実行」はforceを付けないので、再び更新不要で終わる。** その場合は失敗の原因を直したうえで、
  更新不要に戻った欄の「手動で配布」からやり直す（runの入力は一覧APIから見えず、失敗runがforceだったかは判別できない）
- 「iOS変更の判定結果」は起動前には出せない（判定はworkflow内のdetectジョブで、`::notice::`も出していない）。
  ダイアログでは「起動後に判定」と明示し、更新不要は`judgeIosRun`の`skipped`で「iOS更新不要」と出す（失敗にしない）

### 自動化（Mac miniでの実行代行）は調査のみで見送り（#3579）

VPS・サブPCへはTailscale SSH経由の代行実行基盤があるが（`71.manual-step`の代行実行）、
**Mac miniには同等の基盤が無い。** 実機ビルド・インストール・実機確認はMac mini上での
対話的な操作（`xcrun devicectl`・Xcode・実機での目視確認）を含み、安全な実行経路と実行結果の
取得を新たに設計する必要があるため、本Issueでは自動化を実装せず、正確な手動手順の表示までに
留める。自動化が必要になった場合は、Mac miniの代行実行基盤の設計を扱う別Issueとする。

## 自動マージされないことの担保

バージョンbump用PR（`release/v*` → `develop`）・develop→mainのPR（`release-main/v*` → `main`）は
いずれも、ブランチ名が`issue-<番号>`の命名規約に従わないため、`claude-review-develop.yml`の
`auto-merge`ジョブが対応Issue番号を特定できず自動マージをスキップする（既存の仕組みがそのまま
効くため、本Phaseで新たなガードは追加していない）。develop→mainのPRについてはそもそも
`claude-review-develop.yml`が`develop`向けPRしか対象にしないため関与しない。

## 失敗時の通知（#727）

`claude-issue-dispatch.yml`のnotify-failure、`claude-review-develop.yml`の
claude-review-fallback/auto-merge-fallback、`claude-conflict-resolve.yml`のフォールバック通知と
同じ考え方で、`release`ジョブ専用の`notify-failure`ジョブを持つ。`release`ジョブが状態判定・
バージョン判定・バンプPR作成・develop→mainのPR作成のどのステップで失敗しても
（`if: always() && needs.release.result == 'failure'`）起動し、進捗が`Develop`・`Release`に
あるissue（`release`ジョブの「リリース対象issueの一覧を取得する」ステップとは独立に
このジョブでも問い合わせる。どのステップで落ちてもissueを特定できるようにするため）へ実行ログ
URL付きの警告コメントを投稿し、`00.check-user`を付与する。直近のコメントに同一run URLが既に
含まれる場合は重複通知しない（他ワークフローと同じdedupパターン）。対象issueが1件も無い場合
（issue-deckへ疎通できない場合を含む）は通知できず、Actionsの実行ログでしか気づけない制約が残る。
**対象の特定はissue-deckの進捗問い合わせAPI（`GET /api/progress`）に依存する**（#991 Phase 5で
ラベル検索から置き換えた）。

## mainへマージしてもデプロイが起動しないことがある（#2703）

**GitHubはmainへのマージに対してワークフローを1件も作らないことがある。**
`guchi-apps/myroom`のv4.8.0では、リリースPR #312（`release-main/v4.8.0` → `main`）を
issue-deckがマージしたのに`deploy.yml`（Deploy to Production）が**1件も起動せず**、本番が
約20分間v4.7.0のまま残った（guchi-apps/myroom#315）。

- マージコミット`db53cd2`のcheck-suiteは**0件**（正常時はマージの2〜5秒後に2件作られる）
- `push`だけでなく、`issue-labels.yml`が購読している`pull_request(closed)`も同時に起動していない
- 発生頻度は実測で**mainへのマージ55件中1件（約2%）**

つまり落ちていたのはワークフローの定義ではなく**イベントの配送**で、`on:`の書き方では直せない
（設定できるのは「届いたイベントにどう反応するか」だけ）。`deploy-retry.yml`
（`reusable-deploy-retry.yml`）も、*起動したデプロイが失敗したとき*の再実行なのでこの状態には
効かない。

### 直せるのはマージした側だけ

マージした主体（issue-deck）だけが**マージコミットのSHAを知っている**。イベントの配送に依存せず
ポーリングで「このコミットに対する`deploy.yml`の実行が作られたか」を確かめられるのはここだけで、
だから唯一「即時に」直せる。仕組みは次のとおり。

1. `POST /api/issues/pull-request-merge`が**mainへのマージ**を成功させた時点で、
   `DeployLaunchWatch`へ1行置く（リポジトリ・PR番号・マージコミットのSHA・マージ時刻）。
   **リクエストの中では待たない**——ブラウザを握り続けることになり、本番の再起動
   （PM2の`max_memory_restart`・#2331）でその待ちごと消える
2. サブPCのpollerが1巡（30秒）ごとに`POST /api/repositories/deploy-launch-sweep`を呼び、
   `deploy.yml`の直近の実行を引いて照合する。**この巡回だけは間隔で間引かない**（遅れが
   そのまま本番が古いままの時間になる）。見張っている行が無ければGitHubを1回も叩かない
3. 猶予（`DEPLOY_LAUNCH_GRACE_SECONDS`・既定90秒・0で無効）を過ぎても実行が無ければ、
   issue-deckが`deploy.yml`を起動し直し、マージ済みPRへコメントを残してPush通知を鳴らす

照合は次のどれかを満たせば「出している」と見なす。

- 実行の`head_sha`がマージコミットと一致する（mainへのpushで起動した本来の実行）
- 実行の`head_commit.tree_id`がマージコミットのtreeと一致する（**手動デプロイが別のrefから
  起動されていた場合**。SHAは一致しないが中身は同じ）。この取得は起動し直す直前にだけ行う
- mainブランチで、マージより後に作られた実行がある（後続のマージ・手動デプロイがmain先端を
  出しており、そこにこのマージも含まれている）

### 起動し直すときは必ず`--ref main`

**リリースブランチのrefから起動してはいけない。** `deploy.yml`の`tag`ジョブが`v<version>`を
**main上に無いコミットへ付けてしまい**、以後mainから起動したデプロイがタグ検証で必ず失敗する
（guchi-apps/myroom#315で実際に起きた）。issue-deck側の起動は`dispatchDeployWorkflow`
（`ref: "main"`固定）を通す。手で起動する場合も
`gh workflow run deploy.yml --repo <owner>/<repo> --ref main`にする。

### 直せない範囲

- **GitHubの画面から直接マージした場合は見張りが立たない。** 見張りを置けるのはマージコミットの
  SHAを知っている側だけで、issue-deckを経由しないマージはそれを知らない。この場合は従来どおり、
  デプロイ失敗の巡回（#2236）とブランチ画面の表示（`resolveDeployState`）で拾う
- **`deploy.yml`に`workflow_dispatch`を書いていないリポジトリでは起動し直せない**
  （`guchi-apps/portfolio`）。dispatchが422で落ちた時点で見張りを`unsupported`として畳み、
  鳴らさない（押し直しても直らないため）

実装は[`src/lib/deploy-launch.ts`](../../src/lib/deploy-launch.ts)（判定）と
[`src/lib/github/deploy-launch-sweep-run.ts`](../../src/lib/github/deploy-launch-sweep-run.ts)（IO）。

## 本番デプロイ復旧PRは「マージ差分だけ」を適用する（#4005）

画面の本番デプロイ復旧（`src/lib/github/deploy-recovery-api.ts`）は、選択したdevelop向けPRを
main起点の`deploy-recovery/*`ブランチへ取り込む。**`merges`APIは使わない**——マージコミットを渡すと
祖先の未選択変更ごと入るため。代わりにGit Data APIで次を行う。

1. 各PRのマージコミットの**第1親→マージコミットの差分**（ファイル単位のblob）だけを、ブランチへ
   コミットとして積む。ブランチ上のblobが差分の起点と食い違うファイルは、未選択のdevelop変更に
   依存しているため**競合として止め**、理由（ファイル名）を返す。`package.json`・ロックファイルが
   該当するときは、依存を安全に分離できない旨と、候補を加えるか出し直すかを案内する
2. `package.json`のversionを、**既存タグと重ならない次のパッチ版**へ上げる（タグは作らず動かさない）
3. mainとの最終差分が「選択PRが触れたファイル＋`package.json`」だけであることを検証し、外れれば
   PRを作らずブランチを消す

**マージ後の整合**: mainのversionがdevelopより上がるため、通常リリースの状態判定（main版 != develop版
＝バンプ済み）が誤作動する。復旧PRのマージ後、リリース前に**developのversionをmainと同じか上へ揃える**
こと（復旧PR本文にも書く。自動化は未対応）。

## 復旧系列に限り、main向け復旧PRを自動マージする（#4006）

「AIに修正を依頼」（#3998）の開始時に、開始者が「mainへのマージまで自動で進める」（`scope=fix_until_main`）
を選んだ系列だけが、修正PRのdevelopマージ後に`awaiting_main_merge`へ進み、次を行う。これが
「main反映は人が行う」の唯一の限定例外で、通常リリースのルールは変えない（ルールの全文は`CLAUDE.md`
「自動マージ不可カテゴリ」）。

1. 修正PRだけをmain起点の復旧PRへ取り込む（`createDeployRecoveryPullRequest`。#4005の差分限定）。
   このとき復旧PRの番号・ブランチ・HEAD・main先端（base）・変更ファイルを系列へ記録する
2. 巡回のたびに、復旧PRの**現在のHEAD**のCI・mainの**現在の先端**・PRの現在の差分を観測し直し、
   `decideRecoveryMainMerge`で判定する（権限は系列の記録だけ。ラベル・PR本文は使わない）
3. 合格したら、停止・期限切れと競合しない条件付き更新で`releasing`へ進めてから、HEADのSHAを添えてマージする

止まる条件（`needs_attention`＋修正Issueへ引き継ぎコメントと`00.check-user`）: 停止・期限切れ・範囲外・
復旧PRの不一致・HEAD変更・main前進・コンフリクト・差分が記録外・CI失敗・人の確認ラベル・別リリースによる置換済み。
マージ後の稼働版の確認（`recovered`）は#4007で足す。

## リリース完了系列に限り、リリース候補を本番へ自動マージする（#4480）

リリース候補（`release-main/v*`→main）の全体レビューの指摘・統合検証の失敗から、画面の「リリース完了まで進める」で
開始する系列（`ReleaseCompletionRun`）。開始者が「本番反映・稼働確認まで」（`scope=until_production`）を選んだ系列
だけが、上の復旧PRと並ぶ**もう1つの限定例外**として、記録した候補1本を本番mainへマージする（ルールの全文は
`CLAUDE.md`「自動マージ不可カテゴリ」）。「チェック通過まで」（`until_ready`）を選んだ系列・系列の外のリリースは
従来どおり人がマージする。

- **追う候補は系列が記録したものだけ。** 起点の候補と、修正系列（`ReleaseFixSeries`）が作り直した後継
  （`successorPrNumber`・`successorHeadSha`）だけに追従する。系列の外で候補が作り直された・閉じられた・HEADが
  動いたときは追わずに`needs_attention`で止める
- **マージ直前に観測し直す。** 候補の現在のHEAD・base・mainの先端・CI・検証記録を取り直し、`decideCompletionMerge`で
  判定する。全体レビュー・統合検証は**強制ありで**`evaluateReleaseMergeGate`を評価し、`ready`のときだけ通す
  （要確認・未実施・旧SHAの結果は通さない。画面の明示確認で通せるのは人だけ）。Mac検証は合格か対象外（設定なし）だけ
- **mainが進んだら止める。** 検証済みの前提（base）が変わっているので、無関係なリリースの先行も含めて自動では
  進めない。候補の作り直しは人が行い、作り直した候補では検証をやり直す
- マージは条件付き更新で実行権を取ってから、記録したHEADのSHAを添えて行う（GitHubがHEAD不一致を409で弾く）。
  マージ後は`recordDeployLaunchWatch`で起動漏れを見張り、#4007と同じ`decideDeployRecoveryRelease`でdeployと
  稼働SHAを確かめて完了にする

## リリース起動確認でPRごとのレビューを出す（#4245）

リリースworkflowの起動確認（PC・スマホ共通の`ReleaseChangeList`）は、「今回反映する内容」の各PR行に、PR作成時に
本文へ記録された`## 検証結果`の判定（自動レビュー・機械的リスク・判定時点の鮮度）を出す。本番マージ確認の
「コードレビュー」（`PullRequestMergeReview`）と同じ語彙・同じ`VerdictText`を使う。**表示専用で、起動の可否は変えない。**

- 本文は`GET /api/repositories/release/changes`が取る。`base=develop`のclosed PR一覧（1回・ETag）から引き、足りない
  PRだけ`fetchPullRequest`で補う（上限20件）。取れなかったPRは**「記録なし」ではなく「取得不可」**として出す
- バージョンバンプPRはレビューの対象ではないので判定を出さず、内訳の分母にも入れない（`tallyChangeReviews`を再利用）

## リリース候補の作り直しの操作履歴を残す（#4359）

「自動で作り直しました」というコメントだけでは、手動の追加承認があったのか、関連修正だけで自動に進んだのかが分からなかった（#4345）。
作り直しの操作ごとに追記専用の記録`ReleaseRebuildEvent`を残し、ブランチ画面・スマホのリリースシートの
「リリース候補の作り直しの履歴」（`ReleaseRebuildHistoryPanel`）が読む。**取得はDBだけ**でGitHub APIは叩かない。

- **種別**: `approval`（手動の追加承認）・`decision_waiting`（判断待ち）・`rebuild_started`・`rebuild_failed`・`successor_created`・`stopped`・`superseded`（元候補の取消・置換）
- **契機（`trigger`）**: `manual`・`resume`・`fix_series_related`（関連修正のみの自動）・`fix_series_after_approval`（手動承認を根拠にした自動。承認イベントのidを`payload.approvalEventId`へ持つ）・`sweep`・`workflow`
- **承認範囲は承認時点のものを保持する。** 承認できるのは判断待ちにした時点で示したPR（`decision_waiting`の`pendingPrs`）と修正PRだけで、承認の操作までに入ったPRは承認済みにならない。判断待ちの範囲を記録していない既存の待ちは、承認時点の候補全体を範囲にし、その旨を理由に残す
- **重複は`dedupeKey`のユニーク制約で1件に絞る**（二重クリック・巡回の重なり・再起動後の再実行）。承認は`status: awaiting_decision`の条件付き更新で、同時の承認・巡回に負けた側は何も書き換えない
- **記録が無い履歴は「操作経路不明」と出す。** 後継候補だけが残る既存の修正系列は、画面側で合成して補い、承認や操作者を推測しない
- 後継候補は、修正系列の巡回と、リリース準備の完了報告（`notify-prepared`）で観測して記録する
- 記録の失敗は本処理を止めない。理由は機密除去してから保存する

## 正式版から独立したリリース候補（#4495）

正式版を上げる前にリリース候補を固定し、レビュー・統合検証・修正を同じ論理候補の中で繰り返す（親: #4494）。
旧方式（`release-main/vX.Y.Z`）は版を上げてから候補を作り、作り直すたびにバンプの取り消しと再生成が伴っていた。
新方式では版は公開準備（#4496）で確定し、候補の作成・修正では正式版・公開タグ・公開用の更新履歴を作らない。

### 候補とrevision

| 記録 | 何を持つか |
| --- | --- |
| `ReleaseCandidate` | リポジトリ内の候補番号（`RC-<番号>`）・段階（`phase`）・固定したdevelopのSHAと対象PR・固定範囲外から承認したPR・現在のrevision |
| `ReleaseCandidateRevision` | 作成・関連修正の取り込み・移行ごとの1行。要求キー・前提にした直前のhead・足したPR・適用後のPR番号とbase/head・失敗理由 |

- ブランチは`release-rc/<番号>`（版を入れない）。判定は`src/lib/release-branch.ts`に1か所にまとめ、`release-main/`を直書きしない。
  検証・マージゲート・修正系列・完了系列・本番PR詳細は旧方式と新方式の両方を対象にし、凍結ブランチを閉じて消す旧方式の作り直し（#3014）だけが旧方式に限る
- **revisionは同じブランチへ早送りで積む。** 物理PRは原則変わらず、headが変わるので既存の検証記録（PR番号＋base/head SHA）がそのまま「旧revisionの結果は現在の合格にしない」を満たす。PRを作り直した場合もrevisionの`prNumber`で追える
- 初回は「headが固定したdevelopのSHAそのもの」、2回目以降は「直前のheadから早送り」のときだけ適用する（`decideRcReport`）。版上げ・範囲外のコミット・履歴の書き換えはここで弾く
- 候補PRは版を上げる前なので`version-tag-check`が必ず赤になる。**マージ防止としてそのまま残し**、PRはdraftで作る（公開準備で解消する。下の「公開準備（正式バンプ。#4496）」）

### 状態

画面・APIに出す状態は12種（作成中・検証待ち・検証中・要修正・修正中・公開準備可能・公開準備中・本番承認待ち・本番反映中・稼働確認中・完了・中止）。
**記録するのは段階（`creating`・`review`・`preparing`以降）だけ**で、`review`の間の5つは現在revisionの検証結果と未完了の更新から`deriveRcStatus`が導く（記録と実データを食い違わせないため）。

- 合否は`evaluateReleaseMergeGate`（強制あり）を、候補PRの現在のbase/headで評価する。旧revisionの合格・遅れて届いた結果・`unverifiedScope`付きの合格は公開準備可能にしない
- 候補ブランチのheadが記録したrevisionのheadと違う（記録に無いpush）ときは合格にせず、理由を出す
- 段階の遷移表は`canTransitionRcPhase`。mainへのマージ以降は取り消せない

### 冪等性・再起動・取消

- 作成・取り込み・移行は画面が生成する**要求キー**で冪等にする（候補・revisionの`requestKey`のユニーク制約）。二重押し・再送は既存を返す
- 同じリポジトリの候補は`activeKey`で1本、同じ候補への更新は`pendingKey`で1本
- workflowの報告（`POST /api/dispatch/release-rc`）は要求キーと結果の種別しか信じず、候補ブランチをGitHubから取り直して照合する。**報告が届かなくても、画面の読み込み（`GET /api/repositories/release/rc`）で同じ照合をして取り込む**。2時間結果が無ければ`expired`にしてやり直せるようにする
- 更新に失敗しても`currentRevision`は進めない。元のrevision・選択・承認は残る。取消は段階を`cancelled`にし、候補PRは理由を書いて閉じる（ブランチと記録は残す）

### 取り込みの承認範囲

関連修正（その候補の修正系列#4317の修正PR）だけは承認なしで取り込める。それ以外は、要求で明示的に承認した番号に限り、承認者・時刻を`approvedExtraPrs`へ記録して取り込む（`decideRcImport`）。依存PRを自動で足さない。PRごとの検証は既存の`checkRebuildPullRequest`を使う。

### 旧方式との共存と移行

- 開いている`release-main/v*`の候補は**閉じず、バンプも取り消さない**。その間は新方式の候補を作らない（`legacy_open`）
- 本番PR詳細に「旧方式の候補」と出し、このまま旧方式で完了させるか「新方式へ移行」を選べる。移行は、候補の先端が`vX.Y.Zをリリースする。`の1コミットのときだけ、その親（版を上げる前の固定点）から新しい候補を作り、作れた後にだけ旧PRを閉じる。作り直し・履歴修復で積まれた候補は固定点を推測しないので移行できない
- 移行した場合、developには旧方式のバンプが残る。公開準備は版ファイルを**公開済みのmainの内容へ戻してから**書き換えるので、版は整合する。旧バンプが更新履歴ファイルへ足した内容は、その版の文面としてlifecycleが作り直す

### 公開準備へ渡す契約

`buildRcFinalizeContract`は現在revisionが公開準備可能のときだけ、候補ID・候補番号・revision・PR番号・base/head・固定したdevelopのSHA・含めるPR番号を返す。公開準備はこれを固定の入力として扱い、developの最新を取り込まない。

### workflowの候補モード（`candidate-request`）

`reusable-release-develop-to-main.yml`は`candidate-request`入力（手動起動のみ）を受け取ると、旧方式の処理（バンプ・`release-main/v*`）を一切行わず、次だけを行う。結果は最後のステップが要求キーと種別だけを`POST /api/dispatch/release-rc`へ報告する（旧方式の`notify-failure`は動かさない）。

- `mode=create`: 固定SHA（developの祖先であること）をそのまま`release-rc/<番号>`としてpushし、main向けの**draft PR**を作る。既にブランチがあれば同じ内容のときだけ受け付け、書き換えない（再実行で同じ結果）
- `mode=import`: 候補ブランチの先端が要求の前提（直前revisionのhead）と一致するときだけ、選んだPRを当てて早送りでpushする。当てる処理は旧方式の選択的作り直しと**同じ関数`apply_selection`**（#4335の`cherry-pick -m 1`・範囲外ファイルの検査・#4452の履歴修復）で、取り込み用の別ループは作らない。force pushはしないので、途中で候補が動いていればpushが拒否される
- 新方式の候補PRが開いている間は、schedule・push・手動起動の旧方式の処理（バンプPR・`release-main/v*`の作成）をしない。開いている旧方式の候補がある間は、issue-deckが新方式の候補を作らない。どちらか一方だけが進む

**状態判定の`run`ブロックはActionsを回さずに確かめられる。** 再利用ワークフローは配布先のチェックアウトで動くため`.github/scripts/`の共通スクリプトを読めず、処理はinlineのbashに置いてある（同じ処理を2経路で使うときは、同じ`run`の中でbash関数に切り出す）。YAMLから`id: state`の`run`を取り出し、`gh`をPATH上のスタブに差し替えて、bareのoriginとcloneで作ったgitサンドボックスで実行すると、分岐ごとのpush先のSHAと`GITHUB_OUTPUT`を確認できる（#4495で作成・取り込み・古い前提の拒否・旧方式の回帰をこの方法で確かめた）

### 修正系列・完了系列との接続

- 修正系列（#4317）は、候補が新方式なら作り直し（`requestSelectiveRebuild`）の代わりに`requestRcImport`で同じ候補へ修正PRを取り込む。要求キーは系列と前提headから決める（`rcFixSeriesRequestKey`）ので、巡回の重なり・再起動で二重に依頼しない。取り込みが適用されたら、そのrevisionのPR・SHAを「後継」として再検証へ進め、失敗・失効なら理由付きで止める（候補と元のrevisionは残る）
- リリース完了系列（#4480）は、同じPR番号でもheadが進んだ後継を追い、取り込み中（`rebuilding`）にheadが動いても止めずに待つ。後継へ進む更新はheadも条件にして二重に進めない
- 内部確認（#4410/#4478）・次世代の起案・本番マージ・deploy追跡は既存のまま使う。新しいレビュー・復旧のループは作っていない

### callerの対応世代と段階展開

世代を表す専用の印は無いので、`rebuild_selection`（#4335）と同じく**developのcallerに`candidate_request`のinputと`candidate-request:`の受け渡しがあるか**で判定する（`parseRcCallerSupport`）。未対応・読めないときは理由付きで「旧方式で動作中」と出し、作成・移行の要求は`caller_unsupported`で断る。

**未有効化の候補機能を、利用可能な新機能として更新案内へ載せない**（#4551）。生成済み案内が実態と食い違った場合は、develop向けの訂正PRでリリースノートと画面内更新履歴を揃え、生成済み文面の訂正理由をIssueに残す。リリース候補を作り直す際も未有効化の説明を維持する。

**callerの有効化は公開準備（#4496。reusable側・サーバー側は実装済み）をcallerへ配線してから行う。** 新方式の候補が開いている間は旧方式のリリースが止まるため、版を確定して公開する経路が無いうちに有効化すると、移行した候補を公開できなくなる。reusable側の候補モードは任意入力なので、callerを変えない限り配布先・issue-deck自身の挙動は変わらない。

段階展開の手順（#4496の後。callerには`candidate_request`に加えて`finalize_request`のinputと`finalize-request:`の受け渡しも足す）:

1. issue-deck自身のcaller（`.github/workflows/release-develop-to-main.yml`）へ`candidate_request`のinputと`candidate-request:`の受け渡しを足し、作成・取り込み・取消・旧方式の移行・公開までを確認する
   - **配線済み（#4567）**: issue-deck自身のcallerには`candidate_request`・`finalize_request`の両inputと`candidate-request:`・`finalize-request:`の受け渡しがある（push・schedule起動では空文字）。通しの確認（作成→取り込み→公開準備→最終CI→本番承認→mainマージ→deploy→稼働版→同期PR、公開前の再試行で版が増えないこと）は実リリースを伴うため、人が実施する
2. `develop`→`main`のリリースを通し、画面の「新しいタグを切って配る」でタグを切る
3. 対応させるリポジトリのcallerへ`candidate_request`のinputと受け渡しを足すPRを、リポジトリごとに出す（一括で配らない）
4. 戻すとき（復帰）は、そのリポジトリのcallerから`candidate_request`を外す。判定が未対応へ戻り、以後は旧方式で動く。作成済みの候補の記録は残り、開いている候補PRは画面から取り消してから旧方式のリリースを起動する

### 通常の開始操作の接続と、リポジトリごとの展開状況（#4604）

ブランチ画面・スマホのリリースシート・一括の開始操作は、**起動の直前にサーバーで開始方式を取り直し**（`GET /api/repositories/release/start-mode`、判定は`src/lib/release-start-mode.ts`）、次のように振り分ける（入口は`requestReleaseStart`〈`src/lib/release-request.ts`〉に1本化）。

| 開始方式 | 条件 | 個別・スマホ | 一括 |
| --- | --- | --- | --- |
| 新方式（`candidate`） | callerが`candidate_request`と`finalize_request`の**両方**に対応 | 「候補を作成して検証」＝`POST /release/rc` create（版は上げない） | 候補を作成 |
| 未対応（`legacy`） | どちらかに未対応 | **起動しない**（更新が要るcallerと参照タグを表示） | 起動しない（理由を表示） |
| 判定不能（`unknown`） | callerを読めない・取得失敗 | 押せない（理由を表示） | 起動しない |

**通常開始は新方式を既定とし、旧方式へは落とさない**（#4623）。唯一の例外は本番デプロイ失敗中の「修正リリース」（`allowFailedDeploy`）で、新方式の候補作成が失敗中デプロイを扱えないため、確認チェックを付けた明示操作に限り旧方式で起動する（`requestReleaseStart`の分岐）。**旧方式の進行中候補は保持**し、画面の「新方式へ移行」で明示移行するか旧方式のまま完了させる（自動削除・二重作成はしない）。

- 候補作成だけ対応で公開準備が未対応のrepoは新方式にしない（候補を作っても公開できなくなるため）
- 要求キー（`requestKey`）は操作ごとに作り、失敗後の再送では同じ値を送る。進行中の候補（`rc_active`）・旧方式の候補（`legacy_open`）はサーバーが拒否し、画面は既存候補の検証・修正・公開準備か「新方式へ移行」へ案内する。定期処理からは候補を作らない（#4599）
- 新規repoの雛形（`src/lib/new-app/scaffold-workflows.ts`）のcallerは、`candidate_request`・`finalize_request`の両方を持つ

**展開状況**（2026-10-13・#4623の棚卸し。caller更新はリポジトリごとのIssue・PRで行い、一括で配らない。「反映」は配布先のdevelopへのマージ、「通し確認」は実リリースでの確認で、両者は別）:

| repo | 参照タグ | 版ファイル・bump | caller | 展開Issue・PR | 反映 | 通し確認 |
| --- | --- | --- | --- | --- | --- | --- |
| issue-deck | ローカル | `package.json` | 配線済み（#4567） | — | 済 | 未（人が実施） |
| kurashio | v51 | `frontend/package.json`・iOS差異あり | 配線済み | guchi-apps/kurashio#792・PR#793 | 済 | 未（代表ケース） |
| yoteiflow | v51 | 既定（`package.json`） | 未対応 | guchi-apps/yoteiflow#1241 | 未 | 未 |
| asset-manager | v51 | 既定 | 未対応 | guchi-apps/asset-manager#748 | 未 | 未 |
| portfolio | v51 | 既定 | 未対応 | guchi-apps/portfolio#197 | 未 | 未 |
| solitaire | v51 | 既定 | 未対応 | guchi-apps/solitaire#183 | 未 | 未 |
| car-care | v51 | 既定 | 未対応 | guchi-apps/car-care#251 | 未 | 未 |
| stockly | v51 | 既定 | 未対応 | guchi-apps/stockly#145 | 未 | 未 |
| work-relay | v51 | 既定 | 未対応 | guchi-apps/work-relay#296 | 未 | 未 |
| status-hub | v51 | 既定 | 未対応 | guchi-apps/status-hub#601 | 未 | 未 |
| morrow | v51 | 既定 | 未対応 | guchi-apps/morrow#561 | 未 | 未 |
| db-console | v51 | 既定 | 未対応 | guchi-apps/db-console#214 | 未 | 未 |
| meisai-lab | v51 | `--ignore-scripts`付きの個別bump | 未対応 | guchi-apps/meisai-lab#293 | 未 | 未 |
| clip-hive | v51 | `--ignore-scripts`付きの個別bump | 未対応 | guchi-apps/clip-hive#201 | 未 | 未 |
| signaly | v51 | `version.json`＋`bump_version.py` | 未対応 | guchi-apps/signaly#342 | 未 | 未 |
| pi0w | v51 | `version.json`＋`bump_version.py` | 未対応 | guchi-apps/pi0w#29 | 未 | 未 |
| aide | v51 | `package.json`＋iOSのXcode版同期 | 未対応 | guchi-apps/aide#650 | 未 | 未 |

`pi0w_260719`はアーカイブ済みのため対象外。この表は反映状況の記録で、**各repoの反映・通し確認が残る間は、issue-deck側のPRのマージだけで全展開完了にしない**（本番承認待ち・反映済み・未検証を区別して報告する）。

対象外（理由付き）: アーカイブ済み（pi0w_260719）、およびdevelopにリリースworkflowのcallerを持たず本番リリースが無いrepo（docs・subpc・vps・ideas・claude-config・question・gucchii-os・uptime-kuma・sensor_260531・sensor_260218・wifi-speed。2026-10-13時点）。未対応を「対応済み」と表示しない（画面は`legacy`と理由を出す）。

## 公開準備（正式バンプ。#4496）

合格した候補（#4495）だけを、公開の直前に正式バンプする。レビュー・修正の間は版を上げない。
外部操作は`src/lib/release-finalize-run.ts`、判断は純関数の`src/lib/release-finalize.ts`、画面は`ReleaseRcFinalizePanel`が持つ。

### 流れ

1. 画面の「本番公開へ進む（公開承認）」（`POST /api/repositories/release/finalize`の`action=start`・`approvePublish: true`）。**これが唯一の公開承認**（#4666。下の「公開承認」）。押した時点の候補のhead・mainの先端・合格した契約（`buildRcFinalizeContract`）が全て一致するときだけ受け付ける（`decideFinalizeStart`）。要求の時点で段階を`review`→`preparing`へ条件付きで進める
2. 上げ幅は手動指定（patch/minor/major）か自動判定。**手動指定は要求の時点で版を予約**し、**自動判定はworkflowが差分から判定してバンプしたあと、サーバーが版から上げ幅を逆算して予約**する。予定の版は点線、確定した版は実線で出し、確定前の値を確定済みと混同しない
3. `finalize-request`（`reusable-release-develop-to-main.yml`の`finalize`ジョブ。`release`ジョブは動かない）が、候補ブランチへ版の書き換え・更新履歴だけの**1コミットを早送りで積む**。最新developの変更は取り込まず、force pushもしない。`version-file`・`version-query`・`bump-command`・`RELEASE_CHANGELOG`/`RELEASE_USAGE`は旧方式と同じ契約で、リポジトリ差異はcallerの設定を読む（`parseFinalizeCallerSupport`）
4. 報告（`POST /api/dispatch/release-finalize`）は要求キーと結果の種別だけを信じ、早送り・版ファイルの版・変更ファイルをGitHubから取り直して照合する（`decideFinalizeReport`）。届かなくても画面の読み込みで同じ照合をする
5. 適用したら、バンプ後のheadを`finalize_bump`のrevisionとして記録し（修正工程へ戻っても候補の履歴が途切れない）、候補PRのdraftを解除する。**バンプ後のheadで最終CI・ビルド（`version-tag-check`を含む）が成功し、再実行が必要な検証が全て合格したとき**だけ段階が`awaiting_approval`へ進む（`decideFinalizeReadiness`）
6. mainマージは、承認者を開始者とした`until_production`のリリース完了系列（#4480）が既存のPR保護・`release-merge-gate`・必須チェックを通して行う（二度目の本番承認は求めない）。バンプ差分だけで合格・保護を迂回しない

### 検証対象の分離と引継ぎ

- 検証行（`ReleaseVerification`）はPR・base・head・種別が対象のキーで、**バンプ前のheadの行は書き換えない**
- 引継ぎの判定は`decideInheritedVerification`。引き継ぐのは**バンプ前が合格（未確認範囲なし）で、mainが進んでおらず、バンプの差分が版ファイル（と同じ階層のロック）・更新履歴だけ**のときに限る。iOSの設定・依存関係・その他のコード・設定が変わった場合は再検証する。iOS（Mac）検証が必要なリポジトリ（`macBuildCheck`）は、統合検証をバンプ後のheadで必ず再実行する。判定できなければ再検証する
- 判定と根拠（元のbase/head・バンプ後のbase/head・変更ファイル・理由）は`ReleaseCandidateFinalization.handoffEvidence`へ残す。検証の読み取り（`listReleaseVerificationRecords`・`listReleaseVerificationDetails`）が、証跡と元の結果が今も合格であることを確かめたうえで**バンプ後の対象に対する派生の記録**として足し、`inheritedFromHeadSha`と「バンプ後のheadで実行した結果ではありません」の注記で区別する。**旧SHAの結果を新SHAの実行結果へ書き換えない**
- 再検証が必要な種別だけを、バンプ後のheadで依頼する（引き継いだ種別の行は作らない）

### 版の予約（`ReleaseVersionReservation`）

- 起点は常に**mainの版**。developの版は見ない（公開後のdevelopは古いので、起点にすると公開済みの版を「バンプ済み」と誤判定する）
- 計算した版がタグ・消費済み・他の候補の予約にあれば欠番にして次のpatchへ進める（上書きしない）。同じ版を2候補が取れないことは`@@unique([repositoryFullName, version])`が止める
- **公開前の失敗・再試行では予約を保ち、版を増やさない。** 候補が既に予約した版でバンプ済みなら、新しいコミットも作らずそのまま確定する。候補を取り消したときは、タグ・main上に無いことを確かめて手放し（`released`。再利用してよい）、あれば消費済みにする
- mainへマージした版は`consumed`（マージSHA・タグを記録）。以後再利用せず、本番に既に出た版のコード修正には新しい版を付ける

### 失敗・鮮度

- バンプ後の最終CI・再検証が失敗したとき、公開準備の記録が失敗として残り、候補は同じ`review`へ戻る（修正工程）。予約は保つ
- バンプ後に候補のheadが動いた・mainが進んだときは、公開準備を`superseded`にして`review`へ戻し、検証と承認を取り直す
- 完了系列（#4480）は、**記録したバンプ前→バンプ後のheadの更新だけ**を後継として追う（`decideReleaseCompletion`の`finalization`。修正系列の`successorHeadSha`と同形）。それ以外のhead変更は従来どおり`candidate_changed`で止まる。新方式の候補は、段階が`awaiting_approval`（公開準備と最終検証が済み）でバンプ後のheadと一致するときだけマージの評価へ進む（`isFinalizationReady`）。公開準備を始める（＝公開承認）のは人の操作で、系列は代わりに押さない
- マージ後は、deployの成功**と稼働中の版の一致**（`decideDeployRecoveryRelease`）を確かめるまで`completed`にしない。失敗・不一致は段階を進めず、既存の本番復旧（#4451）が追う。Web本番とTestFlight配布は別の結果で、build番号は正式版と混ぜない

### 公開承認（#4666）

RCから本番公開へ進む確認は**公開準備の開始の1回だけ**にし、最終検証の後に同じ内容の「本番承認」をもう一度求めない。判断は純関数`src/lib/release-publish-approval.ts`、外部操作は`release-publish-approval-run.ts`、記録は`ReleasePublishApproval`。

- **承認の範囲**: 押した時点の候補（revision・PR・base/head）・版指定方針・公開内容と、想定した正式バンプ（版ファイル・更新履歴だけの変更。`allowedChanges`）まで。確認画面にこの範囲と「合格後は自動で本番公開する」ことを全部出してから押させる。古い画面からの`start`（`approvePublish`なし）は`approval_required`で拒否し、承認として扱わない
- **自動継続**: 承認と同時に、承認者を開始者とした`until_production`の完了系列を承認専用の入口（`ensurePublishApprovalRun`。初期状態`checking`・`publishApprovalId`付き）で作る。復旧用の`startReleaseCompletionRun`（問題の無い候補は`nothing_to_recover`）とは混ぜない。同じ候補の復旧系列が進行中ならそれへ紐付け、別の候補の系列が進行中なら承認を受け付けない。巡回はpoller（`runReleaseCompletionSweep`）が回すので、画面を開いておく必要はない
- **承認由来の系列は修正Issueを起動・起案しない。** 検証の失敗は`approval_checks_failed`、未判断の止める指摘は`approval_review_undecided`（#4657の判断で解除されれば止めない。公開承認を指摘の採否と混同しない）、公開準備の失敗は`finalize_failed`で理由を示して止める。CI・`22.merge-confirm-required`・mainの保護は既存どおり止める
- **失効**: 巡回ごとに`decidePublishApprovalValidity`で照合し、バンプの差分が範囲外（差分のファイルを残す）・範囲外のhead（候補の更新・置換）・mainの前進・候補の取消・期限（24時間。系列の期限と揃える）なら承認を`invalidated`にして系列を止める。範囲内のバンプ後headでは失効させない
- **再試行**: 検証の失敗・取得不能・マージの失敗など、同じ処理をやり直せば済む停止（`APPROVAL_RETRYABLE_STOP_REASONS`）では承認を保つ。公開準備のやり直し（同じpre head/base、または範囲内のバンプ後head）は同じ承認を使い回し（`isWithinApprovalTarget`）、停止した系列は「自動公開を再開」（`action=approve`）で承認し直さずに作り直す。対象が変わった停止・取消では承認ごと終える（計画レビューG1の「停止したら承認も失効」は、再試行で再承認を増やさない要件に合わせてこの区別へ改めた）
- **取消と二重実行**: マージ直前に承認を`active`→`merging`へ条件付きで確保できたときだけマージし、成功で`consumed`、失敗で`active`へ戻す。取消（`action=revoke`）は`active`→`revoked`の条件付き更新で、確保と競合したらどちらか一方だけが進む。系列を「停止」したときも承認を取り消す。承認済みの候補は手動のマージ（`decideRcPublish`の`rc_auto_publishing`）を並べない
- **既存候補の移行**: 承認の記録が無い公開準備済みの候補は「公開準備済み」から承認を推定せず、パネルで1回だけ承認を求める（`action=approve`。対象はバンプ後のheadとそのbase）
- **表示**: パネルの工程は「公開承認」（承認済み・失効・承認が必要）、承認欄は`describePublishProgress`の「最終検証中／自動公開待ち／自動公開が停止（理由）／本番反映中／稼働確認中」。承認済みの候補の段階表示は「本番承認待ち」ではなく「自動公開待ち」（`deriveRcStatus`の`publishApproved`）
- 共有workflowの配布・callerの変更は不要（`finalize_request`の受け渡しは既存のまま）

### 公開後のdevelop整合

- 新方式のバンプ・候補上の修正・競合解消はdevelopへ入らないまま公開される。公開後に、mainの内容をdevelopへ戻す同期PRを作り、同期されるまで次の候補は作らない（#4641。判定は`src/lib/release-develop-sync.ts`、観測・作成・巡回は`release-develop-sync-run.ts`）
- **判定の正は実際のGit履歴で、DBの記録（版の予約・公開準備）は見ない。** 記録の無い手動公開・取消・外部マージ・hotfixのmain直接マージでも、mainにだけある変更が残っていれば未同期になる。同期済みとみなすのは次のどれかだけ
  1. mainの先端がdevelopの祖先（`develop...main`の`aheadBy`が0）
  2. 祖先でなくても`develop...main`の3点比較で変更ファイルが0（旧方式のマージコミットだけ）
  3. マージ済みの同期PR（本文の`<!-- issue-deck-develop-sync:main=<SHA> -->`）があり、そのSHA以降mainに変更ファイルが無い。**squash・rebaseでマージするとmerge-baseが進まず1・2では同期済みにならない**ための救済で、同期PRは本来マージコミットでマージする
- GitHubから取得できないときは**判定不能**（`develop_sync_unknown`）で、同期済みと推定して候補を作らない
- 同期PRのheadは`main`ではなく、mainの先端から切った`release-sync/main-<SHA12>`。競合したらこのブランチへdevelopを取り込んで解消する（mainへpushしない・developを上書きしない）。ブランチ名がmainのSHAで決まり、開いている同期PR（以前のhead=mainのものも含む）があれば作らないので、巡回が重なっても1本にしかならない。同期PRの作成後にmainが進んだときは、そのマージ後に残りの同期PRを作る
- 同期PRは通常のdevelop向けPRとして既存のCI・レビュー・マージ保護を通る（`issue-<番号>`ブランチではないため`claude-review-develop.yml`の自動マージの対象外）。**マージは`runDevelopSyncSweep`が自動で行う**（#4669）。条件は専用ブランチ（`release-sync/*`。旧head=mainは対象外）・PRのHEADが今のmainの先端と一致（追いコミット・競合解消なし）・変更が`package.json`・`src/lib/changelog.ts`・`.github/release-notes.md`・iOSの`project.pbxproj`だけ（ワークフロー・コード等を含むときは人）・競合なし・CI成功・自動レビューの判定（`passed`か`skipped`）が出揃い要修正/要確認が現HEADに無い・`00.check-user`/`22.merge-confirm-required`が無い、のすべて（判定は純関数`decideDevelopSyncAutoMerge`）。HEADのSHAを指定してマージコミットでマージし、満たさないものは従来どおり人がマージする（失敗しても例外にせず次の巡回で再判定）
- 同期PRの版更新による`push`は次のリリース開始の承認ではない（#4650）。mainとdevelopが同じ版ならコード差分が残っていても新規バンプを開始せず、旧方式の版判定・patchフォールバック・バンプPR作成の3ステップも`workflow_dispatch`に限定する。既存の旧方式バンプ後（developの版がmainより新しい）のリリースPR作成は維持する。この共通workflowの修正は公開した配布タグの参照更新まで各repoへ反映されないため、callerの入力追加だけで完了としない（全展開の追跡: #4651）。
- 追跡は公開処理の段階から独立している。呼び出し元は本番反映の追跡（`advanceProduction`）・pollerの巡回（`deploy-recovery-series/sweep`へ相乗りする`runDevelopSyncSweep`。候補を使ったことのあるリポジトリを5分おき）・候補作成（`createReleaseRc`の中で判定するのでAPI以外の経路からも迂回できない）・画面の「同期PRを作成」の4つ。作成の失敗理由はプロセス内にだけ持ち、巡回が再試行する
- 画面は開始前の案内（`start-mode`の`develop_sync`。PCの個別ボタン・スマホのシート・一括）と、本番反映以降の候補の本番PR詳細に「developへの同期」欄を出す。**公開結果とは別の欄**で、同期できていないことを本番公開の失敗とは表示しない。承認・全体レビューの記録は作らない
- 共有workflowの状態判定は、**developの版がmainより古い**ときを「バンプ済み」とみなさない（古いリリースPRを作らない）

### 二重実行しない

要求キーのユニーク制約・同じ候補への未完了を1本に絞る`pendingKey`・段階と状態の条件付き更新・早送りのみのpush・版の予約のユニーク制約・同じheadでバンプ済みなら何もしない、で重ねる。workflowの途中失敗・再起動・報告の重複・画面の二重押しで、バンプ・マージ・タグ・deployは二重に実行されない。

### 範囲外（別Issue）

callerへの`finalize_request`の配線と実リポジトリでの通し確認（段階展開）、TestFlight配布結果の記録は含まない。

## リリース画面の候補中心の並び（#4560）

本番PR詳細（`release-pull-request-overview.tsx`）とスマホリリースシート（`mobile-release-sheet.tsx`）は、候補の識別（RC-n・revision・base/head）→ 状態と次の操作 → 候補共通検証 → 公開対象 → 履歴の順に並べる。

- 候補共通検証の下に「検証の根拠」（`release-rc-evidence.tsx`）を置き、バンプ前（検証対象）とバンプ後（最終ビルド対象）のbase/headを分けて出す。引継ぎは元の結果と差分根拠を出し、バンプ後のSHAで実行したとは書かない
- 候補の改訂履歴は新しい順
- ブランチ一覧の束の見出しに「現在の本番版」「次のリリース候補」「旧方式で進行中」のバッジを出す（`branch-flow-view.tsx`）
- 未対応: リリース履歴から候補への導線・旧リンク解決は別Issueで扱う

## 現在の候補と次の操作を最上部に集約する（#4635）

#4560の並びを、ブランチ画面の「次のリリース」・本番PR詳細・スマホリリースシートで揃えた。**現在のリリース候補（RC名・状態・停止理由）と主操作 → 候補の検証結果 → 今回公開する変更 → 現在の本番版・履歴**の順で、本番版（本番稼働中・再デプロイ）は補足として後方に置く。

- **工程と操作の判定は純関数`release-rc-action.ts`が1か所で持つ。** `decideRcPublish`（公開してよいか）を画面（`release-publish-action.tsx`）とマージAPI（`POST /api/issues/pull-request-merge`）が共用し、`describeRcPrimaryAction`が工程ごとの主操作を決める。「本番公開へ進む」を出す・通すのは、段階が`awaiting_approval`・ドラフトでない・PRのheadが公開準備の最終headと一致するときだけ。
- **サーバーの拒否（409）**: `rc_record_missing`・`rc_not_prepared`（公開準備前。次は検証→公開準備）・`rc_preparing`・`rc_draft`・`rc_pull_request_unobserved`・`rc_head_mismatch`・`rc_already_published`・`rc_cancelled`。応答に`next`と日本語の`message`を含め、GitHubのmerge APIの405（ドラフト）を利用者に見せない。ドラフト解除だけでは公開準備を飛ばせない。記録が引けない・ドラフト状態が未取得のときは推測で通さず拒否する。
- **検査対象は新方式（`release-rc/<番号>`）だけ。** 旧方式（`release-main/*`）はRC記録が無いため従来のゲートのみ（`rcSequenceOf(head.ref)`がnullなら検査しない）。
- 合格後・公開準備前の見出しは「公開準備へ進めます」（`describeFixOverview`の`publishBlock`）。公開準備中は「公開準備を進めています」。全体レビューの実行失敗中は「操作は不要です。自動で進みます。」を出さず、再実行へ案内する。
- **最新SHAの結果は現在結果。** `isPreviousVerificationResult`が、系列の状態でなく**表示中の検証結果の対象head**で修正前かを判定する。RCは同じPRのheadが進むため、最新headの失敗・合格を「修正前の履歴」へ隠さない。対象が未取得の間は現在の結果として見せない。
- 新方式で候補があるとき、正式版が決まる前は「未作成」でなく「正式版は未確定」と出す。

## バンプ後の再検証の表示は検証ごとの状態から決める（#4640）

公開準備の「バンプ後の再検証・引継ぎ」は、`describeReverifyItems`／`decideReverifyPhase`（`src/lib/release-finalize.ts`）が検証ごとの状態から決める。**「再検証中」は実行中のジョブがあるときだけ**で、待機は「実行待ち」、終了済みの要確認は「要確認で終了」、失敗・未実施・対象変更はそれぞれ別の表示にする。最終CIの欄にはCI自体の状態だけを書き、未完了の検証は再検証の工程に検証名と理由を併記する。

全体レビューの要確認が統合検証の結果待ち時点の理由を保持し、統合検証が今は終了している場合（`isStaleReviewWait`）は、「前回レビュー時点の理由」として分け、冒頭の主操作を「最新の証跡で全体レビューを再実行」（#4632の再実行導線へ誘導）にする。指摘は消さず併記する。

### マージ済み候補の再確認（#4673）

開始方式の取得は候補の更新要求だけでなく、既存の公開準備・本番追跡も照合する。
`reconcileActiveRcPublication`は同一候補の段階が変化したときだけ最大3巡進める。
マージ、承認、検証の起動は行わず、最終検証・デプロイ・稼働確認の既存条件を維持する。
完了時に解放したactiveKeyを再取得し、その後develop同期ゲートを評価する。
GitHubのマージ事実は古いpreparing/awaiting_approvalより優先して表示するが、マージだけで完了にはしない。
再確認中は古い開始方式を隠し「確認中」を表示する。取得失敗はunknownとなり、候補なしとは扱わない。
