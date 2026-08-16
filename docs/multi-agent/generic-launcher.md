# 汎用ランチャー（対象リポジトリに何も置かずに起動する）

サブPC上で、issue-deck以外のリポジトリのIssueについてもClaude Codeセッションを起動する仕組み（#1224）。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

> **「起動コマンドをコピー」経由の起動はこの仕組みの対象外。** そちらは対象リポジトリが契約適合の
> `scripts/start-issue.sh`を持っている場合だけ起動できる（[local-quick-start.md](local-quick-start.md)）。
> 広げたのはサブPCからの起動だけ。#1263で廃止した「このPC」（`issuedeck://`）も同様だった。

## なぜ必要だったか

サブPCへのディスパッチ（#1179・#1180）で「画面のボタンからサブPC上のセッションを起動する」経路は
通ったが、**実際に起動できるリポジトリは`guchi-apps/issue-deck`の1つだけ**だった。

原因は、対応可否の唯一の真実が「対象リポジトリが契約適合の`scripts/start-issue.sh`を持つこと」
（#1073）だったこと。これはメインPCのワンクリック起動を前提にした設計で、Windows Terminal・UAC・
LANポートフォワーディングといった**起動元の環境差をリポジトリ側のスクリプトが吸収する**必要が
あったため、リポジトリごとに実体を持つ形になっていた。

対象を1つ増やすたびに700行規模のスクリプトを移植して6箇所を書き換える運用になり、増やしたい数
（7リポジトリ）に対して複製が割に合わない。

一方で、**サブPC起動に限れば環境差はほぼ無い。** 出口はtmux固定で、Windows依存の処理は最初から
要らない（#1178でtmux出口を入れた時点で片付いている）。リポジトリごとに違うのはベースブランチ・
パッケージマネージャ・envファイルの名前・ポート帯・プロンプト文面くらいで、いずれも規約か設定で
表現できる。

## 経路

```text
poller → scripts/start-local-session.sh <owner> <repo> <番号>
           ├ 対象リポジトリに契約適合の start-issue.sh がある → 従来どおりそれを exec（issue-deck自身）
           └ 無い                                            → scripts/generic-start-issue.sh を exec
```

分岐の判定は[scripts/lib/local-repo-resolve.sh](../../scripts/lib/local-repo-resolve.sh)が持つ
（`LOCAL_REPO_MODE`が`contract`か`generic`か）。**受け口とpollerが同じ関数を呼ぶ**ので、申告と
実際の起動可否がずれない。

**マーカー行を宣言しているリポジトリは、これまでどおり自前のスクリプトで起動する。** 宣言している
以上はそのリポジトリが起動元の事情を吸収する手当てを持っているはずで、汎用ランチャーへ回すと
その手当てを黙って捨てることになる。

## 汎用ランチャーがやること

`scripts/start-issue.sh`からWindows依存（`setup-lan-access.sh`・UAC・sslip.io）を落としたもの。

1. Issueの取得（`gh issue view --repo <owner/repo>`）
2. `11.local`の付与と進捗（`POST /api/progress`）の報告 — worktree作成より**先**に行う
3. worktreeの作成／再利用（`issue-<番号>`ブランチを`origin/HEAD`から分岐）
4. envファイルの供給（本体チェックアウトからコピー／不足キーの追記）とポートの書き込み
5. 依存インストール
6. 起動用プロンプトの生成
7. tmuxセッションの起動（`<リポジトリ名>-issue-<番号>`）

`scripts/run-issue-session.sh`（claudeの起動フラグ・共有知識の`--add-dir`・権限モード）は
issue-deck自身の経路と共有している。**片方だけが直る状態を作らない。**

## リポジトリ固有の値の解決方法

