# 実装セッションの状態通知とRemote Control

サブPC（`subpc`）のtmuxで動く実装セッションが、入力待ちと応答終了を自分からSignalyへ通知する
仕組み（#1219）。あわせて`--remote-control`で、通知に気づいた側がスマホやブラウザから
そのセッションへ答えられるようにする。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## なぜポーリングをやめるのか

これまでセッションの状態を知る手段は「メインPCから`ssh subpc tmux capture-pane`を定期的に
読み、画面の文字列から状態を推定する」ポーリングしか無かった。次の限界がある。

- 45〜60秒の遅延がある
- **見ている人がいる間しか機能しない。** 夜間に入力待ちで止まっても翌朝まで誰も気づかない
- **画面の文字列からの推定なので誤判定する。** 実際に「プランモードではフッターが
  `esc to interrupt` にならない」ことに気づかず、作業中を「停止」と誤って通知した
- 常時SSHを張るコストがかかる

Claude Codeのフックはイベント発生の瞬間にコマンドを実行するので、遅延も誤判定も無くなり、
見ている人がいなくても飛ぶ。

```text
tmuxの実装セッション（run-issue-session.sh が起動）
  │ 承認プロンプト・AskUserQuestion → Notification フック
  │ 応答終了                        → Stop フック
  ↓
scripts/session-notify.sh（フックのstdinでJSONを受け取る）
  ↓ webhook（~/.config/issue-deck/notify.env の SESSION_NOTIFY_WEBHOOK_URL）
Signaly → スマホ・メインPCへ通知
  ↓ 通知に載っているURLを開く
claude.ai/code/<セッション> （--remote-control）→ その場で答える
```

## 飛ばすのは2種類だけ

`--permission-mode auto`（#1205）により承認プロンプトは激減しているので、飛ばすのは
**「本当に人の判断が要るもの」と「完了」**に絞る。判定は
[scripts/session-notify.sh](../../scripts/session-notify.sh)が持つ。

| フック | 条件 | 意味 | 通知 |
| --- | --- | --- | --- |
| `Notification` | `notification_type` が `permission_prompt` | 承認プロンプト・`AskUserQuestion`の質問 | 🙋 入力待ち |
| `Notification` | `notification_type` が `idle_prompt` | 応答終了から60秒アイドル | **送らない** |
| `Stop` | — | 応答の終了。無人で回すセッションでは実質「作業完了」 | ✅ 応答終了 |

**`idle_prompt`を捨てるのは、直前の`Stop`と必ず二重になるため。** 応答が終わって60秒
放置されると発火するので、`Stop`を送った約60秒後に同じ内容がもう1件飛ぶことになる。
通知が多すぎると意味を失う。

`--permission-mode auto`でも`AskUserQuestion`では`permission_prompt`が発火する（実測）。
autoは「Claudeが自分で判断してよいもの」を自動承認するだけで、人に聞く意思そのものは
潰さないため、この経路は生きている。

`SessionEnd`は使っていない。tmuxのウィンドウを閉じただけのイベントに通知の価値が薄い。

## 通知の中身

載せるのは Issue番号・リポジトリ名・ホスト名・イベント種別・`tmux attach`のコマンド・
IssueのURL・Remote ControlのURL（取れたときだけ）。

**応答テキスト（`Stop`フックの`last_assistant_message`）は載せない。** 応答本文には
Issue本文の引用・ファイルの中身・コマンドの出力が混ざりうる。それを外部サービスである
Signalyへ出す経路を最初から作らない。中身はRemote ControlのURLから見る。

## CI/デプロイ通知とチャンネルを分ける

セッション通知は**CI/デプロイ通知とは別のSignalyチャンネル・別の1Passwordフィールド**を使う
（#1231）。

| 通知 | 1Passwordのフィールド | 環境変数 | 設定場所 |
| --- | --- | --- | --- |
| CI/デプロイ | `apps/issue-deck` の `ci-webhook-url` | `SIGNALY_WEBHOOK_URL` | `.github/ci.env.tpl`・`.github/deploy.env.tpl` |
| セッション状態 | `apps/issue-deck` の `session-webhook-url` | `SESSION_NOTIFY_WEBHOOK_URL` | `~/.config/issue-deck/notify.env` |

