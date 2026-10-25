# リモートセッション（#4743）

左メニュー「構想・相談」・スマホホームの「リモートセッション」（`?pane=remote-sessions`／
`?mscreen=remote-sessions`）から、**リポジトリだけを指定してサブPCにClaude Codeのセッションを立て、
Claude Codeアプリへ移動する**。会話そのものはIssueDeckではなくClaude Codeアプリ（claude.ai/code・
モバイルアプリ）で行う。アプリ内チャット（#3975・[chat.md](chat.md)）はこれに置き換えた。

## 入口（#4991）

- **PC**: トップバーの端末アイコン（起動中の本数バッジ付き）が開くポップオーバー
  （`remote-session-popover.tsx`）。上段が起動中のセッション（「開く」でClaude Codeアプリへ）、
  下段が新しく起動するリポジトリの一覧。再開・終了は左メニューの画面が持つ
- **スマホ**: 右下の端末ボタン（本数バッジ付き）が開くダイアログの最上部に、起動中のセッションを出す
  （`remote-session-active-list.tsx`）。その下は従来のリポジトリ一覧
- 起動中の一覧は、実行状況と同じ`useDispatchState`の`remoteSessions`を使う。横断質問の入口
  （ヘッダーのボタン・スマホ右下のボタン・専用ダイアログ）は同じ#4991で廃止した
- **Issue詳細のコメント欄の「リモートセッションで聞く」**（#5047）: 廃止した「質問する」の代わり。
  `openRemoteSessions(<Issueのリポジトリ>)`がクエリ`rsrepo`（`REMOTE_SESSION_REPOSITORY_PARAM`）を付けて
  この画面を開き、そのリポジトリを選んだ状態にする（スマホは詳細シートまで開く）。**起動はしない**。
  新規作成ダイアログで内容が質問だと判定されたときの提案（#1890）も同じ経路で開く

## 流れ

```text
画面「セッションを起動」→ POST /api/remote-sessions
  └ RemoteSession（starting）＋ DispatchJob（REMOTE_SESSION・tmuxSessionName=<repo>-remote-<8文字>）
       poller（claim）→ run_remote_session_job
         └ scripts/start-remote-session.sh <owner> <repo> <セッション名>
              既定ブランチの最新から detached の worktree を作る（~/apps/<repo>-worktrees/remote-<8文字>）
              tmux で claude --remote-control <セッション名> --permission-mode <auto> を起こす
         └ ~/.claude/sessions/<pid>.json の bridgeSessionId からURLを組み立てる（最大90秒待つ）
       POST /api/dispatch/report（succeeded・remoteControlUrl）→ RemoteSession（running・URL）
画面 → GET /api/remote-sessions を3秒おきに読み、URLが届いたらそのURLへ移動する
```

- **URLが取れなくても起動は成功として返す。** URLは非公開仕様のファイルから取るbest-effortで、
  取れなかった巡はホスト申告（`POST /api/dispatch/hosts`の`remoteSessions`）が後から届ける。画面は
  150秒待って届かなければ自動移動をやめ、一覧の「開く」が押せるようになるのを待つ
- **終了**は`DELETE /api/remote-sessions?id=`が`REMOTE_SESSION_KILL`を積み、pollerが
  `start-remote-session.sh --kill`でtmuxを畳んでworktreeを片付ける
- tmuxを直接閉じた・Claude Codeが終了した・ホストを再起動したものは、ホスト申告に出てこなくなって
  3分で`ended`になる。worktreeはpollerの巡回（`--sweep`）が片付ける
- **無操作の自動終了**（#4871）: 最後の会話（転記ファイルの更新。無ければtmuxの起動時刻）から
  `ISSUE_DECK_REMOTE_SESSION_IDLE_MINUTES`（既定180分・0で無効）経ったセッションは、pollerの巡回が
  `start-remote-session.sh --kill-name`で畳む（worktreeは作業が残っていれば残す）。畳んだ名前は
  `~/.local/state/issue-deck/remote-session-idle-ended`に30分残し、ホスト申告の`remoteSessionsIdleEnded`で
  送る。issue-deckは猶予を待たずに`ended`にし、`failureMessage`へ「一定時間操作が無かったため、自動で
  終了しました。」を残す（画面の履歴に灰色で出る）。Claude Codeアプリで画面を開いているだけの状態は
  無操作とみなす