| 項目 | 解決方法 |
| --- | --- |
| ベースブランチ | `origin/HEAD`から判定する（develop / mainが混在するため）。引けない場合は`develop`→`main`→`master`の順に探す |
| worktree置き場 | `~/apps/<repo>-worktrees` |
| パッケージマネージャ | `detect_package_manager`（宣言 → ロックファイル → package.json）。`package.json`が無ければ依存インストール自体を行わない |
| envファイル | 本体チェックアウトの`.env.local`・`.env`をコピーし、既にあるものには不足キーだけを補う（`lib/env-file-sync.sh`） |
| ポート帯 | [scripts/local-repo-ports.conf](../../scripts/local-repo-ports.conf) |
| プロンプト | 対象リポジトリに`scripts/prompts/implementation-agent.md`があればそちらを優先し、無ければissue-deckの`scripts/prompts/generic-implementation-agent.md` |
| 上記で吸収できない事情 | 対象リポジトリの`scripts/issue-session-hooks.sh`（任意） |

### 進捗報告の鍵はサブPCでは`.env.local`に無いことがある

`11.local`の付与と`POST /api/progress`の報告は、issue-deck自身の経路（`start-issue.sh`）と同じく
worktree作成より**先**に行う。宛先と鍵（`APP_BASE_URL`・`PROGRESS_REPORT_SECRET`）を
issue-deck本体チェックアウトの`.env.local`だけから読むと、**サブPCのチェックアウトはアプリを
動かすためのものではないため空のことがある**（実際に空だった）。そのため
`~/.config/issue-deck/dispatch.env`も見る（[deploy/subpc/dispatch.env.example](../../deploy/subpc/dispatch.env.example)）。

どちらにも無ければ報告をスキップして起動は続ける。**起動できないより、記録が遅れる方が軽い。**

**この解決は[scripts/lib/progress-report.sh](../../scripts/lib/progress-report.sh)が持ち、
汎用ランチャーとissue-deck自身の`start-issue.sh`が共有する**（#1236）。当初は汎用ランチャー側に
だけ置いたため、**issue-deck自身のIssueをサブPCで起動したときだけ進捗が`Ready`のまま**という
状態になっていた。同じ約束を2か所に書くと、片方だけが直った時点でそこが穴になる
（`local-repo-resolve.sh`・`env-file-sync.sh`と同じ理由）。

### envは1Password経由ではなく本体チェックアウトからコピーする

`op inject`をここで走らせない。リポジトリごとにテンプレートの置き場も項目名も違い、
**汎用ランチャーがリポジトリ固有の知識を持つことになる**ため。サブPC側で一度だけ本体
チェックアウトに`.env.local`／`.env`を置いておけば、以降のworktreeはそこから供給される
（issue-deck自身の経路と同じ考え方・#1099）。

### 逃げ道（`scripts/issue-session-hooks.sh`）

規約と設定で吸収できない事情（DBセットアップ等）がある場合だけ、対象リポジトリに置く。**無いのが
既定。** 置いた場合はworktreeの中でsourceされ、定義されている関数だけが呼ばれる。

| 関数 | 呼ばれる場所 |
| --- | --- |
| `issue_session_after_worktree` | worktree作成・env供給の後、依存インストールの前 |
| `issue_session_after_install` | 依存インストールの後、プロンプト生成の前 |

環境変数`ISSUE_SESSION_REPOSITORY`・`ISSUE_SESSION_ISSUE_NUMBER`・`ISSUE_SESSION_WORKTREE_DIR`・
`ISSUE_SESSION_MAIN_CHECKOUT`・`ISSUE_SESSION_DEV_PORT`・`ISSUE_SESSION_PACKAGE_MANAGER`が渡る。
**フックの失敗は警告に留めて起動を続ける**（フックが原因でセッションごと立たない方が困る）。

## 開発サーバーは既定で起動しない（`23.preview-required`のときだけ起こす）

サブPCは2C/4T（同時実行の既定が2なのもこの実測による・#1177）で、**リポジトリ数ぶんのdevサーバーを
常駐させる前提が置けない。** ポートはenvファイルへ書き込むので、画面確認が必要なセッションだけ
中で起動する（生成されるプロンプトにも起動コマンドを書いている）。

