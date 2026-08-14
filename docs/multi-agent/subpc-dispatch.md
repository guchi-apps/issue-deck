# サブPCへのディスパッチ（pull型ジョブキュー）

issue-deckの画面から、常時起動のサブPC（`subpc`）上でClaude Codeセッションを起動する仕組み（#1179）。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## なぜpull型なのか

issue-deck（VPS）からサブPCへジョブを届ける方式として、SSHでキックするpush型は**成立しない**（#1176）。

- サブPCはOSのsshdを無効化しTailscale SSHへ一本化している。**Tailscale SSHにforced commandの
  仕組みは無い**（認証がtailnetのACLで行われ`authorized_keys`を経由しない）
- **VPSはtailnetに参加していない。** push型を採るならVPSをtailnetに入れる工程が前段に丸ごと増える

そこでサブPC側がissue-deckをポーリングしてジョブを取りに行くpull型を採る。サブPCが落ちていても
ジョブがキューに残るだけで、issue-deck側は何も知らなくてよい。

```text
issue-deckの画面「サブPCで開始」
  ↓ POST /api/dispatch          ジョブをキューに積む
（キュー: DispatchJob テーブル）
  ↑ POST /api/dispatch/claim    一定間隔のポーリング（共有シークレット認証）
scripts/subpc-dispatch-poller.sh（systemd service・常駐）
  ↓
scripts/start-local-session.sh <owner> <repo> <番号>
  ↓
<対象リポジトリ>/scripts/start-issue.sh <番号>       ← 契約適合のリポジトリ（issue-deck自身）
  または scripts/generic-start-issue.sh              ← それ以外（汎用ランチャー・#1224）
  ↓
tmuxセッションが立つ → 以降の進捗は POST /api/progress（Project Status）が持つ
```

画面側の起動先選択は#1180（後述の[画面から起動先を選ぶ](#画面から起動先を選ぶ1180)）。

## ジョブのライフサイクル

```text
queued ──claim──> claimed ──起動開始──> running ──> succeeded
   │                  │                    │
   └──cancel──> canceled                   └──> failed
                      └─ claim後に進まない ──> timeout
                                          heartbeat途絶 ──> timeout
```

**`succeeded`が意味するのは「tmuxセッションが立ち上がった」までで、実装の完了ではない。**
実装の進捗はProject Statusが唯一の正として持つ（[progress-status-architecture.md](../progress-status-architecture.md)）。
ここで実装完了まで追うと、セッションの終了検知という別の仕組みが要るうえ、Project Statusと
情報が二重になる。ジョブキューの責務は「起動を届けること」に閉じている。

### 立ち上がった後のセッションは別のモデルで見る（#1217）

ジョブの寿命が起動までで終わるということは、**立った後のセッションを見ている口が無い**ということでもある。
そこは`DispatchSession`が担当し、pollerが1巡ごとに`POST /api/dispatch/sessions`で
「そのホストで今見えている、Issueに紐づくtmuxセッションの全て」を報告する。ジョブへ相乗りさせないのは
寿命が違うためで、同じ行に混ぜると`activeKey`（未完了ジョブを1件に制限するunique制約）の意味が壊れる。

見るのは**`pane_dead`と`#{pane_dead_status}`（終了コード）だけ**で、画面（`capture-pane`）の内容は
読まない。入力待ち・完了・停滞はClaude Codeのフックが担当し（#1219）、こちらはフックが飛ばない
「プロセスの死・消失」に絞る。切り分けの根拠は[gates.md](gates.md)。

#### 終了だけはセッション自身が即時に報告する（#1321）

pollerの巡回は**実測で最大75秒遅れる**（`sleep`の60秒＋1巡の実処理の約14秒）。#1311で生きている
セッションのあるIssueは起動を押せなくしたため、その遅れがそのまま「畳んだのにまだ押せない」時間に
なっていた。そこで`scripts/run-issue-session.sh`の`cleanup`（`trap ... EXIT HUP TERM`）から、
`POST /api/dispatch/sessions/ended`へ1件だけ送って`ALIVE`を降ろす。

**送るのは「このセッションは終わった」だけで、終了コードは送らない。** `tmux kill-session`ではHUPで
trapに入るため、そこで拾える終了コードは異常終了かどうかを表さない。ここから`FAILED`を書けるように
すると、畳んだだけのセッションでIssueコメント＋`00.check-user`の引き上げが起きる。異常終了の判定は
pollerの担当のまま（`remain-on-exit`で死んだペインが残っていれば、次の巡回で`EXITED`/`FAILED`へ
上書きされる。引き上げの記録をこの報告で落としているため、引き上げも従来どおり働く）。

**pollerの報告を置き換えるものではない。** SIGKILL・ホストの再起動ではtrapを通らないため、
「報告に含まれない＝消えた」で拾う層は引き続き要る（実地でも、`tmux kill-session`では即時報告が届き、
`kill -9`では届かずpollerの巡回に落ちることを確認している）。

**版数がずれても壊れない。** ランチャー（サブPCの作業ツリー＝develop）と受け口（本番＝main）は
別々に更新される。受け口がまだ無い期間は404で、`curl`が失敗しても何も出力せずに次へ進むため、
巡回による従来の反映に戻るだけ（`skipped`のように報告し直す必要は無い。ここは状態の上書きが
1巡遅れるだけで、ジョブが宙に浮くことが無い）。

### 走っているセッションを画面から止める（#1332）

