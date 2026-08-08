# 対応リポジトリ一覧

issue-deckのマルチエージェント自動化ワークフロー一式（`@claude`起動・ラベル遷移による
計画〜実装〜PR作成〜レビューまでの無人実行）が実際に導入され、機能しているリポジトリを
記録する。導入の背景・他リポジトリへ展開する際の検討事項は
[docs/cross-repo-automation.md](cross-repo-automation.md)、実際に導入する際の手順は
[docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md)を参照。

「対応」の実態はワークフローファイル一式・ラベル体系・CLAUDE.md・ブランチ運用・Secretsなど
多軸にわたり、DBスキーマや自動判定で正確に表すのは難しいため、本ドキュメントでの手動記録に
留めている。

| リポジトリ | ステータス | 導入済み自動化ワークフロー | CLAUDE.md / ラベル体系 | 最終確認日 | 関連Issue | 備考 |
|---|---|---|---|---|---|---|
| `m-guchi/issue-deck` | 対応済み | 一式（`claude-issue-dispatch.yml`・`issue-labels.yml`・`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`release-develop-to-main.yml`） | あり（本体） | 2026-08-05 | #354, #501 | issue-deck自身のセルフホスティング |
| `m-guchi/shopping-list` | 対応済み | 一式（`claude-issue-dispatch.yml`・`issue-labels.yml`・`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`release-develop-to-main.yml`） | あり（新規作成） | 2026-08-08 | #357, #723 | DBなし・ビルドなし・npm依存パッケージゼロのため、DBセットアップ・pnpm・Playwrightの前段ステップを削除して簡素化。`24.screenshot-required`は未対応（後述） |

## sync-state マーカー（ワークフロー同期状態の記録）

リポジトリが実際にワークフローファイルを導入した際、issue-deckのどのコミット時点から
コピー・改変したかを、機械可読な形で以下のHTMLコメント形式で記録する。

```html
<!-- sync-state: repo=<owner/repo> workflow=<ワークフローファイル名> base-commit=<issue-deck側のコミットSHA> -->
```

実際の記録例は下記「m-guchi/shopping-list」の節を参照する。`scripts/check-workflow-sync-drift.sh`は
本ドキュメント中のマーカーを（コードブロック内や説明用の記述であっても）すべて実データとして
読み取るため、ここに架空のサンプル行は置かない。

導入したワークフローファイルごとに1行記録する（複数ファイルを導入した場合は複数行）。
`scripts/check-workflow-sync-drift.sh`がこのマーカーを読み取り、issue-deck側にbase-commit以降
加わった変更を一覧表示する（詳細は[docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md)の
「ワークフロー同期のずれ検知」を参照）。

### m-guchi/shopping-list

<!-- sync-state: repo=m-guchi/shopping-list workflow=claude-issue-dispatch.yml base-commit=29958837e7569c852740742dfd30daa2c03e89fc -->
<!-- sync-state: repo=m-guchi/shopping-list workflow=issue-labels.yml base-commit=29958837e7569c852740742dfd30daa2c03e89fc -->
<!-- sync-state: repo=m-guchi/shopping-list workflow=claude-review-develop.yml base-commit=29958837e7569c852740742dfd30daa2c03e89fc -->
<!-- sync-state: repo=m-guchi/shopping-list workflow=claude-conflict-resolve.yml base-commit=29958837e7569c852740742dfd30daa2c03e89fc -->
<!-- sync-state: repo=m-guchi/shopping-list workflow=release-develop-to-main.yml base-commit=29958837e7569c852740742dfd30daa2c03e89fc -->

導入時の改変内容は各ワークフローファイル冒頭のコメントに記載されている。主な差異は以下のとおり。

- `claude-issue-dispatch.yml`: MySQLサービスコンテナ・pnpmセットアップ・Prismaマイグレーション・
  CIバイパス用ユーザーとダミーデータのシード・Playwrightインストールの前段ステップを削除。
  検証コマンドは`npm run check`（`node --check`による構文チェックのみ）
- `claude-review-develop.yml`: `risk-check`のパスパターンから`prisma/migrations/**`を削除し、
  `deploy/**`・`scripts/update-env-file.sh`・`**/*.env.tpl`を追加。依存関係はメジャー更新だけでなく
  新規追加もリスク判定対象（依存パッケージを持たない方針自体の変更にあたるため）
- `claude-conflict-resolve.yml`: pnpm/DB前提の検証ステップを`npm run check`へ置換
- `release-develop-to-main.yml`: バージョンbumpを`npm pkg set version`から
  `npm version <新バージョン> --no-git-tag-version`へ変更（npmのversion lifecycleフックで
  `frontend/changelog.js`のスタブを生成する必要があるため）。あわせてバージョン判定の構造化出力に
  `changelog`を追加し、利用者向け更新履歴の本文もコード差分から生成する。生成文面が公開されるため
  バンプPRの自動マージは行わない。この改修は#800より前に、shopping-list側で個別に手改造する
  形で行われたもの。#800でissue-deck本体の`release-develop-to-main.yml`にも同種の
  `npm version --no-git-tag-version`化・`changelog`生成・`RELEASE_CHANGELOG`環境変数による
  汎用フックが追加されたため、今後同様の更新履歴同期を導入するリポジトリは個別改造なしで
  `"version"` lifecycleスクリプトを定義するだけで済むようになった（詳細は
  [docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md)の「6. リポジトリ差異の吸収
  チェックリスト」参照）。shopping-list自身をこの汎用フックへ移行する作業は本Issueのスコープ外
  のため未実施
- `issue-labels.yml`: `screenshots`ブランチの掃除ジョブを削除（無人撮影を導入していないため）
- **`24.screenshot-required`は未対応**: 全画面がSupabase Auth + Google OAuthログインの背後にあり、
  issue-deckの`src/lib/ci-auth-bypass.ts`相当のCIログインバイパス機構とNotion APIのスタブが
  存在しないため無人撮影が成立しない。ラベルが付いていた場合は撮影を試みず、実装・コミット・
  ブランチpushまで行った上で`00.check-user`を付与しPR作成前に停止する挙動にしている
  （詳細は[docs/cross-repo-automation.md](cross-repo-automation.md)のケーススタディ参照）
