# 新規アプリの立ち上げ

**いつ読むか**: 画面の「新規アプリを立ち上げる」を触るとき。立ち上げで作られるIssueの中身を変えるとき。

新しい個人アプリの立ち上げ（#2188）を、issue-deckの画面から一続きで行う仕組み。
「何を作るか」の相談から、GitHubリポジトリの作成と残りの作業のIssue起票までを扱う。

作業手順そのものの正は共有知識（`guchi-apps/docs`の`guides/new-app-checklist.md`）で、
**ここに手順を複製しない。** このドキュメントが持つのは「issue-deckが何を自動化し、
何を人へ残すか」の線引きと、その理由。

## 入口

- PC: 左メニューの最下部「新規アプリを立ち上げる」
- スマホ: ホーム画面のメニューの最下部（同じ1行）

**丸ボタン（FAB）は増やさない。** 使うのは年に数回で、いちばん使うIssue作成の導線を
1タップ遠くする理由が無い。常設するのも1行だけにして、上の常用の並びには混ぜない。

## 4つのステップ

| ステップ | すること | 実装 |
|---|---|---|
| 0. 相談 | 何を作るかをAIと数往復して固める。仕様案（名前・種別・DB・認証・URL）が下にまとまる | [`lib/claude/new-app-consult.ts`](../src/lib/claude/new-app-consult.ts) |
| 1. 基本 | アプリ名・リポジトリ名・公開範囲・概要。リポジトリ名の空きをGitHubで確かめる | [`lib/new-app/spec.ts`](../src/lib/new-app/spec.ts) |
| 2. 配置 | 種別・公開URL・本番ポート・DB名・認証・マルチエージェント運用の要否 | 同上 |
| 3. 確認 | 作られるもの8件を「自動 / 代行できる / あなたが実行」の内訳付きで出す | [`lib/new-app/plan.ts`](../src/lib/new-app/plan.ts) |

**相談と設定を同じ画面に混ぜない。** 会話しながら横で仕様が埋まっていく形も検討したが、
スマホでは会話と設定の両方を1画面に収めることになる。相談を先に終えて値を引き渡す形なら、
どちらのステップも393pxに素直に収まる。

**相談で決まっていない項目は空のまま渡す**（`normalizeDraft`が知らない値・使えない値を
`null`へ落とす）。埋めさせると、聞かれていない前提が既定値として設定ステップへ流れ込む。

## 作られるもの（8件）

| 作られるもの | 場所 | 自動化 |
|---|---|---|
| リポジトリ | `guchi-apps/<name>` | 自動（`develop`既定・ラベル一式を写す） |
| 親Issue「◯◯の立ち上げ」 | `guchi-apps/issue-deck` | 自動 |
| ポート帯を足すPull Request | `guchi-apps/issue-deck` | 自動（`scripts/local-repo-ports.conf`へ1行） |
| プロジェクトを初期化する | 新しいリポジトリ | 自動（起票のみ。実装はサブPCのローカルセッション） |
| VirtualHostを追加し、アプリ一覧に載せる | `guchi-apps/vps` | 自動（起票のみ） |
| `[手作業] VPS: 置き場とプロセスを用意する` | `guchi-apps/issue-deck` | あなたが実行 |
| `[手作業] サブPC: cloneして対応表に載せる` | `guchi-apps/issue-deck` | 代行実行できる |
| `[手作業] ブラウザ: DNSとシークレットを登録する` | `guchi-apps/issue-deck` | あなたが実行 |

**`guchi-apps/vps`のIssueだけは、同じ対象のopenなIssueが既にあれば作らない**（#2250。
後述「同じ対象のIssueが`guchi-apps/vps`に開いていれば、起票しない」）。そのときは既存Issueへ
コメントを書き足し、画面の一覧には「既存」の印を付けて出す。

手作業の3件は`71.manual-step`ラベル付きで、親Issueのサブissueとして紐付く。
**進捗を追う専用の画面は持たない**——サブIssueはいつもの盤面と「ユーザーの作業待ち」に
出るので、同じ状態を2か所で持たない。

## 自動化できないこと（そう決めた理由）

- **DNSのAレコードの登録。** DNSはVPSプロバイダの管理画面でしか設定できず、使えるAPIが無い
  （共有知識の`guides/apache-domain-setup.md`も「実行者: 人間のみ」としている）。自動化
  できるのはサブドメイン名の決定と重複チェックまで。
