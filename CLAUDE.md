# issue-deck 固有ルール

グローバルルール（`~/.claude/CLAUDE.md`）に加えて、このリポジトリ固有のルールを記載する。

## Issueごとの複数Claude Codeエージェント運用

Issueごとに専用ブランチ・git worktree・Claude Codeセッションを分離して実装する運用を導入している（詳細設計は [docs/multi-agent-workflow.md](docs/multi-agent-workflow.md) を参照）。

### ブランチ運用

- `main`/`develop`の基本運用は既存のとおり（git-github-jaスキル参照）。
- Issue単位の作業ブランチは`develop`から作成し、ブランチ名は`issue-<Issue番号>`とする（例: `issue-123`）。
- worktreeは本体リポジトリの外（`~/apps/issue-deck-worktrees/<ブランチ名>/`）に作成する。

### 実装エージェント（Issueごとに起動するセッション）の禁止事項

- `main`/`develop`への直接コミット・push
- 他Issueのブランチ・worktreeの編集
- 不要なforce push
- 自分が作成したPull Requestの自己マージ

### レビュー・統合エージェントの禁止事項

- `main`への直接マージ・push

### 実装前の計画フェーズ（`21.plan-required`ラベル）

- Issueに`21.plan-required`ラベルが付いている場合、実装前にPlan modeで計画（アプローチ・変更範囲・懸念点）を提示し、承認を得てから実装に入る。
- `01.wip`は実装開始時点ではなく、計画の検討に着手した時点（Plan mode開始時点）で付与する。
- ラベルが付いていない場合は直接実装してよい。
- 承認待ちの合図には`00.check-user`ラベルを使う。

### Issueラベルの状態遷移

マルチエージェント運用で進めるIssueは、原則として以下の順でラベルが遷移する。全PJ共通の`01.wip`は流用しつつ、旧`02.close`（状態：対応済）はissue-deckでは`09.main`にリネームして統合した（他リポジトリの`02.close`には影響しない。ラベルはリポジトリごとの設定のため）。

1. `01.wip` — 実装エージェントが計画検討中・コード実装中
2. `03.d:marge` — developへPR作成・マージ中
3. `05.develop` — developへマージ完了（main未反映）
4. `07.m:marge` — mainへPR作成・マージ中
5. `09.main` — mainへマージ完了。**この時点でissueをclose**する

`00.check-user`（ユーザーのチェックが必要）は上記のどの段階でも他のラベルと併用して付与する。

`07.m:marge`・`09.main`に対応するdevelop→mainのリリースフロー自体は、バージョンbump PR・develop→mainのPR作成までを`.github/workflows/release-develop-to-main.yml`が自動化している（詳細はdocs/multi-agent-workflow.md「Phase 6」参照）。develop→mainの実際のマージは下記「自動マージ不可カテゴリ」に該当するため人間が手動で行う。

### 自動マージ不可カテゴリ（`00.check-user`付与対象）

以下に該当する変更は、レビュー・統合エージェントが自動マージせず`00.check-user`を付与し、ユーザーの確認を待つ。

- 認証・認可
- DBスキーマ変更・マイグレーション
- 本番環境の設定
- GitHub Actionsやデプロイ設定
- Secretsや環境変数
- 課金・決済
- 大規模な依存関係の更新
- `develop`→`main`のマージ

上記カテゴリに該当するかどうかによらず、Issueに`22.merge-confirm-required`ラベルが付いている場合も、develop向けPRへのpushのたびに常に`00.check-user`が付与され自動マージがスキップされる（詳細はdocs/multi-agent-workflow.md「developへのマージ前確認要否をIssueラベルでトグルする」参照）。

### PR本文テンプレート

`develop`宛のPRには以下を記載する。

- 対応Issue（`closes #番号`/`fixes #番号`は使わず`#番号`のみ記載する。developマージ時点ではissueをcloseしない運用のため）
- 実装内容
- テスト内容
- 確認方法
- 注意点
