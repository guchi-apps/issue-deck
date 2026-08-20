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
- worktreeは`scripts/cleanup-worktrees.sh`で掃除する（#1100）。**サブPCではpollerが1時間ごとに`--yes`付きで呼ぶ**（#1716。下記「掃除を回す起点」）。「未コミットの変更が無い」「`origin/develop`に入っていないコミットが無い」「そのIssueのセッション・開発サーバーが動いていない」「ブランチ`issue-<番号>`を開いていて、gitの作業ツリーとして壊れていない」「実行中のworktreeでない」を**すべて**満たすものだけを対象とし、削除対象を一覧表示して確認を取ってから、worktree・ローカルブランチ・そのIssue用の生成物（起動用プロンプト、devサーバーのログ・PIDファイル）を消す。`--dry-run`で判定だけ、`--yes`で確認省略、`--issue <番号>`で対象を1件に絞れる、`--size`でディスク使用量も測る。非対話実行で`--yes`が無い場合は表示のみで終了する。リモートブランチには触れない。**worktreeを消す直前に、そのIssueのポートを掴んでいる開発サーバーを止める**（#1524）。上の判定はPIDファイルと`run-issue-session.sh`のプロセスしか見ないため、エージェントが手で起こし直した`pnpm dev`はすり抜け、消えたworktreeを指したまま走り続ける。`--recreate`でworktreeを作り直す`start-issue.sh`も同じ停止を行う。
- **「PRがマージ済みか」は削除の判定に使わない**（#1192）。消して失われるものが無いことは「未コミットの変更が無い」「`origin/develop`に入っていないコミットが無い」の2つで決まり、PRの有無はそこへ何も足さない（`develop`に入っていないコミットが1つでもあれば必ず残る）。逆にPRを条件にすると、**PRが最初から作られないworktreeが永久に消せなくなる**。#1177では起動確認だけして実作業を別リポジトリで行った結果、コミット0件・push無し・PR無しのworktreeが「マージ済みPRが無い（作業中）」として保護され続け、手で`git worktree remove --force`を打つことになった（他に「セッションが途中で落ちた」「Issueが取り下げられた」も同じ形になり、無人実行では失敗ジョブのぶんが誰にも気づかれずに溜まる）。マージ済みPRの番号は削除理由の表示にだけ使うので、`gh`が不通・未認証でも掃除は進む。
- それでも残るもの（未コミットの変更がある・未pushのコミットがある）は`--issue <番号> --force`で消す。**`--force`は必ず`--issue`と併用する**（全件に効く強制削除は、判定を1つ間違えただけで並行して走っている他セッションの作業ごと消えるため作らない）。何が失われるか（未コミット何件・未pushのコミット何件）を一覧に出してから消す。ただし**セッション・開発サーバーが動いている／別ブランチを開いている／作業ツリーとして壊れている／実行中のworktree自身は`--force`でも消さない**。これらは「消すと失われる」ではなく「消すと壊れる・他の作業を巻き込む」ためで、代わりに残す一覧へ対処方法（セッションの止め方・`worktree prune`の打ち方など）を1行で出す。
- 掃除で解放されるディスクは、`du -sh`で見えるworktreeのサイズ（1つあたり1GB前後）よりかなり小さい。pnpmは`node_modules`の実体をストアへのハードリンクとして持つため（実測でリンク数18）、worktree単位の`du`は他worktreeと共有している分まで数える。2026-08-11に6件（`du`合計6.7GB）を削除したときの`df`の変化は約1GBだった。**サイズは`--size`を付けたときだけ測る**（#1680）。1件あたり0.2〜0.3秒かかるうえ、上のとおり数値自体が当てにならないため、既定では件数と理由だけを出す。
- **worktreeの数に比例して増える処理を走査ループへ足さない**（#1680）。worktreeは1件ずつ消さない限り溜まり続け、実測で169件まで増えていた。1件ごとに`gh pr list`（1回0.5秒前後のAPI往復）と`du`（同0.2〜0.3秒）を呼んでいた頃は`--dry-run`だけで4分以上かかり、その間**1行も出力しなかった**ため「終わらない」と判断された。対策は3つで、(1)マージ済みPRは`worktree_merged_pr_map`で1回の呼び出しにまとめる、(2)`du`は`--size`のときだけ測る、(3)走査中は進捗（`走査中 N/M`）を出す（端末では同じ行を上書きし、リダイレクト時は25件ごとに1行）。同じ形の処理を足すときは、まとめて1回で引けないか・進捗を出せるかを先に考える。`gh`の呼び出しには`timeout`（既定60秒、`ISSUE_DECK_GH_TIMEOUT`で変更可）を被せてあり、ネットワークが片側だけ切れても待ち続けない。
- 掃除を`run-issue-session.sh`のtrap（セッション終了時）で自動化はしない。「あとで見返したい」「PRにコメントが付いたら直す」という用途を壊すため、セッションの終了とは切り離した定期実行にしている（下記「掃除を回す起点」）。
- 放置すると効くのはディスクだけではない。#1076でworktreeを再利用するようにしたため、**マージ済みIssueで再開すると、developから分岐し直されていない古いブランチのまま作業を始めてしまう**（以前は「既に存在します」で止まっていた）。そのため`start-issue.sh`は再開時にマージ済みPRの有無を確認し、見つかったら警告する。詳細は[local-quick-start.md](local-quick-start.md)の「マージ済みIssueで再開したときの扱い」。