### 「終了中」のまま終わらなかった不具合（#4871）

「更新して再起動」（`SELF_UPDATE`）を実行したpollerは`exec`で新しいスクリプトへ入れ替わる。以前は
`run_self_update_job`の中で即座に`exec`していたため、**同じclaimで受け取った後ろのジョブ（終了・起動など）が
実行も報告もされないまま消えていた**（2026-10-19に4件取得→`SELF_UPDATE`だけ実行、2件取得→同じ、を
journalで確認）。消えたジョブは`CLAIMED`のまま10分残るので画面は「終了中」が続き、developへのマージが
続いて自動更新が頻繁に来ると、押し直しても同じ形で消える。入れ替えは保留フラグにし、claimした
ジョブを全部回した後（`exec_pending_self_update`）で行う。自動更新（`maybe_auto_self_update`）は
もともと`run_once`の後でしか入れ替えないので対象外

### 終了したセッションの再開（#4874）

終了（手動・無操作の自動終了・ホスト再起動）したセッションは、画面の「終了したセッション」の
「再開」から**会話の続きとして**起動し直せる。

```text
画面「再開」→ POST /api/remote-sessions { resumeId }
  └ enqueueRemoteSessionResume: 同じ RemoteSession の行を starting へ戻し、launchJobId を新しい
    REMOTE_SESSION ジョブへ差し替える（tmux名はそのまま。URL・理由・endedAt は消す）
       poller → start-remote-session.sh <owner> <repo> <同じセッション名>
         └ 同じ worktree パス（remote-<8文字>）。片付け済みなら既定ブランチの最新で作り直す
         └ そのパスの転記（~/.claude/projects/<パスの英数字以外を-にした名前>/*.jsonl）があれば
           claude --continue --remote-control <名前> で起こす
```

- **行は使い回す**（新しい行を作らない）。tmux名＝worktreeのパス＝転記の置き場で、同じ名前で起こし
  直すことが再開そのものだから。`tmuxSessionName`の一意制約もそのまま守れる。`launchJobId`は再開の
  たびに新しいジョブへ差し替える（古いジョブの報告は`launchJobId`で照合されるので混ざらない）
- **`--continue`が別の会話を拾わない理由**: パスはセッションごとにランダムな8文字で分かれるため、
  そのパスの転記はそのセッションの会話だけ。何度再開しても「そのパスの最新の会話」＝前回の続きになる
- **再開できるのは一度でも動いた（`lastSeenAt`がある）`ended`・`failed`**（`isRemoteSessionResumable`）。
  `failed`を含めるのは、再開の起動に失敗した行をもう一度押せるようにするため
- **一覧に残す期間**は、再開できるものだけ終了後7日（それ以外は従来どおり30分）。画面の「終了したセッション」は
  最後に動いていた順に5件まで出す。転記はClaude Codeの既定で30日残るので、7日なら転記切れで失敗しない
- **起動先はそのセッションが動いていたホストに固定**する（転記とworktreeはそのホストにしか無い）。
  同時実行の上限・オンライン判定は新規起動と同じ
- **pollerの版数41以上**（`REMOTE_SESSION_RESUME_MIN_AGENT_VERSION`）にだけ配る。古いランチャーは
  `--continue`を付けないため、同じ名前で新しい会話を始めてしまう。画面は「更新して再起動」を案内する
- **無操作の自動終了の記録**（`remote-session-idle-ended`。30分残る）に同じ名前が残っていると、申告の
  `remoteSessionsIdleEnded`で再開したセッションまで`ended`へ戻される。pollerは起動前に記録からその
  名前を外し、issue-deckも`starting`の行には自動終了の記録を当てない
- worktreeを片付けたあとに再開すると、作業ツリーは**既定ブランチの最新**から作り直される（会話は戻るが、
  前回切ったブランチのチェックアウトまでは戻らない。pushしていない作業がある場合はworktreeが残っているので、
  そのまま戻る）

## 実装セッションと混ぜない

| 項目 | リモートセッション | Issueの実装セッション |
|---|---|---|
| tmux名 | `<repo>-remote-<8文字>` | `<repo>-issue-<番号>` |
| 状態の持ち場所 | `RemoteSession` | `DispatchSession` |
| 生存の報告 | ホスト申告の`remoteSessions` | `POST /api/dispatch/sessions` |
| フック（session-notify） | 渡さない | `--settings`で渡す |
| 引き上げ・停滞検知・自動再開・回収 | 対象外 | 対象 |
| 同時実行数 | ホストごとに既定3本（`REMOTE_SESSION_MAX`・`REMOTE_SESSION_MAX_PER_HOST`） | `DISPATCH_MAX_SESSIONS` |

