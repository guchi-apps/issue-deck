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
- **モデルも同じダイアログで選べる**（#3192）。エージェントでCodex CLIを選ぶと、Claude Codeと
  同じ位置の「モデル」欄がCodexの候補（おまかせ・Sol・Terra・Luna）へ切り替わる。詳細は下の
  「モデルは起動ごとに選べる」
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

## モデルは起動ごとに選べる（#3192）

「実装を開始」ダイアログの「モデル」欄は、エージェントに合わせて中身が変わる。**Claude Codeで
立てるときの「おまかせ」・Fable・Opus・Sonnetと同じ形**で、Codexでは**おまかせ・Astra・Sol・Terra・Luna**。
選んだ値は`DispatchJob.codexModel`へ入り、払い出し（`POST /api/dispatch/claim`）が
`job.codexModel ?? 設定`を`codexModel`として載せ直す。**pollerは従来どおり`codexModel`
だけを読む**ので、poller・ランチャー側の変更は要らない（Claudeの`claudeLocalModel`と同じ持たせ方）。

| | Claude Code | Codex |
|---|---|---|
| ジョブの列 | `DispatchJob.claudeModel` | `DispatchJob.codexModel` |
| ダイアログの候補 | `CLAUDE_LOCAL_MODEL_OPTIONS`（fable・opus・sonnet） | `CODEX_LOCAL_MODEL_VALUES`（astra・sol・terra・luna） |
| 設定の値 | `AppSetting.claudeLocalModel`（`pick`あり） | `AppSetting.codexModel`（`pick`あり。旧世代・`auto`も残る） |
| 払い出しで`pick`のとき | Sonnet | Terra |

- **`POST /api/dispatch`・`POST /api/nightly-run`の`model`は`agent`で語が決まる。** Codexへ`opus`、
  Claude Codeへ`gpt-5.6-sol`を送ると400（選んだつもりのないモデルで立つより、その場で断る）
- **ダイアログの候補に`auto`（`-m`を付けない起動）と旧世代（GPT-5.5・5.4）は入れない。** どのモデルで
  立つか分からない方式を選ばせない、というClaude側の方針（#2776）に揃えた。**設定には残る**ので、
  ダイアログを経由しない起動（次にやること・ローカルで開始・PR修正依頼の呼び戻し・一括停止からの再開）は
  従来どおり設定の値で立つ。**設定が旧世代・`auto`のときのダイアログの初期選択はTerra**
  （`resolveCodexInitialModel`。選択なしで開くと何で立つか分からなくなるため）
- **「おまかせ」は判定を行うのがどちらもアプリ内AI**（既定Claude Haiku。Codexへ問い合わせる経路は無い）。
  変わるのは候補・プロンプト・AIを呼べないときのルール（`lib/claude/model-pick.ts`。
  `POST /api/issues/model-pick`の`agent`で切り替える）。**ルールでLunaを選ぶのは文書だけの短い更新に
  限り、迷ったらTerra**。エージェントごとに判定と結果を別に持つので、切り替えても取り違えない
  （`use-model-pick.ts`をエージェントごとに1つずつ持つ）
- **設定が「おまかせ」なら、Codexを選んだ時点で1回だけ自動で判定する**（Claude Codeの
  #3106と同じ。開いたあたり、エージェントごとに1回）。判定が終わるまで「開始する」は押せない
- 実行キューの行に、指定したモデルの印と●の濃さが出る（指定が無いジョブには付けない）

## Claude Codeと揃わないもの

Codexに同じ仕組みが無いため、**issue-deckの画面側の連携が一部効かない**。

| 機能 | Claude Code | Codex |
|---|---|---|
| セッションの開始・終了の報告、プレビューURL | ○ | ○（`run-issue-session.sh`のラッパー側で行っているため） |
| 停止（応答終了）の通知 | ○（`Stop`フック） | ○（同名のフック。#2509） |
| 「まだ開始していません」の検知（#1465） | ○ | ○（`SessionStart`フック。#2509） |
| 入力待ちの通知（Push通知） | ○（`Notification`フック） | **×**（同じイベントが無い。後述） |
| 計画の承認パネル（画面から承認・修正） | ○（`ExitPlanMode`のフック） | ○（`scripts/submit-plan.sh`。#2545） |
| 質問への回答（画面から答える） | ○（`AskUserQuestion`のフック） | ○（`scripts/submit-question.sh`。#2579） |
| 作業ステップの表示（一覧の「実装中(3分)」・進捗バーの調査／実装／検証のマス） | ○（`Pre/PostToolUse`フックが`.step`を書く。#2705） | ○（**フックではなく転記から**。pollerが直近のツール呼び出しを分類して`.step`を書く。#3213。下の「作業ステップは転記から起こす」） |
| AI使用量の集計（エージェント別・Issue別） | ○ | ○（#2535） |
| AI使用量のフェーズ内訳（計画・調査・実装・検証・仕上げ） | ○ | ○（#3169。下の「フェーズの内訳も同じ5行へ割る」） |
| APIエラーで中断したセッションの自動再開 | ○ | ○（`task_complete.error`を検知して`codex queue`で再開。#3178） |
| ターンが閉じないまま止まったセッションの自動再開 | ○（ツール呼び出しの空振り。#2896） | ○（`task_started`のまま閉じない形を検知して`codex queue`で再開。#3174。**現象そのものが違う**——下の「ターンの取りこぼし」） |
| アーティファクトの取り込み（#2154） | ○（`Artifact`のフック） | **×**（Claude Code固有のツール。`scripts/lib/codex-artifact.sh`で手動登録する） |
| 追加指示を送る（#1012） | ○（`send-keys`の3段階プロトコル） | ○（`codex queue`。#2519。**信頼確認に答えるまでは送れない**） |
| Remote Control | ○（Issueごとのリンク） | **△**（画面の「Codexに繋ぐ」でペアリングコードを発行する。ホストのカードとIssueの両方から押せるが、繋がるのはホスト単位。繋いだ先では`<リポジトリ名> #<番号>`の名前で見分ける。#2524・#2537・#2540） |
| 前回の会話の引き継ぎ | ○（`--continue`） | ○（`codex resume <session_id>`。#2520） |
| `--disallowedTools`による封じ込め | ○ | **×**（指定されていたら起動を断る） |

