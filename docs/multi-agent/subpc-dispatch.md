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

取り消せるのは`queued`と`claimed`まで。`running`はworktreeの作成や依存インストールの最中で、
途中で止めると中途半端なworktreeとブランチが残る（後始末は`scripts/cleanup-worktrees.sh`）。

### タイムアウトに定期実行の仕組みを持たない

期限切れの判定は`expireStaleDispatchJobs()`（[src/lib/dispatch/jobs.ts](../../src/lib/dispatch/jobs.ts)）が
**enqueue・claim・一覧取得のたびに掃く遅延評価**にしている。VPS上にcronやワーカーを増やすと、
それ自体の死活監視が要るようになるため。60秒ごとにポーリングが来るぶん、掃く機会は十分にある。

タイムアウトしたジョブは`activeKey`が外れ、同じIssueに次のジョブを積めるようになる。
**Actionsへの自動フォールバックは行わない。** 自動で`@claude`コメントを投げると、サブPC側で
既にセッションが立っていた場合に二重実行になる。`timeout`・`failed`を理由付きで画面に出すまでが
このキューの責務で、Actionsへ回すかどうかは人が判断する。

## 重複起動の防止（3層）

| 層 | 仕組み | 何を防ぐか |
|---|---|---|
| DB | `DispatchJob.activeKey`（`owner/repo#番号`）に`@unique` | 画面からの二重クリック。MySQLはunique indexに複数のNULLを許すため、終了時にnullへ戻せば「未完了は1件まで」が成立する |
| poller | 起動前に`<リポジトリ名>-issue-<番号>`のtmuxセッションがあるかを確認 | **手元のターミナルから直接起動した分。** そちらはissue-deckにジョブとして残らないため、DB側の制約では防げない |
| ラベル | 既存の`11.local` | 無人実行（`claude-issue-dispatch.yml`）との二重起動（#1097） |

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

| 起動先 | 経路 | 使える場面 |
|---|---|---|
| このPC | `issuedeck://`プロトコル → WSLの受け口（#1049） | メインPCでブラウザを開いているときだけ |
| サブPC（申告のあったホスト） | ジョブをキューに積む | **スマホからでも押せる。メインPCが起動していなくてよい** |

**申告しているホストが1台も無ければ、従来どおり単独のボタンのまま**にしている。申告さえあれば
（応答が途絶えていても）メニューになり、選べない理由はその場に出る。

### スマホの詳細画面には「このPC」を出さない

**サブPC起動の主な用途は外出先のスマホ**（#1180）なので、スマホ用のIssue詳細
（`components/dashboard/mobile/mobile-issue-detail.tsx`）にも導線を置く。ただし
**「このPC」は候補に入れない。** `issuedeck://`はブラウザを開いている端末のWindowsに登録された
ハンドラを踏むもので、スマホから押しても黙って何も起きない（未登録かどうかは検知できない。
#1088）。押せる場所に置くこと自体が誤解になる。

その結果、起動先が1つだけになる場面が2つできる（PCでサブPC未申告＝このPCのみ、スマホ＝
サブPCのみ）。**どちらもメニューにせず単独のボタンにする。** 選択肢が1つのメニューを開かせる
意味が無いため。スマホでサブPCの申告が無ければ、導線ごと出ない。

### 選べない理由は押す前に出す

判定は`resolveDispatchTargetRejection`（[src/lib/dispatch/dispatch-job.ts](../../src/lib/dispatch/dispatch-job.ts)）が持ち、
**理由の並びも文言も`enqueueDispatchJob`と同じものを使う**。画面とAPIで判定が分かれると、
「画面では押せるのにAPIが断る」状態が生まれる。押せない理由は4つ（申告が無い・応答していない・
そのリポジトリを実行できない・未完了ジョブが既にある）。

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

## API