分ける理由。

- **性質が違う。** CI/デプロイ通知は結果の記録で、見逃してもGitHubに残る。セッションの
  入力待ちは今すぐ人が答えないとセッションが止まる。混ぜると、後者を後者として扱えない
- **頻度が違う。** `Stop`は応答ごとに発火し、`21.plan-required`のIssueではturnごとに飛ぶ
  （後述の既知の制約）。CIのチャンネルに混ぜると、リリース失敗の通知が埋もれる
- 全アプリ共通の運用でも、ログイン通知は`login-webhook-url`としてCI/デプロイ通知と
  別チャンネルに分けている。種類ごとにチャンネルを分けるのが既定

**Signalyでのチャンネル作成と1Passwordへのフィールド登録は人間の作業で、エージェントは
実行できない。**

## セットアップ

1. **【人間】** Signalyにセッション通知用のチャンネルを作り、Webhook URLをコピーする。
   CI/デプロイ用のチャンネルを再利用しない
2. **【人間】** 1Passwordの`apps/issue-deck`に`session-webhook-url`として登録する
3. `deploy/subpc/notify.env.example` を `~/.config/issue-deck/notify.env` へ置き
   （**chmod 600**）、1Passwordから値を書き出す。

   ```bash
   install -D -m 600 deploy/subpc/notify.env.example ~/.config/issue-deck/notify.env
   WH=$(op read "op://apps/issue-deck/session-webhook-url") || exit 1
   [ -n "$WH" ] || exit 1
   printf 'SESSION_NOTIFY_WEBHOOK_URL=%s\n' "$WH" >> ~/.config/issue-deck/notify.env
   ```

   **代入を`export`と分けること・`2>&1`を付けないこと。** `export WH=$(op read ... 2>&1)`
   と書くと、返るのは`export`の終了コードなので`op`の失敗を検出できず、エラーメッセージが
   値に混入してそのままwebhook URLとして書き込まれる（#1231で実際に踏んだ）。中間ファイル
   （`/tmp`等）を介さないのも、消す前に他ユーザーから読まれうるため
4. **書き出した直後に手で1回発火させ、届くことを確認する**（次節）
5. フックの設定は`run-issue-session.sh`が起動のたびに生成するので、他にやることは無い

**この設定をしていないPCでは、`session-notify.sh`は黙って何もしない。** メインPCで同じ
リポジトリのセッションを起動しても通知は飛ばない。

`SESSION_NOTIFY_WEBHOOK_URL`が未設定のときは旧名の`SIGNALY_WEBHOOK_URL`も読む。#1231より前に
設定した`notify.env`をそのまま動かすための互換で、新規に設定するときは新しい名前を使う。

## 設定したら1回手で発火させる

`session-notify.sh`はフックから呼ばれる限り**何が起きても`exit 0`で返す**（後述）。
つまり**設定が壊れていても、セッション側には何の兆候も出ない。** 気づける唯一の機会が、
手で叩いたときのstderrなので、設定・変更のたびに1回実行する。

```bash
printf '{"hook_event_name":"Stop","session_id":"manual-test"}' \
  | scripts/session-notify.sh 1231 issue-deck guchi-apps/issue-deck
```

- 成功: Signalyのセッション通知チャンネルに `✅ [issue-deck #1231] 応答終了 (subpc)` が届く。
  標準出力・標準エラーには何も出ない
- 失敗: `session-notify: Signalyへの通知に失敗しました（実装は続行します）` がstderrに出る。
  URLが誤り・値にエラーメッセージが混入している・Signalyが落ちている、のいずれか

`SESSION_NOTIFY_DRY_RUN=1`を付けると送信せずにpayloadだけを出力する。**これはpayloadの
組み立てまでしか見ておらず、webhook URLが正しいかは検証されない**（#1231で壊れていたのは
まさにURL側だった）。届くことの確認には必ず実際に発火させる。

## フックはこのスクリプトから起動したセッションにだけ適用する