**ただし`23.preview-required`が付いている場合は起動する**（#1265）。あのラベルは「PR作成前に
画面を確認する」ためのもので、起動していなければ確認そのものが成立しない。あわせて
`tailscale serve`でtailnetへ出し、**スマホから開けるURL**をプロンプト・Signalyの通知・
issue-deckの画面へ渡す（`localhost`のURLでは外出先から届かない）。

実装は`run-issue-session.sh`の`ISSUE_DECK_DEV_SERVER`で、汎用ランチャーがラベルを見て
`0`か`1`を渡す。issue-deck自身の経路（`start-issue.sh`）はこれまでどおり常に起動する。

## 「実行できるリポジトリ」の判定

申告（`POST /api/dispatch/hosts`）に載る条件から、**マーカー行の必須要件を外した**。

| # | 条件 | 変更 |
| --- | --- | --- |
| 1 | `~/.config/issue-deck/local-repos.conf`に記載がある | 変わらず |
| 2 | チェックアウト先のディレクトリが実在する | 変わらず |
| 3 | `scripts/start-issue.sh`が存在する | **不要になった**（汎用ランチャーで起動する） |
| 4 | 宣言している版数が受け口の対応範囲に収まる | **宣言している場合のみ**課す |

汎用ランチャーが配られていない環境（`~/.local/share/issue-deck/`へ複製された受け口）では、
従来どおり3・4を課す。手元からの起動を広げるのは#1224の範囲外で、`ok`にしてしまうと
押した先で「ランチャーが無い」と言われるだけになるため。

### 画面のゲートは起動先ごとに分ける

| 起動先 | 判定材料 |
| --- | --- |
| 起動コマンドをコピー | `Repository.hasLocalStartScript`（GitHub上のマーカー行・#1073） |
| サブPC | サブPCの申告（`resolveDispatchTargetRejection`） |

`canStartLocalSession(hasLocalStartScript)`は**「起動コマンドをコピー」のゲートに限定した**
（#1224。「このPC」を廃止した#1263以降も同じ）。
GitHub上のファイルの有無ではなく、実際にcloneされ起動できるかを申告しているサブPC側の情報の方が
正確なため。マーカー行を持たないリポジトリのIssueでも、サブPCが申告していれば「サブPCで開始」が出る。

## 対象リポジトリを増やす（サブPC側の作業）

対象リポジトリには**何も追加しない。** サブPC側だけで完結する。

```bash
# 1. clone（worktreeの置き場は起動時に ~/apps/<repo>-worktrees が作られる）
gh repo clone guchi-apps/<repo> ~/apps/<repo>

# 2. 依存インストール（初回だけ。worktree側は起動時に毎回入る）
cd ~/apps/<repo> && npm ci   # または pnpm install。package.json が無ければ不要

# 3. 対応表へ追記
$EDITOR ~/.config/issue-deck/local-repos.conf

# 4. 申告に載ることを確認する
~/apps/issue-deck/scripts/subpc-dispatch-poller.sh --announce-only
```

**`git clone git@github.com:...`（SSH形式）では通らない。** サブPCの`~/.ssh/`には`authorized_keys`と
`known_hosts`しか無く、GitHubへ出ていくための秘密鍵が無い。既存リポジトリのremoteもすべてHTTPSで、
認証は`gh auth`のトークンが持っている。**秘密鍵を置いてSSH形式に揃える案は採らない**——トークンで
足りており、鍵を1つ増やすと管理対象が増えるだけのため。

対応表を追記しただけなら**pollerの再起動は要らない**。`local_repo_list_runnable()`は申告のたびに
`local-repos.conf`を読み直す（再起動が要るのは後述の、issue-deck側スクリプトを差し替えたとき）。

ポート帯だけはissue-deck側の[scripts/local-repo-ports.conf](../../scripts/local-repo-ports.conf)へ
追記する（1台に複数リポジトリのセッションが常駐するため、帯が重なると衝突する）。**サブPC側の作業より
先に確保しておく。** 載っていないと`local_repo_port_base()`が何も返さず、汎用ランチャーの既定
`3000 + Issue番号`に落ちて、未登録のリポジトリ同士が同じ帯に相乗りする。

