# 対応リポジトリ一覧

issue-deckのマルチエージェント自動化ワークフロー一式（`@claude`起動・ラベル遷移による
計画〜実装〜PR作成〜レビューまでの無人実行）が実際に導入され、機能しているリポジトリを
記録する。導入の背景・他リポジトリへ展開する際の検討事項は
[docs/cross-repo-automation.md](cross-repo-automation.md)を参照。

「対応」の実態はワークフローファイル一式・ラベル体系・CLAUDE.md・ブランチ運用・Secretsなど
多軸にわたり、DBスキーマや自動判定で正確に表すのは難しいため、本ドキュメントでの手動記録に
留めている。

| リポジトリ | ステータス | 導入済み自動化ワークフロー | CLAUDE.md / ラベル体系 | 最終確認日 | 関連Issue | 備考 |
|---|---|---|---|---|---|---|
| `m-guchi/issue-deck` | 対応済み | 一式（`claude-issue-dispatch.yml`・`issue-labels.yml`・`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`release-develop-to-main.yml`） | あり（本体） | 2026-08-05 | #354, #501 | issue-deck自身のセルフホスティング |
| `m-guchi/shopping-list` | 検討中 | 未導入（実現可能性のケーススタディのみ完了） | なし | 2026-08-05 | #357 | DBなし・npm依存パッケージゼロで導入は容易と判定。スクリーンショット無人撮影のみ追加実装が必要 |