- **VPS実機の操作**（`/apps/<name>/`の作成・`CREATE DATABASE`・PM2への登録と`pm2 save`・
  certbot）。**`guchi-apps/vps`の`deploy.yml`が配る受け口ではない**ため、リポジトリ経由では
  反映されない。手作業アシスタントの代行実行もサブPC限定なので、ここは人が実行する。
- **1PasswordとGitHub Secrets。** 無断で変更してよい設定ではない。
- **GitHub Appのインストール対象への追加は、必要なときだけ残す**（#2248）。`issue-deck`・
  `issue-deck-dev`とも`repository_selection=all`で入っているので、新しく作ったリポジトリは
  何もしなくても対象に入る。`selected`へ戻されたとき（と選び方を読めなかったとき）だけ、
  ブラウザの手作業Issueに手順が出る。

## 実装のうえで外せない前提

### ポートとホスト名は`guchi-apps/vps`の実物から決める

読むのは2つだけ（[`lib/github/vps-inventory-api.ts`](../src/lib/github/vps-inventory-api.ts)）。

1. **READMEの2つの表**（「アプリ一覧」と「予約済みポート（未デプロイ）」）。README自身が
   「ドメイン・ポート・プロセス管理方式の一次情報はこの表のみです」と書いている。
   **予約済みの表も必ず読む**——まだデプロイしていないぶんを落とすと二重に払い出す。
2. **`apache/sites-available/`の各vhostの`ServerName`／`ServerAlias`。**

守るべき点が3つある。

- **READMEの散文（「空きは3103・3112、および3114以降」）は読まない。** 実際に古くなっている
  （`aide`が3114を使い始めた後もそのままだった）。表から計算する。
- **vhostはファイル名で判定しない。** `wordpress.conf`の`ServerName`は`blog.gucchii.com`、
  `gucchii.conf`は`gucchii.com`というように、ファイル名とホスト名は一致しない。ファイル名で
  見ると`blog`を空きだと誤って答える。
- **PM2の設定は読まない。** `guchi-apps/vps`に`pm2/`は無く（READMEの構成図には残っているが
  実体が無い）、`ecosystem.config.js`は各アプリの自リポジトリで管理されている。プロセス管理
  方式もアプリ一覧の表にある。

**`guchi-apps/vps`を読めなかったときは自動採番せず、手入力に倒す**（`vpsRead: false`）。
ここで失敗にすると、vpsを読む権限が無いだけでウィザードが一切使えなくなる。

`githubFetch`は`Accept`ヘッダを`application/vnd.github+json`で上書きするので、
**`application/vnd.github.raw`は使えない。** base64の`content`を自分で戻す。

### ローカルセッションのポート帯は、立ち上げが払い出す

**Issueにせず、issue-deck自身のdevelopへPull Requestを作る**（#2225）。追記の内容は
「現状の最大 + 1000」で機械的に決まり、変更は1行。Issueにすると立ち上げのたびに1行のために
実装セッションを1回起こすことになる（CLAUDE.md「同じ作業が繰り返し発生するものは、その作業を
なくすIssueを立てる」）。develop向けPRなので`claude-review-develop.yml`がCIの完了を待って
自動マージする。

- 採番は[`lib/new-app/local-port-bands.ts`](../src/lib/new-app/local-port-bands.ts)（純粋関数）。
  **空きを詰め直さない**——帯を外したリポジトリの番号を再利用すると、古いチェックアウトが
  残っているサブPCで前の持ち主と衝突しうる。
- **書式の正はシェル側**（`scripts/lib/local-repo-resolve.sh`の`local_repo_port_base`）。
  行全体が`<名前><空白><数字>`に一致しないと読まれないので、**行末コメントは書けない**。
  `local-port-bands.test.ts`が、生成した行を実際に`bash`へ読ませて突き合わせている。
- **帯を決められないときは、何も作る前に止める**（`port_band_unavailable`）。`guchi-apps/vps`の
  読み取り（`vpsRead: false`で続行）と扱いが違うのは、黙って飛ばすと帯が未確保のまま立ち上げが
  終わり、#2213と同じ漏れが再発するから。まだ何も作っていない時点なので押し直せる。
- **Pull Requestの作成そのものに失敗したときは止めない。** 残りのIssueを作らずに終える方が
  損失が大きいので、`warnings`として画面へ返す（帯の値は親Issueの本文にも残る）。
- **developへマージしただけでは効かない。** このファイルはサブPCの本体チェックアウト
  （`~/apps/issue-deck/scripts/`）から読まれるため、画面のホスト一覧で「更新して再起動」を
  押すまで反映されない（[multi-agent/generic-launcher.md](multi-agent/generic-launcher.md)）。
  **これは手作業Issueにしない**——画面のボタン1つで済む操作だから（#2009）。サブPCの手作業
  Issueの`## 前提条件`に1行書いてある。