### 作業ステップは転記から起こす（#3213）

一覧の添える字「実装中(3分)」と進捗バーの調査／実装／検証・仕上げのマスは、`.step`
（`scripts/lib/session-step.sh`の語彙）だけを材料にしている。Claude Codeは`Pre/PostToolUse`フックが
書くが、**Codexは`SessionStart`・`Stop`しかフックを繋いでいない**ため`.step`が空のままで、画面は
進捗Statusの「計画検討中（サブPC）」で固定され、実装に入ってもバーが動かなかった。

**pollerが転記（`~/.codex/sessions/…/rollout-*.jsonl`）の末尾から直近のツール呼び出しを読み、
同じ分類で`.step`を書く**（`scripts/lib/session-codex-step.sh`。セッションの報告のたびに1回）。

- 呼び出しは`response_item`・`payload.type=custom_tool_call`・`name=exec`で、`payload.input`に
  JSのコードが入る。拾うのは`tools.apply_patch(`（→`EDITING`）と`tools.exec_command(`の`cmd`
  （→`session_step_from_bash_command`。Claude Codeと同じ分類）、`web__run`・`view_image`（→`EXPLORING`）
- **見た時刻は転記のレコードの時刻**。巡回した時刻で書くと直前の`Stop`より後になり、終わった
  ターンの作業が「いま走っている」ように出る（`isSessionStepFresh`）
- `write_stdin`（走っているコマンドへの入力・待ち）と`update_plan`は作業の種類を表さないので書かない。
  `submit-plan.sh`・`submit-question.sh`も書かない（画面の返事を待って止まるため、「コマンド実行中」と
  出すと人を待っていることが隠れる）
- **読めなければ何もしない**（従来どおり進捗Statusの文言に戻る）。転記の形はCodexの内部仕様
- フックを繋ぐ案は見送った。`exec`ラッパーの下で`tool_name`／`tool_input`がどう渡るかを実機で
  確かめておらず、ツール呼び出しごとにプロセスを起こすことにもなる。反映はpollerの巡回間隔ぶん遅れる
- **計画の承認後に進捗が動かない問題は別の原因**で、エージェント種別を問わない。ローカルセッションは
  承認を受けて`Planning`→`Implementation`へ進める経路が無かった。画面から承認したとき
  （`POST /api/dispatch/plan-decision`）にissue-deckが報告する（`advanceSessionPlanProgress`。
  [progress-status-architecture.md](../progress-status-architecture.md)）。端末で承認した場合は動かない

### 画面デザインをIssueDeck配下で共有する（#2597）

Codex CLIにはClaude Codeの`Artifact`ツールが無いため、画面デザインをローカルHTTPサーバーの
`localhost` URLで公開すると、サブPC上のURLを別端末から開けない。Issue専用セッションでは
`scripts/lib/codex-artifact.sh <HTMLファイル>`を使う。このコマンドはHTMLを既存の
`POST /api/dispatch/sessions/artifact`へ登録し、ログインが必要な
`https://issuedeck.gucchii.com/artifacts/<id>`を返す。計画コメントにはlocalhost URLではなく、
返されたIssueDeck URLを記載する。

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
| `codex remote-control start` / `pair` | **○**（同上）。取れるのは短命のペアリングコード（#2524で画面へ出した） |
| セッションに`<リポジトリ名> #<番号>`の名前を付けられるか | **△**。起動オプションには無いが、app-serverの`thread/name/set`で後から付けられる（#2540） |
| `codex resume <session_id> <PROMPT>` | **○**。ピッカーを出さず、履歴も引き継ぐ |

**この表のものは実装済みになった。** 「追加指示」は#2519、「前回の会話の引き継ぎ」は
#2520、Remote Controlは#2524（下の「Remote Controlはペアリングコードで繋ぐ」）。
ただしRemote Controlで繋がるのは**ホスト単位**で、Claude Codeのような
「そのIssueを開くURL」にはならない。

### `codex queue`は使える。しかも`send-keys`が要らない

tmuxの中で普通に起こしたCodexのTUIセッションへ、**別のシェルから**メッセージを差し込めた。

```bash
codex queue --thread <セッションUUID または 完全一致のセッション名> --message '<本文>'
# → Queued message <メッセージUUID> for thread <セッションUUID>.
```

**これがissue-deckにとって大きい。** Claude Code側の「追加指示」（#1012）は、`tmux send-keys`
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

### セッション名は起動オプションでは付けられないが、app-serverから付けられる（#2540）

**起動時には付けられない。** `--thread`は名前でも引けるが、名前を決めるのはCodex側で、
`~/.codex/session_index.jsonl`には最初に「プロンプトの先頭を切ったもの」が入り、数秒後にモデルが
付け直した短い題名（例: `bashでsleep 90を実行`）へ置き換わる。**名前を指定する起動オプションは
無い**（`codex --help`・`codex exec --help`のどちらにも無い）。改名は`codex agents`のTUI
（`TuiAgentsKeymap`に`search` / `rename` / `toggle_grouping`）にあるが、TTYが要るので外から
呼べない。

**後から付けることはできる**（#2540）。app-serverのJSON-RPCに`thread/name/set`があり、
`SessionStart`フックで取れるUUIDを宛先にして`<リポジトリ名> #<Issue番号>`を付けられる。
**これがCodexにとってのRemote Control相当の要**——繋いだChatGPTアプリに出るのはホストの
Codexセッション全部の一覧（#2524・#2537）で、名前が自動命名のままだと**どれがどのIssueか
分からない**。