| ルート | 認証 | 用途 |
|---|---|---|
| `POST /api/dispatch` | ログインセッション | ジョブを積む。実行できない組み合わせは理由付きで拒否 |
| `GET /api/dispatch` | ログインセッション | ホストの申告・未完了ジョブ・直近24時間の終了ジョブ・セッションの状態・同時実行数 |
| `POST /api/dispatch/<id>/cancel` | ログインセッション | 取り消し（`queued`・`claimed`のみ） |
| `POST /api/dispatch/claim` | `DISPATCH_SECRET` | ジョブの払い出し |
| `POST /api/dispatch/report` | `DISPATCH_SECRET` | `running` / `succeeded` / `failed` の報告 |
| `POST /api/dispatch/hosts` | `DISPATCH_SECRET` | 実行可能リポジトリの申告＋生存報告 |
| `POST /api/dispatch/sessions` | `DISPATCH_SECRET` | 起動後のtmuxセッションの状態報告（#1217） |

### シークレットは`PROGRESS_REPORT_SECRET`と分ける

**専用の`DISPATCH_SECRET`を持つ。** 進捗報告のシークレットはorganization secretとして全リポジトリの
ワークフローから参照できる値で、そこに「キューからジョブを取り出せる」権限まで載せると、
どこか1つのリポジトリのワークフローが漏らしただけでジョブの横取りが成立してしまう。値を分ければ、
漏洩時に停止・再発行する範囲もそれぞれに閉じられる。

Bearer検証の実装自体は[src/lib/shared-secret-auth.ts](../../src/lib/shared-secret-auth.ts)で共有している。
未設定は`unauthorized`（401）ではなく`not_configured`（503）で返し、poller側が「設定漏れ」と
「値の不一致」を切り分けられるようにしている。

## サブPC側のセットアップ

```bash
# 1. 設定ファイル（chmod 600。実値はコミットしない）
install -D -m 600 ~/apps/issue-deck/deploy/subpc/dispatch.env.example \
  ~/.config/issue-deck/dispatch.env
$EDITOR ~/.config/issue-deck/dispatch.env   # APP_BASE_URL と DISPATCH_SECRET を埋める

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

`systemctl --user status issue-deck-dispatch-poller.service` で常駐しているかを確認できる。

**API呼び出しが失敗したときのレスポンスボディは、1行に潰したうえで先頭200文字までしか出ない**
（末尾の`…`が切り詰めた印・#1210）。本番が404や502を返すとNext.jsのエラーページのHTML（約10KB）が
そのまま返り、pollerは毎分動くためjournaldがHTMLで埋まって本来見たい失敗理由が読めなくなるため。
URLとステータスコードは切り詰めずに残るので、どの経路が何で落ちたかは判断できる。全文が要る場合は
同じURLを`curl`で直接叩く。

## 受け口の複製に注意（#1179で増えた）

メインPC（WSL）のワンクリック起動は、`register-issuedeck-protocol.ps1`が
`~/.local/share/issue-deck/`へ複製した受け口を使う（#1076）。**受け口が
`lib/local-repo-resolve.sh`をsourceするようになったため、複製の中身が
「1ファイル」から「受け口＋`lib/`」に変わった。**

したがって**この変更を取り込んだら、メインPCで登録スクリプトの再実行が必要**。

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w ~/apps/issue-deck/scripts/windows/register-issuedeck-protocol.ps1)"
```

再実行を忘れた場合、受け口は**黙って失敗せず**「登録スクリプトを再実行してください」と案内して
止まる。#1085と同じ性質の変更で、#1089が「画面側から検知する手段が無い」と記録しているケース。

## 関連

- [#1176](https://github.com/guchi-apps/issue-deck/issues/1176) 実装実行基盤をサブPCへ移行する（親）
- [#1180](https://github.com/guchi-apps/issue-deck/issues/1180) 起動先（このPC / subpc）を選べるようにする
- [local-quick-start.md](local-quick-start.md) メインPCのワンクリック起動とローカル起動プロトコル
- [generic-launcher.md](generic-launcher.md) 対象リポジトリに何も置かずに起動する汎用ランチャー（#1224）
- [progress-status-architecture.md](../progress-status-architecture.md) 進捗の唯一の正はProject Status
