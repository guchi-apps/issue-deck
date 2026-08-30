# 個人設定（グローバルルール・個人skill）の同期

メインPC（WSL）とサブPC（`subpc`）で、Claude Codeの`~/.claude/CLAUDE.md`と個人skillを
同じ内容に保つ仕組み（#1190）。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## なぜ必要か

ローカル実装セッションの品質は、次の3つが揃っていることを前提にしている。

| 置くもの | 内容 |
|---|---|
| `~/.claude/CLAUDE.md` | 個人のグローバルルール（回答言語・git運用・依存追加時の確認など） |
| `~/.claude/skills/` | 個人skill（`changelog-ja`・`git-github-ja`・`secrets-1password`等） |
| `~/apps/_docs` | 全アプリ共通の共有知識（[shared-knowledge.md](../shared-knowledge.md)） |

これが揃っていないマシンで動くエージェントは、GitHub Actionsの無人実行と同じ
「グローバルルールが効かない」品質に落ちる（#1176が「移行の意味の半分がここ」としている箇所）。

`~/apps/_docs`はgitリポジトリなので`git pull`で済む。問題は`~/.claude/`配下の2つで、
#1177の時点では**両機に手動コピーしただけ**で同期経路が無かった。片方で更新しても
もう片方に届かず、気づかないまま古いルールで実装が進む。

## 方式：実体を1つにする

個人設定の実体を専用のプライベートリポジトリ`guchi-apps/claude-config`に置き、
両機はそれを`~/apps/claude-config`へcloneして、`~/.claude/`側を**symlink**にする。

```text
~/apps/claude-config/CLAUDE.md   ←── ~/.claude/CLAUDE.md （symlink）
~/apps/claude-config/skills/     ←── ~/.claude/skills    （symlink）
```

コピーを2つ持って同期する形にすると「どちらが新しいか分からない」状態が必ず生まれる。
実体を1つにすれば、その状態自体が起きない。残るのは「commit/pushしたか」「pullしたか」
だけで、これはgitが答えられる。

**「実装はサブPCに寄せるのだから同期は要らないのでは」は成立しない。** メインPCでも
Claude Codeは動き続けるし（skillの執筆自体がメインPCのObsidianで行われている）、
サブPCが落ちているときのフォールバックもある。むしろ「執筆＝メインPC／消費＝サブPC」と
役割が分かれているぶん、片方向に確実に届く経路が要る。

### 採らなかった方式

| 方式 | 採らなかった理由 |
|---|---|
| `guchi-apps/docs`（`~/apps/_docs`）に相乗り | あそこは複数アプリのエージェントが「共有知識」として読む場所。個人設定が混ざると、エージェントがどれを共有知識として扱うか判断できなくなる |
| `guchi-apps/subpc`に相乗り | サブPC固有の構成管理であり、かつ「公開/共有される可能性」を前提に作られている。両機共通の個人ルールの置き場所として役割が合わない |
| `chezmoi`等のdotfiles管理ツール | 同期対象が2つだけなのに、テンプレート・状態管理という新しい概念が増える。必要になってから移行しても遅くない |

### 同期対象に含めないもの

`~/.claude/.credentials.json`（認証情報）・`settings.json`（テーマや通知など機体ごとに
違ってよいもの）・`projects/`・`history.jsonl`・`sessions/`（セッションの実行時状態）。
`subpc`の`setup.sh`が認証情報を扱わない方針なのと揃えている。

## メモリを同期せず「昇格」させる

`projects/`を同期対象から外していることには、もう一段の意味がある。Claude Codeの**メモリ**
（`~/.claude/projects/<プロジェクトのslug>/memory/`）がここに入るため、**メモリは機体ごとに
別々に育つ**（#1400）。CLAUDE.mdと個人skillが両機で同じ実体を指しているのとは対照的で、
サブPCのメモリはメインPCからは見えないし、その逆も見えない。

保存先について非自明な点が1つある。**worktreeのセッションでも、メモリは本体リポジトリのslugへ
保存される。**

