# ブランチ・worktree運用とエージェントの役割

Issueごとにブランチ・worktree・Claude Codeセッションを分離する運用と、各エージェントの責務。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## ブランチ・worktree運用

- ブランチ名はラベルによる接頭辞分けをせず、単純に `issue-<Issue番号>`（例: `issue-123`）とする。
- worktreeは本体リポジトリの外、`~/apps/issue-deck-worktrees/<ブランチ名>/` に作成する。本体 `~/apps/issue-deck` は常にレビュー・統合エージェント用の `develop` 最新チェックアウトとして空けておく。
- worktree作成後に必要な準備:
  - `.env.local` を本体からコピーする（`.gitignore`対象でworktreeに複製されないため。symlinkではなくコピーとし、将来worktreeごとに値を変える余地を残す）
    - コピーは新規作成時の1回だけで、その後は追随しない。そのため**既存worktreeの再開時は、本体の`.env.local`にあってworktree側に無いキーだけを値ごと追記する**（#1099）。既存キーの値は書き換えないので、ローカルで書き換えている場合も壊れない。`PORT`はworktreeごとに採番するため対象外。worktree側でコメントアウトしているキーは「意図的に無効化している」とみなして復活させない。追記したキーは**キー名のみ**を表示する（値はログに出さない）
  - `pnpm install`（pnpmのcontent-addressableストアにより高速）
  - `postinstall` で `prisma generate` が走る