```bash
{ printf '%s\n' \
  '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"issue-deck","version":"1"}}}' \
  '{"method":"initialized","params":{}}' \
  '{"id":2,"method":"thread/name/set","params":{"threadId":"<UUID>","name":"issue-deck #2540"}}'
  sleep 3; } | codex app-server
# → {"id":2,"result":{}} ＋ {"method":"thread/name/updated",…}
```

- **デーモンは要らない。** stdioの`codex app-server`を1回起こすだけでよい（`codex queue`と同じ）。
  **`codex app-server proxy`（走っているデーモンの制御ソケットへの中継）では応答が返らなかった**
  ——NDJSON・`Content-Length`の両方で無反応
- **stdinを閉じるとリクエストを処理せずに終了する**（実測200ms）。応答を読み終えるまでstdinを
  開けておく（実装は`coproc`。`scripts/lib/codex-thread-name.sh`）
- **走っているセッションにも効く。** tmuxで起こしたTUIのスレッドへ付け替えられる。ただし
  **モデルの自動命名に上書きされる**（#2540で「上書きされない」としていたのは誤り。
  下の「自動命名で消えた名前は巡回で付け直す」）
- 知らないスレッドIDには`no rollout found for thread id …`が返る。**セッション開始の直後は
  転記がまだ無いことがある**ので、そのときだけ数回やり直す
- 付けるのは`session-notify.sh`の`SessionStart`（`name_codex_thread`）。**切り離して走らせる**
  ——名前が付くのを待つ価値は無く、付かなくてもセッションは動く（`codex queue`の宛先はUUIDのまま）

**宛先は引き続きUUIDで持つ。** 名前は人が一覧で見分けるためのもので、`codex queue`が名前でも
引けることには依存しない（名前は後から人が変えられる）。

#### 自動命名で消えた名前は巡回で付け直す（#3220）

**`SessionStart`で1回付けるだけでは残らない。** 実機（codex-cli 0.152.1）では、付けた
`<リポジトリ名> #<番号>`が**最初のターンの2〜6秒後にモデルの自動命名で上書きされる**。索引
（`~/.codex/session_index.jsonl`）には3行がこの順で並ぶ。

```
13:52:04  出力言語は日本語です。ユーザーの目に…   ← プロンプトの先頭を切ったもの
13:52:05  asset-manager #504                  ← SessionStartのフックが付けたもの
13:52:07  アプリアイコンを変更                   ← モデルの自動命名（これが残る）
```

2026-09-20時点でapp-serverの一覧（`thread/list`）に出ていた25本のうち22本が自動命名のままで、
**ChatGPTアプリのリモート制御からどれがどのIssueのセッションか選べなかった**——#2540が
やろうとしていたことが実際には効いていなかった。

そこで**pollerがセッションを報告するたびに、名前がずれていれば付け直す**
（`sync_codex_thread_name` → `codex_thread_name_sync`）。

- **判定では`codex`を起こさない。** 索引の最後の行（同じIDの行は名前が変わるたびに増える）を
  読んで比べるだけで、`codex app-server`を起こすのはずれているときだけ。付け直した結果も索引へ
  入るため、次の巡では何も起きない
- **自動命名が走るのは最初のターンの1回だけ**なので、付け直しも実質1回で落ち着く。反映は
  巡回の間隔（60秒）ぶん遅れる
- **索引を読めない・知らない形のときは何もしない**（自動命名のままになるだけ）。索引の形は
  Codexの内部仕様で、当て推量で書くと人が付けた名前まで壊す
- **人がChatGPTアプリ側で改名しても巡回で戻る。** 一覧の名札としての一意性を優先している。
  止めたいときは`ISSUE_DECK_CODEX_NAME_SYNC=0`（pollerの環境）
- **自動命名を止める設定は無い**（`codex features list`にも索引・`config.toml`のキーにも
  見当たらない）。`Stop`フックで付け直す案は、ターンごとに`codex app-server`を起こすことに
  なるため採らない

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
実体を置き、`~/.local/bin/codex`をそこへのsymlinkにする。**PATHの順序に依存しない**——pollerは
miseのshimsが先に来る環境でも`~/.codex/packages/standalone/current/codex`を明示的に選ぶ（#3194）。
npm版を消す必要はない。

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

#### Remote Controlはペアリングコードで繋ぐ（#2524・#2537）

**「Codexに繋ぐ」ボタンは2か所にある**——実行キューのホストのカードと、**Codexで動いている
Issueのセッション表示**（#2537。スマホのIssue詳細にも同じものが出る）。押すとpollerが
`codex remote-control start`（デーモンの起動）と`pair --json`（コードの発行）を打ち、
返ってきた`XXXX-XXXX`が画面へ出る。ChatGPTアプリの「Connect to Codex」へ打ち込むと繋がる。

**スマホから繋ぐ手順**（#3220の答え。繋いだ後はそのホストのCodexセッションの様子を逐一見られる）。

1. issue-deckを開き、実行キューのサブPCのカード（またはCodexで動いているIssueのセッション表示）の
   「Codexに繋ぐ」を押す。**10分で切れる**ので、繋ぐ直前に押す
2. ChatGPTアプリの設定＞リモート制御＞「接続を追加」へ、出てきた`XXXX-XXXX`を入れる
3. 一覧に`<リポジトリ名> #<Issue番号>`の名前で並ぶ（#2540・#3220）。繋がる単位はホストなので、
   **そのホストで動いているCodexセッションが全部見える**

**「オフライン」と出るときは、そのホストのデーモンが上がっていないか、別のホストの接続を見ている。**
`remoteControlEnabled`は`~/.codex/app-server-daemon/settings.json`に残り、Codexのセッションが
立つたびにデーモンも上がるが、確実なのは「Codexに繋ぐ」をもう一度押すこと（`start`は冪等）。
サブPCの接続名はホスト名（`subpc`）になる。

