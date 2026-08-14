# Issueごとの複数Claude Codeエージェント運用 設計

issue #16 に一部対応する設計ドキュメント。

## 背景

現在 `develop` ブランチ上で複数のClaude Codeセッションが直接作業しており、変更の上書き・コンフリクト・作業内容の混在が起きる問題がある。これを解消するため、Issueごとに専用ブランチ・git worktree・Claude Codeセッションを分離し、実装は必ず`develop`向けPRを経由、別の「レビュー・統合エージェント」が確認してからマージする運用へ移行する。将来的にはIssueラベル/`@claude`コメントを起点にGitHub Actions上で実装〜レビュー〜自動マージまで行う自動化も見据える。

## 全体像

```text
GitHub Issue
↓
Issue専用ブランチ・worktreeを作成
↓
実装担当Claude Codeを起動
↓
実装・テスト・コミット・push
↓
develop向けPull Requestを作成
↓
レビュー・統合担当Claude Codeが確認
↓
問題がなければdevelopへマージ
```

```text
main   （直接push禁止、develop→mainのPRのみ、CI必須）
└─ develop （日常のベース。将来的にはPR経由のマージのみに寄せる）
   ├─ issue-123
   ├─ issue-124
   └─ issue-125
```

## ドキュメント構成

本ドキュメントは索引である。詳細はテーマごとに分割した以下のファイルを参照する（#908）。
**必要な節だけを読めるようにするための分割であり、最初から全部を読む必要はない。**

| ファイル | 内容 |
|---|---|
| [ブランチ・worktree運用とエージェントの役割](multi-agent/branching.md) | Issueごとのブランチ・worktree分離、エージェントの責務、共有知識層、ブランチ保護 |
| [Issueラベルによる状態管理とトグル](multi-agent/labels.md) | ラベルの状態遷移、計画フェーズ・プレビュー・スクリーンショット・マージ前確認の各トグル、サブIssue分割、自動マージ可否の判定 |
| [Phase 5: @claudeコメント起点の完全自動化](multi-agent/dispatch.md) | `claude-issue-dispatch.yml`の全体。トリガー、詰まりからの再開、通知コメント、権限モード、既知の制約 |
| [計画フェーズの信頼性と実装runへの引き継ぎ](multi-agent/dispatch-plan.md) | 計画提示ステップのフォールバック・自己リトライ、計画runの調査結果を実装runへ渡す仕組み |
| [プロンプトの配置・使用モデル・使用量の可視化](multi-agent/prompts-and-models.md) | `.github/prompts/`の構成と式テンプレート長上限、実装用／補助用モデルの設定、Job Summaryへの使用量出力 |
| [Phase 6: develop→mainのリリースフロー自動化](multi-agent/release.md) | バージョンbump PR・リリースPR作成の自動化 |
| [Phase 7: 無人実行でのスクリーンショット撮影・画像埋め込み](multi-agent/screenshots.md) | Playwrightによる撮影とIssueコメントへの埋め込み |
| [PRコンフリクト・CI失敗の自動解消](multi-agent/auto-repair.md) | `claude-conflict-resolve.yml`・`claude-ci-fix.yml` |
| [画面からのローカルセッション起動](multi-agent/local-quick-start.md) | `issuedeck://`プロトコル経由でWSLのClaude Codeセッションをワンクリック起動する仕組み、初回セットアップ、セキュリティ上の前提 |
| [サブPCへのディスパッチ](multi-agent/subpc-dispatch.md) | pull型のジョブキュー、実行可能リポジトリの申告、同時実行数の上限、サブPC側のpollerとsystemd |

## 段階的導入計画

