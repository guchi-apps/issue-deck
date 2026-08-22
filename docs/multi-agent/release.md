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

### 対象issue一覧もT0から引き継ぐ

同じ理由で、develop→mainのPR本文の`## 対象issue`は**マージ済みのバンプPR（head
`release/v<版>`）の本文から引き継ぐ**。T1でその場の進捗（`status=develop,release`）を問い合わせ
ると、T0〜T1に入ったissue（リリースには含まれない）まで載る。引き継げなかった場合は従来どおり
その場で問い合わせる。

### 進捗の遷移とcloseの対象

- `main-pr-in-progress`（`Develop` → `Release`）は`opened`の1回だけが実質の掃き寄せになる。
  headが動かないので`synchronize`は発火しない。**リリースPRの作成後にdevelopへ入ったissueは
  `Develop`のまま残り、次のリリースで`Release`へ進む**（それがmainへ出る内容と一致する）。
- `main-pr-merged`（`Done`＋close）の対象は**リリースPR本文の`## 対象issue`に載った番号**。
  Project Statusで探すと、リリースに含まれないissueまで`Develop`として拾ってcloseしてしまう。
  本文から1件も取れなかった場合だけ、従来どおり`Develop`/`Release`のStatusで探す（#2117以前の
  PR・手で作ったPR・PR作成時にissue-deckへ問い合わせできなかった場合の安全網）。

### リリースPRのCIが落ちたときは、ブランチを直さず切り直す

`release-main/vX.Y.Z`はマージ時に自動削除される（`delete_branch_on_merge`）。そこへ直接修正を
pushすると、修正がmainにだけ残りdevelopから消え、次のリリースで巻き戻る。そのため自動修復
（`reusable-claude-pr-repair.yml`）は、headがこのブランチのとき修正の行き先（`FIX_BASE_REF`）を
`develop`にして**develop向けのPRとして出す**。修正はリリースPR自体には反映されないので、
developへ取り込んだうえでリリースPRをcloseし、リリースを起動し直す（新しい凍結ブランチが
現在のdevelop先端で作られる）。

### ブランチ名を変えるときに揃える場所

`release/v`（バンプPR）と接頭辞が重ならない名前にしてある。重なると`classifyPullRequest`の判定順
でリリースPRが`version-bump`に落ちる。

| 場所 | 何をしているか |
|---|---|
| `reusable-release-develop-to-main.yml` | 凍結ブランチのpushとPR作成、既存リリースPRの検出 |
| `reusable-issue-labels.yml` | `main-pr-in-progress`・`main-pr-merged`のhead条件 |
| `reusable-claude-pr-repair.yml` | `FIX_BASE_REF`を`develop`に倒すcase |
| `src/lib/pull-request-list.ts` | `RELEASE_BRANCH_PREFIX`・`isReleaseHeadRef`・`classifyPullRequest` |

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

## バージョンの上げ幅の判定

issueのラベルではなく、main/develop間の実際のコード差分の内容から判定する。専用のClaude
Codeステップ（`claude-code-action`、`--json-schema`による構造化出力）が`git diff origin/main
origin/develop`・`git log origin/main..origin/develop`を確認し、semverに基づき
major/minor/patchのいずれかと判断根拠を返す。判定ステップ自体が失敗した場合や、返り値が
major/minor/patchのいずれでもない不正な場合はpatchにフォールバックする。

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

**issue-deck自身もこの契約の受け取り側になった**（#1764）。`package.json`の`"version"`
lifecycleスクリプト（`scripts/version-changelog.mjs`）が`src/lib/changelog.ts`の先頭へ
エントリを足し、設定 →「更新履歴」に出る。`changelog`は`changes`、`usage`は同じエントリの
`usage`として持つ（`changes`へ混ぜない）。バンプ時に依存はインストールされないため、
スクリプトはNode標準モジュールだけで書き、`preversion`は作らない。

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

## トリガー

`workflow_dispatch`（手動実行）と、**`package.json`の変更を伴う`develop`へのpush**の2つ。

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
  push:
    branches: [develop]
    paths:
      - package.json
```

`schedule`による定期起動はしない（#178）。通常のフィーチャーpushでは`package.json`が変わらない
ため、pushトリガーが発火するのは実質**バンプPRがdevelopへマージされた瞬間だけ**である。この1回で
develop→mainのPRを自動作成し、「バンプPRをマージしたあと、もう一度手で起動する」という手間を
省いている。

**pushトリガーからバンプPRが誤作成されることはない。** `need_bump`系のステップは
`github.event_name == 'workflow_dispatch'`でゲートしてあり、push起点の実行はdevelop→mainのPR作成
だけを行う。

同時実行による二重作成を避けるため、`concurrency`グループで直列化している。

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