- **繋がるのはホスト単位。** `serverName`はホスト名（`subpc`）なので、1枚のコードで
  そのホストのCodexセッションが**全部**見える（`codex agents`に出るもの。tmuxで起こした
  TUIも載る）。Claude Code側（#1219）のような「そのIssueを開くURL」にはならない
- **Issueの画面にも置いたのは、そこが答える出口だから**（#2537）。Codexのセッションでは
  `remoteControlUrl`が空になり、Claude Codeなら出る「Claude Codeアプリで開く」が消える。
  入力待ちのIssueを開いても画面から答える手段が1つも無いように見えていた。**押したIssueだけに
  繋がると誤解させない**ため、Issue側の文言は「このIssueだけでなく」から始める
- **繋いだ先でどれがどのIssueかは、セッション名で見分ける**（#2540）。名前はモデルの自動命名
  だったため一覧から目的のセッションを選べなかった。`SessionStart`で`thread/name/set`を打ち、
  Claude Codeの`--name`と同じ`<リポジトリ名> #<Issue番号>`に揃えている（前述の
  「セッション名は起動オプションでは付けられないが、app-serverから付けられる」）
- **Issue側は、申告の無いホストでもボタンを消さない。** 押せない理由（standalone installの
  Codexが要る）を出して無効にする。ホストのカードはCodexと関係の無いホストにも並ぶので
  申告のあるホストにだけ出すが、Issueの行は既にCodexで動いていると分かっている
- **コードは10分で切れる。** 期限を過ぎた行は画面に出ず、DBの列も
  `expireStaleDispatchJobs`が空にする。**コードは資格情報**なので、Issueコメント・PR本文・
  Push通知・pollerのjournaldには出さない（画面はログイン必須）
- **押せるのは`codexRemoteControl`を申告したホストだけ。** 申告の条件は`codex`の実体が
  `~/.codex/packages/standalone/`配下にあること（`codex_remote_control_capable`）。
  **`codexCapable`（`codex`コマンドがある）だけでは足りない**——npmで入れたCodexでも
  サブコマンドは存在するが、共有のapp-serverデーモンを起こせない（#2521）
- **デーモンは止めない。** `stop`を打つと、そのとき繋いでいる端末との接続も切れる。
  `start`は既に上がっていれば`connected`を返すだけ（冪等）なので、押すたびに呼んでよい
- 実装は`src/lib/dispatch/codex-pairing.ts`（判定と表示）・`enqueueCodexPairingJob`（積む）・
  pollerの`run_codex_pairing_job`（発行）。ジョブの種別は`CODEX_PAIRING`で、
  `SELF_UPDATE`・`REBOOT`と同じ枠外のジョブ（キューの一覧には出ない）。ボタンと出てきた
  コードの見せ方は`src/components/dashboard/codex-pairing-control.tsx`にまとめてあり、
  **ホストのカードとIssueのセッション表示が同じ部品を呼ぶ**（#2537。送るものはどちらも
  ホスト名だけ）
- **Issue一覧の行には出していない**（#2537）。あの行のRemote Controlはリンク（#1915）で、
  発行の往復と10分で切れるコードの表示は行に収まらない。一覧から辿るときはIssueを開く

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

`run-issue-session.sh`は、同じworktreeを再利用して起こすときに
`<セッション名>.codex-thread`（#2519）を読み、対応があればこのコマンドで再開する。UUIDは
`SessionStart`フックが書き、セッション終了後も次回の再開用にホスト内だけへ残す。

- **対応が無ければ新しい会話。** 初回や、ディレクトリの信頼確認に答える前に終了した場合は
  `SessionStart`が飛ばずUUIDも無いため、従来の`codex <PROMPT> ...`で起こす
- **新規作成・再作成では引き継がない。** 呼び出し元が`ISSUE_DECK_CLAUDE_RESUME=0`を渡すため、
  古いUUIDを起動前に消して新しい会話にする。人が明示的に同じ環境変数を渡した場合も同じ
- **`--last`は使わない。** ホスト全体の最後ではなく、tmuxセッション名
  （`<リポジトリ名>-issue-<番号>`）に対応するUUIDだけを指定する

## 追加指示は`codex queue`で送る（#2519）

画面の「追加指示」（#1012）は、Codexのセッションでも押せる。**送り方だけが違う。**

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

### 計画・質問の判断は、issue-deckが払い出して送る（#3218）

**Codexは判断を待てない。** `submit-plan.sh`・`submit-question.sh`はシェルのコマンドとして
実行されるが、Codexは`tools.exec_command`を`yield_time_ms: 30000`で呼ぶため、30秒で打ち切られた
出力が「`Script completed` / `Wall time 30.2 seconds`」として返る。**まだ走っているとは書かれない**
ので、Codexは完了と解釈してそのターンを終える。実測（ops-dashboard#302）では、スクリプト自身は
162秒後に修正依頼を受け取って終了コード0で完了していたが、それを受け取る当事者はもういなかった。

**#3179の保険（スクリプトの中から`codex queue`を打つ）はセッションの内側では動かない。**
Codexのサンドボックスが書込みを許すのはworktree・`/tmp`・`$TMPDIR`・対象リポジトリの`.git`だけで、
`~/.codex`のstate DB（SQLite）は読み取り専用になる（`attempt to write a readonly database`）。
2026-09-20の失敗5件と ops-dashboard#302 は偶発ではなく、通ったのは`~/.codex/app-server-daemon`が
上がってWALファイルがあった1回だけだった。

そこで送る場所をサンドボックスの外へ出した。

1. `submit-plan.sh`・`submit-question.sh`は、`ISSUE_DECK_AGENT=codex`のとき**登録だけして
   終了コード0で返る**。標準出力に「このターンはここで終えてよい／承認を待たずに進まないこと」を出す
