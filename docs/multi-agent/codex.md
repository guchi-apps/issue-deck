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

**画面（issue-deck）からも選べる**（#2505）。Issueの「実装を開始」ダイアログで実行先にサブPCを
選ぶと「エージェント」欄が出る。既定はClaude Codeで、Codex CLIを押すとその場で
「効かなくなる連携」（下の比較表）が出る。起動した後は、積んだジョブの状態表示に`Codex CLI`の
印が付く（既定のClaude Codeには付けない）。

- **欄が出るのは、そのホストが対応を申告しているときだけ**（`DispatchHost.codexCapable`）。
  申告の条件は`codex`コマンドが入っていることで、判定は`scripts/subpc-dispatch-poller.sh`の
  `codex_capable`。**古いpollerはジョブの`agent`を読まない**ため、申告が無いホストで選ばせると
  Codexを選んだのにClaude Codeが黙って立つ
- **選べるのは「実装を開始」ダイアログだけ。** ツールバーの「サブPCで開始」ボタンと
  「セッションを復旧」は従来どおりClaude Codeで起こす（同じ選択をメニューの階層にも持たない）
- **GitHub Actions・「実装プロンプトをコピー」・「起動コマンドをコピー」には効かない**
  （実行先をそちらへ切り替えると欄ごと消え、選択は既定へ戻る）

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
| 停止（応答終了）の通知 | ○（`Stop`フック） | ○（同名のフック。#2509） |
| 「まだ開始していません」の検知（#1465） | ○ | ○（`SessionStart`フック。#2509） |
| 入力待ちの通知（Push通知） | ○（`Notification`フック） | **×**（同じイベントが無い。後述） |
| 計画の承認パネル（画面から承認・修正） | ○（`ExitPlanMode`のフック） | **×**（同名のツールが無い） |
| 質問への回答（画面から答える） | ○（`AskUserQuestion`のフック） | **×**（同名のツールが無い） |
| アーティファクトの取り込み（#2154） | ○（`Artifact`のフック） | **×**（Claude Code固有のツール） |
| Remote Control | ○ | **×** |
| 前回の会話の引き継ぎ | ○（`--continue`） | **×**（`codex resume --last`を手で叩く） |
| `--disallowedTools`による封じ込め | ○ | **×**（指定されていたら起動を断る） |

**そのぶんIssueコメントに残す記録が重要になる。** 端末だけで完結させると、画面からは何も起きて
いないように見える。この点は`scripts/prompts/codex-supplement.md`でエージェント自身にも伝えている。

`--disallowedTools`を使う経路（横断質問セッション・#1454）は、封じ込めが機械的に効かない状態で
読み取り専用のセッションが立つのを避けるため、**Codexでは起動を断る**（`run-issue-session.sh`）。

## フック（#2509）

**Codexにもフックがある。** #2377の時点では「無い」としていたが、実機（codex-cli 0.151.0）では
stableとして入っており、`codex features list`に`hooks / stable / true`が出る。
インターフェースはClaude Codeとほぼ同じで、**`scripts/session-notify.sh`が読んでいるフィールド名
（`hook_event_name`・`tool_name`・`tool_input`）がそのまま一致する**ため、通知スクリプトは
作り直さずに流用している。

繋いでいるのは2つ。

| イベント | 何のために |
|---|---|
| `SessionStart` | 「まだ開始していません」の印を消す（#1465） |
| `Stop` | 応答終了をissue-deckへ報告する（画面の様子・停止の通知） |

### 設定は`-c`のオーバーライドで渡す

フック設定を置ける層は3つあるが、**このセッションにだけ効かせられるのは`-c`だけ**（実測）。

| 置き場 | 効く範囲 |
|---|---|
| `~/.codex/hooks.json`（ユーザー層） | そのホストの**全Codexセッション**。手元の対話セッションにも飛ぶ |
| `<worktree>/.codex/hooks.json`（プロジェクト層） | そのディレクトリ。**リポジトリの中**なのでコミットの事故が起きうる |
| `-c 'hooks.<イベント>=…'`（セッション層） | このプロセスだけ。**worktree単位の分離がそのまま得られる** |

`command`の文字列は**シェルの規則で分割される**ので、Claude側と同じ
`'…/session-notify.sh' '2509' 'issue-deck' 'guchi-apps/issue-deck'`をそのまま渡せる。
組み立ては[`scripts/lib/agent-cli.sh`](../../scripts/lib/agent-cli.sh)の
`agent_cli_build_codex_hook_args`にある。