- 開発用MySQL DBはworktree間で共有する（Issueごとに新規DBは作らない）。通常のIssueはスキーマ変更を伴わない前提。マイグレーションを伴うIssueは下記「自動マージ不可カテゴリ」の対象として扱う。
- 開発サーバー（`pnpm dev`）のポートは`start-issue.sh`/`.ps1`が`.env.local`に`PORT=4000 + Issue番号`を自動設定する（例: issue-46 → 4046）。複数Issueのworktreeで同時に`pnpm dev`を起動しても衝突せず、developへマージする前に人間がブラウザ（`http://localhost:<ポート>`）で直接画面を確認できる。実装エージェントは画面に関わる変更のPRで、このURLを「確認方法」に記載する。
- ポート設定に加えて、開発サーバーの起動・停止も自動化されている。`start-issue.sh`は`prepare_issue()`完了後、最終的に`exec claude ...`でClaude CLIへプロセス置き換えするのではなく、新規`scripts/run-issue-session.sh`（Issue番号・devポート・プロンプトファイルパスを引数に取るラッパー）を`exec`する。このラッパーが`pnpm dev`をバックグラウンド起動（ログ・PIDは`$ISSUE_DECK_WORKTREE_BASE/.dev-servers/issue-<n>.{log,pid}`）したうえで、`claude`を（execせず）フォアグラウンドの子プロセスとして実行し、`trap ... EXIT HUP TERM`でclaude終了時に開発サーバーのプロセスグループを停止する。`pnpm dev`のstdinは`/dev/null`に向ける（#1094）。バックグラウンドジョブのまま端末を読む子プロセスがいると`SIGTTIN`でプロセスグループごと停止し、devサーバーが起動しないまま無反応になるため。Ctrl+C（`INT`）は意図的にtrapしない（1回の押下は現在の処理の中断であることが多く、devサーバーまで止めると過剰停止になるため）。`kill -9`やWSLごとのクラッシュ等、trapで捕捉できない強制終了時はPIDファイルが残るため、`$ISSUE_DECK_WORKTREE_BASE/.dev-servers/issue-<n>.pid`のPIDを手動で`kill`するのがフォールバック手段になる。
- `start-issue.sh`はWSLのターミナルから直接叩くほか、issue-deckの画面の「ローカルで開始」からワンクリックで起動できる（`issuedeck://`プロトコル → `scripts/start-local-session.sh` 経由。#1049）。詳細は[local-quick-start.md](local-quick-start.md)。
- VSCodeのClaude Codeタブを横に並べて複数Issueを並行で進める場合は、タブ内で`/issue <番号>`（`.claude/commands/issue.md`）を使う。`start-issue.sh --prepare-only`でworktreeだけを用意し、そのセッションがそのまま実装に入る（#1049）。**本体チェックアウトは全タブで共有されるため、そこでのブランチ切り替えは他タブのセッションを巻き込む。**
- `start-issue.sh`はworktree準備時に`scripts/setup-lan-access.sh`を呼び、Windows側のポートフォワーディング（`netsh interface portproxy`）とファイアウォール許可を自動設定したうえで、`http://<WSL IP>.sslip.io:<ポート>`をあわせて提示する（同一LAN上のスマホ等、`localhost`が使えない別端末からの確認用。詳細はsslip-io-lan-devスキル参照）。WSLのIPはWSL再起動のたびに変わるため、`scripts/dev.sh`経由の通常起動時も含め、devサーバー起動のたびに再設定する。Windowsの管理者権限が必要なためUACダイアログが表示される。ただしワンクリック起動（`start-local-session.sh`）から始まったセッションでは、UAC待ちから戻らずタブが固まる／devサーバーが起動しないため、`ISSUE_DECK_SKIP_LAN_SETUP=1`により`start-issue.sh`・`dev.sh`の双方でスキップする（#1076・#1094。詳細は[local-quick-start.md](local-quick-start.md)）。`next.config.ts`の`allowedDevOrigins`は個別IPではなく`*.sslip.io`（ワイルドカード）を許可しており、WSLのIPが変わってもコード変更不要。
- worktreeは自動では消えないため、マージ済みのものは`scripts/cleanup-worktrees.sh`で掃除する（#1100）。「PRがマージ済み」「未コミットの変更が無い」「ブランチのコミットがすべて`origin/develop`に入っている」「そのIssueのセッション・開発サーバーが動いていない」「実行中のworktreeでない」を**すべて**満たすものだけを対象とし、削除対象を一覧表示して確認を取ってから、worktree・ローカルブランチ・そのIssue用の生成物（起動用プロンプト、devサーバーのログ・PIDファイル）を消す。`--dry-run`で判定だけ、`--yes`で確認省略、`--issue <番号>`で対象を1件に絞れる。非対話実行で`--yes`が無い場合は表示のみで終了する。リモートブランチには触れない。**worktreeを消す直前に、そのIssueのポートを掴んでいる開発サーバーを止める**（#1524）。上の判定はPIDファイルと`run-issue-session.sh`のプロセスしか見ないため、エージェントが手で起こし直した`pnpm dev`はすり抜け、消えたworktreeを指したまま走り続ける。`--recreate`でworktreeを作り直す`start-issue.sh`も同じ停止を行う。
- 掃除で解放されるディスクは、`du -sh`で見えるworktreeのサイズ（1つあたり1GB前後）よりかなり小さい。pnpmは`node_modules`の実体をストアへのハードリンクとして持つため（実測でリンク数18）、worktree単位の`du`は他worktreeと共有している分まで数える。2026-08-11に6件（`du`合計6.7GB）を削除したときの`df`の変化は約1GBだった。掃除コマンドはこの旨を注記付きで表示する。
- 掃除を`run-issue-session.sh`のtrap（セッション終了時）で自動化はしない。「あとで見返したい」「PRにコメントが付いたら直す」という用途を壊すため、明示的に走らせるコマンドにとどめている。
- 放置すると効くのはディスクだけではない。#1076でworktreeを再利用するようにしたため、**マージ済みIssueで再開すると、developから分岐し直されていない古いブランチのまま作業を始めてしまう**（以前は「既に存在します」で止まっていた）。そのため`start-issue.sh`は再開時にマージ済みPRの有無を確認し、見つかったら警告する。詳細は[local-quick-start.md](local-quick-start.md)の「マージ済みIssueで再開したときの扱い」。

## マージ済みのリモートブランチを掃除する（#1478）

上の`cleanup-worktrees.sh`が扱うのは**ローカル**のworktreeとブランチだけで、GitHub上のリモート
ブランチには触れない。そちらは長く放置されており、2026-08-15時点で`guchi-apps/issue-deck`に
**670ブランチ**（うち`issue-*`が大半）が残っていた。原因は2つで、リポジトリ設定
`delete_branch_on_merge`が無効だったことと、掃除する仕組みがどこにも無かったこと。

### 今後のぶんは自動で消える

