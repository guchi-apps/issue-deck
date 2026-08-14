# 画面からのローカルセッション起動（クイックスタート）

issue-deckの画面の「ローカルで開始」から、WSL上のClaude Codeセッションをワンクリックで
起動する仕組み（#1049）。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

> **この経路が成立するのは、ブラウザを開いている端末＝メインPCのときだけ。** サブPCが申告して
> いる環境では「ローカルで開始」が起動先の選択になり、サブPCを選ぶとジョブをキューに積む
> （#1180）。そちらは[subpc-dispatch.md](subpc-dispatch.md)を参照。このドキュメントが説明するのは
> 「このPC」を選んだときの経路。
>
> **後述の「ローカル起動プロトコル」が必須なのも、この「このPC」経路だけ**（#1224）。サブPCからの
> 起動は、マーカー行を持たないリポジトリを汎用ランチャーで起こす
> （[generic-launcher.md](generic-launcher.md)）。

## なぜ必要だったか

起動経路は3つあるが、自動化されていたのは2つだけだった。

| 起点 | 実体 | 自動化 |
|---|---|---|
| GitHub Issue（`@claude`コメント・画面の「実装を開始」） | `claude-issue-dispatch.yml` | 全自動（無人実行） |
| WSLのターミナル・SSH越しのターミナル | `scripts/start-issue.sh` | worktree作成〜devサーバー〜`claude`起動まで全自動 |
| 画面を見ていて「これをローカルでやろう」と思った瞬間 | — | 無かった |