2. 画面から承認・修正・回答を押すと、issue-deckが`INSTRUCTION`ジョブを積む
   （[`src/lib/dispatch/codex-decision-notify.ts`](../../src/lib/dispatch/codex-decision-notify.ts)）
3. pollerが`deliver_codex_instruction`から`codex queue`で送る。pollerは通常のユーザー権限で
   走っているので`~/.codex`へ書ける

**送る本文は3つの固定文面だけ**（承認・修正・質問への回答）。修正の内容と回答はIssueコメントに
残っている（`buildSessionPlanDecisionCommentBody`・`buildSessionQuestionAnswerCommentBody`）ので、
固定文面は「最新のコメントを読め」と言うだけにする。`DispatchJob.instruction`は改行を含まない
500字までで、人が書いた長い文章は入らない。

**送り先はCodexのセッションに限る**（`codexThreadKnown`が非null）。Claude Codeのセッションへ
積むと、pollerが`send-keys`の3段階プロトコルの方へ倒し、人の操作を挟まない自動の`send-keys`に
なってしまう。Claude Codeはフックが`GET …/decision`で判断を取りに来るので、そもそも要らない。

**届かなかったことは画面に出す。** 計画の返事待ちには`CODEX_QUEUED`／`CODEX_QUEUE_FAILED`を
配送の記録として書くので、計画パネルの結果欄に積めたかどうかが出る。セッションが終わっていて
積めない場合は、既存の「セッションを復旧」から呼び戻す。

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
宛先の無い`codex queue`を打つことになる。UUIDは次回の`codex resume`にも使うため、セッションを
畳んでも残す（#2520）。新しい会話で起こす場合はランチャーが起動前に消し、前回の宛先へ追加指示を
送らないようにする。

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
- **`--add-dir`で渡すのはgitの管理領域だけ**（#2529。下の「gitの管理領域だけは開ける」）。
  それ以外には渡さない。Codexの`--add-dir`は「書き込み可能なディレクトリを増やす」もので、
  読むだけならサンドボックスの外でもできる。共有知識リポジトリ（`~/apps/_docs`）は読み取り専用と
  して扱う決まり（[CLAUDE.md](../../CLAUDE.md)）なので、渡すと機械的に破れるようになるだけ

### gitの管理領域だけは開ける（#2529）

**worktreeだけを書けるようにすると、コミットできない。** git worktreeの`.git`は
`gitdir: <本体>/.git/worktrees/<名前>`と書かれた**ただのファイル**で、インデックスもHEADもログも
本体側にある。オブジェクトと`refs/heads/*`・`packed-refs`・`FETCH_HEAD`はさらに上の本体の`.git`
にあるため、`workspace-write`のままでは`git add`が次のエラーで落ちる。

```
fatal: Unable to create '/home/guchi/apps/issue-deck/.git/worktrees/issue-2511/index.lock': Read-only file system
```

実例が#2511で、実装も検証（Lint・型チェック・テスト5,255件・ビルド）も終えたあと、
**コミットの直前でセッションが止まった**。

そこで`agent_cli_build_codex_args`が、`git rev-parse --git-common-dir`と`--absolute-git-dir`の
うち**ワークスペースの外にあるもの**を`--add-dir`で渡す（`scripts/lib/agent-cli.sh`の
`agent_cli_codex_writable_dirs`）。linked worktreeの管理領域は本体の`.git`の下にあるので、
実際に渡るのは**本体の`.git`1つだけ**。**ふつうのクローン（`.git`がワークスペースの中）では
1つも渡さない**——閉じ込めを緩める理由が無い。足すのは`workspace-write`のときだけで、
`read-only`と`danger-full-access`には足さない。

起動時の1行で確かめられる（`workdir`のほかに本体の`.git`が並ぶ）。

```
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /home/guchi/apps/issue-deck/.git] (network access enabled)
```

**緩むのは`.git`の中だけ。** 他Issueのworktreeの管理領域と他ブランチのrefへは書けるようになるが、
**本体チェックアウトと他Issueのworktreeの作業ファイル**は従来どおり読み取り専用で、下の逃げ道
（`danger-full-access`）とは別物。gitはオブジェクトもrefも本体側へ書くため、これより狭くして
コミットとpushを通す方法は無い。

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
worktree（cwd）と本体の`.git`に閉じている」ことで、`danger-full-access`はその層だけを外す。残るのは後段の防御
（Pull Request必須・レビュー・自動マージ不可カテゴリ）で、**他のIssueのworktreeや本体
チェックアウトへ手が届く状態**になる。急ぐときに自分で1回ずつ付けるものとして扱い、
恒久対処は`guchi-apps/subpc#77`（ホスト側でuserns制限を緩める）を待つ。

**画面から起こす経路でこれを効かせたい場合は、pollerの環境（`dispatch.env`）へ置くことになる。**
pollerが受け口を`env ISSUE_DECK_AGENT=codex`で呼ぶとき、それ以外の環境変数はpollerのものが
そのまま継承されるため、置けば申告（`codex_capable`）も起動もそろって`danger-full-access`で
判定される。ただし上のとおり**そのホストの全Codexセッションから書き込みの閉じ込めが消える**ので、
置くかどうかは人が決める。

## プロンプトは分岐させず、差分だけを足す

実装プロンプトのひな形（`scripts/prompts/implementation-agent.md`。#3021で整理する前は43KBあった）について、Codex専用の写しを
作れば**片方が必ず古くなる**。そのため写しは作らず、Codexで起こしたときだけ
`scripts/prompts/codex-supplement.md`（読み替え）を生成したプロンプトの末尾へ足す。

読み替えに書いてあるのは、Claude Code前提の記述をどう置き換えるか。

