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

## バージョンの上げ幅の判定

issueのラベルではなく、main/develop間の実際のコード差分の内容から判定する。専用のClaude
Codeステップ（`claude-code-action`、`--json-schema`による構造化出力）が`git diff origin/main
origin/develop`・`git log origin/main..origin/develop`を確認し、semverに基づき
major/minor/patchのいずれかと判断根拠を返す。判定ステップ自体が失敗した場合や、返り値が
major/minor/patchのいずれでもない不正な場合はpatchにフォールバックする。判断が誤っている
と思われる場合は人間が生成されたPR上でバージョンを直接修正する想定（release-to-mainスキルの
「迷う場合はユーザーに確認する」に相当）。

## トリガー

`workflow_dispatch`（手動実行）のみ。バンプPR・develop→mainのPR作成は人間の確認なしに
走ってしまうため、developへのPRマージや`schedule`による自動起動はしない（#178）。人間が
GitHub ActionsのUIから`Run workflow`で明示的に実行する。

同時実行による二重作成を避けるため、`concurrency`グループで直列化している（手動実行のみの
現在でも、短時間に複数回実行された場合の安全網として維持している）。

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
（`if: always() && needs.release.result == 'failure'`）起動し、`05.develop`・`07.m:marge`
ラベルが付いたissue（`release`ジョブの「リリース対象issueの一覧を取得する」ステップとは独立に
このジョブでも問い合わせる。どのステップで落ちてもissueを特定できるようにするため）へ実行ログ
URL付きの警告コメントを投稿し、`00.check-user`を付与する。直近のコメントに同一run URLが既に
含まれる場合は重複通知しない（他ワークフローと同じdedupパターン）。対象issueが1件も無い場合
（ラベル付け忘れ等）は通知できず、Actionsの実行ログでしか気づけない制約が残る。