`delete_branch_on_merge`を`guchi-apps`の非fork・非archiveリポジトリ**26件すべて**で有効にした。
PRをマージした時点でheadブランチがGitHub上から自動的に消える。設定の適用・再確認は
`scripts/set-delete-branch-on-merge.sh`（既定はdry-run、`--apply`で適用）で行う。

**ローカルのworktree運用には影響しない。** 消えるのはリモートのブランチだけで、worktreeも
ローカルブランチもそのまま残る。`scripts/lib/worktree-status.sh`は`origin/develop`にコミットが
含まれるかだけを見ており、リモート作業ブランチの存在を判定材料にしていない。

### 既に残っているぶんは`cleanup-merged-branches.sh`で消す

```bash
scripts/cleanup-merged-branches.sh                 # 既定。issue-deckをdry-run
scripts/cleanup-merged-branches.sh --all-repos     # 非forkの全リポジトリをdry-run
scripts/cleanup-merged-branches.sh --apply --yes   # 実際に削除する
```

次を**すべて**満たすブランチだけを削除する。1つでも欠けたら残す。

1. 名前が保護対象でない — `main`／`develop`／`master`／デフォルトブランチ／`screenshots`
   （#255のorphanブランチ）／GitHub上で`protected: true`
2. そのブランチをheadとするPRが1件以上あり、最新のPRがマージ済み
3. openなPRのheadでない
4. **ブランチの現在のSHAが、そのマージ済みPRの`head.sha`と一致する**
5. `issue-<番号>`形式なら、そのIssueがopenでない（`--include-open-issues`で解除）

**`develop`はdevelop→mainのPRのheadなので、条件2〜4だけでは削除対象に入る。** 条件1の名前に
よる保護が最後の砦になっている。ここを緩めないこと。

条件4がこの判定の要で、「マージ後に同名ブランチで作業を再開した」ものをAPI 2本
（branches／pulls）だけで機械的に外せる。issue-deckの実測では、670本のうち647本が削除対象、
残る23本の内訳は保護3・PR無し5・未マージ4・マージ後に進行4・対応Issueがopen 8だった。

削除は取り消せないため、dry-run既定・実行前の件数表示と確認プロンプト（`--yes`で省略）に加えて、
削除したブランチ名とSHAをTSVで残す（既定`~/.local/state/issue-deck/deleted-branches.tsv`）。
消したあとでも次で戻せる。

```bash
git push origin <SHA>:refs/heads/<ブランチ名>
```

### ブランチを消すと無人実行のmode判定が変わる

`reusable-issue-dispatch.yml`のmode判定はリモートブランチの存在（`BRANCH_EXISTS`）を見ており、
**「ブランチがある＋develop向けPRがOPENでない（＝マージ済み）」ときは`mode=skip`で何もしない。**
ブランチが消えるとこの分岐を抜け、`develop`から新規ブランチを切って実装が始まる。

closedなIssueは手前の`ISSUE_CLOSED`判定で弾かれるので影響を受けないが、**openなIssue
（`Develop`・`Release`待ちなど）は挙動が変わる**——マージ済みIssueへの`@claude`コメントが、
今までの「無反応」から「新しいブランチでの実装開始」になる。掃除スクリプトが条件5で
open Issueのブランチを既定から外しているのはこのためだが、`delete_branch_on_merge`を
有効にした以上、今後マージするぶんはこの状態が常時発生する。

## セッション中に作った新しいIssueは、そのセッションで実施しない（#1316）

作業中に別件のIssueを起票すること自体は想定どおり（[labels.md](labels.md)の分割・関連事項の起票・
`71.manual-step`）。ただし**起票したIssueをそのまま今のセッションで実装してはいけない。**
「1 Issue = 1ブランチ = 1 worktree = 1セッション」は運用上の推奨ではなく、進捗・二重起動防止・
回収の判定がすべてその対応を前提に組まれているため、崩すと静かに壊れる。

