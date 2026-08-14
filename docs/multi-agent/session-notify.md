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
  ├→ ~/.local/state/issue-deck/sessions/<tmuxセッション名>.event へ最後のイベントを記録（#1256）
  ↓ webhook（~/.config/issue-deck/notify.env の SESSION_NOTIFY_WEBHOOK_URL）
Signaly → スマホ・メインPCへ通知
  ↓ 通知に載っているURLを開く
claude.ai/code/<セッション> （--remote-control）→ その場で答える
```

### 通知とは別に、ホストへも記録する（#1256）

セッションの自動回収は「最後の`Stop`からどれだけ経ったか」「今は人の入力待ちか」を判定材料に
するが、**通知を投げるだけではホストに何も残らない**。そこで`session-notify.sh`は、送信の前に
`<epoch> <Stop|permission_prompt>`の1行を状態ファイルへ書く。

**記録はwebhookの設定より前に行う。** 送信先の判定を先に置くと、通知を設定していないホストで
記録も行われず、回収がまったく効かなくなる。記録の失敗は1行のログに留め、通知もセッションも
止めない。書式と使い道は
[作業が終わったセッションは自動で畳む](local-quick-start.md#作業が終わったセッションは自動で畳む1256)を参照。

## 計画はIssueのコメントへ残す（#1342）

**`21.plan-required`のIssueをここで起こすと、計画はセッションの中にしか残らなかった。**
画面に出るのは「入力を待っています」というバッジだけで（後述の#1264）、中身はRemote Controlを
開くまで見えない。プロンプト（`scripts/prompts/implementation-agent.md`）は計画をIssueへ投稿する
よう指示していたが、**エージェントが従うかどうかに依存していて担保が無い。**

そこで`ExitPlanMode`の`PreToolUse`フックで計画本文を掴み、issue-deckを経由してIssueへ書く。

```text
ExitPlanMode（計画の提示）
  → PreToolUse フック → session-notify.sh
       → POST /api/dispatch/sessions/plan
            → Issueへ計画コメントを投稿（末尾にRemote Controlのリンク）
            → 00.check-user を付与
       → ホストに「ラベルを付けた」印を残す（<セッション名>.plan）
  → 承認プロンプト（Notification）→ 従来どおりの入力待ち通知・画面表示
  → 人がRemote Controlで承認 → 実装 → Stop
       → POST /api/dispatch/sessions/activity に planResolved: true を添える
            → 00.check-user を除去
       → 印を消す