### 掃除を回す起点（#1716）

**判定するスクリプトがあっても、実行の起点が無ければ何も掃除されない。** `cleanup-worktrees.sh`は
#1100からあったが、ユーザーcrontabにもsystemd timerにも登録されておらず、`start-issue.sh`は
案内メッセージを出すだけだった。結果、サブPCの稼働開始（2026-08-13）から3日で
**worktreeが181本・38GB**まで溜まり、ルートFSが77%（残り23GB）に達した。増加ペースは約12〜13GB/日で、
放置すれば2日で尽きる計算だった。**そのうち177本は削除対象になりうる状態**で、足りなかったのは
判定ではなく起点だった。#1576（`71.manual-step`）で人が手で実行する運用にしたが、それも続かなかった。

起点は**サブPCのディスパッチpoller**（`scripts/subpc-dispatch-poller.sh`）に置いた。1巡ごとに
呼ぶ`reap-dev-servers.sh`・`reap-sessions.sh`と同じく、**新しい常駐プロセスもsystemd timerも
増やさず1巡に相乗りさせる**。ただし掃除は`git fetch`と`gh pr list`を叩き、本数ぶんの走査を
行うため毎巡（30秒ごと）は重い。`WORKTREE_CLEANUP_INTERVAL_MINUTES`（既定60分・**0で無効**）の
間隔でだけ実際に走る（前回の実行時刻は`~/.local/state/issue-deck/worktree-cleanup.stamp`のmtime）。
セッションの回収の直後に呼ぶので、**畳んだセッションのworktreeは同じ巡でそのまま消える**。

- systemd timerにしなかった理由は、pollerの間隔設定と同じ（`issue-deck-dispatch-poller.service`の
  コメント）。timerに間隔を持たせると、変更のたびにunitの編集と`daemon-reload`が要り、
  他の回収の設定（`DEV_SERVER_IDLE_MINUTES`・`SESSION_IDLE_MINUTES`）と置き場所が分かれる
- **非対話実行では`--yes`が必須。** 付けないと「非対話実行のため削除しません」と表示して終わる
- 掃除が固まってもポーリングごと止まらないよう、`timeout`（5分）を被せている。**走っている間は
  ポーリングが止まる**（ジョブの取得が最大5分遅れる）。別プロセスへ逃がすと失敗がjournaldに
  出ないままになるため、上限付きの同期実行にしている
- pollerが動かすのは**自分と同じチェックアウト**（`~/apps/issue-deck`）のスクリプトで、
  これを自動で更新する仕組みは無い（#1612）。掃除の挙動を変えたら、そのチェックアウトを
  `git pull`してサービスを再起動するまで効かない

#### 準備中のworktreeを消さない（`--min-age-minutes`）

削除の判定はどれも「いま何かが動いているか」を見ておらず、`start-issue.sh`がworktreeを作ってから
`run-issue-session.sh`のプロセスが立つまでの数分間（`pnpm install`を含む）は、**未コミットの変更も
developに未反映のコミットも無い**。`pnpm install`が置くのは`.gitignore`対象のファイルだけなので、
未コミットの変更としては数えられないためである。人が手で打っていた頃はその瞬間に当たる確率が
低かったが、定期実行では毎時ぶつかりに行く。

そこで**起動の準備から30分が経っていないworktreeは触らない**（`--min-age-minutes`・
`ISSUE_DECK_CLEANUP_MIN_AGE_MINUTES`。0で無効）。経過時間は次の3つのうち最も新しいmtimeから測る。

- worktreeのディレクトリ（作成時刻。`stat`のbirth timeが取れればそちら）
- `.env.local`（`start-issue.sh`が**起動のたびに**`PORT`を書き直すため、作り直しでも再開でも通る）
- 起動用プロンプト（`.prompts/issue-<番号>.md`。準備の最後に生成される）

**`--issue <番号>`で1件に絞ったときはこの猶予を見ない。** 番号を打った人は対象を分かって指定して
いるので、「30分待ってください」と返すのは邪魔にしかならない。安全弁が要るのは全件を無人で回す側。

#### 残すworktreeの`.next`は削除する（#1716）

worktreeが消えれば`.next`も一緒に消えるが、**未pushのコミットや未コミットの変更を抱えて長く残る
worktree**はビルド成果物を抱えたままになる。38GBの内訳の実測は次のとおりで、`node_modules`より
`.next`のほうが大きい。