| 仕組み | 何からIssueを特定しているか | 実装 |
| --- | --- | --- |
| 画面のセッション状態・実行先 | tmuxセッション名 `<リポジトリ名>-issue-<番号>` | `parseSessionName`（`src/lib/dispatch/session-state.ts`）・`src/lib/dispatch/issue-session.ts`・`issue-execution-target.ts` |
| 無人実行の停止（二重起動防止） | Issueに付いた`11.local`ラベル | `claude-issue-dispatch.yml`（後述「ローカル実行と無人実行の二重起動を防ぐ」） |
| 進捗（`Implementation`→`Develop PR`→`Develop`→`Done`とclose） | **ブランチ名`issue-<番号>`だけ** | `.github/workflows/reusable-issue-labels.yml`（`$GITHUB_REF_NAME` / PRの`head.ref`を正規表現で見る） |
| セッション・worktreeの回収 | セッション名・ブランチ名・そのIssueのPR | `scripts/reap-sessions.sh`・`scripts/cleanup-worktrees.sh` |

どれもIssue番号を**起動時に渡された1件**から取っており、セッションの中で実際に何を実装したかは
見ていない。そのため#Aのセッションで#Bを実装すると、次が同時に起きる。

- #Bは「ローカルで起動している」と判定されない。画面のセッション欄にも実行先にも何も出ず、
  `reap-sessions.sh`の保護対象にもならない
- #Bに`11.local`が付かないため、`@claude`コメント・`00.check-user`の除去・画面の「実装を開始」を
  きっかけに**無人実行が別に走りうる**。同じ変更を2か所で実装する事故（#905と同じ形）に戻る
- 変更が乗るのはブランチ`issue-A`なので、進捗が進むのもcloseされるのも#Aだけ。#Bは`Ready`のまま
  残り、コードが本番へ出た後もカンバン上は未着手に見える（PR本文に`#B`と書いても遷移はしない）

実施するなら、その新規Issue用に別セッションを起こす（`scripts/start-issue.sh <番号>`、または
画面の「ローカルで開始」）。今のセッションでやってよいのは**起票まで**。

- `71.manual-step`（人の手作業）・`70.confirm`（やるかどうか未決）で起票したものは、そもそも
  実装フローに乗せない。起票して終わりでよい
- 元Issueのスコープに収まる変更なら、新規Issueを立てずそのまま今のブランチで実装する。
  「別Issueとして起票するか」と「別ブランチで実装するか」は同じ一つの判断で、片方だけを分けない
- 誤って今のセッションで別Issueの実装を始めてしまった場合は、コミットを別ブランチへ移すか、
  その変更を元Issueのスコープとして引き取り（PR本文にその旨を書く）、新規Issue側には
  「#Aで実施済み」とコメントして手動でcloseする。**ブランチ名と実施したIssueの対応が崩れたまま
  進めない。** 崩れていることに気付けるのはこの時点だけで、以降は「進捗が進まないIssue」としてしか
  現れない

## エージェントの役割

役ごとの責務・禁止事項はこの節が一次情報源。ただし**役の一覧だけでは表せない切り口**として、
「どの瞬間に誰が何を検証するか（関門）」と「判断を伴わない計測をどこに置くか（計器）」の整理を
[関門と計器](gates.md)に置いている。監視・計画のレビュー・並行セッション同士の衝突を扱うときは
そちらも読む。**監督のための役を新設しない**判断とその根拠もそこにある（#1200）。

### 実装エージェント

Issueごとに独立したClaude Codeセッションとして起動する。

責務:
- GitHub Issueの内容を取得する。着手（進捗を`Implementation`へ進める）は`scripts/start-issue.sh`が起動時に報告済み（#1096・#1010）
- 最新の`develop`からIssue専用ブランチ（`issue-<番号>`）を作成する
- Git worktreeで作業フォルダを分離する
- `21.plan-required`ラベルが付いていれば、実装前にPlan modeで計画を提示し承認を得る
- Issueの要件を実装する
- テスト・Lint・型チェック・ビルドを実行する
- 変更をコミットしてpushする
- `develop`向けPull Requestを作成する（本文に対応Issue・実装内容・テスト内容・確認方法・注意点を記載。developマージ時点ではissueをcloseしない運用のため、`closes #番号`/`fixes #番号`は使わず`#番号`のみ記載する）
- PR作成をトリガーとした`Implementation`→`Develop PR`の遷移（ワークフローが自動で報告する）
- 全アプリ共通の共有知識（`.shared-context/`）を必要な範囲で参照する
- 実装中に得た知見を、アプリ固有なら`docs/`へ同梱し、全アプリ共通と判断したものは対応Issueへ「追加提案」コメントとして投稿する（共有知識リポジトリ自体は編集しない。[docs/shared-knowledge.md](../shared-knowledge.md)参照）