- `CLAUDE.md`を自分で読むこと（**Codexが自動で読むのは`AGENTS.md`**）
- 確認は`AskUserQuestion`ではなく端末＋Issueコメント（**ラベルを外すのも自分**）
- `Read`・`Grep`・`Glob`はシェルで代替する
- 承認プロンプトは出ない・書き込みはworktreeと本体の`.git`に閉じている（`git`はそのまま使える）

**読み替えが見つからない場合、Codexでの起動は失敗する**（`start-issue.sh`）。Claude Code前提の
記述だけが残ったプロンプトを渡すと、存在しない手順を待って止まるため。

### 手順が変わるものは、末尾の読み替えに書かず本文を差し替える（#2551）

**「本文はこう書いてあるが、末尾でこう読み替える」が成立するのは、道具の名前が変わるときだけ。**
やることの順序そのものが変わるものは、本文側を書き換える。

#2545で計画の登録を`scripts/submit-plan.sh`へ寄せたとき、読み替えは末尾の補足にだけ置いた。
本文（`## 最初にやること`・`## Issueに残す記録`）には「Plan modeで提示する」「フックが自動で
投稿するので、**投稿されていなければ手で投稿する**」が残ったままで、Codexのセッションは
そちらに従い、計画を`gh issue comment`で自分で投稿して承認を待たずに実装へ進んだ（#2550）。
末尾の1行より、本文で2か所くり返される手順の方が強い。

そのため計画の出し方だけは、生成時にエージェント別の文面へ差し替える。

- ひな形の該当箇所は`{{PLAN_INSTRUCTIONS}}`・`{{PLAN_COMMENT_NOTE}}`のプレースホルダ
- 埋めるのは`scripts/start-issue.sh`と`scripts/generic-start-issue.sh`（どちらも解決した種別で
  分岐する。#2590）。**汎用ランチャーのひな形（`scripts/prompts/generic-implementation-agent.md`）にも
  同じプレースホルダを置いてある**——そちらにClaude Code前提の手順が残っていると、#2550と同じことが
  他リポジトリのセッションで起きる
- **43KBの本文を分岐させるわけではない。** 差し替えるのは矛盾する2か所だけで、残りは共通のまま

### 宛先と鍵は`dispatch.env`から読む（#2551）

`scripts/submit-plan.sh`が使う`APP_BASE_URL`・`DISPATCH_SECRET`は、`session-notify.sh`・
pollerと同じ`~/.config/issue-deck/dispatch.env`にある。**`notify.env`には無い**——あちらが持つのは
Signalyのwebhook URLだけで、`deploy/subpc/notify.env.example`にもそう書いてある。

**環境変数だけを見るのも不可**。pollerは`dispatch.env`を`set -a`で読んでから起動するが、tmuxの
セッションが引き継ぐのは**tmuxサーバー側の環境**で、サーバーをいつ・誰が起こしたかで届くか
どうかが変わる（`build_env_prefix`が明示的に転送するのは`ISSUE_DECK_*`だけ）。

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

`scripts/start-local-session.sh`が既定以外のエージェントを受け取ったとき、次を先に確かめる。
`exit 1`すればpollerがジョブを`failed`にするため**理由が画面に出る**。

- **`scripts/start-issue.sh`が`ISSUE_DECK_AGENT`を読まないリポジトリ** — 実際に走るファイルを
  `grep`で見る。**ローカル起動プロトコルの版数では判定しない**（版数はリポジトリ側が手で書く
  宣言で、`ISSUE_DECK_AGENT`を読むようにしたかどうかとは連動しない）。ここを通さないと、
  画面には「Codex CLI」と出たままClaude Codeが立つ

**確かめるのは契約適合（`contract`）の出口だけ**（#2590）。汎用ランチャー（`generic`）で起こす
リポジトリは、走るのがissue-deck自身の`scripts/generic-start-issue.sh`なので、対象リポジトリ側には
何も要らない（[generic-launcher.md](generic-launcher.md)「エージェントは受け口から渡ってくる」）。

## 実装の在り処

| 何を | どこに |
|---|---|
| 種別の解決・Codexの通常／resume引数の組み立て・フックの`-c`の組み立て・サンドボックスの下見 | [`scripts/lib/agent-cli.sh`](../../scripts/lib/agent-cli.sh) |
| 起動の分岐（Claude固有の処理を飛ばす・フックの有効化） | [`scripts/run-issue-session.sh`](../../scripts/run-issue-session.sh) |
| フックから呼ばれる通知スクリプト（Claudeと共通） | [`scripts/session-notify.sh`](../../scripts/session-notify.sh) |
| `--agent`の受け取り・存在チェック・サンドボックスの起動前チェック・読み替えの追記・計画の出し方の差し替え | [`scripts/start-issue.sh`](../../scripts/start-issue.sh) |
| 計画・質問の登録（Codexでは待たずに返す。#3218） | [`scripts/submit-plan.sh`](../../scripts/submit-plan.sh)・[`scripts/submit-question.sh`](../../scripts/submit-question.sh) |
| 判断・回答をCodexへ払い出す固定文面と送り先の判定（#3218） | [`src/lib/dispatch/codex-decision-notify.ts`](../../src/lib/dispatch/codex-decision-notify.ts) |
| 画面から渡された種別の受け取り・出口ごとの可否 | [`scripts/start-local-session.sh`](../../scripts/start-local-session.sh) |
| 他リポジトリでの種別の受け取り・読み替えの追記・計画の出し方の差し替え（#2590） | [`scripts/generic-start-issue.sh`](../../scripts/generic-start-issue.sh) |
| ジョブの`agent`の読み取り・`codex`の申告・追加指示の送り分け | [`scripts/subpc-dispatch-poller.sh`](../../scripts/subpc-dispatch-poller.sh) |
| `codex queue`での送出（#2519） | [`scripts/lib/codex-queue.sh`](../../scripts/lib/codex-queue.sh) |
| セッション名を付ける・自動命名から付け直す（#2540・#3220） | [`scripts/lib/codex-thread-name.sh`](../../scripts/lib/codex-thread-name.sh) |
| 宛先（セッションUUID）の置き場・エージェント種別の記録 | [`scripts/lib/session-state.sh`](../../scripts/lib/session-state.sh) |
| 語の検証・表示名・選べるかの判定 | [`src/lib/dispatch/dispatch-job.ts`](../../src/lib/dispatch/dispatch-job.ts) |
| 選択欄と注意の表示 | [`src/components/dashboard/start-implementation-dialog.tsx`](../../src/components/dashboard/start-implementation-dialog.tsx) |
| 使用量の集計（転記の読み取り・フェーズの境界） | [`scripts/lib/session-usage.sh`](../../scripts/lib/session-usage.sh)の`codex_session_usage_aggregate` |
| プラン枠の読み取り | [`scripts/lib/codex-usage.sh`](../../scripts/lib/codex-usage.sh)・[`src/lib/dispatch/codex-usage.ts`](../../src/lib/dispatch/codex-usage.ts) |
| 境界のテスト | [`scripts/agent-cli.test.mjs`](../../scripts/agent-cli.test.mjs)・[`scripts/codex-queue.test.mjs`](../../scripts/codex-queue.test.mjs)・[`scripts/codex-thread-name.test.mjs`](../../scripts/codex-thread-name.test.mjs) |