### 信頼（trust）は2種類あり、両方を越えないとフックは1つも飛ばない

1. **フックの信頼**。非管理フックは人がレビューして信頼するまで実行されない。信頼はフック定義の
   ハッシュに紐づくため、Issueごとに引数（番号）が変わるこの用途では毎回「新しいフック」になる。
   `--dangerously-bypass-hook-trust`で越える
2. **ディレクトリの信頼**。初めて開くディレクトリでは起動直後に
   `Do you trust the contents of this directory?`が出て、**答えるまで`SessionStart`すら飛ばない**。
   Claude Codeは本体チェックアウトのパスに記録する（リポジトリにつき1回）のに対し、
   **Codexはworktreeのパスごとに記録する**（`~/.codex/config.toml`の`[projects."<絶対パス>"]`）ため、
   **Issueごとに1回聞かれる**

2つ目は自動化しない（「信頼確認そのものは自動化しない」。[session-notify.md](session-notify.md)）。
代わりに、フックを有効にできたセッションには「まだ開始していない」印を置くようにした。答えないまま
猶予（既定180秒）を過ぎるとpollerが拾い、画面に「まだ開始していません」と出て`00.check-user`が付く。
**答えられていないことが画面から分かる**のが、この印を置く目的（#1465）。

### `--dangerously-bypass-hook-trust`を選んだ理由

管理フック扱い（`requirements.toml`の`hooks.managed_dir`）にする道もあるが、あれは**ホスト全体へ
効く管理設定**で、置いた時点でCodexのフックの信頼レビューがこのホストから丸ごと消える。
フラグなら効果はこの1プロセスに閉じる。

代償は「そのプロセスで有効なフックが**全部**レビュー無しで走る」こと。ディレクトリを信頼すると
プロジェクト層（`<worktree>/.codex/`）のフックも読まれるため、リポジトリが同梱したフックが
混ざりうる。そこで**worktreeに`.codex/hooks.json`か`.codex/config.toml`があるときは、フックを
丸ごと有効にしない**（`agent_cli_codex_project_hook_file`）。画面連携を諦めるほうが軽い。

### `PostToolUse`は繋がない

同名のイベントはあるが、`session-notify.sh`のあのイベントは「人が承認プロンプトに答えて作業へ
戻った」ことを拾うためのもので、**直前の状態が`permission_prompt`のときしか報告しない**。
Codexは`--ask-for-approval never`で走らせるため承認プロンプトが出ず、`permission_prompt`を
書き込む経路（Claudeの`Notification`・`ExitPlanMode`・`AskUserQuestion`）がどれも無い。
繋ぐとツール実行のたびにプロセスを起こして必ず捨てるだけになる。

**したがってCodexでは、このスクリプトが`00.check-user`を付けることは無い。** 付け外しは
エージェント自身が`gh issue edit`で行う（`scripts/prompts/codex-supplement.md`）。

## サンドボックスとネットワーク

起動時に渡すのは`--sandbox workspace-write --ask-for-approval never`と、
`-c sandbox_workspace_write.network_access=true`。

- **`--ask-for-approval never`はClaude Codeの`--permission-mode auto`（#1205）と同じ位置づけ。**
  人が横にいない実行が前提で、承認を求めた時点でセッションが黙って止まる。**Codexには入力待ちを
  知らせるイベントが無い**（フックは#2509で繋いだが、`Notification`に当たるものが無い）ため、
  `on-request`にすると誰も気づけないまま止まる
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

## 画面から選んだときに通る道（#2505）

画面で選んだ種別は、ジョブの列 → pollerの環境変数 → 受け口 → `start-issue.sh` と渡っていく。
**受け渡しの形はどこも`ISSUE_DECK_AGENT`（小文字の語）で、引数には積み替えない**——この指定を
解釈しないリポジトリのランチャーへ届いても無害にするため（未知のフラグはIssue番号として扱われる）。

1. 「実装を開始」ダイアログが`POST /api/dispatch`へ`agent`を載せる
2. `enqueueDispatchJob`が`DispatchJob.agent`へ保存する（既定`claude`。既存行はすべてこの値）
3. pollerが払い出されたジョブの`agent`を読み、`env ISSUE_DECK_AGENT=<種別>`で受け口を呼ぶ
4. `scripts/start-local-session.sh`が種別を解決し、必要なCLIの有無を確かめて`start-issue.sh`へ渡す