禁止事項:
- `main`/`develop`への直接コミット・push
- 他Issueのブランチ・worktreeの編集
- 不要なforce push
- 自分が作成したPull Requestの自己マージ
- 共有知識リポジトリ（`.shared-context/`・ローカルの`~/apps/_docs`）の編集・コミット

### レビュー・統合エージェント

レビュー・統合専用のClaude Codeセッションを別に用意する。

責務:
- `gh pr list --base develop` で未処理PRの一覧を確認する（複数ある場合は1件ずつ処理し、develop最新との競合・CI結果・他PRとの依存関係を都度確認する）
- 対応Issueの要件充足、Issue外変更の混入有無、コード品質・セキュリティ、CI結果を確認する
- 「自動マージ不可カテゴリ」に該当する変更を検知したら`00.check-user`を付与し、マージせずユーザーの確認を待つ
- 問題がなければ`develop`へマージし、マージ後`develop`上で再テストする。対応Issueの`Develop PR`→`Develop`はPRマージをトリガーにワークフローが報告する（issueはcloseしない）
- 実装エージェントが投稿した共有知識への追加提案を、再利用性・正確性・重複・恒久性の4観点で審査し、承認/却下のマーカー付きコメントを投稿する（[docs/shared-knowledge.md](../shared-knowledge.md)参照）

禁止事項:
- `main`への直接マージ・push
- 共有知識リポジトリの編集・コミット（反映は`shared-knowledge-propose.yml`がPRを作成し、人間がマージする）

## 全アプリ共通の共有知識層（shared context）

GitHub Actions上の実行はチェックアウトしたワークツリーしか参照できないため、個人環境の
グローバル`CLAUDE.md`・スキルは読み込まれない。その結果、全アプリ共通のルール（Git/GitHub運用、
Actions上でClaude Codeを動かす際の知見、共通コーディング方針、デプロイ方針など）を各リポジトリの
`CLAUDE.md`とワークフローのプロンプトへ手で複製することになり、複製先が静かにずれていく。

これを解消するため、共通知識は共有知識リポジトリ`guchi-apps/docs`で一元管理し、各ワークフローが
実行時に`.shared-context/`へcheckoutして読む構成にしている。あわせて、実装中に得た知見を
「アプリ固有＝対象リポジトリの`docs/`」「全アプリ共通＝提案 → レビュー審査 → 反映PR → 人間の
マージ」に振り分ける循環を用意し、セッションではなくGit管理されたドキュメントとして知見を
引き継げるようにしている。

設計の全体像・提案フォーマット・審査の4観点・共有知識リポジトリ側に必要なファイルは
[docs/shared-knowledge.md](../shared-knowledge.md)を参照。他リポジトリへ導入する際の手順は
[docs/cross-repo-setup-guide.md](../cross-repo-setup-guide.md)の「10. 共有知識リポジトリの参照設定」を参照。

## ローカル自動化とGitHub Actionsの役割分担

| フェーズ | 実行場所 | 認証 | 想定用途 |
|---|---|---|---|
| ローカル起動（実装・レビュー） | ローカル(WSL)・人間が起動 | ユーザー自身の`gh auth` | 手動起動だが手順を自動化。人間が横で見ている前提 |
| GitHub Actions | GitHub Actions | `CLAUDE_CODE_OAUTH_TOKEN`（専用） | 無人実行。人間不在でも安全に倒せる設計が必須 |

ローカル実行はユーザー自身のGitHub認証で動くため、「developへの直接push禁止」はGitHubのbranch protectionでは技術的に強制できない（bypassしても同じアカウントになるため）。この段階ではCLAUDE.md・プロンプト内の運用ルールとして守らせる。GitHub Actionsでは専用トークンという別IDが使えるため、branch protectionのbypass listを人間アカウントのみにする設計が意味を持つ。

### ローカル実行と無人実行の二重起動を防ぐ（`11.local`）

