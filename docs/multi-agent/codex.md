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
  申告の条件は`codex`コマンドが入っていることと、**そのホストでサンドボックスを実際に
  組み立てられること**（#2526。下の「サンドボックスを組み立てられないホスト」）。判定は
  `scripts/subpc-dispatch-poller.sh`の`codex_capable`。**古いpollerはジョブの`agent`を読まない**
  ため、申告が無いホストで選ばせるとCodexを選んだのにClaude Codeが黙って立つ
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
| `ISSUE_DECK_CODEX_SANDBOX` | `workspace-write` | Codexの`--sandbox`。サンドボックスを組み立てられないホストでの逃げ道でもある（下の「サンドボックスを組み立てられないホスト」） |
| `ISSUE_DECK_CODEX_MODEL` | （空） | Codexの`-m`。空なら`codex`側の既定 |
| `ISSUE_DECK_CODEX_EXTRA_ARGS` | （空） | 追加の引数（空白区切り）。実機でしか分からない調整をスクリプトの修正なしで当てるための逃げ道 |

導入（サブPC側で1回だけ）。**未導入のまま起動しようとすると、worktreeを作る前にエラーで止まる。**

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex login
```

**公式インストーラのstandalone installで入れる**（#2521）。`npm install -g @openai/codex`でも
TUIのセッションは起こせるが、共有のapp-serverデーモンに載るもの（`codex agents`・
`codex remote-control`）が1つも動かない（後述の「`codex agents`・`remote-control`はstandalone
installが要る」）。インストーラが`~/.bashrc`へ足すPATH追記は**戻すこと**（同じ節に手順がある）。

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
| 追加指示を送る（#1012） | ○（`send-keys`の3段階プロトコル） | ○（`codex queue`。#2519。**信頼確認に答えるまでは送れない**） |
| Remote Control | ○ | **△**（デーモンは起動できる。ただし取れるのはURLではなく短命のペアリングコード。未実装。#2521） |
| 前回の会話の引き継ぎ | ○（`--continue`） | **△**（`codex resume <session_id>`で作れる。未実装。#2510） |
| `--disallowedTools`による封じ込め | ○ | **×**（指定されていたら起動を断る） |

**そのぶんIssueコメントに残す記録が重要になる。** 端末だけで完結させると、画面からは何も起きて
いないように見える。この点は`scripts/prompts/codex-supplement.md`でエージェント自身にも伝えている。

`--disallowedTools`を使う経路（横断質問セッション・#1454）は、封じ込めが機械的に効かない状態で
読み取り専用のセッションが立つのを避けるため、**Codexでは起動を断る**（`run-issue-session.sh`）。

## queue・resume・remote-controlでどこまで揃うか（#2510）

上の表で「×」としていたもののうち、いくつかはCodex側が先に進んでいた。codex-cli 0.151.0の実機で
確かめた結果を残す。**分かれ目は「共有のapp-serverデーモンが要るかどうか」**で、要るものは
npmで入れたCodex（`npm install -g @openai/codex`）では1つも動かなかった。
**そのためサブPCのCodexはstandalone installへ入れ替えた**（#2521。下の表はその後の結果）。

| 確かめたこと | 結果 |
|---|---|
| `codex queue`で走っているセッションへ差し込めるか | **○**。デーモン不要。`send-keys`も要らない（#2519で実装） |
| 差し込んだメッセージの届き方 | **次のターンの頭**。走っているターンは中断しない |
| `codex agents`でセッションを一覧できるか | **○**（#2521でstandalone installへ入れ替えた） |
| `codex remote-control start` / `pair` | **○**（同上）。ただし取れるのは短命のペアリングコード |
| セッションに`<リポジトリ名> #<番号>`の名前を付けられるか | **×**。名前はモデルが自動で付ける |
| `codex resume <session_id> <PROMPT>` | **○**。ピッカーを出さず、履歴も引き継ぐ |

**このうち実装したのは「追加指示を送る」だけ**（#2519。下の「追加指示は`codex queue`で送る」）。
`resume`とRemote Controlはまだ可否の記録のまま（Remote Controlは#2521でデーモンが動くように
なったが、画面へ出す設計から要る）。