起動はできるのに止められない状態だった。`POST /api/dispatch/<id>/cancel`で取り下げられるのは
`queued`・`claimed`までで、tmuxセッションが立ったあとはSSHして`tmux`を叩くしかなく、
外出先のスマホからの運用（#1180）では手が届かない。

**同じジョブキューに種別（`kind`）を足して載せている。** 別モデルにすると、claim・状態報告・
タイムアウト・画面表示の一式をもう1セット持つことになる（寿命が短いだけで、経路も認証も同じ）。

| `kind` | pollerが実行するもの | 用途 |
|---|---|---|
| `LAUNCH`（既定） | 従来のランチャー起動 | セッションを立てる |
| `INTERRUPT` | `tmux send-keys -t "=<名前>:" C-c` | 走っている処理を止める。セッションは残る |
| `KILL` | `tmux kill-session -t "=<名前>"` | セッションごと畳む |
| `QUESTION`（#1294） | （未実装） | 読み取り専用の質問応答を1回走らせ、回答コメントを投稿する |

安全側に倒している点が5つある。

1. **pollerがセッション名を組み立て直す。** 受け取った`tmuxSessionName`をtmuxへ渡さず、
   ジョブの`repositoryFullName`/`issueNumber`から`<リポジトリ名>-issue-<番号>`を導出し
   （重複起動ガードと同じ式）、**一致しなければ実行せず`failed`で返す**。書式の検証と
   `has-session -t "=名前"`（`=`で完全一致）も掛ける。任意コマンド実行の経路にしない
   （`send-keys`の`-t`はペインを指すため、末尾に`:`が要る。付けないと`can't find pane`で失敗する）
2. **送るキーは固定の`C-c`だけで、文字列は送らない。** `send-keys`の禁止の範囲については
   [gates.md](gates.md)「やらせないこと」を参照
3. **対応を申告したpollerにしか配らない。** pollerは`POST /api/dispatch/hosts`で
   `sessionControl: true`を申告し、`claim`はそれが真のホストにだけ制御ジョブを払い出す。
   古いpollerは`kind`を読まないため、渡すと**起動ジョブとして解釈してセッションを立てる**
   （「閉じる」を押して起動する）。画面側も、申告していないホストではボタンを押させず理由を出す
4. **`QUEUED`のまま5分を過ぎた制御ジョブは`TIMEOUT`にする。** 起動ジョブと違い、**待たせるほど
   危険になる**（何時間も後に届いた`C-c`は、そのとき走っている別の作業を止める）
5. **`activeKey`は種別で名前空間を分ける**（`interrupt:owner/repo#番号`）。制御ジョブで`null`に
   すると起動ジョブとは衝突しない代わりに、スマホでの連打ぶんだけ`C-c`が積まれる

払い出しでは、制御ジョブを**起動ジョブより先に・同時実行数の枠外で**渡す。tmuxを1回叩くだけで
重くないうえ、起動待ちの後ろに並ばせると**止めたいときほど待たされる**（1巡で取るのは既定1本）。
実行キューの表示（#1266）が数えるのは起動ジョブだけで、制御ジョブの状態はIssueのセッション表示に出る。

**セッション本数の上限（#1361）に達していても、制御ジョブだけは取りに行く。** pollerは
`maxJobs: 0`で「起動ジョブは要らない」と伝えてclaimする。上限に達している状態は**セッションを
畳みたいときそのもの**で、ここで claim ごと止めると、押した停止が届かないまま5分で失効する。

押してから届くまでは**pull型ぶん（既定60秒）遅れる**ため、押した直後は「送信しました」を出す
（#1180と同じ）。**畳んだ結果が画面へ返るのは即時**で、`kill-session`でも
`run-issue-session.sh`のtrapが通り、上の#1321の即時報告が`ALIVE`を降ろす。
**VPS上のtmuxセッションは対象外**（pollerはサブPCにしか居ない）。

### 質問をサブPCで実行するための土台（#1294）

「リポジトリに質問する」（`mode=ask`）をサブPCでも実行できるようにするための**器だけ**が入っている。
実行（pollerでの`claude -p`と`gh issue comment`）・フォールバック・実行先の選択はStep 3以降で、
**この時点では質問ジョブを積む経路も払い出し口も無い**。方針の全文は #1290 のコメントを参照
（Actionsを廃さず、サブPCを既定にしてActionsをフォールバックとして残す）。

**1. 質問コメントの識別を、Actionsの起動トリガーから切り離した。**
`@claude 質問: `プレフィックスは`claude-issue-dispatch.yml`の起動トリガーそのもので、
このままでは同じコメントをサブPC側でも処理させた時点で**必ず二重に回答する**。
「Issueに残す質問コメント」と「Actionsを起こすトリガー」を別の軸にした。

| 軸 | 何で決まるか |
|---|---|
| 質問コメントかどうか | `<!-- issue-deck-question -->`マーカー（`QUESTION_COMMENT_MARKER`）。**旧形式（`@claude 質問: `で始まる）も引き続き質問として扱う**（既存Issueに積まれたコメントは移行できないため） |
| Actionsが起動するか | 本文の先頭が`@claude`であること（`triage`ジョブの`if`）。サブPCで答えさせる場合は`@claude`を含めない本文（`askClaudeCommentBody(question, { trigger: "none" })`）を投稿する |