`~/.claude/settings.json`（ユーザー設定）に書くと、メインPCの対話セッションでも通知が飛んで
邪魔になる。そこで[scripts/run-issue-session.sh](../../scripts/run-issue-session.sh)が
`$ISSUE_DECK_WORKTREE_BASE/.claude-hooks/issue-<番号>.settings.json`を生成し、
`--settings`で渡す。`--settings`の内容はユーザー設定・プロジェクト設定に**加算**されるので、
既存の設定を壊さない。

JSON文字列ではなくファイルで渡すのは、`ps`の出力にフックの中身が丸ごと出るのを避けるため
（プロンプトをファイル経由で渡しているのと同じ理由。#1105）。

フック設定に書くのは「`session-notify.sh`を呼ぶ」ことだけで、どのイベントを送るかの判定は
スクリプト側に置いている。判定を2箇所に分けると、必ずどちらかが古くなる。

## 通知の障害でセッションを止めない

通知経路の障害で実装が止まるのは本末転倒なので、`session-notify.sh`は**何が起きても
`exit 0`で返す**。webhookのURLが未設定でも、`curl`が失敗しても、`python3`が無くても同じ。
`curl`には`--max-time 10`を掛けてあり、応答が返らないwebhookでセッションを待たせない。

フックが非0で終了してもClaude Codeは`Failed with non-blocking status code`と表示して続行する
（実測）が、セッションのログに毎回エラーが出ると本来見たいものが読めなくなるため、
そもそも非0を返さない。なお**exit 2はフックの規約でブロッキング扱いになるので絶対に返さない**。

失敗をログに出すときもURLは出さない。webhookのURLはそれ自体が投稿権限を持つシークレットで、
tmuxのスクロールバックに残る。

## Remote Control

`claude --remote-control [name]`で、セッションをclaude.ai経由でスマホやブラウザから
操作できるようになる。`run-issue-session.sh`が`--name`と同じセッション名で付ける。

- 起動直後に `/remote-control is active · Continue here, on your phone, or at
  https://claude.ai/code/session_XXX` と表示される
- tmux上で問題なく動く。既存のログインを使うので追加のペアリング操作は要らない
- **`ISSUE_DECK_CLAUDE_REMOTE_CONTROL=0` で無効化できる。** 既定は有効
- `--remote-control`を解釈しない古いClaude Codeへ渡すと起動ごと失敗するため、
  `claude --help`に載っているときだけ付ける（`--name`と同じ扱い）

通知にURLを載せられるのは、`~/.claude/sessions/<pid>.json`に`sessionId`と`bridgeSessionId`
（`https://claude.ai/code/<bridgeSessionId>`のID）の対応があるため。フックには`session_id`が
渡ってくるので、そこから引ける。

**これはClaude Codeの非公開の内部ファイルなので、更新で形が変わりうる。** 読めなくても
通知自体は落とさず、URLだけが載らなくなる設計にしてある。

## #1179 のジョブキューとの切り分け

**この通知は`POST /api/dispatch/report`にも`POST /api/progress`にも何も足さない。**

- ディスパッチのジョブ状態（#1179）の`succeeded`は「tmuxセッションが立ち上がった」までで、
  それ以降は追わない
- 実装の進捗はProject Statusが唯一の正として持つ
  （[progress-status-architecture.md](../progress-status-architecture.md)）

「入力待ち」はそのどちらでもない一時的な状態で、issue-deckのDBへ入れると、
セッションが落ちたときに誰も消せない古い状態が残る。通知として飛ばして終わらせるのが
一番安い。issue-deckの画面に出す必要が実運用で出てきたら、そのとき改めて設計する。

## 既知の制約

- **`Stop`は応答の終了ごとに発火する。** 無人で回す実装セッションは
  「起動 → 数十分作業 → Stop」でほぼ1回だが、`21.plan-required`のように人が途中で答える
  Issueではturnごとに飛ぶ。多すぎたときの間引きは実運用の数字を見てから入れる
- 他リポジトリ（`dayspan`等）の`run-issue-session.sh`は別のコピーなので、この仕組みは
  issue-deckのセッションにしか掛かっていない。横展開は
  [local-quick-start.md](local-quick-start.md)のローカル起動プロトコルの版数と一緒に扱う