1. **Phase 1**: `start-issue.sh`/`.ps1` — worktree・ブランチ・Claude Code起動のコマンド化
2. **Phase 2**: `start-reviewer.sh`/`.ps1` — レビュー・統合セッション起動のコマンド化
3. **Phase 2.5**: `.github/workflows/issue-labels.yml` — 進捗の状態遷移（`Planning`〜`Done`）のGitHub Actionsによる自動化（#991 Phase 5までは`01.planning`〜`09.main`のラベル遷移だった）
4. **Phase 3**: PR作成時の自動レビューをGitHub Actionsで実行（`subscription-lists`リポジトリの`claude-code-action`テンプレートを土台にカスタマイズ）
5. **Phase 4**: 低リスクなPRのみ`develop`へ自動マージ（自動マージ可否の判定方法を実装）
6. **Phase 5**: Issueへの`@claude`コメントを起点に実装からPR作成まで自動化
7. **Phase 6**: develop→mainのリリースフロー（バージョンbump PR・develop→mainのPR作成）を自動化

各Phaseは前段が安定稼働してから着手する。

## 今後作成するファイル（Phase進行に合わせて）

- `scripts/start-issue.sh` / `scripts/start-issue.ps1`（Phase1）
- `scripts/run-issue-session.sh`（Phase1、開発サーバーの自動起動・セッション終了時の自動停止を担うラッパー。#687）
- `scripts/prompts/implementation-agent.md`（Phase1）
- `scripts/start-reviewer.sh` / `scripts/start-reviewer.ps1`（Phase2）
- `scripts/prompts/review-agent.md`（Phase2）
- `.github/workflows/issue-labels.yml`（Phase2.5、作成済み）
- `.github/workflows/claude-review-develop.yml`（Phase3、作成済み。Phase4で`risk-check`/`auto-merge`ジョブを追加）
- `.github/workflows/claude-issue-dispatch.yml`（Phase5、作成済み）
- `.github/workflows/release-develop-to-main.yml`（Phase6、作成済み）
- `.github/workflows/shared-knowledge-propose.yml`（共有知識層、作成済み。承認済みの知見を`guchi-apps/docs`へのPRに変換する。[docs/shared-knowledge.md](shared-knowledge.md)参照）

手動セットアップ項目:
- GitHubラベル`21.plan-required`の新規作成
- GitHubラベル`23.preview-required`・`24.screenshot-required`の新規作成
- GitHubラベル`22.merge-confirm-required`の新規作成（#366、作成済み）
- `main`のBranch protection設定（未設定のため）
- リポジトリ設定でAuto-merge機能を有効化（Phase4、`gh repo edit --enable-auto-merge`で設定済み）
- `develop`のBranch protectionに`required_status_checks`（`lint-and-build`）を設定（Phase4）
- 共有知識リポジトリ（`guchi-apps/docs`）への`secrets.WORKFLOW_PAT`の到達性（共有知識層。issue-deckのPATはRepository accessが「All repositories」のため追加設定は不要。**到達できない場合でも共有知識のcheckoutが失敗するだけで、各ワークフローは`continue-on-error`で続行する**）
- 共有知識リポジトリ`guchi-apps/docs`側へのファイル追加（`CLAUDE.md`・`agent-rules/`・`knowledge/`等。[docs/shared-knowledge.md](shared-knowledge.md)「6. 共有知識リポジトリ側に必要なファイル」参照。**対応済み**）

## 未解決の課題・申し送り事項

- Claude Code CLIの起動オプション（`--permission-mode`の具体的な値、`--add-dir`等）は実装時に`claude --help`で最新仕様を確認する。特に無人実行（Phase3以降）で全チェックを無効化するようなフラグ（例: `--dangerously-skip-permissions`・`--permission-mode bypassPermissions`）を使うのは、意図しない破壊的操作のリスクがあるため避け、GitHub Actions実行は`claude-code-action`側の許可ツールリスト等で制御する方針とする。ローカル実行の権限モードは当初`acceptEdits`（人間が横にいる前提）としていたが、既定を`auto`へ変更した（#1205。切り替えは`ISSUE_DECK_CLAUDE_PERMISSION_MODE`。詳細は[multi-agent/local-quick-start.md](multi-agent/local-quick-start.md)「権限モードは環境変数で切り替える」）。
- VS Code拡張（Claude Code for VS Code）側に「起動時に初期プロンプトを自動投入する」公式な方法は確認できていない。Phase1では「ターミナルで`claude "プロンプト"`として起動し、その結果としてVS Codeが開く」形（またはVS Codeは別途手動で開く）を落としどころとする想定。