### 新しいリポジトリのIssueは、立ち上げ自身が取り込む

リポジトリを作っただけでは、issue-deckのDBに現れない。`repository_selection=all`の
インストールでは新しいリポジトリを足しても`installation_repositories`のwebhookが飛ばず、
設定の「リポジトリを再同期」を押すまでDBに入らないためで、Issueの取り込みはさらにその後に
なる。当初はこの2つを人が押す手順としてブラウザの手作業Issueへ入れていたが、押し忘れると
初期化Issueが画面に出ないままになる（#2215で実際に押されていなかった）。

そこで**立ち上げの最後で、issue-deck自身が同じ2つを実行する**（#2248。
[`lib/new-app/resync.ts`](../src/lib/new-app/resync.ts)）。

- **初期化Issueを作ったあとに置く。** 先に回すと取り込むIssueがまだ無い。
- **Issueの再同期は作ったリポジトリ1つだけに絞る。** 画面のボタンは接続中の全リポジトリを
  回すが、ここで欲しいのは今作ったものだけ。
- **Projectへの追加（`addMissingProjectItems`）は呼ばない。** 対象は
  `claude-issue-dispatch.yml`を持つリポジトリに限られ、それを作るのが初期化Issue自身なので、
  この時点では何も載らない。
- **失敗しても止めない。** `warnings`で「設定で2つを押してください」と画面へ返す
  （ポート帯のPull Requestと同じ扱い）。

**カンバンの盤面へ載る条件は別で、`claude-issue-dispatch.yml`がデフォルトブランチにあること**
（[cross-repo-setup-guide.md](cross-repo-setup-guide.md)）。**それを作るのが初期化Issue自身**
なので、初期化Issueの実行経路は**サブPCのローカルセッション**に固定してある（条件は
`~/.config/issue-deck/local-repos.conf`への記載で、サブPCの手作業Issueを初期化Issueの
`## 前提条件`に置いてある）。

### `repository_selection`はDBではなくGitHubへ聞く

DBの`GithubInstallation.repositorySelection`は`installation`イベントでしか更新されず、
インストール画面で対象を選び直したときに飛ぶ`installation_repositories`イベントでは
更新されない。立ち上げの判断に使うと、`selected`へ戻されたことに気付かないまま手順を落とす。
そのためApp JWTで取り直す（[`lib/new-app/installation-scope.ts`](../src/lib/new-app/installation-scope.ts)）。
**読めなかったときは手順を出す側に倒す**——余分な手順が1つ増えるだけで済み、落とすと
立ち上げが黙って壊れる。

### サブPCの手作業Issueは代行実行の条件を満たす形で書く

`lib/dispatch/dispatch-job.ts`の`manualStepExecutionRejection`が見る条件をすべて満たすこと。

- `## 前提条件`の「実行するデバイス」が**サブPC1つだけ**
- 1手順にコマンドブロックが**ちょうど1つ**
- 対話が要るコマンド（`op signin`など）を含まない
- `<…>`のプレースホルダを含まない（値はすべて埋めて出す）

1つでも崩すと、その手順は「あなたが実行」として並ぶだけになる。
`lib/new-app/plan.test.ts`が、生成した本文を実物の`buildManualStepRunPlan`に通して見張っている。

### 同じ対象のIssueが`guchi-apps/vps`に開いていれば、起票しない（#2250）

`aide-bot`の立ち上げでは、**同じ「vhostを作って公開する」作業のIssueが`guchi-apps/vps`へ4件**
並んだ（`#121`＝立ち上げが起票・`#122`＝別セッションが「受け入れる設定が無い」として起票・
`#124`＝手作業Issue・`#128`＝デプロイ失敗の調査から起票）。**後から入ったエージェントが既存の
Issueを見つけられず、起票し直した**のが原因。

対策は2つで、判定は[`lib/new-app/launch-marker.ts`](../src/lib/new-app/launch-marker.ts)（純粋関数）、
IOは[`lib/github/new-app-existing-issue.ts`](../src/lib/github/new-app-existing-issue.ts)にある。

**1. 立ち上げが作るIssueの本文へ、不可視のマーカーを埋める。**

```
<!-- new-app-launch: {"app":"aide-bot","repo":"guchi-apps/aide-bot","host":"aide-bot.gucchii.com","kind":"vps-issue","parent":"guchi-apps/issue-deck#2213"} -->
```