**既知の語（`claude` / `codex`）に絞る判定を、画面・API・pollerの3か所に置いている。**
`previewAction`と同じ作法で、列を手で書き換えられても環境変数として届く語は変わらない。
**黙って`claude`へ落とす経路はDBの値を読むときだけ**（`readDispatchAgent`）で、指定として
受け取った値が未知なら断る——Codexを選んだつもりでClaude Codeが立つ方が分かりにくい。

### 起動できない組み合わせは、worktreeを作る前に止まる

`scripts/start-local-session.sh`が既定以外のエージェントを受け取ったとき、次の2つを先に確かめる。
どちらも`exit 1`で、pollerがジョブを`failed`にするため**理由が画面に出る**。

- **汎用ランチャー（`generic`）で起動するリポジトリ** — `scripts/generic-start-issue.sh`はCodexに
  未対応なので断る
- **`scripts/start-issue.sh`が`ISSUE_DECK_AGENT`を読まないリポジトリ** — 実際に走るファイルを
  `grep`で見る。**ローカル起動プロトコルの版数では判定しない**（版数はリポジトリ側が手で書く
  宣言で、`ISSUE_DECK_AGENT`を読むようにしたかどうかとは連動しない）。ここを通さないと、
  画面には「Codex CLI」と出たままClaude Codeが立つ

## 実装の在り処

| 何を | どこに |
|---|---|
| 種別の解決・Codexの引数の組み立て・フックの`-c`の組み立て | [`scripts/lib/agent-cli.sh`](../../scripts/lib/agent-cli.sh) |
| 起動の分岐（Claude固有の処理を飛ばす・フックの有効化） | [`scripts/run-issue-session.sh`](../../scripts/run-issue-session.sh) |
| フックから呼ばれる通知スクリプト（Claudeと共通） | [`scripts/session-notify.sh`](../../scripts/session-notify.sh) |
| `--agent`の受け取り・存在チェック・読み替えの追記 | [`scripts/start-issue.sh`](../../scripts/start-issue.sh) |
| 画面から渡された種別の受け取り・出口ごとの可否 | [`scripts/start-local-session.sh`](../../scripts/start-local-session.sh) |
| ジョブの`agent`の読み取り・`codex`の申告 | [`scripts/subpc-dispatch-poller.sh`](../../scripts/subpc-dispatch-poller.sh) |
| 語の検証・表示名・選べるかの判定 | [`src/lib/dispatch/dispatch-job.ts`](../../src/lib/dispatch/dispatch-job.ts) |
| 選択欄と注意の表示 | [`src/components/dashboard/start-implementation-dialog.tsx`](../../src/components/dashboard/start-implementation-dialog.tsx) |
| 境界のテスト | [`scripts/agent-cli.test.mjs`](../../scripts/agent-cli.test.mjs) |

## まだやっていないこと

- **無人実行（GitHub Actions）は対象外。** `claude-issue-dispatch.yml`は`claude-code-action`の
  ままで、Codexで走らせるには`OPENAI_API_KEY`のSecrets追加と課金の判断が要る
- **汎用ランチャー（`scripts/generic-start-issue.sh`）は未対応。** 他リポジトリのセッションは
  従来どおりClaude Codeで立つ（画面から選んでも、受け口が理由を出して止まる）
- **他リポジトリの`start-issue.sh`は`ISSUE_DECK_AGENT`を読まない。** 揃えるまでは、画面から
  Codexを選べるのはissue-deck自身のIssueだけになる（他は受け口が止める）
- **計画の承認と質問の受け答えは画面へ出せていない**（#2509）。Codexに`ExitPlanMode`・
  `AskUserQuestion`に当たるツールが無いため、フックを繋いでも中身が手に入らない
  （`update_plan`はTODOの更新で、承認待ちではない。`tools.experimental_request_user_input`は
  under development）。**MCPサーバとして専用のツールを提供し、`PreToolUse`のmatcherを
  `mcp__…`に掛けるのが確実**だが、作るものが増えるので別途の判断が要る
- **ディレクトリの信頼確認はIssueごとに1回出る。** Claude Codeのように本体チェックアウトへ
  記録されないため、worktreeを作るたびに人が答える必要がある。答えるまで止まっていることは
  画面に出る（「まだ開始していません」）
