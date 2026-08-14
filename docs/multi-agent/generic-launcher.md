# 汎用ランチャー（対象リポジトリに何も置かずに起動する）

サブPC上で、issue-deck以外のリポジトリのIssueについてもClaude Codeセッションを起動する仕組み（#1224）。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

> **「このPC」（`issuedeck://`経由のWSL起動）はこの仕組みの対象外。** そちらは従来どおり、対象
> リポジトリが契約適合の`scripts/start-issue.sh`を持っている場合だけ起動できる
> （[local-quick-start.md](local-quick-start.md)）。広げたのはサブPCからの起動だけ。

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
worktree作成より**先**に行う。宛先と鍵（`APP_BASE_URL`・`PROGRESS_REPORT_SECRET`）は
issue-deck本体チェックアウトの`.env.local`から読むが、**サブPCのチェックアウトはアプリを動かす
ためのものではないため、`.env.local`の値が空のことがある**（実際に空だった）。その場合は
`~/.config/issue-deck/dispatch.env`を見る（[deploy/subpc/dispatch.env.example](../../deploy/subpc/dispatch.env.example)）。

どちらにも無ければ報告をスキップして起動は続ける。**起動できないより、記録が遅れる方が軽い。**

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

## 開発サーバーは既定で起動しない

サブPCは2C/4T（同時実行の既定が2なのもこの実測による・#1177）で、**リポジトリ数ぶんのdevサーバーを
常駐させる前提が置けない。** ポートはenvファイルへ書き込むので、画面確認が必要なセッションだけ
中で起動する（生成されるプロンプトにも起動コマンドを書いている）。

実装は`run-issue-session.sh`の`ISSUE_DECK_DEV_SERVER=0`。issue-deck自身の経路（`start-issue.sh`）は
これまでどおり起動する。

## 「実行できるリポジトリ」の判定

申告（`POST /api/dispatch/hosts`）に載る条件から、**マーカー行の必須要件を外した**。

| # | 条件 | 変更 |
| --- | --- | --- |
| 1 | `~/.config/issue-deck/local-repos.conf`に記載がある | 変わらず |
| 2 | チェックアウト先のディレクトリが実在する | 変わらず |
| 3 | `scripts/start-issue.sh`が存在する | **不要になった**（汎用ランチャーで起動する） |
| 4 | 宣言している版数が受け口の対応範囲に収まる | **宣言している場合のみ**課す |

汎用ランチャーが配られていない環境（`~/.local/share/issue-deck/`へ複製された受け口）では、
従来どおり3・4を課す。「このPC」経由の起動を広げるのは#1224の範囲外で、`ok`にしてしまうと
押した先で「ランチャーが無い」と言われるだけになるため。

### 画面のゲートは起動先ごとに分ける

| 起動先 | 判定材料 |
| --- | --- |
| このPC | `Repository.hasLocalStartScript`（GitHub上のマーカー行・#1073） |
| サブPC | サブPCの申告（`resolveDispatchTargetRejection`） |

`canStartLocalSession(hasLocalStartScript)`は**「このPC」導線のゲートに限定した**（#1224）。
GitHub上のファイルの有無ではなく、実際にcloneされ起動できるかを申告しているサブPC側の情報の方が
正確なため。マーカー行を持たないリポジトリのIssueでも、サブPCが申告していれば「サブPCで開始」が出る。

## 対象リポジトリを増やす（サブPC側の作業）

対象リポジトリには**何も追加しない。** サブPC側だけで完結する。

```bash
# 1. clone（worktreeの置き場は起動時に ~/apps/<repo>-worktrees が作られる）
git clone git@github.com:guchi-apps/<repo>.git ~/apps/<repo>

# 2. env を置く（1Passwordから。テンプレートは各リポジトリの .env.example 等を参照）
cd ~/apps/<repo> && op inject -i .env.tpl -o .env.local   # リポジトリによって名前が違う

# 3. 依存インストール（初回だけ。worktree側は起動時に毎回入る）
npm ci   # または pnpm install

# 4. 対応表へ追記
$EDITOR ~/.config/issue-deck/local-repos.conf

# 5. 申告に載ることを確認する
~/apps/issue-deck/scripts/subpc-dispatch-poller.sh --announce-only
```

ポート帯だけはissue-deck側の[scripts/local-repo-ports.conf](../../scripts/local-repo-ports.conf)へ
追記する（1台に複数リポジトリのセッションが常駐するため、帯が重なると衝突する）。

### この仕組みを取り込むとき（サブPC側）

```bash
git -C ~/apps/issue-deck pull
systemctl --user restart issue-deck-dispatch-poller.service
```

**pollerの再起動が要る。** 常駐しているのは`subpc-dispatch-poller.sh`のプロセスで、bashは実行中の
スクリプトファイルを読み進めながら動くため、`git pull`でファイルが差し替わると走行中のプロセスが
壊れうる。再起動すれば新しい判定（＝汎用ランチャーを使う申告）で動き出す。

### マルチエージェント運用に未対応のリポジトリ

`claude-issue-dispatch.yml`・`issue-labels.yml`を持たないリポジトリでも起動自体はできるが、
**`11.local`ラベルが無ければ付与に失敗し、Project Statusの自動遷移も起きない。** 起動はするが
記録が残らない状態になるので、対応可否は個別に判断する（#1224ではclip-hiveがこれに当たる）。

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