### `codex queue`は使える。しかも`send-keys`が要らない

tmuxの中で普通に起こしたCodexのTUIセッションへ、**別のシェルから**メッセージを差し込めた。

```bash
codex queue --thread <セッションUUID または 完全一致のセッション名> --message '<本文>'
# → Queued message <メッセージUUID> for thread <セッションUUID>.
```

**これがissue-deckにとって大きい。** Claude Code側の「追加指示を送る」（#1012）は、`tmux send-keys`
での本文送出とEnterの別送を3段階プロトコルで囲って成立させている（`scripts/subpc-dispatch-poller.sh`の
`INSTRUCTION_*`）。承認プロンプトや選択フォームの表示中に送ると既定の選択肢で勝手に答えてしまう
事故があったため、[gates.md](gates.md)は`send-keys`そのものを禁じ、そこだけを例外として開けている。
**`codex queue`はTUIのキー入力を経由しない**ので、この例外を開けずに同じことができる。

- **デーモンは要らない。** `codex agents`や`codex remote-control`と違い、standalone installが
  無くても動く。「走っているセッション」の判定は`~/.codex/thread-writer-locks/<session_id>.lock`で、
  終了済み・存在しないセッションを指すと`Error: No active session found matching '<指定>'.`で
  終了する（終了コードは0ではない）
- **投げたシェルのカレントディレクトリは関係ない。** worktreeの外から`/tmp`配下のセッションへ
  差し込めた
- **アイドル中のセッションへ投げると、その場で新しいターンが始まる。** 「走っている間だけ使える」
  ものではない
- 差し込んだ本文は普通のユーザー発言としてTUIにも転記（rollout）にも残る

### 差し込みは割り込みではなく「次のターン」

120行の出力を求めるターンの実行中に2通目を投げたところ、**1通目の出力は最後まで流れ切り**、
そのあとで2通目がユーザー発言として現れて処理された。走っているターンは止まらない。

「追加指示」としてはこの届き方でよい（Claude Code側の3段階プロトコルも、処理中
（`esc to interrupt`が出ている間）は送らずに待つ）。**逆に、走っている処理を止めたいときには使えない**
——停止は従来どおり`C-c`（[gates.md](gates.md)の1つ目の例外）のままになる。

### スレッドIDは`SessionStart`フックのJSONから取る

`--thread`はセッションUUIDか**完全一致**のセッション名を取るが、名前は当てにできない（次項）。
残るのはUUIDで、これは**#2509で繋いだ`SessionStart`フックのJSONにそのまま入っている**。

```json
{"session_id":"01a0510e-…","transcript_path":"/home/guchi/.codex/sessions/…jsonl",
 "cwd":"…","hook_event_name":"SessionStart","model":"gpt-5.6-sol",
 "permission_mode":"bypassPermissions","source":"startup"}
```

`Stop`にも同じ`session_id`が入る（加えて`turn_id`・`last_assistant_message`）。
`scripts/session-notify.sh`はすでに`session_id`と`transcript_path`を読んでいるので、**Issue番号と
UUIDの対応をどこかへ残せば、`codex queue`の宛先はそこから引ける**。

**ただしフックはディレクトリの信頼確認に答えるまで飛ばない**（上の「信頼（trust）は2種類あり」）。
**答える前のセッションのUUIDは取れない**ので、その間は追加指示を送れない。画面には
「まだ開始していません」が出ている状態なので、実装するなら送れないことを画面側でも表せる。

### セッション名は付けられない

`--thread`は名前でも引けるが、**名前を決めるのはCodex側**だった。`~/.codex/session_index.jsonl`には
最初に「プロンプトの先頭を切ったもの」が入り、数秒後にモデルが付け直した短い題名（例:
`bashでsleep 90を実行`）へ置き換わる。**名前を指定する起動オプションは無い**（`codex --help`・
`codex exec --help`のどちらにも無い）。改名は`codex agents`のTUI（`TuiAgentsKeymap`に
`search` / `rename` / `toggle_grouping`）にあるが、その`codex agents`が動かない（次項）。