## AI使用量はClaude Codeと同じ粒度で出す（#3169）

画面の「AI使用量」は、エージェント別（Claude／Codex）・リポジトリ別・セッション種別別・Issue別の
どれもCodexを数えている（#2535）。**揃っていなかったのは「セッション種別別」のフェーズの行だけ**で、
Codexのセッションは実装の金額がまるごと「実装（フェーズ未集計）」の1行へ落ちていた。

### フェーズの内訳も同じ5行へ割る

`codex_session_usage_aggregate`（`scripts/lib/session-usage.sh`）がフェーズの境界を拾うようにした。
**考え方はClaude側（`session_usage_aggregate`）と同じで、拾う場所だけが違う。** Codexのツール
呼び出しは`exec`の1つしか無く、中身はJavaScriptのソースとして`input`に入っている。

| 境目 | Claude Code | Codex |
|---|---|---|
| 計画 → 調査 | `ExitPlanMode` | `scripts/submit-plan.sh`の実行（#2545） |
| 調査 → 実装 | `Edit`/`Write`/`MultiEdit`/`NotebookEdit`、またはBashでの書き込み | `tools.apply_patch(`、または`cmd`がBashでの書き込み |
| 実装 → 仕上げ | 最初の`git commit` | 同じ（`cmd`を見る） |
| 検証の印 | テスト・Lint・型チェック・ビルド・疎通確認 | 同じ（`cmd`を見る） |

- **`BASH_WRITE`・`BASH_COMMIT`・`BASH_VERIFY`の正規表現は両方で同じものを持つ。片方だけ直さない。**
  Codex側は`"cmd":"…"`をJSONとして解いてから当てる（`exec`のソースはJSの文字列なので、
  素のソースへ当てると`\n`のようなエスケープを踏む）
- **境は「次に来た応答の時刻」にする。** Codexの`custom_tool_call`は、その呼び出しを出した応答の
  `token_count`より**前**の行に出る（Claudeは同じ応答の中の`tool_use`なので時刻が並ぶ）。
  呼び出し自体の時刻を境に使うと、計画を出した応答が計画の外へ落ちる
- **境を1つも拾えなかったセッションは、従来どおり区分なし（`null`）で送る。** 画面は
  「実装（フェーズ未集計）」として合算だけを見せる。実測（サブPCの転記67本）では43本が割れた

### 金額は累積値の差から積む

`token_count`の`total_token_usage`は**累積値**で、`last_token_usage`（そのAPI呼び出しぶん）の合計と
一致する。フェーズへ割るには応答ごとの金額が要るので、**前の値との差**を1応答ぶんとして積む。

- **累積値は1本の転記の中で巻き戻る**（圧縮・枝分かれの後は0から数え直す）。以前のように最後の
  累積値だけを読むと、巻き戻りより前の消費がまるごと落ちていた（実測で1セッションぶんの金額が
  半分に出ていた）。下がった時点で基準を戻し、差を積んだものを合計にする
- 差の合計を金額にしているので、**5つのフェーズの合計はセッションの金額とぴったり合う**
  （画面のカードの合計が「従量課金相当」タイルと食い違わない）

### Codexのプラン枠に5時間枠は無い

Codexのカード（`codex-usage-card.tsx`）が週間枠しか出さないのは取りこぼしではない。転記の
`rate_limits`を実機で確かめると、**プランによって返る枠が変わる**——`plus`は`primary`が5時間
（`window_minutes: 300`）＋`secondary`が週間（`10080`）だが、いまの`prolite`は`primary`が週間だけで
`secondary`は`null`。Claude側と同じ2段のメーターにはできないので、**高さだけを合わせた空の枠**を
置いてある（#2666）。

## 転記からターンの取りこぼしを見つける（#3174）

Codexの転記（`~/.codex/sessions/<年>/<月>/<日>/rollout-<時刻>-<スレッドUUID>.jsonl`）は、
**ターンの区切りを`event_msg`として明示的に書く。** この3つだけを見れば、ターンが閉じたかどうかが
外から分かる。

| `payload.type` | いつ書かれるか |
|---|---|
| `task_started` | ターンの開始（人の入力・`codex queue`で積んだ差し込み） |
| `task_complete` | ターンの終了。APIエラーのときは`error`が入る（#3178の判定材料） |
| `turn_aborted` | Ctrl-Cでの中断（`reason: "interrupted"`） |

