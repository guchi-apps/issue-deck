# 画面からのローカルセッション起動（クイックスタート）

issue-deckの画面の「ローカルで開始」から、WSL上のClaude Codeセッションをワンクリックで
起動する仕組み（#1049）。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## なぜ必要だったか

起動経路は3つあるが、自動化されていたのは2つだけだった。

| 起点 | 実体 | 自動化 |
|---|---|---|
| GitHub Issue（`@claude`コメント・画面の「実装を開始」） | `claude-issue-dispatch.yml` | 全自動（無人実行） |
| WSLのターミナル | `scripts/start-issue.sh` | worktree作成〜devサーバー〜`claude`起動まで全自動 |
| 画面を見ていて「これをローカルでやろう」と思った瞬間 | — | 無かった |

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

登録スクリプトは2つの複製を作る。

| 複製するもの | 複製先 | 理由 |
| --- | --- | --- |
| `scripts/windows/issuedeck-protocol.ps1` | `%LOCALAPPDATA%\issue-deck\` | WSL上のパス（`\\wsl.localhost\...`）を直接登録すると、WSLが停止した状態からの初回起動でパス解決に失敗しうる |
| `scripts/start-local-session.sh` | WSLの`~/.local/share/issue-deck/` | リポジトリの作業ディレクトリを直接叩くと、そこが別Issueのブランチに切り替わっている間はファイルが存在せず起動できない（#1076） |

**どちらかを変更したときは、登録スクリプトを再実行して複製を更新する。**

受け口の複製元は`$PSScriptRoot`から辿る。`\\wsl.localhost\<ディストロ>\...`と`\\wsl$\<ディストロ>\...`は
そのまま読み替え、それ以外（Cドライブ等から実行した場合）は`wslpath -u`に任せる。特定できない
場合は警告を出すので、表示された`install`コマンドをWSL側で実行する。

解除は`-Unregister`を付けて実行する。両方の複製とレジストリ登録が消える。

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

**ただし対応表に書いただけでは起動しない。** 対象リポジトリが後述の「ローカル起動プロトコル」に
適合している必要がある。

## ローカル起動プロトコル v1

ワンクリック起動は、対象リポジトリの`scripts/start-issue.sh`を呼ぶ形で成り立っている。実体が
リポジトリごとにあるため、**ファイルがあっても約束を守っているとは限らない**。

実際に踏んだ例: shopping-listは`scripts/start-issue.sh`を持っているが`ISSUE_DECK_SKIP_LAN_SETUP`を
解釈しないため、押すとUACを承認しても待ちから戻らず**タブが無言で固まる**。「ファイルの存在」だけを
条件にすると、この最悪ケースを通してしまう。

そこで各リポジトリの`scripts/start-issue.sh`の冒頭に**マーカー行**を宣言させ、これを対応可否の
**単一の真実**として扱う（#1073）。

```bash
#!/usr/bin/env bash
# issue-deck-local-session: v1
```

受け口（`scripts/start-local-session.sh`）・画面・検査スクリプトの3か所がこの行を見る。
ワークフロー側が`uses: ...@workflows/v6`という参照そのものをバージョン記録にしているのと同じ発想で、
bashには`uses:`が無いため実体はコピーせざるを得ないが、**どの契約に従っているかの宣言だけは
機械可読にできる**。

### 約束の内容

| # | 約束 | 機械検査 |
| --- | --- | --- |
| 1 | `bash scripts/start-issue.sh <番号>`の1引数で、**そのターミナルのフォアグラウンドで**セッションを開始する（新しいタブを開かない） | できない |
| 2 | `ISSUE_DECK_SKIP_LAN_SETUP`が`0`以外なら、UACを伴う処理（`setup-lan-access.sh`）を行わない | できる |
| 3 | worktreeが既にあり`issue-<番号>`ブランチなら、作り直さず再利用する | できない |
| 4 | `ISSUE_DECK_DEV_PORT_BASE`が渡されたら開発サーバーのポートのベース値に使う | できる |
| 5 | 上記を満たしたうえでマーカー行を宣言する | できる |

**約束しないこと**: 依存インストール・開発サーバー起動・スクリーンショット対応の有無。これらは
技術スタックの違いで、リポジトリごとに要否が変わる（shopping-listは依存パッケージを持たない）。

約束1が要るのは、受け口が`exec`で自分自身を置き換えるため。ここで新しいタブを開くと元のタブが
即座に閉じる。約束4は、どのリポジトリがどのポート帯を使うかが**定義上どのリポジトリ単独でも
決められない**ため。実際、issue-deckとshopping-listが同じ`4000 + Issue番号`のまま衝突していた。
ベース値の表は受け口が持つ（issue-deck=4000／shopping-list=5000／dayspan=6000）。

### 適合を確かめる

```bash
scripts/check-local-session-contract.sh          # issue-deck自身（CIでも同じものが動く）
scripts/check-local-session-contract.sh --all    # 対応表の全リポジトリ
```

`--all`はローカルのチェックアウトを読むため、手元にクローンしていないリポジトリは見られない。
検査できるのは「宣言があるか」「約束が要求する環境変数を解釈しているか」までで、実際の挙動
（約束1・3）までは見ない。

適合していないリポジトリでボタンを押すと、**受け口の段階で停止して足すべき1行を表示する**。
起動してから固まるより安全という判断。

### 他リポジトリへ移植するとき

`scripts/start-issue.sh`は骨格が共通で、書き換えが要るのは実質6点。

| # | 書き換える箇所 | 例 |
| --- | --- | --- |
| 1 | worktreeベースの環境変数名と既定ディレクトリ | `DAYSPAN_WORKTREE_BASE:-$HOME/apps/dayspan-worktrees` |
| 2 | 共有知識ディレクトリの環境変数名 | `DAYSPAN_SHARED_CONTEXT_DIR` |
| 3 | `gh issue view --repo <owner/repo>` | |
| 4 | 環境変数ファイルの名前と供給方法 | `.env.local`のコピー／`.env`のコピーor`op inject` |
| 5 | 依存インストールの有無と開発サーバーの起動方式 | `pnpm install`＋`run-issue-session.sh`／どちらも無し |
| 6 | プロンプト内のリポジトリ名と技術前提 | テスト・ビルドの有無、認証、スクリーンショット可否 |

ポートのベース値は約束4により受け口が渡すので、移植時に決め直す必要はない。

そのままコピーで済むのは、事前バリデーション・worktreeの作成と再利用・sslip.ioの設定・
python3によるプロンプト生成ブロック全体・`wt.exe`でのタブ起動・`claude --permission-mode acceptEdits`
の起動フラグ。

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

`scripts/windows/*.ps1`は**UTF-8 BOM付き**でコミットしている。Windows PowerShell 5.1
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
```

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
- 進捗ラベル — `21.plan-required`が付いていれば`01.planning`、無ければ`02.wip`。
  **既に進捗ラベル（`01.planning`〜`09.main`）のいずれかが付いている場合は触らない。**
  再開（後述）で2回目以降に起動したときに、`03.d:marge`まで進んだIssueを`02.wip`へ
  巻き戻さないため

進捗ラベルを付ければGitHub ProjectsのStatusもWebhook経由で追随する
（`src/app/api/webhooks/github/route.ts`がラベルを正としてStatusを是正する）ため、ローカルから
`/api/progress`へ報告する必要はない。共有シークレット（`PROGRESS_REPORT_SECRET`）をローカルへ
置かずに済む。

ラベル付与に失敗しても起動自体は妨げない（起動できないより、記録が遅れる方が軽いという判断）。
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
| `issue-<番号>`ブランチのworktreeがある | **再利用** |
| gitの作業ツリーでないディレクトリがある | エラー終了（中身を確認して手動で削除する） |
| 別ブランチを開いている | エラー終了 |

前回のセッションがタブの強制終了などで開発サーバーを残していた場合は、再開時に停止してから
起動し直す。残ったままだとポートを掴んでいて`pnpm dev`が起動できないため。

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
`ISSUE_DECK_SKIP_LAN_SETUP=1`を設定し、`start-issue.sh`がそれを見てスキップする。
LAN内の別端末（スマホ等）から見たくなったら、そのworktreeで
`scripts/setup-lan-access.sh <ポート>`を直接実行する。

コマンドライン引数ではなく環境変数で渡しているのは、この指定を解釈しない他リポジトリの
`start-issue.sh`へ渡っても無害にするため（未知のフラグはissue番号として扱われて失敗する）。

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

## 未対応（このIssueの範囲外）

- マージ済みworktreeの**掃除**。放置すると溜まる。
- 受け口スクリプトの**陳腐化の検知**（別Issue）。画面側は「登録コマンドをコピーした版」を控えて
  人が照合できるようにするところまでで、実際にインストールされている版はブラウザからは見えない。