したがって`run-issue-session.sh`が付けている`<リポジトリ名> #<Issue番号>`に相当する名前を
Codex側へ持ち込むことはできない。**宛先はUUIDで持つ**。

### `codex agents`・`remote-control`はstandalone installが要る（#2521で入れ替えた）

どちらも共有のapp-serverデーモン越しに動くもので、npmで入れたCodexでは同じエラーで止まっていた。

```
$ codex remote-control start --json
Error: managed standalone Codex install not found at /home/guchi/.codex/packages/standalone/current/codex
This command requires the standalone install managed by the Codex installer, because the daemon
starts and updates app-server from that fixed path.
```

`codex agents`・`codex app-server daemon start` / `version`も同じだった。導入方法の変更＝依存関係の
変更なので、[CLAUDE.md](../../CLAUDE.md)のとおりユーザーの判断を取ったうえで**サブPCのCodexを
standalone installへ入れ替えた**（#2521）。以下はその結果。

#### 入れ替えても、npm版は消さずに済む

インストーラは`~/.codex/packages/standalone/releases/<版>-x86_64-unknown-linux-musl/`（約330MB）へ
実体を置き、`~/.local/bin/codex`をそこへのsymlinkにする。**サブPCの`~/.local/bin`はPATHの先頭**
（`~/.profile`が置いている。miseのshimsより前）なので、npm版を消さなくても新しいシェルでは
standalone版が優先される。

- **戻すのは`rm ~/.local/bin/codex`の1回で済む**（消すとmiseのshim経由でnpm版に戻る）
- **走っているセッションには影響しない。** 実行中のプロセスは起動時に解決した実体を握ったままで、
  入れ替えの最中も2本のCodexセッションが動き続けていた
- **`~/.bashrc`へ入る`# >>> Codex installer >>>`のPATH追記は戻すこと。** `~/.bashrc`は
  `guchi-apps/subpc`（`configs/bash/bashrc`）の管理下にあり、手で足すとドリフト検知に出る。
  そもそも`~/.profile`が同じPATHを置いており、subpcのREADMEも「PATHは`~/.bashrc`ではなく
  `~/.profile`側に置く」としているため、この追記は要らない

  ```bash
  cp ~/apps/subpc/configs/bash/bashrc ~/.bashrc   # 管理下の内容へ戻す
  ```

- インストーラは既存のnpm版を見つけると「アンインストールするか」を対話で聞く。
  `CODEX_NON_INTERACTIVE=1`を付ければ聞かずに「消さない」を選ぶ
- **バージョンの追い方が変わる。** miseのnode配下から外れ、Codex自身の自動更新
  （`autoUpdateEnabled: true`）に載る。上げ直すときは`npm install -g`ではなくインストーラを
  もう一度流す。`codex --version`が見るのは`~/.local/bin/codex`の側なので、npm版が残っていても
  表示は混ざらない

#### 取れるのはURLではなく短命のペアリングコード

Claude Code側のRemote Control（#1219）は`--remote-control`が出すURLを`scripts/session-notify.sh`が
拾っている。**Codex側はURLを出さない。**

```
$ codex remote-control start --json
{"mode":"daemon","status":"connected","serverName":"subpc","environmentId":"env_e_…",
 "timedOut":false,"daemon":{"status":"bootstrapped","backend":"pid","autoUpdateEnabled":true,
 "remoteControlEnabled":true,"managedCodexPath":"…/packages/standalone/current/codex",…}}

$ codex remote-control pair --json
{"pairingCode":"<数字の長い列>","manualPairingCode":"<XXXX-XXXX>","environmentId":"env_e_…",
 "expiresAt":<epoch秒>}
```

- **`pair`が返すのは`XXXX-XXXX`形式の手動ペアリングコードで、有効期限は10分**（`expiresAt`と
  実行時刻の差）。`serverName`はホスト名（`subpc`）で、Issueごとには分かれない
