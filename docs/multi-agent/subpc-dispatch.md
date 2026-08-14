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
<対象リポジトリ>/scripts/start-issue.sh <番号>
  ↓
tmuxセッションが立つ → 以降の進捗は POST /api/progress（Project Status）が持つ
```

**画面の起動先選択UIは#1180。** このドキュメントが説明するのは受け口とキューまで。

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
| poller | 起動前に`tmux has-session`相当の確認 | **手元のターミナルから直接起動した分。** そちらはissue-deckにジョブとして残らないため、DB側の制約では防げない |
| ラベル | 既存の`11.local` | 無人実行（`claude-issue-dispatch.yml`）との二重起動（#1097） |

## 「実行できないリポジトリ」はディスパッチ前に弾く

サブPCに`git clone`されていないリポジトリのIssueを投げても起動しない。「投げたのに動かない」
状態を作らないため、**サブPCが「自分が実行できるリポジトリの一覧」を申告し、issue-deck側は
実行できないリポジトリの起動先としてサブPCを選べなくする**（#1179のコメントで決定）。

その場で`gh repo clone`して自動対応する案は採らない。冷えた状態からの依存インストールに時間が
かかるうえ、リポジトリによってはDBセットアップも要り、無人実行の前提として重すぎるため。

申告に載るのは、`scripts/start-local-session.sh`と**同じ4つの検証**を通ったものだけ。

1. `~/.config/issue-deck/local-repos.conf`に記載がある
2. チェックアウト先のディレクトリが実在する
3. `scripts/start-issue.sh`が存在する
4. 宣言しているローカル起動プロトコルの版数が、受け口の対応範囲に収まる（#1073）

**判定は[scripts/lib/local-repo-resolve.sh](../../scripts/lib/local-repo-resolve.sh)が持ち、
受け口とpollerが同じ関数を呼ぶ。** 判定を二重に持つと、申告と実際の起動可否が必ずずれる。

申告と実態がずれる可能性は残る（申告後にcloneを消した、`git pull`で版数が変わった等）。その場合は
**ディスパッチが失敗した理由をジョブの結果として画面へ返す**。ここを省くと、無人実行では何も
起きないまま終わる。

### ops-dashboard#34 との切り分け

「実行できるリポジトリの一覧」は**ジョブの割り当て可否を決める情報なのでissue-deck側**に持つ。
ホストの死活・CPU・メモリ・tmuxセッション一覧は[ops-dashboard#34](https://github.com/guchi-apps/ops-dashboard/issues/34)側で扱う。
サブPCはissue-deck専用機ではなく、他リポジトリの作業セッションも並ぶため。

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

## API

| ルート | 認証 | 用途 |
|---|---|---|
| `POST /api/dispatch` | ログインセッション | ジョブを積む。実行できない組み合わせは理由付きで拒否 |
| `GET /api/dispatch` | ログインセッション | ホストの申告・未完了ジョブ・直近24時間の終了ジョブ・同時実行数 |
| `POST /api/dispatch/<id>/cancel` | ログインセッション | 取り消し（`queued`・`claimed`のみ） |
| `POST /api/dispatch/claim` | `DISPATCH_SECRET` | ジョブの払い出し |
| `POST /api/dispatch/report` | `DISPATCH_SECRET` | `running` / `succeeded` / `failed` の報告 |
| `POST /api/dispatch/hosts` | `DISPATCH_SECRET` | 実行可能リポジトリの申告＋生存報告 |

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
- [progress-status-architecture.md](../progress-status-architecture.md) 進捗の唯一の正はProject Status
