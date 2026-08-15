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

## バージョンの上げ幅の判定

issueのラベルではなく、main/develop間の実際のコード差分の内容から判定する。専用のClaude
Codeステップ（`claude-code-action`、`--json-schema`による構造化出力）が`git diff origin/main
origin/develop`・`git log origin/main..origin/develop`を確認し、semverに基づき
major/minor/patchのいずれかと判断根拠を返す。判定ステップ自体が失敗した場合や、返り値が
major/minor/patchのいずれでもない不正な場合はpatchにフォールバックする。

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
  （`changelog` → `RELEASE_CHANGELOG`）を作っているため、飛ばすと更新履歴が空になる。
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
  workflow_dispatch: {}
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

バージョンbump用PR（`release/v*` → `develop`）・develop→mainのPR（`develop` → `main`）は
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