- **これは資格情報。** 期限が短くてもIssueコメント・PR本文・ログへ値を書かない
- **`start`の直後は`pair`が`timed out waiting for remoteControl/pairing/start response`で落ちる**
  ことがある。デーモンが上がりきってから呼び直すと通る
- 止めるのは`codex remote-control stop`（`{"status":"stopped",…}`）。止めた後は
  `codex app-server daemon version`がソケット無しのエラーに戻る。**確認のあとは止めてある**

#### tmuxで普通に起こしたTUIは、デーモンに載る

「1（tmuxのセッションが共有デーモンに載るか）」の答えは**載る**。standalone版で
`tmux new-session -d … codex …`と起こしたセッションは、別シェルの`codex agents`に
`/home/guchi/apps/issue-deck  1 › ○ Untitled task  Ready`として現れた。
**逆にnpm版で起動済みだった2本は現れない**——入れ替えより前に起こしたセッションは載らない。

- **`codex agents`はTTYが要るTUI**で、`stdin is not a terminal`で終わる。一覧を機械可読で取る
  サブコマンドは無い（画面へ出すなら`codex app-server`のプロトコルを直接叩くことになる）
- 改名（`ctrl+r`）もこのTUIの中だけ。`<リポジトリ名> #<番号>`を外から付ける手段は増えていない

### `codex resume <session_id>`はピッカーを出さずに再開できる

`codex resume <セッションUUID> '<プロンプト>' --sandbox workspace-write --ask-for-approval never`で、
**選択画面を出さずに前の会話を引き継いだ**（直前のやり取りを列挙させて確認）。UUIDは上と同じく
`SessionStart`フックから取れるので、`ISSUE_DECK_CLAUDE_RESUME`（`--continue`）に当たるものを
Codex側にも作れる。`--last`はホスト全体で最後のセッションを指すため、worktreeを並べる運用では
使えない——**UUIDを覚えておくことが前提**になる。

## 追加指示は`codex queue`で送る（#2519）

画面の「追加指示を送る」（#1012）は、Codexのセッションでも押せる。**送り方だけが違う。**

| | Claude Code | Codex |
|---|---|---|
| 送り方 | `tmux send-keys`の3段階プロトコル | `codex queue --thread <UUID> --message '<本文>'` |
| 宛先 | tmuxのセッション名 | セッションUUID（`SessionStart`フックの`session_id`） |
| 送らない条件 | 承認プロンプト・選択フォームの表示中／処理中／入力欄に打ちかけ | **宛先がまだ分からないとき**だけ |
| 届き方 | 入力欄へ入って即座に確定 | 次のターンの頭（走っているターンは止まらない） |

**`send-keys`へ寄せていない。** [gates.md](gates.md)が`send-keys`そのものを禁じて追加指示だけを
例外として開けているのは、TUIのキー入力に本文を流し込むことの危うさ（選択フォームの表示中に
送ると勝手に回答済みになる）が理由で、`codex queue`はそこを通らない。**Codexでは例外を
開けずに同じ機能が成り立つ。**

### 宛先はIssueごとの状態ファイルに残す

`codex queue --thread`が取るのはUUIDか完全一致のセッション名だけで、**名前はCodexが自動で
付け直す**ため当てにできない（#2510）。残せるのはUUIDで、それが手に入るのは`SessionStart`
フックのJSONの`session_id`だけ。

1. `run-issue-session.sh`が起動時、記述子（`<セッション名>.session`）へ`agent=codex`を書く
2. `session-notify.sh`が`SessionStart`で記述子を読み、Codexなら`session_id`を
   `<セッション名>.codex-thread`へ書く（**Claude Codeのセッションでは何もしない**）
3. pollerは追加指示のジョブを受けたとき、記述子の`agent`で送り方を選ぶ
   （`deliver_session_instruction` → `deliver_codex_instruction`）

**判定材料は記述子の`agent`だけ**で、転記のパスやJSONの形からエージェントを推定はしない。
読めない・知らない語のときは`claude`へ倒す——`codex`へ倒すと、Claude Codeのセッションに対して
宛先の無い`codex queue`を打つことになる。セッションを畳むと宛先も消える
（`session_state_remove`）。残すと、次に同じ名前で立ったセッションへ前回の宛先で送ってしまう。