```

- **計画をIssueへ残せる唯一の機会が`ExitPlanMode`の`PreToolUse`。** 承認プロンプトの
  `Notification`のJSONには計画に関する情報が何も無い。`PreToolUse`にmatcherを付けるのは
  このためで、付けずに置くと`Read`・`Bash`のたびにスクリプトが起動する
- **このイベントではSignalyへ送らない。** 直後に承認プロンプトの`Notification`が必ず飛び、
  同じ「入力待ち」が二重になる。計画本文を外部サービスへ出す経路を作らない意味もある
  （下の「通知の中身」と同じ理由）
- **リンクは計画本文の下に、別の段落として置く。** 計画が長いほど、末尾に出口が無いと
  「読んだ後どうすればよいか」が画面から消える
- コメント本文の組み立ては`src/lib/dispatch/session-plan.ts`。GitHubへ書く経路は異常終了の
  引き上げ（`session-escalation.ts`）と同じで、**サブPCにGitHubの認証を持たせない**

### 計画本文は`ExitPlanMode`の引数では渡ってこない

**計画は`~/.claude/plans/<スラッグ>.md`にある。** plan modeに入るとClaude Codeがそのパスを
エージェントへ指示し、エージェントが`Write`／`Edit`で書く。`ExitPlanMode`は**そのファイルを
読むだけで、計画を引数に取らない**（ツールの説明にも「This tool does NOT take the plan content
as a parameter - it will read the plan from the file you wrote」とある。実測でも
`tool_input`は空）。当初は`tool_input.plan`から取るつもりで書き、動かなかった。

そこで`session-notify.sh`は、フックのJSONにある`transcript_path`を末尾から読み、
**エージェントが最後に`Write`／`Edit`した`~/.claude/plans/`直下の`.md`**を計画ファイルとみなす。

- **ツールの引数（`tool_use`ブロックの`input.file_path`）から拾い、本文の文字列一致では
  探さない。** 転記ファイルにはコマンドの出力も引用も入るので、「`~/.claude/plans/`配下の
  パスらしき文字列」を拾うと、**別セッションの計画ファイルの話をしただけの行**を掴む
  （実際に踏んだ）
- 末尾から探すのは、却下されて書き直された場合に新しいものが後ろに来るため。転記ファイルは
  数MBになりうるので末尾8MBだけを読む
- 引数で渡ってくる版に当たった場合はそちらを優先する（版差に強くしておく）
- **読めなければ黙って諦める。** プロンプト側に手で投稿する経路が残っている

**この形はClaude Codeの内部仕様に依存する**（Remote ControlのURLを`~/.claude/sessions/`から
引いているのと同じ性質）。壊れても計画が自動で載らなくなるだけで、セッションは止まらない。

### 「ラベルを外してよいか」の印はホスト側に置く

`00.check-user`を外すのは**自分で付けたときだけ**にする必要がある。`Stop`はturnごとに飛ぶため、
無条件に外すと人が別の理由で付けた`00.check-user`まで落とすからである。

その印をissue-deckのDB（`DispatchSession`）ではなくホスト側の状態ファイル
（`<セッション名>.plan`。#1256の仕組み）へ置いているのは、**`/activity`が`ALIVE`の行が無ければ
何もしない**ため。pollerが1巡する前に計画が出ると記録できず、ラベルだけ付いて外れなくなる。

計画待ちのまま畳まれたセッションでは、`cleanup`が印ごと消すのでラベルは残る。**これは正しい側の
取りこぼし**で、人がまだ計画を見ていないことを表す。起こし直せば新しい計画が投稿され、
その`Stop`で外れる。

なお人が画面の承認ボタンで先に外していることもあるが、`removeIssueLabel`が404を成功として
扱うのでそのまま通る。

## 飛ばすのは2種類だけ

`--permission-mode auto`（#1205）により承認プロンプトは激減しているので、飛ばすのは
**「本当に人の判断が要るもの」と「完了」**に絞る。判定は
[scripts/session-notify.sh](../../scripts/session-notify.sh)が持つ。

| フック | 条件 | 意味 | 通知 |
| --- | --- | --- | --- |
| `Notification` | `notification_type` が `permission_prompt` | 承認プロンプト・`AskUserQuestion`の質問 | 🙋 入力待ち |
| `Notification` | `notification_type` が `idle_prompt` | 応答終了から60秒アイドル | **送らない** |
| `Stop` | — | 応答の終了。無人で回すセッションでは実質「作業完了」 | ✅ 応答終了 |
| `PreToolUse` | `tool_name` が `ExitPlanMode` | 計画の提示（#1342） | **送らない**（Issueのコメントへ回す） |

**`idle_prompt`を捨てるのは、直前の`Stop`と必ず二重になるため。** 応答が終わって60秒
放置されると発火するので、`Stop`を送った約60秒後に同じ内容がもう1件飛ぶことになる。
通知が多すぎると意味を失う。

`--permission-mode auto`でも`AskUserQuestion`では`permission_prompt`が発火する（実測）。
autoは「Claudeが自分で判断してよいもの」を自動承認するだけで、人に聞く意思そのものは
潰さないため、この経路は生きている。

`SessionEnd`は使っていない。tmuxのウィンドウを閉じただけのイベントに通知の価値が薄い。

## 通知の中身

載せるのは Issue番号・リポジトリ名・ホスト名・イベント種別・`tmux attach`のコマンド・
IssueのURL・Remote ControlのURL（取れたときだけ）・**開発環境のURL**（#1265。
`23.preview-required`のセッションで`tailscale serve`が通っているときだけ）。

**応答テキスト（`Stop`フックの`last_assistant_message`）は載せない。** 応答本文には
Issue本文の引用・ファイルの中身・コマンドの出力が混ざりうる。それを外部サービスである
Signalyへ出す経路を最初から作らない。中身はRemote ControlのURLから見る。

## fieldsの値にリンクを載せるときの制約（#1234・#1247）

**Signalyのfieldsの値でリンクになるのは`[表示名](URL)`のマスクドリンク記法だけで、生URLを
置いても自動ではリンクにならない。** そのうえで、次の2つを守らないと表示が壊れる。

1. **URLに`_`を含めない**（含む場合は`%5F`へパーセントエンコードする）
2. **1つの値にリンクを2つ以上入れない**

理由はSignaly側のレンダラ（`frontend/app.js`の`renderFieldValue`）の処理順にある。
`[表示名](URL)`を`<a href="..." target="_blank" rel="noopener noreferrer">`へ置換した**あとで**
`_..._`を`<em>`へ変換するため、**生成後のHTMLに残る`_blank`の`_`が、値の中の他の`_`と対になる**。
対になった時点でhrefとtarget属性ごと壊れる。

```text
[セッションを開く](https://claude.ai/code/session_01ABC)
→ <a href="https://claude.ai/code/session<em>01ABC" target="</em>blank" ...>
```

つまり「値に残る`_`が2個以上」が壊れる条件で、マスクドリンク1つにつき`_blank`の`_`が1個増える。
Remote ControlのURL（`session_XXX`）は`_`を1個持つので、素直にマスクドリンクへ入れると必ず対になる。

- #1234では、これを避けるためにマスクドリンクをやめて生URLに戻した。しかしSignalyには
  自動リンク検出が無いためリンクにならず、しかもIssueリンク（マスクドリンク）と同じ値へ
  `·`で連結していたので、結局`_blank`と`session_`が対になって両方壊れていた（#1247）
- #1247では、URL中の`_`を`%5F`にしたうえでマスクドリンクへ戻し、IssueリンクとセッションURLを
  別々のフィールドへ分けた。`%5F`は`_`のパーセントエンコードなので指す先は変わらない
- 生URLも`Remote Control URL`フィールドに別途載せている。**スマホのプッシュ通知の本文は
  Signaly側がMarkdownを除去する**ため（`backend/push.py`の`_plain_text`）、マスクドリンクだけだと
  プッシュ通知には表示名しか残らずURLが消える。単独の値なら`_`は1個だけなので壊れない

実機で確認した結果（#1247）。

| 書式 | カードでリンクになるか | 開けるか |
| --- | --- | --- |
| `[表示名](.../session%5FXXX)` | なる | 開く |
| `[表示名](.../session_XXX)` | なる | **開かない**（hrefに`<em>`が混入する） |
| 生URL `.../session_XXX` | **ならない** | — |
| `[表示名](URLに_なし)` | なる | 開く |

`scripts/session-notify.sh`の`signaly_link()`がこのエンコードを行う。**fieldsへリンクを足す
ときは必ずこの関数を通し、1フィールド1リンクを保つこと。**

CI/デプロイ通知（`.github/scripts/signaly-notify.sh`）の`[Workflow Run](...)`はURLに`_`を
含まないため、この問題は起きていない。

## CI/デプロイ通知とチャンネルを分ける

セッション通知は**CI/デプロイ通知とは別のSignalyチャンネル・別の1Passwordフィールド**を使う
（#1231）。

| 通知 | 1Passwordのフィールド | 環境変数 | 設定場所 |
| --- | --- | --- | --- |
| CI/デプロイ | `apps/issue-deck` の `ci-webhook-url` | `SIGNALY_WEBHOOK_URL` | GitHubのrepository secret（正は1Password。対応は`.github/secrets-manifest.tsv`、同期は`scripts/sync-github-secrets.sh`。#1302） |
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

## 実際に動くのは本体の作業ツリーのスクリプト（#1274）

**フックが呼ぶ`session-notify.sh`は、worktreeのコピーではなく本体リポジトリの作業ツリー
（`~/apps/issue-deck/scripts/`）のものである。** 生成されるフック設定の`command`は絶対パスで、
`run-issue-session.sh`自身の置き場所（`$SCRIPT_DIR`）を指す。`start-issue.sh`は本体の
`scripts/`から`run-issue-session.sh`を呼ぶため、経路の全体がこうなる。

| 実行されるもの | どこから |
| --- | --- |
| `start-issue.sh` | 本体の作業ツリー |
| `run-issue-session.sh` | 本体の作業ツリー（`start-issue.sh`が絶対パスで呼ぶ） |
| `session-notify.sh` | 本体の作業ツリー（フック設定の`command`が絶対パス） |
| 実装対象のコード | worktree（`origin/develop`から作られる） |

ここに**worktreeだけが新しくなる**という非対称がある。`start-issue.sh`は起動のたびに
`git fetch origin develop`してからworktreeを作るが、「本体の作業ツリーには一切触れない」ことを
約束しているのでmergeはしない。**本体の作業ツリーを新しくするのは人の`git pull`だけ。**

そのため`session-notify.sh`をdevelopへマージしても、pullするまで実際に飛ぶ通知は古いままになる。
#1274はこれを踏んだもので、#1247でリンク書式を直した数時間後の通知が、依然として旧書式
（`Links`フィールドに生URL）で届いていた。**スクリプト側には何の兆候も出ない**ため、直したはずの
不具合を再度Issueとして起票することになる。

対策として、起動時に本体の`scripts/`が`origin/develop`と違っていれば警告を出す
（[scripts/lib/launcher-scripts-sync.sh](../../scripts/lib/launcher-scripts-sync.sh)）。
`start-issue.sh`・`generic-start-issue.sh`の両方から呼ぶ。**警告だけで、起動は止めないし
自動でpullもしない**（本体の作業ツリーに触れないという約束を、起動スクリプト側から破らない）。
`ISSUE_DECK_SKIP_SCRIPTS_SYNC_CHECK=1`で黙らせられる。

セッション通知に限らず、`scripts/`配下を直したときは**本体の作業ツリーへpullするまで反映されない**
と考えること。worktreeを作り直しても新しくならない。

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

## 画面にも同じ様子を渡す（#1264）

当初この節は「『入力待ち』はissue-deckのDBへ入れると、セッションが落ちたときに誰も消せない
古い状態が残る。通知として飛ばして終わらせるのが一番安い」としていた。**#1264で必要が出たので
設計し直した。**

必要になった理由は、**通知を消した時点で承認待ちであることを知る手段が無くなる**こと。
サブPCで`21.plan-required`のIssueを起こすと計画はセッション内のPlan modeで止まるが、
issue-deckの画面には何も出ず（`00.check-user`を付けるのはActions側の計画提示ステップだけ）、
唯一の合図がプッシュ通知だった。

そこで`session-notify.sh`が、Signalyへの通知と同じタイミングで
`POST /api/dispatch/sessions/activity`へも投げる。

| 送るもの | 値 |
| --- | --- |
| `repository` / `issue` | 引数で渡っているもの |
| `activity` | `waiting_input`（`permission_prompt`）/ `responded`（`Stop`） |
| `remoteControlUrl` | 取れたときだけ。受け口は**`https://claude.ai/`配下しか受け付けない** |
| `previewUrl` | セッション起動時に`run-issue-session.sh`が別途1回だけ送る（#1265）。受け口は**tailnet内（`*.ts.net`）のhttp URLしか受け付けない** |

宛先と鍵（`APP_BASE_URL`・`DISPATCH_SECRET`）はpollerと同じ`~/.config/issue-deck/dispatch.env`
から読む。**未設定でも失敗しても実装は止めない**（このスクリプトの約束）。設定していない
ホストでは通知だけが飛び、画面に出ないだけになる。

### 古い「入力待ち」が残らない担保

当初の懸念（誰も消せない古い状態が残る）は、解ける経路を2つ持たせることで潰している。

| 経路 | 何が起きるか |
| --- | --- |
| `Stop`フック | `RESPONDED`へ遷移する。応答が終われば必ず飛ぶ |
| pollerの1巡（既定60秒） | セッションが消えれば`EXITED`/`FAILED`/`GONE`になる |

**画面側は状態（poller）を様子（フック）より優先する**（`summarizeIssueSession`）。
セッションが落ちていれば、`WAITING_INPUT`の報告が残っていても「入力待ち」とは出さない。
入力を待つ相手がもういないため。

### 受け口はpollerの一括報告と分ける

pollerが叩く`POST /api/dispatch/sessions`は「そのホストで今見えているセッションの全て」を
前提に、含まれない行を`GONE`へ倒す。**フックの1件を同じ経路へ流すと、他のセッションが全部
消えたことになる**ため、`/activity`を別に置いている。

`/activity`は**行が無ければ何もしない**（`updated: 0`を返して200）。フックはpollerより先に
飛びうるが、行を作るとフック側が知らない`host`・`tmuxSessionName`に嘘の値が入る。1巡待てば
pollerが作るので、取りこぼしても次のフックで載る。

### 「ここへ書いても届かない」を、承認欄だけでなくコメント欄にも出す（#1287）

`11.local`が付いている間、Issueへ何を書いても無人実行は反応せず、走っているClaude Code自身にも
コメントを取りに行く仕組みは無い。#1264はこれを**承認欄**（`LocalSessionApprovalNotice`）に
出したが、**承認欄は承認待ちのときしか描かれない**。実装中に追加の指示や訂正を書く方がむしろ
多く、そちらは何の合図も無いまま埋もれる。そこでコメント入力欄にも同じ案内を置く
（`LocalSessionCommentNotice`）。

- 枠と「Remote Controlで開く」の導線は`local-session-notice.tsx`の内部コンポーネントで共有し、
  **文面だけを分ける**。片方だけ直して食い違うのを防ぐ
- 出す条件は承認欄と同じ`executionTarget.expectsActionsRun === false`。Actionsで走っている
  Issueではコメントが実際に効くので出さない
- **セッションが見つからなくても案内自体は出す。** 届かないことは`11.local`が決めており、
  セッションの記録が取れているかとは独立している。取れていないときはリンクだけが消える

## 既知の制約

- **`Stop`は応答の終了ごとに発火する。** 無人で回す実装セッションは
  「起動 → 数十分作業 → Stop」でほぼ1回だが、`21.plan-required`のように人が途中で答える
  Issueではturnごとに飛ぶ。多すぎたときの間引きは実運用の数字を見てから入れる
- 他リポジトリ（`dayspan`等）の`run-issue-session.sh`は別のコピーなので、この仕組みは
  issue-deckのセッションにしか掛かっていない。横展開は
  [local-quick-start.md](local-quick-start.md)のローカル起動プロトコルの版数と一緒に扱う