```text
セッションのcwd     ~/apps/issue-deck-worktrees/issue-1400
トランスクリプト     ~/.claude/projects/-home-guchi-apps-issue-deck-worktrees-issue-1400/
メモリ              ~/.claude/projects/-home-guchi-apps-issue-deck/memory/   ← 本体リポジトリ側
```

つまり同一機体内では、Issueごとに分かれたworktreeセッションのあいだでメモリが共有される。
「このworktreeだけの事情」をメモリに書くと、無関係な他Issueのセッションにも読まれる。

### 同期しない理由

メモリはClaude Codeが会話の流れの中で自動的に書くもので、**人のレビューを通っていない**。
共有知識（`guchi-apps/docs`）が提案→審査→PR→人のマージという3重のガードを敷いている
（[shared-knowledge.md](../shared-knowledge.md)「9.4 汚染を防ぐための3重のガード」）のに対し、
メモリを機体間で同期すると、片方の誤った学習が無審査でもう片方へ伝播する経路ができてしまう。
同じ知識を扱いながらガードの強さが逆転するため、揃える方向は「メモリを同期する」ではなく
「メモリに留めない」を採る。

あわせて、**GitHub Actionsの無人実行にはメモリが存在しない**（実行のたびに新しい環境で起動する）。
ローカルで`11.local`を外して無人実行へ引き継いだ時点で、メモリに書いた内容は失われる。

### 昇格先

セッション中にメモリへ書いた内容のうち、恒久的に価値があるものは次の分岐で昇格させる。
**共有知識へ格上げすべきかどうかは判定しない**（#2029。判定は`guchi-apps/docs`側の格上げ判定
エージェントが行う）。

| メモリの内容 | 昇格先 |
|---|---|
| 実装・調査で得た知見（このリポジトリの構成に依存するかどうかを問わない） | 実装PRに同梱して`docs/`または`CLAUDE.md`へ書き、**あわせて**同じ内容を`<!-- knowledge-candidate -->`付きの知見メモとして対応Issueへ投稿する（[shared-knowledge.md](../shared-knowledge.md)「9. 共有知識更新フロー」） |
| 個人の作業ルール（回答言語・git運用・確認の取り方など、プロジェクトに依らない） | `~/apps/claude-config/CLAUDE.md`。`~/.claude/`配下はエージェントが書けないため、ユーザーが編集する |
| そのセッション限りの事情（一時的な障害・その場の手順） | 昇格させない。メモリに残すか削除する |

昇格は実装エージェントの自己申告で、機械的な強制力は持たせていない。
[`scripts/prompts/implementation-agent.md`](../../scripts/prompts/implementation-agent.md)と
[`scripts/prompts/generic-implementation-agent.md`](../../scripts/prompts/generic-implementation-agent.md)の
「実装中に得た知見の記録」で促すに留め、投稿されたかどうかの検証はしない。共有知識と同じく
**量より汚染防止を優先する**ため、取りこぼしは許容する。

なお、これらのプロンプトは`scripts/start-issue.sh`・`scripts/generic-start-issue.sh`が
起こしたセッションにしか渡らない。素の`claude`で起こしたセッションはこの分岐を読まないため、
そこまで効かせたい場合は同じ内容を`~/apps/claude-config/CLAUDE.md`へ置く必要がある。

## symlinkの解決

**skill単位のsymlinkは動作を確認済み**（Claude Code v2.1.232）。`~/.claude/skills/<名前>`を
worktree外のディレクトリへのsymlinkとして置き、headless（`claude -p`）で新しいセッションを
起こすと、その skill が description ごと認識される。

`install.sh`は既定でディレクトリごと（`~/.claude/skills`自体をsymlinkに）張る。
skillを増やしても張り直しが要らないため。ディレクトリのsymlinkが辿られなくなった場合の
フォールバックとして`--per-skill`（skill単位で張る）を持たせてある。

反映されるのは**新しいセッションから**で、既に開いているセッションには効かない。

## 取り残しの検知

`~/apps/claude-config/check-sync.sh`が、次を確認する。