**GitHubのIssue検索はHTMLコメントの中身も索引している**ので、これで引ける。人が読む本文は
変わらない（`deploy-failure.ts`と同じやり方）。

```bash
gh issue list --repo guchi-apps/vps --state open --search "new-app-launch aide-bot" --json number,title
```

**2. 起票の前に、`guchi-apps/vps`のopenなIssueから同じ対象のものを探す。** 見つかったら
新しく作らず、そのIssueへコメントを書き足し、以降の本文（VPSの手作業Issue）もそちらを指す。

- 判定の強さは **マーカー > ホスト名 > タイトルのアプリ名** の順。同じ理由の中では**いちばん
  番号の小さい（古い）Issue**へ寄せる——重複の元になった1件目へ集約したいため
- **ホスト名で照合するのはサブドメインのときだけ。** パス配下（`gucchii.com/foo`）では
  ホスト名が既存アプリと共有で、そのホストに関わるIssueがすべて当たってしまう
- アプリ名は**タイトルだけ**を見る。本文には「他のアプリでは〜」のような言及が入りうる
- 語として一致したときだけ拾う（`aide-bot`は`aide-bottle`に当たらない）
- **検索API（`/search/issues`）は使わない。** 作った直後のIssueが索引に載るまで数十秒かかり、
  「押した直後にもう一度押す」形の重複を取りこぼす。openなIssueの一覧なら`guchi-apps/vps`でも
  1〜2ページで収まる
- **読めなかったときは従来どおり起票する。** 判定できないことを理由に起票を止めると、必要な
  Issueが1件も無いまま立ち上げが終わる。重複は人が閉じられるが、欠落は気付かれない
- **既存Issueをサブissueとして紐付けない。** 別の親が付いていることがあり、付け替えると元の
  追跡が外れる。つながりはコメントのリンクで残す
- 押す前の確認ステップにも同じ判定を出す（`POST /api/new-app/preflight`の`existingVpsIssue`）。
  後から警告だけ出しても、何が起きたのか分からない

**エージェント側にも「起票の前に探す」を書いてある**（`.github/prompts/`・`scripts/prompts/`の
実装・質問応答プロンプトと[multi-agent/labels.md](multi-agent/labels.md)）。#1875で「更新して
再起動」を入れた後も同じ形の手作業Issueが立ち続けたのと同じで、**仕組みを作っただけでは
止まらず、起票する側の基準に書いて初めて止まる。**

### 手作業の分担は、Issueの本文に書いて固定する（#2250）

`#2216`（issue-deck側のVPSの手作業）と`guchi-apps/vps#124`では、certbotの実行と
`-le-ssl.conf`を控える手順が**両方に書かれていた**。`aide-bot`では`#124`の側で実施され、
`#2216`の同じ手順が宙に浮いた。

分担そのものは変えていない（**vhostの追加と`-le-ssl.conf`の取り込み＝vps側、DNS＝ブラウザの
手作業、置き場・DB・PM2・certbot＝VPSの手作業**）。変えたのは、`guchi-apps/vps`のIssueに
**「このIssueが持たない作業」の表を置いた**こと。読んだ人・エージェントが、足りない手順を
見つけたときに新しいIssueを立てず、担当のIssueへ書き足せるようにする。

**1件へ統合しなかった理由。** `guchi-apps/vps#132`（プロビジョニングの受け口）が入ると
置き場・DB・PM2は自動化され、実機に残る手作業はcertbotだけになる。残る量が変わる前に
統合すると、統合したIssue自体を作り直すことになる。

### certbotが作る`-le-ssl.conf`は`guchi-apps/vps`へ戻す

`guchi-apps/vps`のドリフト検知（`.github/scripts/check-drift.sh`）は**実機の
`/etc/apache2/sites-available/*.conf`を正として列挙する**ため、certbotが作った
`<host>-le-ssl.conf`を取り込むまで「[新規（未取り込み）]」として毎日出続ける。
VPSの手作業Issueに「内容を控えてvpsのIssueへコメントする」手順を置き、vpsのIssue側に
2段目として取り込みを書いてある。

## 失敗したときの扱い

**途中で失敗しても、作り終えたものは消さない。** 作成済みのリポジトリ・Issueを`created`として
返し、画面はそれをリンクとして出す。自動で消すと、名前だけ取られたのか何も起きていないのかが
分からなくなる。**同じ内容での押し直しもしない**（リポジトリの作成で弾かれる）。続きは
作られたIssueから人が進める。

サブIssueの紐付けだけは失敗しても止めない——紐付きが欠けても各Issueは独立して読める。