### envは既定では置かない

**手順にenvの配置を含めない。** サブPC上で`.env.local`／`.env`を持っているのは`issue-deck`だけで、
他は1つも持っていない（2026-08-14に実測）。汎用ランチャーは既定で開発サーバーを起動せず、envが無ければ
`supply_env_files`は何もしないため、セッションの起動には影響しない。**開発サーバーを動かす必要が出た
セッションでだけ置く。**

置くときも`op inject -i .env.tpl -o .env.local`を機械的に叩かないこと。**`.env.tpl`の位置づけは
リポジトリごとに違う。** `portfolio`のものはデプロイ／CI用の束で、そのまま流し込むとローカル開発が
本番を向く。

```text
NEXT_PUBLIC_SUPABASE_URL=op://apps/Supabase/project-url      # 本番（開発用は dev-project-url）
SSH_PRIVATE_KEY=op://apps/githubaction-sshkey/private_key     # デプロイ用
DEPLOY_PATH=op://apps/portfolio/deploy-path                   # デプロイ用
```

READMEに「1Passwordは本番デプロイ・CIにのみ使用します」と明記されているのはこのため。
`dayspan`・`car-care`はそもそも`.env.tpl`を持たず`.env.local.example`だけで、開発用の値は手で入れる。
**まず対象リポジトリのREADMEで`.env.tpl`が何用かを確かめる。**

### この仕組みを取り込むとき（サブPC側）

```bash
git -C ~/apps/issue-deck pull
systemctl --user restart issue-deck-dispatch-poller.service
```

**スクリプトを差し替えたときはpollerの再起動が要る。** 常駐しているのは`subpc-dispatch-poller.sh`の
プロセスで、bashは実行中のスクリプトファイルを読み進めながら動くため、`git pull`でファイルが
差し替わると走行中のプロセスが壊れうる。再起動すれば新しい判定（＝汎用ランチャーを使う申告）で
動き出す。

**対応表（`local-repos.conf`）への追記だけなら再起動は要らない**——申告のたびに読み直されるため。
再起動が要るのは、この`git pull`のようにissue-deck側のスクリプトが変わったときに限られる。

**pullが要るものと、要らないものがある**（#1438・#1741）。issue-deck側を直したときに、その変更が
サブPCへいつ届くかは**どちらから読まれるファイルか**で決まる。

| 変更したファイル | 読まれ方 | pullが要るか |
| --- | --- | --- |
| `generic-start-issue.sh`・`start-local-session.sh`・それらが`source`する`lib/`・`local-repo-ports.conf` | 本体の作業ツリー（`~/apps/issue-deck/scripts/`） | **要る** |
| `run-issue-session.sh`・`session-notify.sh`・`prompts/` | `origin/develop`の同期コピー（`~/.cache/issue-deck/launcher-scripts/<SHA>/`） | 要らない（マージされた時点で効く） |

ポート帯（`local-repo-ports.conf`）は前者なので、**developへマージしただけでは効かない。**
載っていない間は汎用ランチャーの既定`3000 + Issue番号`が使われる。

### マルチエージェント運用に未対応のリポジトリ

`claude-issue-dispatch.yml`・`issue-labels.yml`を持たないリポジトリでも起動自体はできるが、
**`11.local`ラベルが無ければ付与に失敗し、Project Statusの自動遷移も起きない。** 起動はするが
記録が残らない状態になるので、対応可否は個別に判断する（#1224ではclip-hiveがこれに当たる）。

**#1741で`subpc`・`vps`・`docs`をこの状態のまま載せた。** インフラ設定・共有知識のリポジトリで、
無人実行を入れる予定が無く、**ローカルセッションが唯一の実行経路**になるため。実際に起きることは
次のとおりで、いずれも起動は止まらない。

```text
failed to update https://github.com/guchi-apps/vps/issues/68: '11.local' not found
#68: 警告: ラベル（11.local）の付与に失敗しました。手動で付けてください。
```