（`start-issue.sh`がWindows Terminalの無い環境でも使えるようになったのは#1178から。
後述の[ヘッドレス（tmux）で起動する](#ヘッドレスtmuxで起動する)）

3つ目が抜けているため、実際には「Issue番号を覚える → ターミナルを開く → コマンドを打つ」を
手でつないでいた。ここを画面のボタン1つに畳む。

## 経路

```text
issue-deckの画面「ローカルで開始」
  ↓ issuedeck://start/<owner>/<repo>/<Issue番号>
Windowsのプロトコルハンドラ（%LOCALAPPDATA%\issue-deck\issuedeck-protocol.ps1）
  ↓ wt.exe → wsl.exe → bash -lc
~/.local/share/issue-deck/start-local-session.sh <owner> <repo> <番号>   ← リポジトリ→ローカルパスの解決
  ↓
<対象リポジトリ>/scripts/start-issue.sh <番号>          ← worktree・devサーバー・claude起動
```

**ブラウザからWSLのプロセスを直接起動する手段は存在しない。** そのため、Windows側に
カスタムURLプロトコルを登録し、そのハンドラを踏み台にする。VSCodeが
`vscode://vscode-remote/wsl+<ディストロ>/<パス>` を受けているのと同じ仕組み。

なお**Claude Code拡張（v2.1.227時点）はURIハンドラを登録していない**（`package.json`の
`contributes`に`uriHandler`が無く、`activationEvents`にも`onUri`が無い）。したがって
「deep linkでVSCodeを開き、そのままプロンプト入りのClaude Codeセッションを始める」ことは
できない。起動先をターミナルの`claude` CLI（＝`start-issue.sh`の既存の出口）にしているのは
この制約による。

## 初回セットアップ（1回だけ）

**手順は画面からも見られる。** Issue詳細の「…」メニュー →「ローカル起動のセットアップ」
（`src/components/dashboard/local-session-setup-dialog.tsx`）。詳細は後述の
[セットアップ手順を画面から見せる](#セットアップ手順を画面から見せる)。

WSLのターミナルに貼れる形。`wslpath -w`がWSLのパスをWindowsのパスへ変換する（`~`はコマンド
置換の中でもシェルが展開するので、ユーザー名を埋める必要は無い）。**管理者権限は不要**
（HKCU配下に登録するため）。

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w ~/apps/issue-deck/scripts/windows/register-issuedeck-protocol.ps1)"
```

Windows側のPowerShellから直接実行してもよい。

```powershell
cd \\wsl.localhost\Ubuntu\home\<ユーザー名>\apps\issue-deck
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\register-issuedeck-protocol.ps1
```

登録スクリプトは3つの複製を作る。

| 複製するもの | 複製先 | 理由 |
| --- | --- | --- |
| `scripts/windows/issuedeck-protocol.ps1` | `%LOCALAPPDATA%\issue-deck\` | WSL上のパス（`\\wsl.localhost\...`）を直接登録すると、WSLが停止した状態からの初回起動でパス解決に失敗しうる |
| `scripts/start-local-session.sh` | WSLの`~/.local/share/issue-deck/` | リポジトリの作業ディレクトリを直接叩くと、そこが別Issueのブランチに切り替わっている間はファイルが存在せず起動できない（#1076） |
| `scripts/lib/local-repo-resolve.sh` | WSLの`~/.local/share/issue-deck/lib/` | 受け口がリポジトリの解決・検証をこのライブラリに任せているため（#1179）。**受け口だけを複製しても起動しない** |

**いずれかを変更したときは、登録スクリプトを再実行して複製を更新する。**

> **#1179を取り込んだ環境では、登録スクリプトの再実行が必須。**
> 受け口が`lib/`をsourceするようになり、複製の中身が「1ファイル」から「受け口＋`lib/`」へ
> 変わった。再実行しないと`issuedeck://`からの起動が失敗する。#1085と同じ性質の変更で、
> 画面側から検知する手段が無いこと自体は#1089に記録がある。
> 受け口は黙って失敗せず、「登録スクリプトを再実行してください」と案内して止まる。

受け口は自分と同じ位置の`lib/`を探す（`$(dirname "${BASH_SOURCE[0]}")/lib/`）。リポジトリ内の
`scripts/lib/`と複製先の`~/.local/share/issue-deck/lib/`が同じ相対位置になるため、経路によらず
同じ1行で解決できる。**ライブラリからリポジトリ内のファイルを参照しないこと**（複製先には
チェックアウトが無い）。

受け口の複製元は`$PSScriptRoot`から辿る。`\\wsl.localhost\<ディストロ>\...`と`\\wsl$\<ディストロ>\...`は
そのまま読み替え、それ以外（Cドライブ等から実行した場合）は`wslpath -u`に任せる。特定できない
場合は警告を出すので、表示された`install`コマンドをWSL側で実行する。

解除は`-Unregister`を付けて実行する。3つの複製（`lib/`ごと）とレジストリ登録が消える。

動作確認は、ブラウザのアドレスバーに`issuedeck://start/guchi-apps/issue-deck/99999`を入力する。
新しいタブが開いて「issue #99999 の取得に失敗しました」で止まれば、レジストリ登録からWSLの
受け口までが繋がっている。**存在しないIssue番号を使う**のは、`start-issue.sh`がIssueの取得を
`git worktree add`より前に行うため、そこで止まればブランチもworktreeも作られないから。実在する
番号を入れると、その場で実装セッションが始まってしまう（#1076で、closedのEpic #1 を案内して
いたのを改めた）。

受け口の複製が見つからない場合は、ハンドラが起動前に検出してエラーを表示する。bashに任せると
終了コード127が出るだけで原因が読めず、受け口側の`pause_on_error`もスクリプトが起動する前
なので働かないため。

### WSLディストロ名が`Ubuntu`でない場合

ハンドラは環境変数`ISSUEDECK_WSL_DISTRO`を見る。未設定なら`Ubuntu`を使う。

## 対象リポジトリを増やす

`scripts/start-local-session.sh`が`owner/repo`→ローカルのチェックアウト先を解決する。
既定で解決できるのは`guchi-apps/issue-deck`のみ。他リポジトリは対応表に追記する。

```text
# ~/.config/issue-deck/local-repos.conf
guchi-apps/shopping-list  /home/guchi/apps/shopping-list
```

最初の空白までをリポジトリ名、残りをパスとして扱うので、**パスに空白を含んでもよい**。
行末のCRLFと余分な空白も落とす（Windows側のエディタで編集されうるため）。
ローカルのフォルダ名はリポジトリ名と一致していなくてよい。サンプルは
[scripts/local-repos.conf.example](../../scripts/local-repos.conf.example)。

**「このPC」経由の起動は、対応表に書いただけでは動かない。** 対象リポジトリが後述の
「ローカル起動プロトコル」に適合している必要がある。

**サブPCからの起動には適合が要らない**（#1224）。マーカー行を持たないリポジトリは、issue-deck側の
汎用ランチャー（`scripts/generic-start-issue.sh`）が起こす。対象リポジトリを増やす手順は
[generic-launcher.md](generic-launcher.md)「対象リポジトリを増やす」を参照。

## ローカル起動プロトコル v2

ワンクリック起動は、対象リポジトリの`scripts/start-issue.sh`を呼ぶ形で成り立っている。実体が
リポジトリごとにあるため、**ファイルがあっても約束を守っているとは限らない**。

実際に踏んだ例: shopping-listは`scripts/start-issue.sh`を持っているが`ISSUE_DECK_SKIP_LAN_SETUP`を
解釈しないため、押すとUACを承認しても待ちから戻らず**タブが無言で固まる**。「ファイルの存在」だけを
条件にすると、この最悪ケースを通してしまう。

そこで各リポジトリの`scripts/start-issue.sh`の冒頭に**マーカー行**を宣言させ、これを対応可否の
**単一の真実**として扱う（#1073）。

```bash
#!/usr/bin/env bash
# issue-deck-local-session: v2
```

受け口（`scripts/start-local-session.sh`）・画面・検査スクリプトの3か所がこの行を見る。
ワークフロー側が`uses: ...@workflows/v6`という参照そのものをバージョン記録にしているのと同じ発想で、
bashには`uses:`が無いため実体はコピーせざるを得ないが、**どの契約に従っているかの宣言だけは
機械可読にできる**。

### 約束の内容

| # | 約束 | 版 | 機械検査 |
| --- | --- | --- | --- |
| 1 | `bash scripts/start-issue.sh <番号>`の1引数で、**そのターミナルのフォアグラウンドで**セッションを開始する（新しいタブ・ウィンドウを開かない。tmuxセッションを作ってその場でアタッチするのは可） | v1 | できない |
| 2 | `ISSUE_DECK_SKIP_LAN_SETUP`が`0`以外なら、UACを伴う処理（`setup-lan-access.sh`）を行わない | v1 | できる |
| 3 | worktreeが既にあり`issue-<番号>`ブランチなら、作り直さず再利用する | v1 | できない |
| 4 | `ISSUE_DECK_DEV_PORT_BASE`が渡されたら開発サーバーのポートのベース値に使う | v1 | できる |
| 5 | 上記を満たしたうえでマーカー行を宣言する | v1 | できる |
| 6 | tmuxがあれば**tmuxの新しいセッション**を出口にする（セッション名は`<リポジトリ名>-issue-<番号>`。Windows Terminalのタブを開く出口は持たない） | v2 | 部分的（`tmux`の使用有無まで） |
| 7 | `ISSUE_DECK_DEV_PORT_BASE`が渡されない経路でも、**自リポジトリのポート帯を既定値として使う** | v2 | できない |

**約束しないこと**: 依存インストール・開発サーバー起動・スクリーンショット対応の有無。これらは
技術スタックの違いで、リポジトリごとに要否が変わる（shopping-listは依存パッケージを持たない）。

約束1が要るのは、受け口が`exec`で自分自身を置き換えるため。ここで新しいタブを開くと元のタブが
即座に閉じる。約束4は、どのリポジトリがどのポート帯を使うかが**定義上どのリポジトリ単独でも
決められない**ため。実際、issue-deckとshopping-listが同じ`4000 + Issue番号`のまま衝突していた。
ベース値の表は受け口が持つ（後述の[開発サーバーのポート帯](#開発サーバーのポート帯はリポジトリごとに固定する)）。

v2で足した約束6・7は、Windows Terminalが無いマシン（サブPCのUbuntu Server・SSH越しの実行）でも
起動できるようにするためのもの（#1178）。詳細は後述の
[ヘッドレス（tmux）で起動する](#ヘッドレスtmuxで起動する)。

**版を上げてもv1のリポジトリは切り捨てない。** 受け口・画面は「宣言された版数が自分の扱える版数
以下か」だけを見る（`isSupportedLocalSessionContract`）。v1のままのリポジトリは、これまでどおり
そのリポジトリ自身が持つ出口で動く。

### 適合を確かめる

```bash
scripts/check-local-session-contract.sh          # issue-deck自身（CIでも同じものが動く）
scripts/check-local-session-contract.sh --all    # 対応表の全リポジトリ
```

`--all`はローカルのチェックアウトを読むため、手元にクローンしていないリポジトリは見られない。
検査できるのは「宣言があるか」「約束が要求する環境変数を解釈しているか」「v2以上を宣言した
リポジトリが`tmux`を使っているか」までで、実際の挙動（約束1・3・7）までは見ない。

**マーカー行が無いことは違反ではない**（#1224）。宣言していないリポジトリは`○`（汎用ランチャーで
起動する）と表示される。検査しているのは「宣言した以上は約束を守っているか」であって、
「宣言しているか」ではない。CIで検査するissue-deck自身だけは、自前の`start-issue.sh`で起動し
続けるため宣言を必須としている。

v2の検査は**v2以上を宣言しているリポジトリにだけ課す**。v1のままのリポジトリを違反扱いにすると、
受け口が受け入れる範囲と検査結果がずれる。

適合していないリポジトリでボタンを押すと、**受け口の段階で停止して足すべき1行を表示する**。
起動してから固まるより安全という判断。

### 他リポジトリへ移植するとき

> **原則として移植しない**（#1224）。サブPCからの起動は汎用ランチャーで足りる
> （[generic-launcher.md](generic-launcher.md)）。ここに残しているのは、「このPC」経由の
> ワンクリック起動をどうしてもそのリポジトリで使いたい場合の手順。**対象を1つ増やすたびに
> 700行を複製して6箇所を書き換える運用が割に合わない**というのが#1224の出発点だった。

`scripts/start-issue.sh`は骨格が共通で、書き換えが要るのは実質6点。

| # | 書き換える箇所 | 例 |
| --- | --- | --- |
| 1 | worktreeベースの環境変数名と既定ディレクトリ | `DAYSPAN_WORKTREE_BASE:-$HOME/apps/dayspan-worktrees` |
| 2 | 共有知識ディレクトリの環境変数名 | `DAYSPAN_SHARED_CONTEXT_DIR` |
| 3 | `gh issue view --repo <owner/repo>` | |
| 4 | 環境変数ファイルの名前と供給方法 | `.env.local`のコピー／`.env`のコピーor`op inject` |
| 5 | 依存インストールの有無と開発サーバーの起動方式 | `pnpm install`＋`run-issue-session.sh`／どちらも無し |
| 6 | プロンプト内のリポジトリ名と技術前提 | テスト・ビルドの有無、認証、スクリーンショット可否 |

ポートのベース値は約束4により受け口が渡すが、**既定値（受け口を通らない経路で使う値）だけは
移植時に自リポジトリの帯へ直す**（約束7。後述の
[開発サーバーのポート帯](#開発サーバーのポート帯はリポジトリごとに固定する)）。

そのままコピーで済むのは、事前バリデーション・worktreeの作成と再利用・sslip.ioの設定・
python3によるプロンプト生成ブロック全体・tmux出口（出口の判定・セッション名の組み立て・
`bash -lc`・`remain-on-exit`）・`claude --permission-mode "$PERMISSION_MODE"`の起動フラグ
（既定値の決め方は後述の[権限モードは環境変数で切り替える](#権限モードは環境変数で切り替える)）。

## ヘッドレス（tmux）で起動する

`start-issue.sh`の出口は元々Windows依存だった（複数Issue指定時の`wt.exe -w 0 new-tab`、タブ名の
書き換え、`setup-lan-access.sh`のUAC）。Windows Terminalが無いマシン（サブPCのUbuntu Server）
では、この出口が使えない。**出口をtmuxの新しいセッションに置き換え、`wt.exe`でタブを開く出口は
削除した**（#1178）。

これにより、外出先の端末からTailscale SSHでサブPCに入り、`start-issue.sh`を叩いて実装を始める
という使い方が成立する（#1176 Phase 1）。

**WSLでも同じtmux経路を使う。** Windows Terminalのタブを開く出口を残すと、同じことをする経路が
2つになり、片方でしか直らない不具合が生まれる。tmuxで代替できるうえ、ターミナル（タブ）を
閉じてもセッションが残るという利点もあるため、Windows依存のない側へ寄せた。

### 出口の決まり方

出口は**tmuxがあるかどうかだけ**で決まる。実行環境（WSLかLinuxか）は見ない。

```bash
scripts/start-issue.sh 1178             # tmuxがあればtmuxセッション
scripts/start-issue.sh --no-tmux 1178   # このターミナルで動かす（逃げ道）
```

| | 単一Issue | 複数Issue |
| --- | --- | --- |
| tmuxがある | 新しいtmuxセッション → そのままアタッチ | Issueごとに新しいtmuxセッション（アタッチはしない） |
| tmuxが無い（`--no-tmux`を含む） | このターミナルのフォアグラウンド | 準備だけ行い、手動実行コマンドを案内 |

`--no-tmux`はこのターミナルで動かしたいときの逃げ道。tmuxが無い環境では警告を出して自動的に
こちらへ落ちる。

tmuxの中から実行した場合は入れ子でアタッチできないため、作るところまでで止めて
`tmux switch-client -t <セッション名>`を案内する。

**ワンクリック起動（画面の「ローカルで開始」）もこの出口を通る。** Windows側のハンドラが
`wt.exe`でタブを開くところは変わらないが、そのタブの中では`start-issue.sh`がtmuxセッションを
作ってアタッチする。タブを閉じてもセッションは残る。

### セッション名

`<リポジトリ名>-issue-<番号>`（例: `issue-deck-issue-1178`）。端末のタイトル
（`<リポジトリ名> #<番号>`）と同じ内容だが、tmuxで使える文字だけに直している。`.`・`:`は`session:window.pane`の区切りとして
解釈されるためセッション名に使えず、空白と`#`は指定のたびにクォートが要る。

**リポジトリ名を含めるのが要点。** サブPCはissue-deck専用機ではなく、他リポジトリの作業セッションも
同じ`tmux ls`に並ぶ。ops-dashboardの各ホストのセクションにtmuxセッション一覧が出る
（guchi-apps/ops-dashboard#38）ため、**ここで付けた名前がそのまま画面に並ぶ**。
リポジトリ名が無いと、どのアプリの作業セッションかがダッシュボード側で判別できない。

セッションの中では、これまでどおり`claude --name "<リポジトリ名> #<番号>"`がウィンドウ名と
端末のタイトルを引き継ぐ。

### tmuxはログインシェルを経由しない（PATHが落ちる）

**実際に踏んだ**（#1177）。`tmux new-session -d -s <名前> <スクリプト>`で起動すると、`claude`が
見つからずセッションが即死する。tmuxはコマンドを既定シェルで直接実行し、ログインシェルとしては
起動しないため、`~/.profile`系が読まれず`~/.local/bin`がPATHに乗らない
（Ubuntu既定の`~/.bashrc`は非対話シェルを冒頭で`return`するので、そちらに書いても読まれない）。

そのため`bash -lc '<コマンド>'`を明示して起動する。起動スクリプトの先頭で
`export PATH="$HOME/.local/bin:$PATH"`を足す方法もあるが、`node`／`pnpm`／`claude`／`gh`／
`OP_SERVICE_ACCOUNT_TOKEN`がすべてログインシェル側で解決するため、個別にPATHを足すと将来
増えた変数を取りこぼす。

あわせて、`ISSUE_DECK_*`のうち起動時に効くものは`export`をコマンド文字列に埋めて渡している
（`build_env_prefix`）。tmuxのセッションはtmuxサーバー側の環境を引き継ぐため、呼び出し元の
`export`がそのまま届くとは限らない。同じ理由で`wt.exe`の経路（別の`wsl.exe`を起こす）にも効く。

### 失敗したペインを残す

tmuxは既定でコマンドの終了と同時にセッションを破棄するため、**エラーメッセージが一切残らない**
（#1177で原因究明にかなり手間取った）。起動後に`remain-on-exit`を設定して、異常終了時にペインを
残す。

```bash
tmux set-option -t "<セッション名>:" -w remain-on-exit failed
```

- `failed`はtmux 3.2以降。異常終了のときだけ残る。古いtmuxでは`unknown value`で失敗するので、
  常に残す`on`へ落とす
- これは**ウィンドウのオプション**なので、対象は`<セッション名>:`（そのセッションの現在の
  ウィンドウ）で指す。セッション指定で使う`=`接頭辞（`-t "=<名前>"`）は付かない。付けると
  `no such window`になる

**メインPCのWSLはtmux 3.0a**で、`on`へ落ちる側を通る。この環境では**正常終了でもセッションが
残る**（`tmux ls`に終了済みのものが並ぶ）。次に同じIssueで起動したときに後述の分岐が畳んで
作り直すため起動できなくなることはないが、気になる場合は`tmux kill-session -t <名前>`で消す。

### 同名セッションが既にあるときは作らない

worktreeの再利用（前述の「2回目以降は再開になる」）と同じ考え方で、同名のtmuxセッションが
動いていれば新しくは起動せず、アタッチの案内だけを出す。同じIssueのセッションが二重に立つと、
どちらのdevサーバーが生きているのか分からなくなる。

**ただし`remain-on-exit`で残った「死んだペインだけのセッション」は例外。** これは動いている
セッションではなく前回の終了の痕跡なので、最後の出力を15行だけ表示してから畳み、作り直す。
残したままにすると、再実行しても「既に動いています」で止まって**二度と起動できなくなる**。

| セッションの状態 | 挙動 |
| --- | --- |
| 無い | 新規作成 |
| 生きているペインがある | 作らずアタッチの案内だけ出す |
| 全ペインが死んでいる（前回の終了の痕跡） | 最後の出力を表示 → 畳んで作り直す |

「異常終了した」と断定せず「終了したまま残っていました」と表示するのは、tmux 3.2未満では
正常終了でも残るため。終了コードは表示する最後の出力（`Pane is dead (status N)`）から読める。

### 並行本数の目安

サブPC実機での実測は**上限3本**（メモリ58%・swap 0）。ただしメモリより先にCPUが律速し、3本並行では
`next build`が35.7秒→88秒（2.5倍）に伸びた。**常用は2本まで**が妥当。

`start-issue.sh`自体は本数を制限しない（手で叩く分には数えられる）。上限の設定値としての実装は、
画面からディスパッチする側（#1179・#1176 Phase 2）が持つ。

## 開発サーバーのポート帯はリポジトリごとに固定する

開発サーバーのポートは`ベース値 + Issue番号`。ベース値はリポジトリごとに固定する。

一覧は[scripts/local-repo-ports.conf](../../scripts/local-repo-ports.conf)が持つ。どのリポジトリが
どの帯を使うかは**定義上どのリポジトリ単独では決められない**ため、全リポジトリを知る唯一の場所
（issue-deck側）に置いている（#1073）。元は受け口（`scripts/start-local-session.sh`）の`case`文
だったが、対象リポジトリが増えたので設定ファイルへ移した（#1224）。

読み込み順は「環境変数`ISSUE_DECK_LOCAL_REPO_PORTS_CONFIG` → 受け口と同じディレクトリ →
`~/.config/issue-deck/local-repo-ports.conf`」。**複製先（`~/.local/share/issue-deck/`）へは
登録スクリプトが配る。** 配られていなくても各リポジトリの既定値（約束7）に落ちるだけなので、
起動自体は妨げない。

`issue-deck`は既に#1224まで進んでおり4000帯（1000ぶん）では足りないため、4000〜5999を占める扱いに
している。5000帯にいた`shopping-list`は、この重なりを解消するため7000へ移した（#1224）。

**契約適合のリポジトリでは、`start-issue.sh`側の既定値も同じ値に揃える**（約束7。#1178）。
ターミナル直叩き・tmux経路は受け口を通らずベース値が渡ってこないため、既定値が帯とずれていると
**同じIssueでも起動経路によって別のポートになる**。複数リポジトリのセッションが常駐するサブPCでは、
そのずれがそのまま他リポジトリの帯との衝突になる。

汎用ランチャー（#1224）で起動するリポジトリでは、そもそも`start-issue.sh`を通らないため
**対応表の値が唯一の帯**になる。

Issue番号は単調増加するので、同じリポジトリ内でポートが衝突することはない。帯の幅（原則1000）を
超えるIssue番号になったら帯を割り直す。

## 開発サーバーは終了時に止め、残った分は回収する

サブPCは**常用2本・上限3本**（前述）で、`pnpm dev`一式は使用中で0.45〜1.13GiB、アイドルでも
1本あたり77MiBとポート1つを掴む（#1177・#1223の実測）。終わったセッションの開発サーバーが
残ると、新しい実装を起こせなくなる。止め方は3段構えになっている。

| 段 | 何をするか | 実装 |
| --- | --- | --- |
| 1 | セッションの終了時に止める | `scripts/run-issue-session.sh`の`trap cleanup EXIT HUP TERM` |
| 2 | 止まらなかった分（孤児）を回収する | `scripts/reap-dev-servers.sh`（pollerが1巡ごとに呼ぶ） |
| 3 | 作業が終わってアイドルなものを止める（**セッションは残す**） | 同上 |

3で**セッション本体は畳まない**。メモリの大半は開発サーバー側にあり、PRがマージされた後に
追加指示が来て同じセッションを再利用した実例（#1178）があるため、文脈を捨てる価値が無い。
セッションそのものを畳む段は#1219（`Stop`フック）待ちで、まだ入っていない。

### `trap`は発火していた。cleanupが途中で打ち切られていた（#1223）

孤児が生まれる原因は長らく「`claude`が対話プロセスなので`trap`に到達しない」と推定されていたが、
**実測すると`trap`は正しく発火していた**。

- tmuxの`kill-session`はペインのプロセスグループへSIGHUPを送る。`set -m`により`pnpm dev`も
  `claude`も別のプロセスグループなので、このSIGHUPは届かない。カーネルによるptyハングアップの
  SIGHUPもセッションリーダーにしか行かない
- `claude`はptyが壊れたことに気づいて自分で終了する。よって`cleanup`は呼ばれる
- しかし`cleanup`の最初の`echo`は**破棄済みのptyへの書き込みでEIOにより失敗**し、
  `set -euo pipefail`のerrexitが`cleanup`をそこで打ち切っていた。`kill`にも
  `rm -f "$DEV_PID_FILE"`にも到達しない

裏付けは`.dev-servers/issue-<番号>.pid`が消えずに残っていたこと。`rm -f`すら走っていない。

**教訓は`cleanup`の先頭で`set +e`すること。** 端末が消えた後に走る後始末では、出力の失敗で
本体の処理が飛ぶ。記録もstdoutではなく`.dev-servers/issue-<番号>.log`（実ファイル）へ残す。
無人実行では「なぜ開発サーバーが落ちているのか」がこのログにしか残らない。

### 回収の判定（`scripts/reap-dev-servers.sh`）

`.dev-servers/issue-<番号>.pid`を走査し、1件ずつ次を判定する。**判断を挟まない計器**であり、
LLMも人への問い合わせも通らない（[関門と計器](gates.md)の「計器」）。

| 判定 | 条件 | 動作 |
| --- | --- | --- |
| 死んでいる | プロセスが居ない | PIDファイルだけ削除 |
| 別人 | プロセスグループリーダーでない、または`/proc/<pid>/cwd`が対象worktreeでない | **止めない。**PIDファイルだけ削除 |
| 孤児 | `PPID == 1`（親の`run-issue-session.sh`が消えてinitに引き取られた） | 停止＋ログ |
| アイドル | `.dev-servers/issue-<番号>.log`のmtimeが閾値（既定60分）より古い | 停止＋ログ |

- **孤児判定にtmuxのセッション名を使わない。** リポジトリ名からセッション名を復元する対応表は、
  Issue番号がリポジトリごとに振られるぶん壊れやすい（#1224）。`PPID`はプロセス単位で確定する
  事実で、対応表を増やさずに済む。
- **アイドル判定の材料は開発サーバーのログのmtimeだけ。** `next dev`はリクエストと再コンパイルの
  たびに書くため、「誰もその画面を見ていない」時間の代理になる。**`capture-pane`の内容は
  読まない**（画面の文字列からの推定は実地で誤判定した実績がある。[関門と計器](gates.md)）。
- **プロセスグループごとkillする以上、確信が持てない相手には触らない。** PIDファイルは残りうる
  ため、書かれたPIDが再利用されている可能性を常に疑う。判定はどちらも
  [scripts/lib/dev-server.sh](../../scripts/lib/dev-server.sh)が持ち、`run-issue-session.sh`と共有する。

閾値は`~/.config/issue-deck/dispatch.env`の`DEV_SERVER_IDLE_MINUTES`（既定60・**0でアイドル回収を
無効**）。孤児の回収はこの値と無関係に常に行う。手元で確かめるときは
`scripts/reap-dev-servers.sh --dry-run`。

### 止められた開発サーバーの起こし方

`cd ~/apps/issue-deck-worktrees/issue-<番号> && pnpm dev`。止めた理由と、この手順は
`.dev-servers/issue-<番号>.log`の末尾に残る。実装エージェントへ渡すプロンプトにも
「一定時間アクセスが無いと自動で停止される」ことを書いてあるため、画面確認で繋がらないことを
事故と受け取って調査に入ることはない。

## 作業が終わったセッションは自動で畳む（#1256）

開発サーバーを止めてもセッション本体は残る。`claude`は対話プロセスで、作業が終わっても
プロンプト待ちに戻るだけで**終了しない**ためで、`tmux new-session`に渡したコマンドが終わらない以上
セッションは残り続ける。同時実行数の上限は**ジョブの払い出しにしか効かない**（tmuxが立った時点で
ジョブは`succeeded`）ので、生きているセッションの本数には上限が無く、放置すると際限なく積み上がる
（2026-08-14の実測で10本・うち5本は対応IssueがCLOSED済み）。

pollerが1巡ごとに`scripts/reap-sessions.sh`を呼び、条件を**すべて**満たすセッションだけを
`tmux kill-session`で畳む。閾値は`~/.config/issue-deck/dispatch.env`の`SESSION_IDLE_MINUTES`
（既定60・**0で無効**）。手元で確かめるときは`scripts/reap-sessions.sh --dry-run`。

### 判定の材料は状態ファイルとgit・GitHubの事実だけ

`Stop`フック（#1219）はSignalyへ通知するだけで、**いつ応答が終わったかをホストに残していなかった**。
そこで`scripts/lib/session-state.sh`を足し、tmuxのセッション名をキーに次の2つを残す。
置き場は`~/.local/state/issue-deck/sessions/`（`ISSUE_DECK_SESSION_STATE_DIR`で変更可能）。

| ファイル | 書く人 | 中身 |
| --- | --- | --- |
| `<セッション名>.session` | `run-issue-session.sh`（起動時） | worktreeの場所・対応Issue・`reapable` |
| `<セッション名>.event` | `session-notify.sh`（フック） | `<epoch> <Stop\|permission_prompt>` |

**キーをtmuxのセッション名にする。** 回収側がtmuxから得られる唯一の識別子で、worktreeの置き場は
リポジトリごとに違い（`~/apps/<リポジトリ名>-worktrees`）、Issue番号はリポジトリごとに振られる。
状態の記録は**webhookの設定より前**に行うため、通知を設定していないホストでも回収は効く。

| # | 条件 | 満たさないときに残す理由 |
| --- | --- | --- |
| 1 | 記述子があり`reapable=1` | ジョブとして起動したセッションだけを対象にする。手元のターミナルから直接起動した分・他リポジトリの作業用セッションは記述子が無い |
| 2 | ペインが生きている | 死んだペインは`remain-on-exit failed`が残した異常終了の証拠。最後の出力を読めるうちは消さない |
| 3 | 最後のイベントが`Stop` | `permission_prompt`が後なら承認プロンプト・`AskUserQuestion`の表示中＝人の入力待ち |
| 4 | その`Stop`から`SESSION_IDLE_MINUTES`以上 | **`Stop`＝作業完了ではない。** レビュー結果待ち・追加指示での再開も`Stop`を出す |
| 5 | Issueに`11.local`が付いていない | 実装エージェントが引き渡し時に自分で外すラベル。付いている間はローカルで作業中 |
| 6 | IssueがCLOSED、または`issue-<番号>`のPRがマージ済み | 成果物が本流に入っていない |
| 7 | worktreeがcleanで、コミットがすべて`origin`にある | 畳むと取り返せない |

- **`gh`・`git`が失敗したときは必ず「畳まない」側へ倒す。** 判定できない＝残す。
- **`22.merge-confirm-required`の特別扱いは持たない。** 人がマージするまでPRはopenのままなので、
  条件6で自動的に残る。ラベルを見る箇所を増やさない。
- **push済みの判定にベースブランチ名を使わない。** 対象リポジトリによって`develop`と`main`が
  混在する（#1224）ため、`git branch -r --contains HEAD`で「HEADを含むリモート追跡ブランチが
  1つでもあるか」を見る。
- **畳んだ事実は必ずjournaldに残す。** 無人実行では「なぜセッションが消えたのか」がここにしか
  残らない。残した理由も出すが、**前回と同じ理由のときは出さない**（60秒ごとに呼ばれるため、
  同じ行でログが埋まると本来見たい回収の記録が読めなくなる）。

### 畳んだ後に追加指示が来たら

**畳むと文脈が失われる。** #1178 ではPRのマージ後に追加指示が来て同じセッションを再利用した実績が
あるため、猶予（条件4）と`11.local`（条件5）で「まだ触る可能性がある間」は残す。それでも畳まれた
後に追加指示が必要になった場合は、issue-deckの画面から起動し直す（worktreeは残っているため
再開扱いになる）。

**`11.local`を外さないまま止まったセッションは畳まれない。** `00.check-user`で人へ引き上げて
止まっているセッションが該当する。これは意図した挙動で、人が見るまで残す。

## Tailscale経由でスマホから画面を見る

WSLで必要だったLANアクセス設定（`setup-lan-access.sh`）は、WSL2の内部NATを越えるための
**Windows側**のポートフォワーディングとファイアウォール規則で、素のLinuxには対応物が無い。
`start-issue.sh`は`powershell.exe`が無い環境を検出してスキップする（`ISSUE_DECK_SKIP_LAN_SETUP`を
渡す必要はない。渡した場合も従来どおりスキップする）。

`next dev`は**既定で全インターフェース（IPv4/IPv6の両方）を待ち受ける**ため、tailnet内の端末から
`http://<ホスト名>:<ポート>`でそのまま見える。閉じたいときだけ`ISSUE_DECK_DEV_HOST`で待ち受け
アドレスを指定する（`dev.sh`が`next dev -H`へ渡す）。

**`-H 0.0.0.0`を明示してはいけない。** 既定（未指定）はIPv4/IPv6の両方を待ち受けるが、
`0.0.0.0`を渡すとIPv4だけに絞られ、tailnetのIPv6アドレスから見えなくなる。

### allowedDevOriginsに載せる必要がある

localhost以外のホスト名で開くと、開発サーバーの内部リソース（`/_next/*`とHMRのWebSocket）が
**403で弾かれる**。`next.config.ts`の`allowedDevOrigins`に載っているホストだけが通る。

```ts
allowedDevOrigins: ["localhost", "127.0.0.1", "**.sslip.io", "**.ts.net", ...extraDevOrigins]
```

**ワイルドカードは末尾の`**`だけが複数ラベルに一致する**（`*`は1ラベルのみ）。Next.jsの実装
（`server/app-render/csrf-protection.ts`）がドット区切りで後ろから突き合わせるためで、
`*.sslip.io`では`172.20.5.3.sslip.io`に一致しない（`*`が`3`に当たった時点で`172.20.5`が余る）。
既存の`*.sslip.io`もこの理由で効いていなかったため、あわせて`**.sslip.io`に直した。

MagicDNSの短い名前（`subpc`）や生のtailnet IP（`100.x.x.x`）で開く場合はワイルドカードに当たらない。
`.env.local`の`ISSUE_DECK_DEV_ALLOWED_ORIGINS`にカンマ区切りで足す（開発サーバーにしか効かない）。

## セキュリティ上の前提

プロトコルを登録すると、この起動経路は**任意のWebページから叩ける**ようになる。悪意ある
ページが`issuedeck://...`を仕込めば、ハンドラは呼ばれる。そのため次を守っている。

- URLは**全体一致の正規表現で検証**し、`owner`・`repo`は`[A-Za-z0-9._-]`、Issue番号は正の整数
  のみを通す。空白・引用符・`;`（Windows Terminalのサブコマンド区切り）・シェルのメタ文字は
  この時点で落ちる。
- `.`を許可文字に含めている都合で`.`・`..`自体は正規表現を通るため、別途弾く（パス走査の防止）。
- 同じ検証をWSL側の`start-local-session.sh`でも行う（多層防御）。
  **片側だけを緩めない。** 緩めた側が単独で穴になる。
- 検証を通った値以外は、コマンドラインへ一切埋め込まない。

起動されうる操作の上限は「issue-deckのworktreeを作り、devサーバーとClaude Codeセッションを
立ち上げる」ところまでで、任意コマンドの実行には至らない。ただしClaude Codeセッション自体は
起動してしまうため、**心当たりのないタブが開いたら閉じる**。

## PowerShellスクリプトはUTF-8 BOM付きで保存する

`scripts/windows/*.ps1`と`scripts/start-issue.ps1`（Windows側で実行する`.ps1`すべて）は
**UTF-8 BOM付き**でコミットしている。Windows PowerShell 5.1
（`powershell.exe`。Windowsに標準搭載されているもの）は、BOMが無いファイルをANSI（日本語環境では
CP932）として読むため、日本語コメントを含むスクリプトが文字化けし、**構文エラーで動かなくなる**。

実際に、BOM無しで保存した時点では次のエラーになった。

```text
式またはステートメントのトークン '}' を使用できません。
```

エラー行（`}`）は実際の原因箇所ではなく、文字化けした前の行で文字列が閉じられなくなった結果
そこまでずれて報告される。**エラー行を読んでも原因にたどり着けない**ので、`.ps1`で不可解な
構文エラーが出たらまずBOMの有無を疑う。

```bash
head -c 3 scripts/windows/issuedeck-protocol.ps1 | xxd   # efbbbf ならBOM付き
```

構文エラーの有無は、Windows PowerShellのパーサーにかければWSL側からでも確かめられる。

```bash
w=$(wslpath -w scripts/start-issue.ps1)
powershell.exe -NoProfile -NonInteractive -Command "\$e=\$null; [void][System.Management.Automation.Language.Parser]::ParseFile('$w',[ref]\$null,[ref]\$e); if(\$e.Count -gt 0){\$e[0].Message}else{'OK'}"
```

`scripts/start-issue.ps1`はBOM無しのままコミットされており、この方法で構文エラーになることを
確認したうえでBOMを付けた（#1105）。`scripts/start-reviewer.ps1`も同じ状態のまま残っている。

## プロトコルが登録されていない環境

ボタンを押しても何も起きない（ブラウザが未知のスキームを無視する）。この場合のフォールバックとして、
Issue詳細の「…」メニューに**「ローカル起動コマンドをコピー」**を用意している。コピーした
コマンドをWSLのターミナルに貼れば、URL経路とまったく同じ`start-local-session.sh`が動く。
経路ごとに挙動が分かれないよう、コマンドの生成も`src/lib/local-session.ts`に集約している。

**このコマンドも受け口の複製（`~/.local/share/issue-deck/start-local-session.sh`）を指す。**
URL経路と同じものを動かすためだが、複製を作るのは登録スクリプトなので、一度も実行していない
環境では存在しない。その場合はリポジトリから直接置く。

```bash
install -D -m 755 ~/apps/issue-deck/scripts/start-local-session.sh \
  ~/.local/share/issue-deck/start-local-session.sh
install -D -m 755 ~/apps/issue-deck/scripts/lib/local-repo-resolve.sh \
  ~/.local/share/issue-deck/lib/local-repo-resolve.sh
```

**受け口とライブラリは必ずセットで置く。** 受け口だけを置くと、実行時に
「`lib/local-repo-resolve.sh`がありません」で停止する。

## セットアップ手順を画面から見せる

登録手順がこのドキュメントにしか無いと、使う側は**「ボタンを押しても何も起きない」状態から
自力でここへ辿り着く**必要がある（#1088）。Issue詳細の「…」メニューに
**「ローカル起動のセットアップ」**を置き、ダイアログで手順を出す
（`src/components/dashboard/local-session-setup-dialog.tsx`）。

**初回の「ローカルで開始」押下時には自動で開く**（localStorageで一度きり。以降はメニューから
任意に開ける）。

### 検知はできない

**ブラウザから`issuedeck://`が登録済みかを知る手段は無い。** 未登録でも押下は黙って無視される
だけで、エラーも遷移も観測できない。インストール済みの受け口のバージョンも見えず、画面から
何かを実行することもできない。遷移後に`blur`が来るかを見る裏技はあるが、ブラウザ自身の確認
ダイアログがフォーカスを奪うため誤検知する。**当てにしない。**

したがって「状況を検知して出す」のではなく、**こちらから一度だけ見せる**設計にしている。

### ダイアログの内容

| 項目 | 内容 |
| --- | --- |
| 1. 登録コマンド | WSLのターミナルにそのまま貼れる1行（コピーボタン付き） |
| 2. 動作確認 | `issuedeck://start/guchi-apps/issue-deck/99999`へのリンク。押せばその場で経路を確認でき、Issue取得に失敗して止まるのでブランチもworktreeも作られない |
| 3. 再実行が要るケース | 「受け口スクリプトを更新したら登録スクリプトを再実行」。アプリのバージョンを併記する |
| 4. フォールバック | プロトコル未登録の環境向けの起動コマンド（「ローカル起動コマンドをコピー」と同じもの） |

3のバージョンは、**登録コマンドをコピーした時点の版**をlocalStorageに控え、現在の版と並べて
出す（`src/lib/local-session-setup.ts`）。登録そのものは検知できないので、「いつの版で登録した
か」を人が照合できるところまでを担保する。版が違えば登録し直しを促す。

コマンドの生成は経路によらず`src/lib/local-session.ts`へ集約している。分かれていると片方だけ
古くなる。案内するチェックアウト先（`~/apps/issue-deck`）も`start-local-session.sh`の既定の
解決先と同じ値にしてある。**ユーザー環境依存の値**（チェックアウト先・WSLのディストロ名）に
ついては、読み替える旨と`ISSUEDECK_WSL_DISTRO`の存在をダイアログ内に添えている。

## 起動時のラベル付与（`11.local`・進捗ラベル）

ローカルセッションを起こした時点で、Issue側にも「ローカルで対応中である」「着手した」ことが
残るようにラベルを付ける。付ける場所は2箇所ある。

| 付ける場所 | 付けるもの | 目的 |
| --- | --- | --- |
| 画面のボタン（`src/components/dashboard/start-local-session-button.tsx`） | `11.local` | **起動前**に立てる。プロトコルハンドラを経てWSLに到達するまでの間も無防備にしないため |
| `scripts/start-issue.sh`（`prepare_issue`） | `11.local` ＋ 進捗ラベル | どの起動経路（ターミナル直叩き・ボタン・`/issue`）もここを通るため、付け忘れが起きない（#1096・#1097） |

スクリプト側の判定は、Issue取得時のJSONに入っているラベルから行う（判定のための追加のAPI
呼び出しはしない）。

- `11.local` — 付いていなければ付ける。無人実行（`claude-issue-dispatch.yml`）との二重起動を
  防ぐ停止フラグ（[branching.md](branching.md)）
- 進捗（Project Status） — `21.plan-required`が付いていれば`Planning`、無ければ`Implementation`を
  issue-deckの進捗報告API（`POST /api/progress`）へ報告する。
  **既に進捗が始まっている（`Ready`以外）場合は触らない。** 再開（後述）で2回目以降に起動した
  ときに、`Develop PR`まで進んだIssueを`Implementation`へ巻き戻さないため。現在の進捗は
  `GET /api/progress`で確認してから報告する

進捗ラベルは#991 Phase 5（#1010）で廃止したため、ローカルからも`gh issue edit`では進捗を
進められない。報告先と鍵（`APP_BASE_URL`・`PROGRESS_REPORT_SECRET`）は
**環境変数 → 本体の`.env.local` → `~/.config/issue-deck/dispatch.env`** の順に探す（#1236。
[scripts/lib/progress-report.sh](../../scripts/lib/progress-report.sh)）。**サブPCのチェックアウトは
アプリを動かすためのものではないため`.env.local`のキーが空のことがあり**、その場合は
サブPC側の設定ファイルが唯一の置き場になる（[subpc-dispatch.md](subpc-dispatch.md)）。
**どこにも無ければ報告せず案内だけ出す**（issue-deckの画面のボタン・カンバンから進める運用も
成立するため、起動を止める理由にしない）。

ラベル付与・進捗の報告に失敗しても起動自体は妨げない（起動できないより、記録が遅れる方が軽いという判断）。
ボタン経由では`11.local`の付与がスクリプト側と重複するが、二重に付けても害はない。

## 2回目以降は再開になる

同じIssueでもう一度ボタンを押すと、worktreeを作り直さずに**既存のworktreeでセッションを
開き直す**（#1076）。一度タブを閉じても戻れる。未コミットの変更が残っていれば件数を表示する。

作り直さないため、`git worktree add`と`.env.local`のコピーは行わない。`.env.local`は
ローカルで書き換えている場合があるので、既にあるものを尊重する（無いときだけ本体からコピー）。
ただし本体に後から足した環境変数が古いworktreeへ届かないままになるため、**本体の`.env.local`に
あってworktree側に無いキーだけは値ごと追記する**（#1099。既存キーの値は書き換えない）。
`pnpm install`とプロンプトの再生成は毎回行う（前者は数秒で終わり、後者はIssueに付いた
新しいコメントを取り込むため）。

想定外の状態のときは再利用せずに止める。

| 状態 | 挙動 |
| --- | --- |
| worktreeが存在しない | 新規作成 |
| `issue-<番号>`ブランチのworktreeがある | **再利用**（PRがマージ済みなら警告。後述） |
| gitの作業ツリーでないディレクトリがある | エラー終了（中身を確認して手動で削除する） |
| 別ブランチを開いている | エラー終了 |

前回のセッションがタブの強制終了などで開発サーバーを残していた場合は、再開時に停止してから
起動し直す。残ったままだとポートを掴んでいて`pnpm dev`が起動できないため。ただしこれは
**同じIssueを起こし直したときにしか効かない**対症療法で、残った分の回収は
[開発サーバーは終了時に止め、残った分は回収する](#開発サーバーは終了時に止め残った分は回収する)が担う。

## タブ名で「どのリポジトリのどのIssueか」を示す

タブ名は`<リポジトリ名> #<Issue番号>`（例: `issue-deck #1105`）にする（#1105）。Issueごとに
タブを開いて並行作業するため、タブを切り替えなくても中身が分かる必要がある。

設定箇所は起動の段階ごとに3つあり、後の段階が前の段階を上書きしていく。

| 段階 | 設定するもの | 実装 |
| --- | --- | --- |
| タブ（tmuxセッション）を開く | Windows Terminalのタブ名／tmuxのセッション名 | `--title "<repo> #<番号>"`（`issuedeck-protocol.ps1`・`start-issue.ps1`）／`<repo>-issue-<番号>`（`start-issue.sh`の`tmux_session_name`） |
| worktree準備中（`gh`取得・`pnpm install`） | 端末のタイトル（OSC 0） | `set_terminal_title`（`start-issue.sh`） |
| セッション実行中 | セッション名（＝端末のタイトル） | `claude --name "<repo> #<番号>"`（`run-issue-session.sh`） |

**最後の`--name`が要点。** Claude Codeは会話の内容からセッション名を自動生成し、それを端末の
タイトル（OSC 0）へ継続的に書き込む。`--name`で明示しない限り、前段で付けたタブ名は
セッション開始後に自動命名で上書きされ、タブからIssueを特定できなくなる。`--name`で渡した名前は
プロンプトボックスと`/resume`の一覧にも出る。

`--name`を解釈しない古いClaude Codeへ渡すと起動自体が失敗するため、`claude --help`に`--name`が
あるときだけ付ける（無い場合はタイトルを諦めて起動する）。

ownerは入れずリポジトリ名だけにしている。タブの横幅が限られており、同名リポジトリを別ownerで
同時に扱う場面が今のところ無いため。

## セッションに渡す最初のプロンプト

`run-issue-session.sh`が`claude`へ渡すのは、プロンプトファイル（`.prompts/issue-<番号>.md`）の
中身そのものではなく、次の1行だけにする（#1105）。

```text
Issue #<番号> の実装を開始してください。あなたへの指示は <プロンプトファイルのパス> にあります。まずこのファイルを読み、確認を待たずにそのまま指示に従って着手してください。
```

- **届かなかったときに貼り直せる。** 数KBのプロンプト全文を貼り直すのは現実的でない。起動前に
  この1行を必ず端末へ表示しておく
- プロンプトファイルを読むのは起動後なので、渡した後に再生成された場合でも最新の内容で動く
- `ps`の出力にIssue本文が丸ごと出るのを避けられる

「確認を待たずに着手する」ことは、プロンプトファイル側（`scripts/prompts/implementation-agent.md`）
にも明記している。ここが曖昧だと、セッションは開いたのに指示待ちで止まる。

### 起動直後に何も始まらない場合

セッションは開いたのに実装が始まらないときは、端末に表示された上の1行を貼り付ける。

この事象は実際に起きている（#1105の時点で、worktree上の過去9セッションすべて、最初のメッセージ
が手打ちだった＝渡したプロンプトが1度も届いていない）。一方、**すでに信頼済みのディレクトリ**では、
同じフラグ・同じ長さ（6KB超・複数行）のプロンプトでも自動送信されることを確認できている。
差分は「worktreeが新規ディレクトリで、初回起動時にフォルダの信頼確認
（`Is this a project you created or one you trust?`）が出ること」だけだが、**承認時にプロンプトが
失われると確定させたわけではない**。信頼確認はこちらから自動化するものではないため、原因を
追うのではなく、貼り直せる形にして先へ進めるようにしている。

## 権限モードは環境変数で切り替える

`run-issue-session.sh`（実装セッション）と`start-reviewer.sh`（レビュー・統合セッション）は、
`claude --permission-mode`へ渡す値を`ISSUE_DECK_CLAUDE_PERMISSION_MODE`から取り、**既定を`auto`
とする**（#1205）。

```bash
PERMISSION_MODE="${ISSUE_DECK_CLAUDE_PERMISSION_MODE:-auto}"
claude --permission-mode "$PERMISSION_MODE" ...
```

元の既定だった`acceptEdits`は**ファイル編集だけを自動承認し、Bashコマンドは都度確認する**。
そのためセッションは`npx tsc --noEmit`・`npx vitest run`・`python3`・`gh issue comment`のたびに
停止し、人が承認しないと進まない（#1179の実装セッションでは1回の実装で6回以上停止した）。
サブPCでの無人実行・外出先からの起動は、この状態では成立しない。

代償は**人が個々のコマンドを目視する機会が失われる**ことで、これは取り戻せない。それでも`auto`を
既定とするのは、後段に防御が残っているため。

- 変更は必ずPull Requestになり、`claude-review-develop.yml`のレビューを通る
- DBスキーマ・認証・本番設定・Secrets等は自動マージ不可カテゴリとして`00.check-user`で止まる
- worktreeがIssueごとに分離されており、他Issueの作業を壊さない

運用上の約束。

- 慎重に進めたいときは`ISSUE_DECK_CLAUDE_PERMISSION_MODE=acceptEdits`で従来の挙動に戻せる。
  ワンクリック起動の経路でもtmuxが`bash -lc`でログインシェルを経由するため、`~/.bashrc`等に
  `export`しておけば効く
- **`bypassPermissions`を既定にはしない。** すべての権限チェックを飛ばすため、破壊的な操作も
  無確認で通る
- 値の妥当性検査は**claude側に任せる**。issue-deck側で受け付ける値を列挙すると、claudeの更新で
  ずれる。不正な値を渡した場合はclaudeが起動時にエラーで落ちるだけで、意図しないモードで
  動き出すことはない（`--permission-mode nonexistent`は
  `option '--permission-mode <mode>' argument 'nonexistent' is invalid.`（＋許可値の一覧）を出して
  終了コード1で落ちる）

なお[セキュリティ上の前提](#セキュリティ上の前提)のとおり、プロトコル経由の起動は
「心当たりのないタブが開いたら閉じる」で受けている。`auto`ではその開いてしまったセッションが
コマンドを確認なしで実行できるため、**閉じる判断は早いほどよい**。

## タブは非対話シェルで始まる（nvmが読まれない）

`wt.exe` → `wsl.exe -d <ディストロ> -- bash -lc` で開くタブは**非対話シェル**で、Ubuntuの
`~/.bashrc` は冒頭で非対話シェルを弾く。

```sh
# If not running interactively, don't do anything
case $- in
    *i*) ;;
      *) return;;
esac
```

nvmの設定は`~/.bashrc`のこれより後ろにあるため読まれない。結果、タブの中では
**システムのnodeしか見えず、nvm管理下のnodeとpnpmがPATHに乗らない**（#1085で実際に踏み、
`pnpm: command not found`で終了コード127になった）。

| | 通常のWSLターミナル | タブ（`bash -lc`） |
| --- | --- | --- |
| node | v24.18.0（nvm） | v20.20.2（システム） |
| pnpm | あり | **無し** |
| claude | あり | あり（`~/.local/bin`。nvmと無関係） |

`claude`は見つかるので`start-issue.sh`冒頭のコマンド存在チェックを通過してしまい、
worktreeを作ったあとで落ちていた。

`start-local-session.sh`が、`pnpm`が見つからない場合に`nvm.sh`を明示的に読み込む。
`nvm.sh`は`set -u`下で未定義変数を参照し`set -e`とも相性が悪いため、読み込みの前後で
`set +eu`／`set -eu`を挟んでいる。あわせて`start-issue.sh`の冒頭で`pnpm`の存在も確認する
（`gh`・`claude`と同じ位置。worktreeを作ってから落ちると中途半端な状態が残るため）。

この問題は**ワンクリック経路に固有**で、`start-issue.sh`を普通のWSLターミナルから叩く
従来の経路では対話シェルなので出ない。作ったことで初めて表に出た類のもの。

## ワンクリック起動ではLANアクセス設定を行わない

`start-issue.sh`を素で叩くと`setup-lan-access.sh`（Windows側のポートフォワーディングと
ファイアウォール規則）が走り、**UACダイアログが出る**。ところがwt.exeで開いたタブでは、
UACを承認して中の処理が成功しても`Start-Process -Verb RunAs -Wait`が待ちから戻らず、
**タブが固まる**（#1076で実際に踏んだ。portproxyとファイアウォール規則は作成済みなのに
画面は無反応、という判断のつかない状態になる）。

そのためワンクリック経路では行わない。`start-local-session.sh`が
`ISSUE_DECK_SKIP_LAN_SETUP=1`を設定し、`start-issue.sh`と`dev.sh`がそれを見てスキップする。
LAN内の別端末（スマホ等）から見たくなったら、そのworktreeで
`scripts/setup-lan-access.sh <ポート>`を直接実行する。

コマンドライン引数ではなく環境変数で渡しているのは、この指定を解釈しない他リポジトリの
`start-issue.sh`へ渡っても無害にするため（未知のフラグはissue番号として扱われて失敗する）。

`start-issue.sh`だけでなく`dev.sh`も見る必要がある点に注意（#1094）。`setup-lan-access.sh`の
呼び出し口は2つあり、#1076で`start-issue.sh`側だけを外した結果、まったく同じ症状が
`pnpm dev` → `dev.sh`側に残っていた。呼び出し経路は次のとおりで、`pnpm dev`は
`run-issue-session.sh`の子プロセスなので`export`した環境変数がそのまま届く。

```text
start-local-session.sh（ISSUE_DECK_SKIP_LAN_SETUP=1 を export）
  → start-issue.sh          ← 見てスキップする
    → run-issue-session.sh
      → pnpm dev → dev.sh   ← 見てスキップする
```

`pnpm dev`を普通のターミナルから叩く従来の使い方（環境変数なし）では、これまでどおり
LANアクセス設定が走る。

**WSL以外の環境では環境変数によらずスキップする**（#1178）。`powershell.exe`が無い環境には
Windows側のポートフォワーディングという概念自体が無いため。前述の
[Tailscale経由でスマホから画面を見る](#tailscale経由でスマホから画面を見る)を参照。

### 止まる正体はUAC待ちではなくSIGTTIN

「UAC待ちから戻らない」ように見えるが、#1094の調査で実際の機構が分かった。**バックグラウンドの
プロセスグループが端末から読もうとして`SIGTTIN`で停止している。**

`run-issue-session.sh`は`pnpm dev`をバックグラウンドジョブとして起動する。`set -m`があるため
これは独立したプロセスグループになり、端末のフォアグラウンドプロセスグループは`claude`のままになる。
出力は`.dev-servers/issue-<n>.log`へ逃がしてあるが、**stdinは端末のまま**だった。この状態で
`setup-lan-access.sh`が起動する`powershell.exe`（WSL interop）が端末を読もうとすると、
カーネルがプロセスグループ全体に`SIGTTIN`を送って停止させる。誰も`SIGCONT`しないので永久に止まる。

止まっているプロセスは`ps`の`STAT`列が`T`（`wchan`は`do_signal_stop`）になる。**`S`ではなく`T`
なら、待っているのではなく止められている。**UACダイアログを承認しても動かないのはこのため。

普通のWSLターミナルから`pnpm dev`を叩く場合はフォアグラウンドプロセスグループなので端末を
読んでよく、停止しない。**ワンクリック経路に固有**なのはこれが理由。

対策は3層になっている。

1. **`ISSUE_DECK_SKIP_LAN_SETUP=1`**（上記）。ワンクリック経路ではそもそも呼ばない
2. **`run-issue-session.sh`が`pnpm dev </dev/null`で起動する**。stdinが端末でなければ
   `SIGTTIN`は原理的に発生しない。devサーバー配下のあらゆる子プロセスに効く
3. **`setup-lan-access.sh`のUAC待ちに`timeout`（既定60秒）**。`ISSUE_DECK_LAN_SETUP_TIMEOUT`で
   変更でき`0`で無制限。打ち切り・失敗のいずれも終了コード1を返し、呼び出し元は警告を出して
   先へ進む（devサーバーの起動は止めない）

3が`SIGTTIN`停止にも効くのは、`timeout`が子を**別のプロセスグループ**に置くため。停止するのは
子だけで`timeout`自身は生き残り、時間になれば落とせる。停止中のプロセスには`SIGTERM`が届かない
ので`--kill-after`を併用している（GNU timeoutはシグナル送出後に`SIGCONT`も送る）。

## VSCodeのタブから始める（`/issue <番号>`）

上のワンクリック起動はWindows Terminalの**タブ**を開くため、同時に見えるのは1つだけになる。
VSCodeのClaude Codeタブを横に並べて複数Issueを並行で進める使い方（1ウィンドウ・Nタブ）には、
`.claude/commands/issue.md` のスラッシュコマンドを使う。

```text
VSCodeでClaude Codeのタブを開く（Claude Code: Open in New Tab）
  ↓
/issue 1049
  ↓
worktree準備・ラベル付与（scripts/start-issue.sh --prepare-only）→ プロンプト適用
```

`--prepare-only`はworktree・ブランチ・`.env.local`・ポート採番・`pnpm install`・起動用
プロンプトの生成までを行い、**開発サーバーもClaude Codeも起動せずに終了する**。既に
セッションの中にいるので、さらに`claude`を起動しても意味がないため。LANアクセス設定
（Windowsの管理者権限＝UACダイアログが出る）も、開発サーバーを立てない以上は不要なので
スキップする。

worktreeが既にある場合は作り直さず再利用する（この挙動は`start-issue.sh`自体が持つため、
画面のボタンから起動したときも同じ。前述の「2回目以降は再開になる」を参照）。

### worktreeを編集できるようにする

Claude Codeタブのカレントディレクトリは、VSCodeで開いているフォルダ（＝本体チェックアウト）
になる。worktreeはその外にあるため、**そのままではEdit/Writeが通らない**。

その場限りで通すなら、セッション内で一度だけ実行する。

```text
/add-dir ~/apps/issue-deck-worktrees/issue-1049
```

毎回不要にするなら、**本体チェックアウト**の`.claude/settings.local.json`（ローカル専用。
gitで無視される）に追記する。Claudeタブのカレントディレクトリは本体チェックアウトなので、
worktree側ではなくこちらに書く。

```json
{
  "permissions": {
    "additionalDirectories": ["/tmp", "/home/<ユーザー名>/apps/issue-deck-worktrees"]
  }
}
```

パスは絶対パスで書く。このファイルはコミットされないマシン固有の設定なので、`~`の展開に
依存させる必要がない。既存の`additionalDirectories`がある場合は**上書きせず追記する**
（`/tmp`等が消えると別の場所で権限エラーになる）。

**コミット対象の`.claude/settings.json`には書かない。** そちらはGitHub Actions上の無人実行でも
読まれるため、Actions側に存在しないパスを持ち込むことになる。

### なぜ本体チェックアウトで作業しないか

タブを複数開くと、全タブのカレントディレクトリが同じ本体チェックアウトになる。そこで
`git switch`すると**他タブのセッションの作業ツリーごと切り替わる**。実際、このIssueの作業中に
本体が`issue-1049`から`issue-834`へ切り替わり、未コミットの変更が別Issueのセッション側へ
持ち越される事故が起きた。`/issue`が必ずworktreeへ寄せるのはこのため。

### Claude Code純正のworktree機能を使わない理由

Claude Codeには`claude -w/--worktree`とVSCode拡張の`Claude Code: Create Worktree`があるが、
このリポジトリでは採用していない。実測（2026-08-11、CLI 2.1.220 / 拡張 2.1.227）での差分は次のとおり。

| 項目 | 純正worktree | issue-deckの規約 | |
|---|---|---|---|
| 作成先 | `<repo>/.claude/worktrees/<name>` | `~/apps/issue-deck-worktrees/<name>` | リポジトリ内部に入る |
| ブランチ名 | `worktree-<name>` 固定 | `issue-<番号>` | **衝突** |
| 分岐元 | `origin/HEAD`（このリポジトリでは`develop`） | `develop` | 一致 |
| gitignore | 追加されない（`?? .claude/`が出る） | — | 除外設定が要る |

**ブランチ名が決定的**で、`worktree-issue-1049`のような名前になる。`issue-<番号>`の命名規約を
前提にした`issue-labels.yml`等の自動化（[labels.md](labels.md)）が対象外と判定して空振りする。
設定スキーマに`branchPrefix`・`branchName`にあたる項目は無く、コード上も`worktree-${name}`の
ハードコードのため、設定で回避できない。

一方`worktree.symlinkDirectories`で`node_modules`をメインリポジトリから共有できる点は純正が
優れており、`--prepare-only`が毎回`pnpm install`する現状より速い。命名の制約が外れたら再検討する。

## マージ済みIssueで再開したときの扱い

再開できるようにしたことで、**マージ済みのIssueでボタンを押すと古いworktreeがそのまま
再利用される**という副作用が出た（#1100）。以前は「既に存在します」で止まっていたぶん、
黙って進む方がかえって気づきにくい。マージ済みブランチは`develop`から分岐し直されておらず、
以降のdevelopの変更を含まないまま作業を始めることになる。

そのため`start-issue.sh`は再開時に`gh pr list --head issue-<番号> --state merged`を見て、
マージ済みPRがあれば警告する。そのうえで**消しても失われないと確認できたときだけ**、
作り直すかどうかを尋ねる。

| 状態 | 挙動 |
| --- | --- |
| マージ済みPRが無い | 何も表示せず再利用（通常の再開） |
| マージ済み・クリーン・端末あり | 警告し、`[Y/n]`で作り直すか尋ねる（既定は作り直す） |
| マージ済み・クリーン・端末なし（`--prepare-only`等） | 警告して再利用。`--recreate`の案内を出す |
| マージ済みだが未コミットの変更・未pushのコミット・稼働中のセッションがある | 警告して再利用（消すと失われるため作り直さない） |

`--recreate`を付けると尋ねずに作り直し、`--no-recreate`を付けると尋ねずに再利用する。
`--recreate`を指定しても、消すと失われるものが残っている場合は作り直さずエラーで止まる。

作り直しはworktreeとローカルブランチを削除してから、通常の新規作成経路（最新の`develop`から
`git worktree add -b`）へ合流する。判定に使う「消してよいか」のロジックは
`scripts/lib/worktree-status.sh`に置き、掃除コマンドと共有している。**片方だけを緩めない。**

## 溜まったworktreeを掃除する

worktreeは自動では消えない。1つあたり`node_modules`込みで1GB前後あるため、放置すると
ディスクを食い、`git worktree list`も読みにくくなる。

```bash
bash ~/apps/issue-deck/scripts/cleanup-worktrees.sh --dry-run   # 判定だけ見る
bash ~/apps/issue-deck/scripts/cleanup-worktrees.sh             # 一覧を出して確認してから削除
```

対象・オプション・削除するものの範囲は[branching.md](branching.md)の「ブランチ・worktree運用」を参照。

## 未対応（このIssueの範囲外）

- 受け口スクリプトの**陳腐化の検知**（別Issue）。画面側は「登録コマンドをコピーした版」を控えて
  人が照合できるようにするところまでで、実際にインストールされている版はブラウザからは見えない。
