# Codex CLIでローカルセッションを起こす（#2377）

**いつ読むか**: ローカルセッションをClaude Code以外のエージェントで動かしたいとき。Codexで起こした
セッションの挙動がClaude Codeと違って見えるとき。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## 使い方

```bash
# サブPCの本体チェックアウト（~/apps/issue-deck）で実行する
scripts/start-issue.sh --agent codex <Issue番号>

# 環境変数でも同じ（画面・pollerから渡す場合はこちら）
ISSUE_DECK_AGENT=codex scripts/start-issue.sh <Issue番号>
```

worktreeの作成・ブランチ・`11.local`の付与・進捗報告・開発サーバー・tailnetへの公開・プロンプトの
生成は**Claude Codeのときと同じ**。変わるのは、tmuxの中で最後に起こすコマンドだけ。

**既定は`claude`のまま。** 指定しなければ従来どおりClaude Codeが立つ。

| 環境変数 | 既定 | 何を変えるか |
|---|---|---|
| `ISSUE_DECK_AGENT` | `claude` | 起こすエージェント（`claude` / `codex`） |
| `ISSUE_DECK_CODEX_SANDBOX` | `workspace-write` | Codexの`--sandbox` |
| `ISSUE_DECK_CODEX_MODEL` | （空） | Codexの`-m`。空なら`codex`側の既定 |
| `ISSUE_DECK_CODEX_EXTRA_ARGS` | （空） | 追加の引数（空白区切り）。実機でしか分からない調整をスクリプトの修正なしで当てるための逃げ道 |

導入（サブPC側で1回だけ）。**未導入のまま起動しようとすると、worktreeを作る前にエラーで止まる。**

```bash
npm install -g @openai/codex
codex login
```

## Claude Codeと揃わないもの

Codexに同じ仕組みが無いため、**issue-deckの画面側の連携が一部効かない**。

| 機能 | Claude Code | Codex |
|---|---|---|
| セッションの開始・終了の報告、プレビューURL | ○ | ○（`run-issue-session.sh`のラッパー側で行っているため） |
| 入力待ち・停止の通知（Push通知） | ○（フック） | **×** |
| 計画の承認パネル（画面から承認・修正） | ○（`ExitPlanMode`のフック） | **×** |
| 質問への回答（画面から答える） | ○（`AskUserQuestion`のフック） | **×** |
| Remote Control | ○ | **×** |
| 「まだ開始していません」の検知（#1465） | ○ | **×**（印を置かない。消すフックがいないため） |
| 前回の会話の引き継ぎ | ○（`--continue`） | **×**（`codex resume --last`を手で叩く） |
| `--disallowedTools`による封じ込め | ○ | **×**（指定されていたら起動を断る） |

**そのぶんIssueコメントに残す記録が重要になる。** 端末だけで完結させると、画面からは何も起きて
いないように見える。この点は`scripts/prompts/codex-supplement.md`でエージェント自身にも伝えている。

`--disallowedTools`を使う経路（横断質問セッション・#1454）は、封じ込めが機械的に効かない状態で
読み取り専用のセッションが立つのを避けるため、**Codexでは起動を断る**（`run-issue-session.sh`）。

## サンドボックスとネットワーク

起動時に渡すのは`--sandbox workspace-write --ask-for-approval never`と、
`-c sandbox_workspace_write.network_access=true`。

- **`--ask-for-approval never`はClaude Codeの`--permission-mode auto`（#1205）と同じ位置づけ。**
  人が横にいない実行が前提で、承認を求めた時点でセッションが黙って止まる。**Codexにはフックが
  無く入力待ちの通知も飛ばない**ため、`on-request`にすると誰も気づけないまま止まる
- 失われる「個々のコマンドを人が目視する機会」は、Claude側と同じ後段の防御で受ける（Pull Request
  必須・`claude-review-develop.yml`のレビュー・自動マージ不可カテゴリ・Issueごとのworktree分離）
- **ネットワークは明示的に開ける。** Codexのサンドボックスは既定でネットワークを塞ぐため、
  開けないと`gh issue comment`・`git push`・`pnpm install`が軒並み失敗する。実装セッションは
  Issueへの報告とPR作成が仕事なので、塞いだままでは成立しない
- **`--add-dir`は渡さない。** Codexの`--add-dir`は「書き込み可能なディレクトリを増やす」もので、
  読むだけならサンドボックスの外でもできる。共有知識リポジトリ（`~/apps/_docs`）は読み取り専用と
  して扱う決まり（[CLAUDE.md](../../CLAUDE.md)）なので、渡すと機械的に破れるようになるだけ

## プロンプトは分岐させず、差分だけを足す

実装プロンプトのひな形（`scripts/prompts/implementation-agent.md`）は43KBあり、Codex専用の写しを
作れば**片方が必ず古くなる**。そのため写しは作らず、Codexで起こしたときだけ
`scripts/prompts/codex-supplement.md`（読み替え）を生成したプロンプトの末尾へ足す。

読み替えに書いてあるのは、Claude Code前提の記述をどう置き換えるか。

- `CLAUDE.md`を自分で読むこと（**Codexが自動で読むのは`AGENTS.md`**）
- 計画は`ExitPlanMode`ではなく`gh issue comment`＋`00.check-user`／`01.check-plan`の自分での付与
- 確認は`AskUserQuestion`ではなく端末＋Issueコメント（**ラベルを外すのも自分**）
- `Read`・`Grep`・`Glob`はシェルで代替する
- 承認プロンプトは出ない・書き込みはworktreeに閉じている

**読み替えが見つからない場合、Codexでの起動は失敗する**（`start-issue.sh`）。Claude Code前提の
記述だけが残ったプロンプトを渡すと、存在しない手順を待って止まるため。

## 実装の在り処

| 何を | どこに |
|---|---|
| 種別の解決・Codexの引数の組み立て | [`scripts/lib/agent-cli.sh`](../../scripts/lib/agent-cli.sh) |
| 起動の分岐（Claude固有の処理を飛ばす） | [`scripts/run-issue-session.sh`](../../scripts/run-issue-session.sh) |
| `--agent`の受け取り・存在チェック・読み替えの追記 | [`scripts/start-issue.sh`](../../scripts/start-issue.sh) |
| 境界のテスト | [`scripts/agent-cli.test.mjs`](../../scripts/agent-cli.test.mjs) |

## まだやっていないこと

- **画面（issue-deck）から選べない。** 「ローカルで開始」はエージェントを選ばず、常にClaude Codeで
  起動する。選べるようにするにはDBのカラム（`DispatchJob`）・起動オプションのUI・poller
  （`scripts/subpc-dispatch-poller.sh`）の受け渡しが要る
- **無人実行（GitHub Actions）は対象外。** `claude-issue-dispatch.yml`は`claude-code-action`の
  ままで、Codexで走らせるには`OPENAI_API_KEY`のSecrets追加と課金の判断が要る
- **汎用ランチャー（`scripts/generic-start-issue.sh`）は未対応。** 他リポジトリのセッションは
  従来どおりClaude Codeで立つ