- `11.local`の付与は`gh issue edit`が`not found`で落ちる（警告のみ）。**無人実行が無いリポジトリでは
  二重起動の心配も無い**ので、記録が残らないこと以外の実害は無い
- 逆に`00.check-user`は、`AskUserQuestion`のときに**付与エンドポイントが色も説明も無いラベルを
  その場で作ってしまう**（`src/lib/dispatch/check-user-labels.ts`）。理由ラベル（`01.check-*`）は
  リポジトリに定義があるものしか付かないのでガードが効く
- 進捗（Project Status）は、報告API（`POST /api/progress`）が未登録なら`addProjectItem`で追加する
  ため**起動したIssueだけ盤面に載る**。一括同期（`syncProjectStatuses`）は`hasClaudeWorkflow: true`で
  絞るので取り込まれず、非対称が残る

**ラベル体系の整備は対象リポジトリごとのIssueで行う**（`CLAUDE.md`「複数リポジトリに影響する変更は、
リポジトリごとにIssueを分ける」）。載せる側（issue-deck）でやるのはポート帯の確保までにする。

### 共有知識リポジトリ自身のIssueを起動するとき

`guchi-apps/docs`（`~/apps/_docs`）は**全セッションが`--add-dir`で読む共有知識のチェックアウト
そのもの**である。このリポジトリのIssueを素直に起動すると、

- 実装対象の**本体チェックアウトが参照に加わり**、worktreeではなくそちらを直接編集する事故を招く。
  そこは走行中の他セッションが読んでいる共有物で、汚すと横へ波及する
- プロンプトのひな形が「共有知識リポジトリは**読み取り専用**」と書いているため、**指示が自己矛盾する**

そのため、チェックアウト先が共有知識ディレクトリと同一実体のときだけ`--add-dir`を付けず、プロンプトの
「全アプリ共通の共有知識」の節も差し替える（#1741）。

**判定はリポジトリ名ではなくパスの一致（`-ef`）で行う。** 共有知識の置き場は
`ISSUE_DECK_SHARED_CONTEXT_DIR`で差し替えられ、ディレクトリ名（`_docs`）もリポジトリ名（`docs`）と
一致しない。実装は`generic-start-issue.sh`が判定して`ISSUE_DECK_SKIP_SHARED_CONTEXT`をexportし、
`run-issue-session.sh`はその印だけを見る（`build_env_prefix`の受け渡し変数にも入れる——tmuxの中まで
届かないと`--add-dir`が付いてしまう）。

**「編集してはいけない」という禁止事項自体は残す。** 実装対象がこのリポジトリ自身でも、触ってよいのは
worktreeだけで、本体チェックアウト（`~/apps/_docs`）は依然として触ってはいけない。

## 注意点

- **LAN外からでも押せる**（pull型のため。サブPCは外向きHTTPSのみで、inboundは不要）。ただし
  起動したセッションの中身を見る（`tmux attach`）にはLAN内かTailscaleが要る
- 対象リポジトリを一切変更しない方式なので、**リポジトリ固有の知識（ポート帯・envの供給方法）は
  issue-deck側に集まる。** どこに何があるかはこのドキュメントと`scripts/local-repo-ports.conf`が持つ
- ディスク・依存インストールの負荷はリポジトリ数に比例する。worktreeは自動では消えないため、
  溜まったら各リポジトリの`~/apps/<repo>-worktrees`を掃除する
  （`scripts/cleanup-worktrees.sh`はissue-deck専用。他リポジトリ向けの掃除は未対応）

## 関連

- [local-quick-start.md](local-quick-start.md) メインPCのワンクリック起動とローカル起動プロトコル
- [subpc-dispatch.md](subpc-dispatch.md) pull型のジョブキューと申告
- [#1073](https://github.com/guchi-apps/issue-deck/issues/1073) ローカル起動プロトコル（マーカー行）
- [#1178](https://github.com/guchi-apps/issue-deck/issues/1178) ヘッドレス（tmux）で起動する