同じIssueをローカルセッションと`claude-issue-dispatch.yml`（無人実行）が同時に進めてしまう事故が起きうる（#905）。原因は、無人実行が「計画が承認された」と判断するシグナルが`00.check-user`ラベルの除去である一方、ローカルセッションも承認を受けてラベルを次段階へ進める際に同じ操作を行うため、両者をイベントから区別できないことにある。#905では、ローカル側がPRを作成している裏で無人実行が計画フェーズを最初からやり直し、`21.plan-required`・`00.check-user`と進捗の`Planning`／`Develop PR`が食い違う矛盾状態になった。

これを二段構えで防ぐ（#919）。

1. **`issues/unlabeled`経路のガード**: `00.check-user`の除去イベントを受けた時点で進捗が`Implementation`または`Develop PR`の場合、そのIssueは別経路で着手済み・PR作成済みなので`mode=skip`とする。進捗はissue-deckの問い合わせAPI（`GET /api/progress`）から引く（#1010でラベル判定から置き換えた）。
   `Planning`はこの判定に含めない。無人実行の計画提示ステップが報告した`Planning`は実装着手時まで変わらず、正規の承認時点の状態が「`Planning` + `00.check-user` + `21.plan-required`」になるため、含めると本来の承認経路が動かなくなる。
2. **`11.local`ラベル**: 付いている間は、トリガー経路によらず`mode=skip`とする（読み取り専用の`mode=ask`だけは例外として通す）。1のガードは操作の順序によってはすり抜ける（ローカル側が進捗を`Implementation`へ進める前に`00.check-user`を外した場合など）ため、人間が明示的に立てられる停止フラグを併せて用意する。
   `@claude`コメント経由でスキップした場合は、無言で終わらせず「`11.local`が付いているため無人実行では対応しない」旨をIssueへ返信する。
   付与は人間の手だけに頼らず、ローカルセッションの起動経路が自動で行う。画面の「ローカルで開始」ボタンは起動前に、`scripts/start-issue.sh`は起動時（`prepare_issue`）に付ける。ターミナルから`start-issue.sh`を直接叩いた場合に何も付かず二重起動を止めるものが無かったのを、後者で塞いだ（#1097）。詳細は[local-quick-start.md](local-quick-start.md)「起動時のラベル付与」。
   **外すのは付けた側の責任**で、自動では外れない。ローカルでの作業を終えてPRを無人実行側へ引き継ぐ時点で外す（付いている間は追加対応・レビュー指摘への対応も無人実行では動かない）。
   順番待ちの間に`11.local`が付いた場合も、`dispatch`ジョブ冒頭の陳腐化チェックで検知して中止する。

`11.local`は`0x.`始まりではないため、issue-deck画面上は進捗ステップ（`WorkflowStepBadge`）ではなく通常のラベルとして表示・編集できる（`src/lib/issue-status.ts`の`isProgressLabel`）。あわせて番号帯が重ならないよう、優先度ラベルを`80.Priority: High`・`89.Priority: low`へリネームした。

## ブランチ保護ルール案

- **`main`**: 組織標準（`_docs/guides/github-repo-setup.md` §5）どおり設定する。Require pull request before merging、Required status checks=`lint-and-build`（`.github/workflows/ci.yml`のジョブ名）、Restrict updates、bypass=自分のアカウント（For pull requests only）。**現状（2026年時点）未設定のため要設定。** 実際の設定はGitHub Web UIで行う（workflowでは自動化しない）。
- **`develop`**: Phase4で`required_status_checks`（`lint-and-build`）のみを設定した（`gh api PUT repos/{owner}/{repo}/branches/develop/protection`、`required_pull_request_reviews`・`restrictions`は`null`のまま）。これは`gh pr merge --auto`がCIの完了を待たずに即マージしてしまうのを防ぐための最小構成で、直接pushやApprove必須化は行っていない。「Require pull request before merging」＋bypass=人間アカウントのみへの本格的な制限は、影響範囲が大きく本Issueの完了条件にも必須ではないため見送った。GitHub Actions専用トークン（`github.token`、Phase3/4で導入済み）を使えば技術的には設定可能なので、必要になった時点で改めて検討する。
