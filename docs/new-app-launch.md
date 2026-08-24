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
| `[手作業] サブPC: cloneし、シークレットを投入する` | `guchi-apps/issue-deck` | 代行実行できる |
| `[手作業] ブラウザ: DNSとシークレットを登録する` | `guchi-apps/issue-deck` | あなたが実行 |

手作業の3件は`71.manual-step`ラベル付きで、親Issueのサブissueとして紐付く。
**進捗を追う専用の画面は持たない**——サブIssueはいつもの盤面と「ユーザーの作業待ち」に
出るので、同じ状態を2か所で持たない。

## 自動化できないこと（そう決めた理由）

- **DNSのAレコードの登録。** DNSはVPSプロバイダの管理画面でしか設定できず、使えるAPIが無い
  （共有知識の`guides/apache-domain-setup.md`も「実行者: 人間のみ」としている）。自動化
  できるのはサブドメイン名の決定と重複チェックまで。
- **VPS実機の操作**（`/home/github-user/apps/<name>/`の作成・`CREATE DATABASE`・PM2への登録と`pm2 save`・
  certbot）。**`guchi-apps/vps`の`deploy.yml`が配る受け口ではない**ため、リポジトリ経由では
  反映されない。手作業アシスタントの代行実行もサブPC限定なので、ここは人が実行する。
- **Signalyのチャンネル作成。** Googleログインの背後にある画面操作で、共有知識の
  `guides/signaly-notifications.md` も「実行者: 人間のみ」としている。**控えたWebhook URLの
  登録は自動化してある**ので、人が行うのはチャンネルを作って値をコマンドへ貼るところまで。
- **GitHub Secrets（`OP_SERVICE_ACCOUNT_TOKEN`など）とGitHub Appのインストール対象。**
  無断で変更してよい設定ではない。

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

### 1Passwordのアイテムは、コマンドで投入する（#2249）

**フィールド名の羅列を手作業Issueに書かない。** `aide-bot`の立ち上げでは
「`db-name = app_aide_bot / ci-webhook-url（Signaly）/ target-dir = /apps/aide-bot`」という
羅列を書いていたため、値が未登録のまま初回の本番デプロイが走り
`DB_NAME: DB_NAME is required` で失敗した（`guchi-apps/aide-bot#4`→`#8`）。

投入は[`scripts/provision-app-secrets.sh`](../scripts/provision-app-secrets.sh)が行う。
**画面（立ち上げのAPI）からは実行しない**——本番のissue-deckは1Passwordを直接読み書きせず、
書き込み用のサービスアカウント（`~/.config/issue-deck/op-writer.env`）を持つのはサブPCだけ
（画面の「シークレット同期」もワークフローを起こしているだけ。#1309）。したがって実行の場は
**サブPCの手作業Issueとローカルセッション**になる。

- **機械的に定まる値**（`target-dir`・`db-name`・`allowed-google-emails`）は**サブPCの手作業
  Issue**の1手順として出す。代行実行の条件を満たしているので、画面のボタンで流せる。
- **人が決める値**（SignalyのWebhook URL）だけを**ブラウザの手作業Issue**に残す。残す形も
  同じスクリプトの1コマンドで、控えた値を`--ci-webhook-url`へ貼るだけにする。
- **`provision-secret.sh`（#1874）とは役割が違う。** あちらはマニフェストに行がある**1キー**を
  発行して本番へ反映するまでを通すもので、アイテムがまだ無い立ち上げでは使えない。こちらは
  **アイテムの新規作成と複数フィールドの一括投入**で、デプロイは起こさない。
- **GitHubのsecretへの同期には`.github/secrets-manifest.tsv`が要る**（どのKEYがどのフィールドを
  読むかの正はマニフェストで、スクリプトは参照を引数で受けない）。それを作るのは初期化Issue
  なので、サブPCの手順の時点では1Passwordへ入るだけで同期は見送られる。**同じコマンドを後から
  実行すると同期まで進む**——何度実行してもよい作りにしてあるのはこのため。初期化Issueの
  やることにも、マニフェストを作った後の同期を1項目として入れてある。
- **入ったことはGitHub側から引き直して確かめる**（`actions/secrets`の`total_count`）。同期
  スクリプトの出力は送った側の記録でしかなく、名前の取り違えや権限不足に気付けない。

### 新しいリポジトリのIssueは、作った直後には盤面に載らない

盤面へ載る条件は`claude-issue-dispatch.yml`がデフォルトブランチにあること
（[cross-repo-setup-guide.md](cross-repo-setup-guide.md)）で、**それを作るのが初期化Issue
自身**という順序になっている。そこで次の2つで噛み合わせている。

- 初期化Issueの実行経路を**サブPCのローカルセッション**に固定する（条件は
  `~/.config/issue-deck/local-repos.conf`への記載）。サブPCの手作業Issueを初期化Issueの
  `## 前提条件`に置いてある。
- ブラウザの手作業Issueに「GitHub Appへ追加 → **リポジトリを再同期 → Issueを再同期**」を
  入れる。**2つとも押す必要がある**（片方だけではIssueが取り込まれない）。

### サブPCの手作業Issueは代行実行の条件を満たす形で書く

`lib/dispatch/dispatch-job.ts`の`manualStepExecutionRejection`が見る条件をすべて満たすこと。

- `## 前提条件`の「実行するデバイス」が**サブPC1つだけ**
- 1手順にコマンドブロックが**ちょうど1つ**
- 対話が要るコマンド（`op signin`など）を含まない
- `<…>`のプレースホルダを含まない（値はすべて埋めて出す）

1つでも崩すと、その手順は「あなたが実行」として並ぶだけになる。
`lib/new-app/plan.test.ts`が、生成した本文を実物の`buildManualStepRunPlan`に通して見張っている。

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