**Actionsに答えさせる形の本文は従来のまま**（`@claude 質問: <本文>`で始まる）。他リポジトリは
`reusable-issue-dispatch.yml`をタグ固定（`@workflows/vX`）で参照しており、**古いタグの`IS_ASK`は
プレフィックスしか見ない**。ここで本文の形を変えると、古いタグのリポジトリでは質問が`mode=ask`に
落ちず実装モードとして走る。

**2. `DispatchJobKind`に`QUESTION`を足し、質問ジョブは`activeKey`を取らない（NULLのまま）。**
`activeKey`のunique制約は「同じIssueの未完了ジョブは1件まで」＝実装ジョブの二重起動を防ぐための
ものであって、質問には当てはまらない。ここで枠を取ると**実装ジョブが走っているIssueに質問を
積めなくなる**が、質問はまさに実装中に割り込んで聞くための導線（`00.check-user`も`11.local`も
貫通する唯一のモード）なので、それでは意味が無い。同じIssueに質問が並ぶこと自体は害にならない。

**質問ジョブは誰にも払い出さない。** 現行のpollerは未知の種別を「未知のジョブ種別です」として
`failed`で返すため、実行側が来ていない段階で配ると質問が必ず失敗として残る。開けるのはStep 3で、
`sessionControlCapable`と同じ形のpoller側の申告とセットにする。

**ジョブの寿命の意味が種別で変わる。** 起動ジョブの`succeeded`は「tmuxセッションが立った」までで、
その先はProject Statusが持つ。質問ジョブにはその続きが無く、`succeeded`は「回答コメントが投稿された」
まで。画面の文言も種別で分けている（「起動しました」／「回答しました」）。

### 開発サーバーの回収も1巡に相乗りさせる（#1223）

pollerは1巡ごとに`scripts/reap-dev-servers.sh`を呼び、**セッションが畳まれても残った開発サーバー
（孤児）と、作業が終わってアイドルな開発サーバー**を止める。claimより先に行うのは、掴んだままの
開発サーバーがあると新しいジョブを取っても起こせないため（サブPCは並行3本が上限）。