### 信頼確認に答えるまでは送れないことを画面に出す

**ディレクトリの信頼確認に答えるまでフックは1つも飛ばない**（下の「信頼（trust）は2種類あり」）。
その間UUIDが手に入らないので追加指示も送れない。押せてしまうと、pollerが見送るまで（最大1分）
何が起きたのか分からないため、**押す前に断る**。

- pollerがセッションの報告に`codexThreadKnown`を載せる。**3値**で、`null`＝Codexのセッション
  ではない（Claude Code）／`false`＝Codexだが宛先がまだ無い／`true`＝送れる
- issue-deckは`DispatchSession.codexThreadKnown`へ写し、`false`のあいだは
  `resolveSessionControlRejection`が`codex_thread_unknown`で断る（画面のボタンは無効になり、
  理由が下に出る）。**停止・終了には効かない**——どちらもtmux側の操作で宛先が要らない
- **項目そのものを送ってこない古いpollerでは`null`のまま**＝従来どおり送れる扱いになる
  （`claudeStarting`・`reapAt`と同じ向き）。そのpollerはCodexを選ぶ経路（`codexCapable`）も
  申告していないので、画面からCodexで起こすことはできない

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

### サンドボックスを組み立てられないホスト（#2526）

**`codex`コマンドが入っていても、セッションが1本もコマンドを実行できないホストがある。**
Codexが同梱するbubblewrapが非特権のuser namespaceを組み立てられない場合で、出るのは
**`bwrap:`で始まる行**（`codex`自身のエラーではないので、メッセージで検索しても何も出てこない）。

```
bwrap: setting up uid map: Permission denied
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

**見分け方はこの1行だけでよい。** `bwrap:`が出ていればホスト側の制限で、Codexの設定・ログイン・
プロンプトのどれとも関係がない。subpcで起きているのはUbuntu 24.04の既定
（`kernel.apparmor_restrict_unprivileged_userns = 1`）がuser namespaceの中でcapabilityを
全部落とすためで、**ホスト側の恒久対処は`guchi-apps/subpc#77`**。issue-deck側では直せない。

手元で確かめるなら次の1行。`0`で返ればこのホストでCodexを起こせる。

```bash
codex sandbox -c sandbox_mode=workspace-write -c sandbox_workspace_write.network_access=true -- /bin/true
```

**`codex sandbox`は`--sandbox`も`--ask-for-approval`も受け取らない**（`-c`のオーバーライドだけ）
ので、起動時と同じモードを確かめたいときは上のように`-c sandbox_mode=`で渡す。

#### 起こす前に止める

以前は「`codex`コマンドがあるか」しか見ていなかったため、**画面でCodexを選べるのにセッションが
即死した**（実例: #2511。worktreeも指示ファイルも読めずに終了した）。今は同じ下見を2か所が使う。

- `scripts/subpc-dispatch-poller.sh`の`codex_capable` — 組み立てられないホストは`codex`を
  申告しない。画面の「実装を開始」にエージェント欄そのものが出なくなる。理由は画面へは送らず、
  **可否が変わった巡だけjournaldへ出す**（`journalctl --user -u issue-deck-dispatch-poller`）
- `scripts/start-issue.sh` — `--agent codex`で起動しようとしたとき、**worktreeを作る前に**
  `bwrap:`の行と逃げ道を出して止まる

判定は`scripts/lib/agent-cli.sh`の`agent_cli_codex_sandbox_probe`が1つだけ持つ。結果は
`ok`／`broken`／`unknown`の3つで、**`unknown`（`codex sandbox`を持たない版）では塞がない**
——証拠があるときだけ止める。

#### 逃げ道: `danger-full-access`

`ISSUE_DECK_CODEX_SANDBOX=danger-full-access`ならbwrapを通らないので、この制限のあるホストでも
起こせる（実測で`codex sandbox -c sandbox_mode=danger-full-access -- /bin/echo hello`が成功する）。

```bash
ISSUE_DECK_CODEX_SANDBOX=danger-full-access scripts/start-issue.sh --agent codex <Issue番号>
```

