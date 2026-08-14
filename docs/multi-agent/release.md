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
major/minor/patchのいずれでもない不正な場合はpatchにフォールバックする。判断が誤っている
と思われる場合は人間が生成されたPR上でバージョンを直接修正する想定（release-to-mainスキルの
「迷う場合はユーザーに確認する」に相当）。

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