`DispatchSession`へ`issueNumber=0`で載せる案は採らなかった。Issue向けの一覧・引き上げ・回収の処理が
`-issue-`の規約と`issueNumber`で動いており、Issueに紐づかない行が紛れ込むと誤判定するため。
ジョブ（`REMOTE_SESSION`・`REMOTE_SESSION_KILL`）は枠外ジョブ（`OUT_OF_BAND_JOB_KINDS`）として配り、
実行状況のジョブの一覧には出さない（状態はこの画面が持つ）。

### 実行状況のホストカードには表示だけする（#4836）

ジョブの一覧とは別に、実行状況（PCの実行キュー・スマホの実行状況シート）のホストカードの最下段へ、
そのホストで動いているリモートセッションを「リモートセッション n/3」の小見出しで並べる。
サブPCで何が動いているかを1か所で見られるようにするためで、スマホのホームの縮めたカードには
「リモート n」の本数だけを出す。

- **データは`GET /api/dispatch`の`remoteSessions`に載せる**（取得口を増やさない）。ポーリング
  （5〜20秒）から呼ばれるため、`listRemoteSessions`（`starting`の畳み込み＝書き込みを伴う）ではなく
  読み取りだけの`listActiveRemoteSessionViews`を使う。返すのは要求者自身の`starting`・`running`だけ
- **行の右端はClaude Codeアプリを開く出口と終了ボタン**（#4845）。終了ボタンは押すとその場（行の下）に
  確認を出し、「終了する」で画面と同じ`DELETE /api/remote-sessions?id=`を呼ぶ。会話中のセッションを
  押し間違えで落とさないための確認で、形はホストの「再起動」に揃えた。積んだ後は次のポーリングを待たずに
  「終了中」にしてボタンを押せなくする。起動と履歴（終了・失敗）はこの画面に任せ、小見出しの
  「画面を開く」をその導線にする
  - #4836の時点では表示だけにしていたが、実行状況を見ていて終了したいときに画面を移る必要があったため足した
- 見出しの「セッション n/m」（`liveSessions`/`maxSessions`）には数えない。上限が別枠のため

## 権限と作業場所

- **権限モード**は実装セッションと同じ`ISSUE_DECK_CLAUDE_PERMISSION_MODE`（既定`auto`）。人が
  Claude Codeアプリから対話する作業用セッションなので、書き込みツールは封じない
- **作業場所はそのセッション専用のworktree**。本体チェックアウトは使わない（pollerの自己更新・
  他セッションと作業ツリーを取り合うため）。detached HEADで始まるので、変更を残すならセッションの中で
  ブランチを切ってpushする
- **フォルダの信頼確認**は本体チェックアウトのパスで判定され、worktreeでは出ない
  （`scripts/lib/claude-trust.sh`）。本体が未信頼なら、起動前に`claude_trust_require`で止めて理由を返す
- **worktreeは作業が残っていないときだけ消す。** 未コミットの変更があるか、HEADがどのリモートブランチ
  からも辿れない（pushしていないコミットがある）ときは残し、パスを終了の結果に出す
- 開発サーバーは起動しない。依存のインストールもしない（要ればセッションの中で行う）

## 対応の申告

pollerの版数40から`remoteSession: true`を申告する（ランチャーと`claude`が揃っているとき）。申告していない
ホスト（古いpoller）には配らず、画面は「pollerが対応していません。更新して再起動してください」を出す。
`--remote-control`への対応はランチャーが起動時に`claude --help`で確かめ、未対応なら理由を付けて失敗で返す。

## 関連ファイル

- 判定と表示（DBに触らない）: `src/lib/dispatch/remote-session-rules.ts`
- 積む・反映・一覧: `src/lib/dispatch/remote-session.ts`
- 画面のAPI: `src/app/api/remote-sessions/route.ts`
- 画面: `src/components/dashboard/remote-session-view.tsx`・`src/hooks/use-remote-sessions.ts`
- サブPC: `scripts/start-remote-session.sh`・`scripts/subpc-dispatch-poller.sh`（`run_remote_session_job`・`remote_session_list_json`）