**常駐プロセスを増やさないためにここへ乗せている。** 判定は回収スクリプト側が全て持ち、poller側は
呼ぶだけにする（判定を2か所に分けない）。閾値は`DEV_SERVER_IDLE_MINUTES`（既定60・0で無効）。
判定の中身と、そもそもなぜ孤児が生まれるのかは
[開発サーバーは終了時に止め、残った分は回収する](local-quick-start.md#開発サーバーは終了時に止め残った分は回収する)を参照。

**`pane_dead`だけで異常終了と判断しない。** `start-issue.sh`は`remain-on-exit failed`（tmux 3.2以降）を
試して失敗したら`on`へ落とすため、tmux 3.0aの環境では**正常終了でもペインが残る**。終了コードが非0の
ときだけ異常終了として扱い、Issueコメントと`00.check-user`で引き上げる。消失は人が畳んだ場合と
区別が付かないので引き上げない。

### 作業が終わったセッションの回収も1巡に相乗りさせる（#1256）

#1223 の第2段階。pollerは1巡ごとに`scripts/reap-sessions.sh`を呼び、**作業が終わった実装セッション
そのもの**（tmuxセッションと`claude`プロセス）を畳む。開発サーバーの回収の直後に呼ぶ。

**同時実行数の上限はセッションの本数には効かない。** `AppSetting.dispatchConcurrency`は
ジョブの払い出しにしか効かず、tmuxが立った時点でジョブは`succeeded`になる（前述の
「ジョブのライフサイクル」）。回収だけでは足りないため、本数そのものの上限を別に設けている
（後述「セッションの本数の上限」・#1361）。

判定材料は**フックが残した状態ファイル・tmuxのメタデータ・gitとGitHubの事実だけ**で、
`capture-pane`の内容は読まない。条件の一覧と、状態ファイルの置き場・書式は
[作業が終わったセッションは自動で畳む](local-quick-start.md#作業が終わったセッションは自動で畳む1256)を参照。
閾値は`SESSION_IDLE_MINUTES`（既定60・0で無効）。

**畳んでよいかを起動経路で切る。** 対象になるのはpollerが`run_job()`で起動したセッションだけで、
`ISSUE_DECK_SESSION_REAPABLE=1`をランチャー経由でtmuxの中まで渡し、`run-issue-session.sh`が
記述子へ書く。手元のターミナルから直接起動したセッションはissue-deck側にジョブとして残らず、
畳んでも画面から理由を辿れないため、この印が付かない＝対象外になる（重複起動の防止で
「手元起動はDBの制約では防げない」としているのと同じ層の話）。

**この回収だけは`gh`と`git`を使う。** 計器は`tmux`・`jq`・`curl`だけで足りるという整理だったが、
「作業が終わったか」はIssueのラベル・状態とPRのマージ、そしてworktreeのcleanさ・push済みかを
見ないと決められない。**判定できないときは必ず「畳まない」側へ倒す**という一点で受けており、
`gh`が無いホストでは回収そのものを行わず、ジョブの取得と開発サーバーの回収は続ける。

取り消せるのは`queued`と`claimed`まで。`running`はworktreeの作成や依存インストールの最中で、
途中で止めると中途半端なworktreeとブランチが残る（後始末は`scripts/cleanup-worktrees.sh`）。

### セッションの本数の上限（#1361）

回収は「判定できないときは畳まない」設計なので、IssueがOPENのセッションも人の入力待ちのセッションも
**正当に残り続ける**。入口を絞らない限り本数は単調に増え、いつかホストのメモリを使い切る。

2026-08-14にサブPCで34本まで積み上がり、メモリ枯渇でホストごと停止した。SSHもコンソールも
応答せず（sshdはバナーを返せず`Broken pipe [preauth]`、agettyはloginをforkできずプロンプトが
出なかった）、Magic SysRqでの再起動が要った。OOM killerは動いておらず、カーネルが
`Under memory pressure, flushing caches`を繰り返してuserspaceにCPUが回らない状態だった。

そこでpollerはclaimの前に生きているセッションを数え、`DISPATCH_MAX_SESSIONS`（既定12）に
達していればジョブを取りに行かない。数えるのは`<リポジトリ名>-issue-<番号>`に一致するもの
だけで、人が手で立てたセッションは巻き込まない。

**取りに行かなくてもジョブは消えない。** `expireStaleDispatchJobs()`が掃くのは`claimed`と
`running`だけで`queued`は対象外のため、回収で空きができた次の巡でそのまま起動する。

上限はホストの搭載メモリで決まる性質のものなので、アプリ設定ではなくホスト側の`dispatch.env`に
置いている。サブPC（13.9GB）では実測で1セッション約390MB、加えて開発サーバーが最大3本走る。

### タイムアウトに定期実行の仕組みを持たない

期限切れの判定は`expireStaleDispatchJobs()`（[src/lib/dispatch/jobs.ts](../../src/lib/dispatch/jobs.ts)）が
**enqueue・claim・一覧取得のたびに掃く遅延評価**にしている。VPS上にcronやワーカーを増やすと、
それ自体の死活監視が要るようになるため。60秒ごとにポーリングが来るぶん、掃く機会は十分にある。

タイムアウトしたジョブは`activeKey`が外れ、同じIssueに次のジョブを積めるようになる。
**Actionsへの自動フォールバックは行わない。** 自動で`@claude`コメントを投げると、サブPC側で
既にセッションが立っていた場合に二重実行になる。`timeout`・`failed`を理由付きで画面に出すまでが
このキューの責務で、Actionsへ回すかどうかは人が判断する。

## 重複起動の防止（4層）

| 層 | 仕組み | 何を防ぐか |
|---|---|---|
| DB | `DispatchJob.activeKey`（`owner/repo#番号`）に`@unique` | 画面からの二重クリック。MySQLはunique indexに複数のNULLを許すため、終了時にnullへ戻せば「未完了は1件まで」が成立する |
| セッション | `DispatchSession`に`ALIVE`の行があれば積ませない（#1311） | **起動が終わった後の再クリック。** `activeKey`はジョブの終了時に外れるため、`SUCCEEDED`になった時点でボタンは再び押せる状態に戻る |
| poller | 起動前に`<リポジトリ名>-issue-<番号>`のtmuxセッションがあるかを確認し、あれば`skipped`で報告する（#1229） | **手元のターミナルから直接起動した分。** そちらはissue-deckにジョブとして残らないため、DB側の制約では防げない |
| ラベル | 既存の`11.local` | 無人実行（`claude-issue-dispatch.yml`）との二重起動（#1097） |

セッションの層を足してもpollerの層は残す。**画面の判定はセッションの報告より先には動けない**ので、
最後に実物のtmuxを見る層が要る。畳んだ側は`cleanup`から即時に報告する（#1321）が、SIGKILL・
ホストの再起動ではその報告が飛ばず、次の巡回（実測で最大75秒）まで`ALIVE`のまま残る。

pollerの層が見送ったジョブは`SKIPPED`（画面では灰色の「起動済みのため見送り」）になる。**`FAILED`にしない**
（#1229）。正常に働いた安全機構を赤い「失敗」として見せると、ログと突き合わせるまで起動できなかったのか
どうか判断できない（#1224で実際に起きた）。対応表に無いリポジトリ・cloneが無いといった設定不備は、
利用者が直すべき異常なので従来どおり`FAILED`のまま。

**pollerとissue-deckは別々に更新される。** pollerは本体の作業ツリー（develop）を追い、issue-deckの画面は
mainから動くため、`skipped`を送るpollerが先に動き始める期間がある。受け口が400で弾いた場合はpoller側が
`failed`で報告し直す（`report_job`）。そのまま諦めると、見送ったジョブが`RUNNING`のまま残って10分後に
「応答なし」になる。

セッションの層の判定は3つ（`findBlockingSession`）。

- **`ALIVE`だけを見る。** `paneDead`のセッションは`EXITED`/`FAILED`になるが、そちらは前回の
  終了の痕跡で、`start-issue.sh`は畳んで作り直す。ここで止めると**二度と起動できなくなる**
- **所属ホストが応答している場合だけ止める。** pollerが落ちている間、行は`ALIVE`のまま古びる
  （`GONE`へ倒すのは「報告に含まれなかった」ときだけ）。判定材料が無いことと「動いている」ことは違う
- **ホストは問わない。** ホストAで動いているIssueをホストBへ積むのは、各pollerが自分のtmuxしか
  見ないため向こう側では防げない

pollerの確認は、**リポジトリ名まで含めて突き合わせる**（#1224）。Issue番号はリポジトリごとに
振られるため、番号だけ（`*-issue-<番号>`）で見ると、別リポジトリの同じ番号のセッションが動いて
いるだけで起動を断ってしまう。起動できるリポジトリが1つだった間は表に出なかったが、増やした
時点で番号の衝突はほぼ確実に起きる。

## 「実行できないリポジトリ」はディスパッチ前に弾く

サブPCに`git clone`されていないリポジトリのIssueを投げても起動しない。「投げたのに動かない」
状態を作らないため、**サブPCが「自分が実行できるリポジトリの一覧」を申告し、issue-deck側は
実行できないリポジトリの起動先としてサブPCを選べなくする**（#1179のコメントで決定）。

その場で`gh repo clone`して自動対応する案は採らない。冷えた状態からの依存インストールに時間が
かかるうえ、リポジトリによってはDBセットアップも要り、無人実行の前提として重すぎるため。

申告に載るのは、`scripts/start-local-session.sh`と**同じ検証**を通ったものだけ。

1. `~/.config/issue-deck/local-repos.conf`に記載がある
2. チェックアウト先のディレクトリが実在する
3. `scripts/start-issue.sh`がマーカー行を宣言している場合は、その版数が受け口の対応範囲に収まる（#1073）

**判定は[scripts/lib/local-repo-resolve.sh](../../scripts/lib/local-repo-resolve.sh)が持ち、
受け口とpollerが同じ関数を呼ぶ。** 判定を二重に持つと、申告と実際の起動可否が必ずずれる。

**マーカー行の宣言は必要条件ではない**（#1224）。宣言していないリポジトリはissue-deck側の汎用
ランチャー（`scripts/generic-start-issue.sh`）で起動する。以前は宣言を必須にしていたため、
cloneも対応表への記載も済んでいるdayspanが申告に載らず、**実際に起動できるリポジトリが
issue-deck 1つだけ**になっていた。詳細は[generic-launcher.md](generic-launcher.md)。

申告と実態がずれる可能性は残る（申告後にcloneを消した、`git pull`で版数が変わった等）。その場合は
**ディスパッチが失敗した理由をジョブの結果として画面へ返す**。ここを省くと、無人実行では何も
起きないまま終わる。

### ops-dashboard#34 との切り分け

「実行できるリポジトリの一覧」は**ジョブの割り当て可否を決める情報なのでissue-deck側**に持つ。
ホストの死活・CPU・メモリ・tmuxセッション一覧は[ops-dashboard#34](https://github.com/guchi-apps/ops-dashboard/issues/34)側で扱う。
サブPCはissue-deck専用機ではなく、他リポジトリの作業セッションも並ぶため。

**この切り分けは#1217のセッション報告でも守る。** 報告に載せるのは`<リポジトリ名>-issue-<番号>`に
一致し、かつ`local-repos.conf`から`owner/repo`を**一意に**解決できたセッションだけで、ホスト上の
無関係なtmuxセッションは送らない。セッション名にownerが含まれないため、別ownerに同名のリポジトリが
あるとどちらのIssueか決められない。**曖昧なときは送らない**（当てずっぽうに選ぶと、無関係なIssueへ
引き上げのコメントを投稿することになる）。

## スクリーンショットの可否も申告する（#1268）

`24.screenshot-required`は「PR作成前にスクリーンショットを撮って承認を得る」ラベルだが、
**Playwrightのブラウザ本体が入っていないホストでは実行できない。** 無人実行では依存の追加を
その場で確認する相手がいない（CLAUDE.md）ため、選ばせると必ず止まる。

そこでpollerが申告に`screenshotCapable`を載せ、**撮れないホストを選んでいるときはその
オプションを理由付きで無効化する**（`resolveScreenshotRejection`）。「実行できないリポジトリを
ディスパッチ前に弾く」のと同じ考え方で、押す前に理由を出す。

判定は`~/.cache/ms-playwright`（`PLAYWRIGHT_BROWSERS_PATH`があればそちら）にブラウザ本体が
あるかで見る。リポジトリごとの`node_modules`ではなくここを見るのは、**ブラウザ本体の置き場が
共通で、どのリポジトリが入れたかに依存しない**ため。

**`null`（申告していない）と`false`（撮れない）は区別する。** 古いpollerが動いているホストでは
`null`になり、そのときは塞がない。判定材料が無いことを理由に選択肢を消すと、実際には撮れる
ホストで使えなくなる。

**既にラベルが付いているIssueでは、撮れないホストでもチェックを外せる**ようにしてある
（塞ぐのは新たに付ける操作だけ）。

## 同時実行数の上限

`AppSetting.dispatchConcurrency`（既定**2**）。**定数で埋め込まない**という決めごと（#1176）に
従い、アプリ設定ダイアログから変更できる。CPUの載せ替えで適正値が変わるため。

既定の2は#1177の実測にもとづく（Athlon 200GE 2C/4Tで並行3本が上限。`next build`単体で
4スレッド中2.6を使い切るため、実運用の快適さでは2本）。

ホスト側が`maxConcurrency`を申告している場合は**小さい方**を採る。

## ポーリング間隔も設定値にする

`~/.config/issue-deck/dispatch.env`の`DISPATCH_POLL_INTERVAL_SECONDS`（既定60秒）。
**コードにもsystemdのunitにも埋め込まない**（#1179のコメント）。

ここが「画面のボタンを押してから起動が始まるまでの待ち時間」を決める。pull型を採った以上この
遅延は避けられず、**実運用で許容できるかは動かしてみないと分からない**。許容できないと分かった
場合はpush型やハイブリッド（普段はpull、起動時だけVPSから軽い通知）を検討することになるため、
まず当たりを付ける実験ができる形にしておく。

pollerをsystemd timerではなく**常駐サービス**にしているのはこのため。timerに間隔を持たせると、
変更のたびにunitの編集と`daemon-reload`が要り、pollerの他の設定と置き場所も分かれる。
落ちたときの復帰は`Restart=always`が持ち、1巡が固まってポーリングごと止まらないよう起動処理には
`timeout`（`DISPATCH_LAUNCH_TIMEOUT_SECONDS`・既定15分）を掛けている。

60秒間隔でissue-deck側にかかる負荷は1分あたりHTTP 2回・DBクエリ数件で、無視できる。

## 画面から起動先を選ぶ（#1180）

Issue詳細の「ローカルで開始」を、**起動先の選択**に変えている
（[src/components/dashboard/start-local-session-button.tsx](../../src/components/dashboard/start-local-session-button.tsx)）。

> **「このPC」（`issuedeck://`）は#1263で廃止した。** ここに書いてあった「起動先を選ぶ」は、
> 現在はサブPCの選択と、手元へ貼るためのコピー（実装プロンプト／起動コマンド）になっている。
> 経緯は[local-quick-start.md](local-quick-start.md)「「このPC」を廃止した経緯」を参照。

| 起動先 | 経路 | 使える場面 |
|---|---|---|
| サブPC（申告のあったホスト） | ジョブをキューに積む | **スマホからでも押せる。メインPCが起動していなくてよい** |
| GitHub Actions | `@claude`の定型コメント | サブPCが使えないときのフォールバック |
| 実装プロンプトをコピー | クリップボード | 手元でVS Codeを既に開いているとき |

**申告しているホストが1台だけなら、メニューにせず単独のボタンにする。** 選択肢が1つのメニューを
開かせる意味が無いため。申告が1台も無ければ、このボタンの導線ごと出ない。

### スマホの「実装を開始」からも起動先を選べる（#1248）

スマホのIssue詳細ヘッダーに置けるのは「実装を開始」（▶）だけで、**サブPCで起動したい場合は
本文の奥までスクロールして別のボタンを探すことになっていた**。そのため
[`start-implementation-dialog.tsx`](../../src/components/dashboard/start-implementation-dialog.tsx)に
`includeDispatchTargets`を追加し、このダイアログでもオプション（`21.plan-required`等）と一緒に
**実行先（GitHub Actions／申告のあるホスト）を選べる**ようにしている。PCでは
ツールバーに「実装を開始」と「サブPCで開始」が並ぶ。**#1262でPCのツールバーでも実行先を選べる
ようにし、既定はサブPCへ寄せた。**

起動のさせ方は実行先で違う。

| 実行先 | 起動のさせ方 | 進捗（Project Status） |
|---|---|---|
| GitHub Actions | `@claude`の定型コメントを投稿する | ダイアログが報告する |
| サブPC | ジョブを積み、成功したら`11.local`を付ける | 起動したランチャーが報告する（#1236） |

- **サブPCを選んだときは`@claude`コメントを投稿しない。** 無人実行と同じ入口を踏ませると、
  `11.local`が付くまでの隙間で二重起動になりうるうえ、Issueには「実装を開始してください」と
  残るのに動くのはサブPC、という食い違いが生まれる。
- **オプションのラベルは実行先によらず起動前に付ける。** `21.plan-required`・
  `24.screenshot-required`はサブPC側のランチャーが読むため、積んだ後では間に合わない
  （ジョブは最大ポーリング間隔ぶん後に取られる）。
- 積んだ後の状態（順番待ち・起動中・失敗）は従来どおり本文の`StartLocalSessionButton`が出す。
  ダイアログは閉じてしまうため、そちらを消すと押した結果を見る場所が無くなる。

### 「作成+実装開始」も実行先を選んでから起動する（#1323）

Issue作成画面の「作成+実装開始」は、**作成後にその場で`@claude`コメントを投稿していた**ため、
起動先が常にGitHub Actionsに固定されていた（#774）。サブPCで始めたい場合は、いったん作成して
Issue詳細を開き直し、そちらの導線から起動し直すしかなかった。

現在は、Issueを作成したあとに同じ`StartImplementationDialog`を`showOptions={false}`で開き、
**実行先だけを選ばせる**（既定はサブPC）。起動そのもの（`@claude`コメント・ジョブの積み込み・
`11.local`・進捗の報告）はすべてダイアログ側が行い、作成画面は起動処理を持たない。

- **オプション（`21.plan-required`等）のチェックボックスは出さない。** 作成フォームで同じものを
  選ばせており、作成時にラベルとして付いた状態でダイアログへ渡る。同じ選択を2画面続けて出すと、
  どちらが効くのか分からなくなる。選択状態はIssueのラベルから同期されるため、
  `Planning`と`Implementation`の出し分けはそのまま働く。
- **`claude-issue-dispatch.yml`が無いリポジトリでも「作成+実装開始」を無効化しない**（#1262と
  同じ判断）。実行先の選択がこの先のダイアログにある以上、ボタンごと塞ぐとサブPCでの起動まで
  塞がる。理由はダイアログのGitHub Actionsの選択肢の説明として出す。

### 選べない理由は押す前に出す

判定は`resolveDispatchTargetRejection`（[src/lib/dispatch/dispatch-job.ts](../../src/lib/dispatch/dispatch-job.ts)）が持ち、
**理由の並びも文言も`enqueueDispatchJob`と同じものを使う**。画面とAPIで判定が分かれると、
「画面では押せるのにAPIが断る」状態が生まれる。押せない理由は5つ（申告が無い・応答していない・
そのリポジトリを実行できない・未完了ジョブが既にある・既にセッションが動いている）。

**API側（`enqueueDispatchJob`）の判定を省かない。** 一括投入（`bulk-dispatch-bar.tsx`）は
個々のIssueの判定をAPI側へ委ねているため、画面だけに置くとそちらが素通りする。

**先出しであって、最終的な拒否はAPI側が行う。** 申告は最大5分古く（`DISPATCH_HOST_ONLINE_WINDOW_MS`）、
押した瞬間にホストが落ちることもある。画面側の判定は「押せてしまわないようにする」ためのもの。

### 積んだ後の状態を出す

pull型を採った以上、押してから起動が始まるまでポーリング間隔（既定60秒）かかる。**その間に
画面が何も変わらないと、押しても何も起きていないようにしか見えない。** そのため
`GET /api/dispatch`を未完了ジョブがある間だけ5秒間隔で取り直し（無ければ60秒）、
順番待ち・起動中・失敗・応答なしをボタンの下に出す（`dispatch-job-status.tsx`）。

- **`succeeded`は「起動しました」と書く。** 「完了」ではない（実装の進捗はProject Statusが唯一の正）
- 失敗理由（ジョブの`message`）は**ホバーではなく本文として出す**。主な用途が外出先のスマホで、
  ホバーが無い
- 終わったジョブも消さずに出す（APIが返す直近24時間ぶん）。押した結果が消えると、
  「押しても何も起きなかった」と区別が付かない
- メニューには`実行中 n/上限・待機 m`を出す。上限に達していれば、押しても順番待ちになると分かる

## 実行キューとして見せる（#1266）

GitHub Actionsで並列に一括で流す使い方をやめ、**サブPCで順に流す**形にした（#1261）。
仕組み自体は#1179の時点で揃っている（上限を超えたジョブは`QUEUED`で待つ）ので、足したのは
画面だけ。

| 足したもの | 場所 |
|---|---|
| キュー全体の一覧 | ヘッダーの「実行キュー」（`dispatch-queue-button.tsx`）。実行中・順番待ち・直近の失敗 |
| まとめて積む | Issue一覧の選択モード（`bulk-dispatch-bar.tsx`） |
| まとめて取り消す | キューのポップオーバー |

**並びは`createdAt`の昇順で、払い出し（`claimDispatchJob`の`orderBy`）と同じ。** 画面に見えて
いる順番と実際に走る順番が一致する。

### まとめて積むときはオプションを選ばせない

`21.plan-required`等は**Issueごとに要否が違う**ので、一括で決める方が事故になる。必要なIssueは
個別に「実装を開始」から積む。既に付いているラベルはそのまま効く（ランチャーが読む）。

### 1件ずつ順に投げる

まとめて投げると、**拒否された理由がどのIssueのものか分からなくなる**。積めなかったぶんは
選択モードを維持したまま理由付きで残し、黙って消さない。`11.local`は**積めたIssueにだけ**付ける
（積めていないのに付けると、無人実行までそのIssueに触れなくなる）。

### 並べ替えは持たない

キューは`createdAt`の昇順で流れる＝**積んだ順**で、これは「順に実行してほしい」という要求
そのものを満たしている。任意の並べ替えを入れるには`DispatchJob`に順序の列が要り、
払い出し側の`orderBy`も変わる。**実際に積んで運用してから、必要性が見えた時点で判断する。**

## API

| ルート | 認証 | 用途 |
|---|---|---|
| `POST /api/dispatch` | ログインセッション | ジョブを積む。実行できない組み合わせは理由付きで拒否。`kind`（省略時は起動／`interrupt`／`kill`）で種別を指定する（#1332）。`question`は**まだ受け付けない**（400。#1294） |
| `GET /api/dispatch` | ログインセッション | ホストの申告・未完了ジョブ・直近24時間の終了ジョブ・セッションの状態・同時実行数 |
| `POST /api/dispatch/<id>/cancel` | ログインセッション | 取り消し（`queued`・`claimed`のみ） |
| `POST /api/dispatch/claim` | `DISPATCH_SECRET` | ジョブの払い出し |
| `POST /api/dispatch/report` | `DISPATCH_SECRET` | `running` / `succeeded` / `failed` / `skipped` の報告 |
| `POST /api/dispatch/hosts` | `DISPATCH_SECRET` | 実行可能リポジトリの申告＋生存報告（スクリーンショットの可否・セッション操作の可否も申告する） |
| `POST /api/dispatch/sessions` | `DISPATCH_SECRET` | 起動後のtmuxセッションの状態報告（#1217） |
| `POST /api/dispatch/sessions/ended` | `DISPATCH_SECRET` | セッションが畳まれた瞬間の報告。1件だけ`ALIVE`を降ろす（#1321） |

### シークレットは`PROGRESS_REPORT_SECRET`と分ける

**専用の`DISPATCH_SECRET`を持つ。** 進捗報告のシークレットはorganization secretとして全リポジトリの
ワークフローから参照できる値で、そこに「キューからジョブを取り出せる」権限まで載せると、
どこか1つのリポジトリのワークフローが漏らしただけでジョブの横取りが成立してしまう。値を分ければ、
漏洩時に停止・再発行する範囲もそれぞれに閉じられる。

Bearer検証の実装自体は[src/lib/shared-secret-auth.ts](../../src/lib/shared-secret-auth.ts)で共有している。
未設定は`unauthorized`（401）ではなく`not_configured`（503）で返し、poller側が「設定漏れ」と
「値の不一致」を切り分けられるようにしている。

**ただし`dispatch.env`には`PROGRESS_REPORT_SECRET`も置く**（#1236）。分けるのは*値*であって
*置き場*ではない。ジョブを取るのがpollerなら、進捗（Project Status）を報告するのは起動した
ランチャーで、サブPCのissue-deckチェックアウトは**アプリを動かすためのものではないため
`.env.local`のキーが空**（`.env.local.example`を写しただけの状態）。ここに無いと、
**セッションは立つのに進捗が`Ready`のまま動かない**という、いちばん気づきにくい壊れ方をする。
ランチャーの探索順は 環境変数 → 本体の`.env.local` → このファイル
（[scripts/lib/progress-report.sh](../../scripts/lib/progress-report.sh)）。

## サブPC側のセットアップ

```bash
# 1. 設定ファイル（chmod 600。実値はコミットしない）
install -D -m 600 ~/apps/issue-deck/deploy/subpc/dispatch.env.example \
  ~/.config/issue-deck/dispatch.env
# APP_BASE_URL・DISPATCH_SECRET・PROGRESS_REPORT_SECRET を埋める。
# PROGRESS_REPORT_SECRET が空だと、セッションは立つのに進捗が動かない（#1236）。
$EDITOR ~/.config/issue-deck/dispatch.env

# 2. 申告だけ試す（ジョブは取らない）
~/apps/issue-deck/scripts/subpc-dispatch-poller.sh --announce-only

# 3. systemdへ登録（ユーザー単位。sudo不要）
mkdir -p ~/.config/systemd/user
cp ~/apps/issue-deck/deploy/subpc/issue-deck-dispatch-poller.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now issue-deck-dispatch-poller.service

# 4. ログアウトしても動き続けるようにする（ユーザー単位のserviceはログインセッションに紐づくため）
sudo loginctl enable-linger "$USER"
```

**`dispatch.env`を変更したら`systemctl --user restart issue-deck-dispatch-poller.service`**。
常駐プロセスが起動時に読むため、書き換えただけでは反映されない。

`DISPATCH_SECRET`は1Password（`apps/issue-deck`）から書き出す。**毎分`op run`は挟まない**
（1Password CLIの起動コストがポーリング間隔に対して重すぎる）。手順は`dispatch.env.example`の
コメントを参照。サブPCはGUIが無いためサービスアカウント方式（#1177）。

## ログをどこで見るか

Actions UIに相当するものが無いため、次の3つで追う。

| 見たいもの | 見る場所 |
|---|---|
| pollerが何をしたか | `journalctl --user -u issue-deck-dispatch-poller -n 50` |
| ジョブが失敗した理由 | issue-deckの画面（ジョブの`message`にそのまま出る） |
| 起動したセッションの中身 | `tmux attach -t <セッション名>`（セッション名もジョブに記録される） |
| 進捗（Project Status）が動かない理由 | 同じjournal。pollerは起動時に鍵の有無を1度だけ確かめ、無ければ警告を出す（#1236）。個々の起動でスキップした場合はランチャーの出力に理由が出る |

`systemctl --user status issue-deck-dispatch-poller.service` で常駐しているかを確認できる。

**API呼び出しが失敗したときのレスポンスボディは、1行に潰したうえで先頭200文字までしか出ない**
（末尾の`…`が切り詰めた印・#1210）。本番が404や502を返すとNext.jsのエラーページのHTML（約10KB）が
そのまま返り、pollerは毎分動くためjournaldがHTMLで埋まって本来見たい失敗理由が読めなくなるため。
URLとステータスコードは切り詰めずに残るので、どの経路が何で落ちたかは判断できる。全文が要る場合は
同じURLを`curl`で直接叩く。

## 受け口の複製は無くなった（#1263）

かつてメインPC（WSL）のワンクリック起動は、`register-issuedeck-protocol.ps1`が
`~/.local/share/issue-deck/`へ複製した受け口を使っていた（#1076）。受け口の中身が変わるたびに
登録スクリプトの再実行が必要で、忘れると陳腐化する問題があった（#1085・#1089）。

**「このPC」の廃止（#1263）で複製する主体がいなくなり、この問題ごと消えている。** 現在
`scripts/start-local-session.sh`を呼ぶのは、サブPCのpollerと「起動コマンドをコピー」で貼られた
1行だけで、どちらもチェックアウトを直接指す。

## 関連

- [#1176](https://github.com/guchi-apps/issue-deck/issues/1176) 実装実行基盤をサブPCへ移行する（親）
- [#1180](https://github.com/guchi-apps/issue-deck/issues/1180) 起動先（このPC / subpc）を選べるようにする
- [local-quick-start.md](local-quick-start.md) ローカルセッションの起動とローカル起動プロトコル
- [generic-launcher.md](generic-launcher.md) 対象リポジトリに何も置かずに起動する汎用ランチャー（#1224）
- [progress-status-architecture.md](../progress-status-architecture.md) 進捗の唯一の正はProject Status