| 対象 | 合計 | 備考 |
|---|---|---|
| `.next/dev` | 16GB | 163本が保持。Turbopackのdevキャッシュ。実データで共有されない |
| `.next/standalone` | 5.1GB | 本番ビルド成果物 |
| `.next` 全体 | 25GB | 1本あたり平均138MB・最大679MB |
| `node_modules` | 14GB | pnpmストアとのハードリンクで1本あたり約77MB相当 |

`.next`は`pnpm dev` / `pnpm build`を打てば作り直されるので、**残すと決めたworktreeのうち
「セッションも開発サーバーも動いておらず、起動の準備からも猶予が経っている」ものは`.next`を消す**
（`--keep-next`で止められる）。動いている最中に消すとビルドが壊れ、準備中に消すと初回の起動を
遅らせるため、この2つの条件は必須。

**`~/apps/subpc`のREADME「リソース実測」節の「worktree 1本の実消費は約75MB」「worktreeを増やしても
ディスクはほとんど増えない」は`node_modules`だけの話で、`.next`を勘定に入れていない**（別リポジトリの
ためguchi-apps/subpc側のIssueで直す）。

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

### PRを作ったら、そのブランチへの追加pushは間に合わないものとして扱う（#1891）

**develop向けPRは、CIが通り次第そのまま自動マージされる。** 判定するのは
`claude-review-develop.yml`で、機械的リスク判定にも意味的判定にも当たらないPRは、
lint・buildの完了から1分足らずでマージされる。#1891では、PR作成の直後に計画レビュー（G1）の
指摘へ対応してpushしたが、そのpushが届く前にPRがマージされ、**指摘への対応だけが取り残された**
（PRの本文には対応を書いてしまっていたため、マージされた内容と本文が食い違った）。

- **PRを作る前に、Issueのコメントを`gh issue view <番号> --comments`で読み切る。** G1の指摘は
  計画の投稿直後に自動で走るため、承認を受けて実装している最中に届いている（[gates.md](gates.md)
  「G1の実装」）。承認と指摘は別物で、承認されたからといって指摘が取り下げられたわけではない
- **追加のコミットが必要になったら、まず`gh pr view <番号> --json state,mergedAt`でマージ済みか
  確かめる。** マージ済みなら同じブランチから追加のPRを立てる（`develop`をマージしてから作る）。
  マージされたPRは追加pushでは開き直らない
- **PR本文を後から書き換える場合も、その時点でマージ済みかを確かめる。** マージ済みのPRの本文を
  直しても、入っていない変更を入っているように読ませるだけになる

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

**`11.local`が効くのはActions側が判定する時点まで**で、逆向き（Actionsが走っている最中にサブPCへ積む）は止められない。triageと陳腐化チェックを通過して走っているrunは、後から`11.local`を付けても止まらないからで、そのままだと同じ`issue-<番号>`ブランチをActionsとサブPCが別々に進める（#2032）。こちらは**積む側の画面**で塞ぐ——GitHub Actionsの実行が進行中のIssueには起動の導線を出さない（Issue詳細の起動ボタン・「まとめて実行」・「セッションを復旧」の3つ）。判定材料は画面が既にポーリングしている実行状況で、GitHub APIは追加で叩かない。詳細は[subpc-dispatch.md](subpc-dispatch.md)「GitHub Actionsが走っている間は積ませない（#2032）」。

`11.local`は`0x.`始まりではないため、issue-deck画面上は進捗ステップ（`WorkflowStepBadge`）ではなく通常のラベルとして表示・編集できる（`src/lib/issue-status.ts`の`isProgressLabel`）。あわせて番号帯が重ならないよう、優先度ラベルを`80.Priority: High`・`89.Priority: low`へリネームした。

## ブランチ保護ルール案

- **`main`**: 組織標準（`_docs/guides/github-repo-setup.md` §5）どおり設定する。Require pull request before merging、Required status checks=`lint-and-build`（`.github/workflows/ci.yml`のジョブ名）、Restrict updates、bypass=自分のアカウント（For pull requests only）。**現状（2026年時点）未設定のため要設定。** 実際の設定はGitHub Web UIで行う（workflowでは自動化しない）。
- **`develop`**: Phase4で`required_status_checks`（`lint-and-build`）のみを設定した（`gh api PUT repos/{owner}/{repo}/branches/develop/protection`、`required_pull_request_reviews`・`restrictions`は`null`のまま）。これは`gh pr merge --auto`がCIの完了を待たずに即マージしてしまうのを防ぐための最小構成で、直接pushやApprove必須化は行っていない。「Require pull request before merging」＋bypass=人間アカウントのみへの本格的な制限は、影響範囲が大きく本Issueの完了条件にも必須ではないため見送った。GitHub Actions専用トークン（`github.token`、Phase3/4で導入済み）を使えば技術的には設定可能なので、必要になった時点で改めて検討する。