**これは既定にしない。** `--ask-for-approval never`で走らせている前提の裏付けが「書き込みが
worktree（cwd）に閉じている」ことで、`danger-full-access`はその層だけを外す。残るのは後段の防御
（Pull Request必須・レビュー・自動マージ不可カテゴリ）で、**他のIssueのworktreeや本体
チェックアウトへ手が届く状態**になる。急ぐときに自分で1回ずつ付けるものとして扱い、
恒久対処は`guchi-apps/subpc#77`（ホスト側でuserns制限を緩める）を待つ。

**画面から起こす経路でこれを効かせたい場合は、pollerの環境（`dispatch.env`）へ置くことになる。**
pollerが受け口を`env ISSUE_DECK_AGENT=codex`で呼ぶとき、それ以外の環境変数はpollerのものが
そのまま継承されるため、置けば申告（`codex_capable`）も起動もそろって`danger-full-access`で
判定される。ただし上のとおり**そのホストの全Codexセッションから書き込みの閉じ込めが消える**ので、
置くかどうかは人が決める。

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
| 種別の解決・Codexの引数の組み立て・フックの`-c`の組み立て・サンドボックスの下見 | [`scripts/lib/agent-cli.sh`](../../scripts/lib/agent-cli.sh) |
| 起動の分岐（Claude固有の処理を飛ばす・フックの有効化） | [`scripts/run-issue-session.sh`](../../scripts/run-issue-session.sh) |
| フックから呼ばれる通知スクリプト（Claudeと共通） | [`scripts/session-notify.sh`](../../scripts/session-notify.sh) |
| `--agent`の受け取り・存在チェック・サンドボックスの起動前チェック・読み替えの追記 | [`scripts/start-issue.sh`](../../scripts/start-issue.sh) |
| 画面から渡された種別の受け取り・出口ごとの可否 | [`scripts/start-local-session.sh`](../../scripts/start-local-session.sh) |
| ジョブの`agent`の読み取り・`codex`の申告・追加指示の送り分け | [`scripts/subpc-dispatch-poller.sh`](../../scripts/subpc-dispatch-poller.sh) |
| `codex queue`での送出（#2519） | [`scripts/lib/codex-queue.sh`](../../scripts/lib/codex-queue.sh) |
| 宛先（セッションUUID）の置き場・エージェント種別の記録 | [`scripts/lib/session-state.sh`](../../scripts/lib/session-state.sh) |
| 語の検証・表示名・選べるかの判定 | [`src/lib/dispatch/dispatch-job.ts`](../../src/lib/dispatch/dispatch-job.ts) |
| 選択欄と注意の表示 | [`src/components/dashboard/start-implementation-dialog.tsx`](../../src/components/dashboard/start-implementation-dialog.tsx) |
| 境界のテスト | [`scripts/agent-cli.test.mjs`](../../scripts/agent-cli.test.mjs)・[`scripts/codex-queue.test.mjs`](../../scripts/codex-queue.test.mjs) |

## まだやっていないこと

- **subpcでは今のところサンドボックスを組み立てられない**（#2526）。`guchi-apps/subpc#77`で
  ホスト側のuserns制限が緩むまで、画面の「実装を開始」にエージェント欄は出ない（急ぐときの
  逃げ道は上の「サンドボックスを組み立てられないホスト」）
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
- **「前回の会話の引き継ぎ」は可否を確かめただけ**（#2510）。`codex resume <session_id>`で
  作れることは実機で確認したが、`ISSUE_DECK_CLAUDE_RESUME`（`--continue`）に当たる実装はまだ無い
  （宛先のセッションUUIDは#2519で残すようになったので、材料は揃っている）
- **Remote Controlは画面へ出せていない**（#2521）。standalone installへの入れ替えは済み、
  `codex remote-control start` / `pair`・`codex agents`は動くようになったが、取れるのはURLでは
  なく10分で切れるペアリングコードなので、`scripts/session-notify.sh`のURL拾い（#1219）を
  そのまま流用できない。issue-deckの画面にどう出すかの設計から要る
