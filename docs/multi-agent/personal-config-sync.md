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
| `guchi-apps/subpc-setup`に相乗り | サブPC固有の構成管理であり、かつ「公開/共有される可能性」を前提に作られている。両機共通の個人ルールの置き場所として役割が合わない |
| `chezmoi`等のdotfiles管理ツール | 同期対象が2つだけなのに、テンプレート・状態管理という新しい概念が増える。必要になってから移行しても遅くない |

### 同期対象に含めないもの

`~/.claude/.credentials.json`（認証情報）・`settings.json`（テーマや通知など機体ごとに
違ってよいもの）・`projects/`・`history.jsonl`・`sessions/`（セッションの実行時状態）。
`subpc-setup`の`setup.sh`が認証情報を扱わない方針なのと揃えている。

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

サブPC側の手順は`guchi-apps/subpc-setup`のREADMEにも記載している。

### セットアップが済んでいないことの検知

`check-sync.sh`は「同期の遅れ」だけでなく「そもそも適用していない」も同じ形で報告する
（`upstream が設定されていません`・`symlink になっていません`）。起動スクリプトから毎回
呼ばれるため、**セットアップを途中で止めたまま忘れる**という失敗の仕方はしない。

実際に#1190では、リポジトリの作成pushとサブPCへの`install.sh`適用が残ったまま完了扱いに
なり、メインPC側の適用（#1252）が`git clone`の時点で着手不能になっていた。

## 関連

- [ブランチ・worktree運用とエージェントの役割](branching.md) 共有知識層の位置づけ
- [shared-knowledge.md](../shared-knowledge.md) `~/apps/_docs`（全アプリ共通の共有知識）の設計
- `guchi-apps/claude-config` 個人設定の実体
- `guchi-apps/subpc-setup` サブPCの構成管理