**開始だけが書かれて、どれも来ないまま更新が止まる**ことがある。セッションはtmuxの中で生きて
いるため画面からは「実行中」にしか見え（`Stop`フックも飛ばない）ず、放置される。これを停滞として
拾うのが`scripts/lib/session-codex-turn-stall.sh`で、詳細は
[subpc-dispatch.md](subpc-dispatch.md)「Codexのターンが閉じないまま止まったセッションの自動再開」。

**Claude Codeの「ツール呼び出しの空振り」（#2655・#2896）とは別の現象。** あちらは`Agent({…})`の
ようなコード風のテキストを出しただけでターンを正常に終える形で、Codexはツールを
`custom_tool_call`としてネイティブに呼ぶため同じ形にはならない。**Codexで再現しないものを移植
しようとしない**（判定材料が無く、誤検知しか増えない）。

実測（2026-09-20・サブPCの転記74件）:

- `task_started` 141 / `task_complete` 129 / `turn_aborted` 5。差の7件が「開始したまま閉じて
  いない」ターンで、1件は実行中、6件は過去に消えたセッションだった
- **ターンの中のレコード間隔は最大103秒**（120秒を超えたファイルは0件）。ツールの実行中は転記へ
  何も書かれないが、それでもこの程度しか空かない。停滞の閾値を分単位で置けば誤検知しない
- ターンをまたぐ間隔（人の入力待ち）は最大42分まで伸びる。**マーカーを見ずに「更新が止まった
  時間」だけで判定すると、入力待ちを停滞と読む**

## 揃えられないものの決着（#3169）

**比較表の`×`・`△`を1つずつ、「別Issueへ起票した」か「Codex側に仕組みが無く実現不可」かで決着させる。**
Issueを跨いで同じ調査を繰り返さないための記録で、**実機（codex-cli 0.152.1）で確かめた事実だけを書く。**

| 揃っていないもの | 決着 | 根拠 |
|---|---|---|
| 入力待ちのPush通知 | **実現不可** | Codexに`Notification`に当たるイベントが無い。フックの一覧にあるのは`PreToolUse`・`PermissionRequest`・`PostToolUse`・`Pre/PostCompact`・`SessionStart`・`SessionEnd`・`Subagent*`・`UserPromptSubmit`・`Interrupt`・`Stop`で、承認待ちに当たる`PermissionRequest`は`--ask-for-approval never`では発火しない |
| Remote ControlのIssueごとのリンク | **実現不可** | `codex remote-control pair`が返すのは10分で切れる`XXXX-XXXX`のペアリングコードだけで、URLを出さない。`serverName`はホスト名なので、繋がる単位はホスト（#2524）。代わりに繋いだ先で見分けられるよう、セッション名を`<リポジトリ名> #<番号>`へ揃えてある（#2540。自動命名で消えるためpollerの巡回で付け直す。#3220） |
| 質問・計画をアプリ側で受け取るトグル（`answerInApp`・#2822） | **実現不可** | 上と同じ理由で、切り替えた先（Claude Codeアプリに当たる出口）が無い。ONにすると画面からもアプリからも答えられない質問ができるため、受け口が断る（`session-answer-mode.ts`） |
| アーティファクトの自動取り込み | **実現不可** | `Artifact`はClaude Code固有のツールで、フックで拾う相手がいない。`scripts/lib/codex-artifact.sh`で同じカードへ登録する（#2597） |
| ディレクトリの信頼確認がIssueごとに出る | **実現不可（方針）** | 自動で答えない（[session-notify.md](session-notify.md)「信頼確認そのものは自動化しない」）。答えていないことは画面の「まだ開始していません」で分かる |
| 無人実行（GitHub Actions） | **人の判断待ち** | `OPENAI_API_KEY`のSecrets追加と課金の判断が要る。決まるまで起票しない |

**揃っているものは表に出さない。** AI使用量の集計・セッション種別のバッジ・計画の承認・質問への回答・
追加指示・前回の会話の引き継ぎ・中断／停滞からの自動再開は、いずれも画面から同じように使える（上の比較表）。

## まだやっていないこと

- ~~**subpcでは今のところサンドボックスを組み立てられない**（#2526）~~ →
  **解消済み。** 2026-09-20の実機では下見（`codex sandbox -c sandbox_mode=workspace-write …`）が
  0で返り、画面の「実装を開始」にもエージェント欄が出ている（pollerも`codex`を申告している）。
  組み立てられないホストでの止まり方は上の「サンドボックスを組み立てられないホスト」のまま
- **無人実行（GitHub Actions）は対象外。** `claude-issue-dispatch.yml`は`claude-code-action`の
  ままで、Codexで走らせるには`OPENAI_API_KEY`のSecrets追加と課金の判断が要る
- **契約適合の他リポジトリ（自前の`scripts/start-issue.sh`を持つもの）は`ISSUE_DECK_AGENT`を
  読まない。** 揃えるまでは受け口が止める。**汎用ランチャーで起こすリポジトリは#2590で対応済み**
  （むしろ`start-issue.sh`を持たない側が先に使えるようになった）
- **ディレクトリの信頼確認はIssueごとに1回出る。** Claude Codeのように本体チェックアウトへ
  記録されないため、worktreeを作るたびに人が答える必要がある。答えるまで止まっていることは
  画面に出る（「まだ開始していません」）
- **Remote Controlは繋げるようになったが、Issueごとのリンクではない**（#2524）。実行キューの
  ホストのカードに出る「Codexに繋ぐ」を押すと、pollerが`codex remote-control start` / `pair`を
  打ってペアリングコードを発行し、画面に出る（前述の「Remote Controlはペアリングコードで繋ぐ」）。
  **`serverName`はホスト名なので、1枚のコードで繋がるのはそのホストのCodexセッション全部**で、
  Claude Codeのような「そのIssueを開くURL」（#1219）にはならない