- コミットしていない変更がある
- upstreamが無い（GitHubへ一度もpushしていない＝もう一方のマシンからcloneできない）
- pushしていないコミットがある（もう一方のマシンに届いていない）
- originより遅れている（もう一方のマシンの更新を取り込んでいない）
- `~/.claude/`側のsymlinkが張られていない

対象は`claude-config`と`~/apps/_docs`の両方。サブPCの`_docs`が古いままになるリスクは
同じ性質のため、まとめて見る。

### issue-deck側から呼ぶ

[`scripts/lib/personal-config-sync.sh`](../../scripts/lib/personal-config-sync.sh)が
`warn_personal_config_drift`を提供し、[`scripts/start-issue.sh`](../../scripts/start-issue.sh)と
[`scripts/generic-start-issue.sh`](../../scripts/generic-start-issue.sh)が起動前チェックの
最後に呼ぶ。

**実装セッションを起こす瞬間に出すのは、そこがルールが実際に読まれる直前であり、かつ
メインPC・サブPCに共通の唯一の入口だから。** 検知する仕組みを別に常駐させると、
それ自体が動いているかを別途気にすることになる。

守っている前提は2つ。

- **起動を止めない。** 同期の遅れは「気づけないこと」が問題であって、実装を止めるほどのものではない
- **無い環境では黙って素通りする。** `~/apps/claude-config/check-sync.sh`が無いマシン
  （セットアップ前・GitHub Actions）では何も出力しない。パスは`ISSUE_DECK_PERSONAL_CONFIG_DIR`で
  上書きでき、`ISSUE_DECK_SKIP_CONFIG_SYNC_CHECK=1`で無効にできる。`git fetch`を含むため
  `timeout 15`を付けており、ネットワークが不安定な場所でも起動が待たされない

## セットアップ

### 0. リポジトリを作る（最初の1台で1回だけ）

`~/apps/claude-config`をローカルに作っただけでは、もう一方のマシンからは見えない。
**GitHubへ作成してpushするまでが「1台目のセットアップ」**で、これが済むまで2台目は
`git clone`から着手できない。

```bash
gh repo create guchi-apps/claude-config --private --source ~/apps/claude-config --push
```

作成済みかどうかは`check-sync.sh`が答える。`upstream が設定されていません`と出ている
あいだは、まだGitHubへ届いていない（＝2台目のセットアップに進めない）状態。

> `gh repo create`はローカルのClaude Codeセッションでは権限分類に拒否されるため、
> エージェントには代行できない。ユーザー自身が実行する（#1252）。

### 1. 各マシンへ適用する（マシンごとに1回だけ）

```bash
git clone https://github.com/guchi-apps/claude-config.git ~/apps/claude-config
cd ~/apps/claude-config
./install.sh
```

1台目（既に`~/apps/claude-config`がある側）は`git clone`を飛ばして`./install.sh`だけでよい。

`install.sh`は既存の`~/.claude/CLAUDE.md`・`~/.claude/skills/`を
`~/.claude-config-backups/<日時>/`へ退避してからsymlinkを張る。既存の内容がリポジトリと
違う場合は**中断する**（そのマシンにしか無い編集を、古い内容のsymlinkで上書きしないため）。

`~/.claude/`配下の書き換えもエージェントには代行できない（同じく権限分類に拒否される）ため、
`install.sh`の実行はどちらのマシンでもユーザー自身が行う。手順をスクリプト1本にまとめて
あるのはこのため。

サブPC側の手順は`guchi-apps/subpc`のREADMEにも記載している。

### セットアップが済んでいないことの検知

`check-sync.sh`は「同期の遅れ」だけでなく「そもそも適用していない」も同じ形で報告する
（`upstream が設定されていません`・`symlink になっていません`）。起動スクリプトから毎回
呼ばれるため、**セットアップを途中で止めたまま忘れる**という失敗の仕方はしない。

実際に#1190では、リポジトリの作成pushとサブPCへの`install.sh`適用が残ったまま完了扱いに
なり、メインPC側の適用（#1252）が`git clone`の時点で着手不能になっていた。

## サブPCの構成そのものの反映（#1616）

ここで扱っているのは個人設定（`~/.claude/`）と共有知識（`~/apps/_docs`）の同期で、
**サブPCのOS側の構成（`/etc`・apt・systemd・`~/.bashrc`）は別の経路で反映される。**

`guchi-apps/subpc`（旧`subpc-setup`）の`main`へマージすると、**サブPC上に常駐する
セルフホストランナー**が`scripts/setup-apply.sh`を実行して実機へ反映する。VPSのように
GitHub ActionsからSSHで入る形を採れないのは、サブPCがOSの`sshd`を無効化して
Tailscale SSHへ一本化しており、公開IPも持たないため（[subpc-dispatch.md](subpc-dispatch.md)の
「なぜpull型なのか」と同じ制約）。`netplan`のapplyと再起動だけは自動化していない。

**`~/apps/issue-deck`（本体の作業ツリー）はこの経路の対象ではない。** サブPCのpollerと
起動スクリプトは本体の作業ツリーから動くが、それを`origin/develop`へ追従させる仕組みは
まだ無い（現状の手当ては#1274の警告と、セッション側だけ同期コピーから読む#1438まで）。

## claude-config のIssueをどう実装するか（#1988）

`guchi-apps/claude-config`（この個人設定の実体）にもIssueが立つ
（最初の実例は guchi-apps/claude-config#1）。**実行経路はサブPCのローカルセッションだけ**で、
無人実行（`claude-issue-dispatch.yml`）は入れない——個人設定は`~/.claude/`へsymlinkで直結している
資産で、GitHub Actionsの実行環境には存在しないため、そこで実装させる意味が薄い。`subpc`・`vps`・
`docs`と同じ枠として扱う（[../supported-repositories.md](../supported-repositories.md)の
「`claude-config`（個人設定）」に実測と判断がある）。

この運用で押さえておく点は3つ。

- **`main`直行になる。** `develop`を持たないので、PRは`issue-<番号>` → `main`。
  `main`のブランチ保護は入れておらず、マージするのは人だけ
- **進捗は当初`Implementation`で止まっていたが、guchi-apps/claude-config#2で解消した。**
  `issue-labels.yml`が無いあいだはマージしても盤面の「実行中」に残り、手で`Done`にして
  closeしていた。現在は`main`宛PRのマージで`Done`＋closeまで自動で進む
- **マージしただけでは実機に反映されない。** `~/.claude/CLAUDE.md`・`~/.claude/skills`は
  本体チェックアウトへのsymlinkなので、両機で`git pull`するまで効かない。取り残しは上記
  「取り残しの検知」の`check-sync.sh`が拾う

### リポジトリ固有の運用ルールを`CLAUDE.md`へ書かない

`~/apps/claude-config/CLAUDE.md`は**個人グローバルルールの実体そのもの**なので、
worktreeで開いたセッションではプロジェクト指示として読まれ、同時に`~/.claude/CLAUDE.md`
（本体チェックアウトへのsymlink）としてもグローバルルールに載る。**同じ内容が2枠に入る。**

内容が同じなので判断は壊れないが、**リポジトリ固有の運用ルールを書く場所としては使えない。**
ブランチ運用やPRの宛先をここへ書くと、全マシン・全セッションのグローバルルールになる。
残すなら`README.md`側にする（`README.md`はセッションへ自動で読み込まれない）。
`subpc`・`vps`・`docs`が`CLAUDE.md`に自リポジトリ向けの節を持っているのと、ここだけ扱いが違う。

## 関連

- [ブランチ・worktree運用とエージェントの役割](branching.md) 共有知識層の位置づけ
- [shared-knowledge.md](../shared-knowledge.md) `~/apps/_docs`（全アプリ共通の共有知識）の設計
- `guchi-apps/claude-config` 個人設定の実体
- `guchi-apps/subpc` サブPCの構成管理（`main`へのマージで実機へ自動反映される）
