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
| 2. 配置 | 種別・公開URL・本番ポート・DB名・認証・マルチエージェント運用の要否と、畳んだ「体裁と運用」（表示名・アイコン・PWA・更新履歴・撮影バイパス） | 同上 |
| 3. 確認 | 作られるもの9件を「自動 / 代行できる / あなたが実行」の内訳付きで出す | [`lib/new-app/plan.ts`](../src/lib/new-app/plan.ts) |

**相談と設定を同じ画面に混ぜない。** 会話しながら横で仕様が埋まっていく形も検討したが、
スマホでは会話と設定の両方を1画面に収めることになる。相談を先に終えて値を引き渡す形なら、
どちらのステップも393pxに素直に収まる。

**相談で決まっていない項目は空のまま渡す**（`normalizeDraft`が知らない値・使えない値を
`null`へ落とす）。埋めさせると、聞かれていない前提が既定値として設定ステップへ流れ込む。

## 作られるもの（9件）

| 作られるもの | 場所 | 自動化 |
|---|---|---|
| リポジトリ | `guchi-apps/<name>` | 自動（`develop`既定・ラベル一式を写す） |
| 親Issue「◯◯の立ち上げ」 | `guchi-apps/issue-deck` | 自動 |
| ポート帯を足すPull Request | `guchi-apps/issue-deck` | 自動（`scripts/local-repo-ports.conf`へ1行） |
| プロジェクトを初期化する | 新しいリポジトリ | 自動（起票のみ。実装はサブPCのローカルセッション） |
| 初回デプロイ前チェックと公開確認 | 新しいリポジトリ | 自動（起票のみ。実装はサブPCのローカルセッション） |
| VirtualHostを追加し、アプリ一覧に載せる | `guchi-apps/vps` | 自動（起票のみ） |
| `[手作業] VPS: 置き場とプロセスを用意する` | `guchi-apps/issue-deck` | あなたが実行 |
| `[手作業] サブPC: cloneし、シークレットを投入する` | `guchi-apps/issue-deck` | 代行実行できる |
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
- **VPS実機の操作**（`/home/github-user/apps/<name>/`の作成・`CREATE DATABASE`・PM2への登録と`pm2 save`・
  certbot）。**`guchi-apps/vps`の`deploy.yml`が配る受け口ではない**ため、リポジトリ経由では
  反映されない。手作業アシスタントの代行実行もサブPC限定なので、ここは人が実行する。
- **GitHub Secrets（`OP_SERVICE_ACCOUNT_TOKEN`など）。** 無断で変更してよい設定ではない。
  アプリ自身の値（配置先・DB名・許可メール）は後述のとおり自動で投入する。
  CI・デプロイ通知の`SIGNALY_WEBHOOK_URL`はorganization secretへ寄せたため（#2255）、
  新規アプリの立ち上げにSignalyのチャンネル作成もWebhook URLの登録も要らない。
- **GitHub Appのインストール対象への追加は、必要なときだけ残す**（#2248）。`issue-deck`・
  `issue-deck-dev`とも`repository_selection=all`で入っているので、新しく作ったリポジトリは
  何もしなくても対象に入る。`selected`へ戻されたとき（と選び方を読めなかったとき）だけ、
  ブラウザの手作業Issueに手順が出る。

## 体裁と運用は、既定値で畳んで置く（#2254）

共有知識の新規アプリ作成チェックリストは、計画段階で公開URLやDBのほかに**表示名・PWA対応方針・
オフライン対応・更新履歴・CI撮影の認証バイパス**も決めるとしている。ウィザードはこれを
決めていなかったため、`aide-bot`ではPWA対応まで入ったものの**アイコンのデザインもテーマカラー
（`#0f766e`）も人が決めておらず**、更新履歴は持たないまま始まった。

**ステップは増やさず、「2. 配置」の末尾に畳んだパネルとして置く。** 5項目すべてに標準の
既定値を持たせ、畳んだ1行に決まった値を出す（[`lib/new-app/spec.ts`](../src/lib/new-app/spec.ts)の
`appearanceSummary`）。**開かずに「次へ」を押せることが要件**で、項目を入力欄として並べると
立ち上げの手数がそのぶん増える。

| 項目 | 既定 | 出どころ |
|---|---|---|
| 表示名 | アプリ名と同じ | `title` / `applicationName` / `appleWebApp.title` |
| アイコン・テーマカラー | 暫定で始める（`#0f172a`） | 標準方針（`standards/tech-stack.md`） |
| PWA・オフライン | PWA対応する／オフラインは対応しない | 同上 |
| 更新履歴 | 持つ | `RELEASE_CHANGELOG`（[supported-repositories.md](supported-repositories.md)） |
| CI撮影の認証バイパス | 用意する（認証があるときだけ。`minimal`ではローカル実行専用） | `24.screenshot-required`の前提 |

守っている点が4つある。

- **決めた事実は必ず表に残す。** 「標準どおりで通した」も決定なので、親Issueと初期化Issueの
  決めごとの表へ5行として出す（`specTable`）。**ApacheのVirtualHostと疎通確認のIssueには
  出さない**——あちらの判断材料にならないので、`specTable(spec, { appearance: false })`で呼ぶ。
- **「やらない」と決めたものは、初期化Issueの「やること」に並べない**（`appearanceSteps`）。
  「PWA対応はしない」のようなチェックを置くと、消し込む相手が無い項目が増える。
- **暫定で始めたものは、親Issueの「後で決めること」に残す。** ただし**完了条件には入れない**
  ——暫定のアイコンでも公開はできるので、条件にすると立ち上げを閉じられなくなる。
- **認証が無いアプリでは撮影バイパスの項目そのものを出さない**（`screenshotBypassEnabled`）。
  迂回する相手が無いので、チェックを残すと「用意したのに効かない」ものになる。
- **`runtime-setup: minimal`（FastAPI・静的サイト）では、撮影バイパスの用途を断って書く**
  （`supportsUnattendedScreenshot`）。`minimal`ではPlaywrightがインストールされないため
  `24.screenshot-required`は無人実行では成立しない（[cross-repo-setup-guide.md](cross-repo-setup-guide.md)）。
  バイパス自体はローカルの画面確認に効くので、**用意しないのではなく「ローカル実行専用」と書く**。

雛形（#2247）が`manifest`・アイコン・更新履歴を含むようになれば、ここで決めた値は
**雛形をどう埋めるか**の指定になる。決める場所はここのままでよい。

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
- **SignalyのWebhook URLはここで扱わない。** organization secretへ寄せたため（#2255）、
  ブラウザの手作業Issueにチャンネル作成・登録の手順は残さない。スクリプト自体は
  引き続き`--ci-webhook-url`オプションを持つが（他アプリの値を後から直すときなどに使う）、
  立ち上げのコマンドからは渡さない。
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

### 手作業Issueの`## 完了の確認方法`は、手順と1対1のコマンドにする（#2256）

`aide-bot`の立ち上げでは、**チェックが付いているのに実際には行われていない手順**が複数あった。
1Passwordへの登録は未実施のままIssueがcloseされ、初回デプロイが`DB_NAME: DB_NAME is required`で
失敗した（`guchi-apps/aide-bot#8`として起票し直し）。原因は確認節が散文で、
**「登録されたか」を見ていなかった**こと。3つの手作業Issue（サブPC・VPS・ブラウザ）はいずれも、
`## やること`の手順ぶんの確認コマンドを`## 完了の確認方法`へ並べる。

- **効いていなければ終了コードが0にならないコマンドにする。** 代行実行も定期巡回（#2008）も
  見ているのは終了コードだけで、「期待する出力」との照合はしない。`--dry-run`のように常に0で
  終わるものを置くと、確かめていないのに通ったことになる
- **1Passwordの投入は`provision-app-secrets.sh --check`で確かめる。** 投入と同じ引数に
  `--check`を足しただけの形にしてあり、未登録が1つでもあれば終了コード1で終わる。引数がずれると
  「確かめていないフィールド」が生まれるので、`provisionCommand`が両方を1か所から組み立てている
- **secretsの確認はorganizationのsecretも数える**（`repos/{repo}/actions/organization-secrets`）。
  リポジトリのsecretだけを見ると、`visibility=all`のorganization secretで足りている場合に
  「未登録」と読めてしまう。`aide-bot`ではまさにそれで、Actions secretsへの登録は不要な手順だった
- DNSの`dig`は**手順ではなく確認**なので、`## やること`から`## 完了の確認方法`へ移してある。
  確認節に置いたものだけが代行実行・巡回の対象になる

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

### 完了の判定は本番URLの`curl`で行う（deployジョブの成功は公開を保証しない）

`deploy.yml`のヘルスチェックが叩くのは**VPS内の`http://127.0.0.1:<port>/`**なので、
ApacheのVirtualHostが無くてもdeployジョブは成功する。`aide-bot`ではそのせいで
「デプロイが通った＝公開できた」と読めてしまい、vhostが無いことに気づくのが
`guchi-apps/vps#128`の調査まで遅れた（#2252）。

そこで置いているのが次の2つ。

- **親Issueの`## 完了条件`**（`buildParentIssueBody`）。先頭が
  `curl -I https://<host>/`が200か3xxを返すことで、「一覧への登録」の3項目もここへ畳んである。
  DNS・Apache・TLS・アプリのすべてを通る確認はこの1本だけ。
- **新しいリポジトリの「初回デプロイ前チェックと公開確認」Issue**（`buildDeployCheckIssueBody`）。
  初回デプロイの前に周辺インフラの疎通を確かめ、デプロイ後に公開URLまで見届ける。返らない
  ときの切り分け（名前解決→DNS、404→vhost、502/503→PM2、TLS→certbot）を表で持たせてある。

**初期化Issueへ畳まない。** 初期化Issueは`develop`へのマージで`Done`になるが、初回デプロイは
`develop`→`main`のリリースPRをマージした後なので、そこまで開いたまま追えるものが残らない。

**実行経路はサブPCのローカルセッション**（初期化Issueと同じ）。実地確認の手順は個人スキル
`initial-deploy-check`にあり、GitHub Actions上の無人実行は個人スキルを読めない。1Passwordの
解決やVPSへのSSHも無人実行からは行えない。

**雛形の`deploy.yml`（#2247）には、失敗させない形で入れる。** 疎通の確認をdeployジョブの成否に
するとcertbot前の初回デプロイが必ず落ちるので、`::warning::`として出すだけにする。初回だけの
分岐は持たない——2回目以降もApacheの設定が壊れていれば拾えるほうがよい。

### certbotが作る`-le-ssl.conf`は`guchi-apps/vps`へ戻す

`guchi-apps/vps`のドリフト検知（`.github/scripts/check-drift.sh`）は**実機の
`/etc/apache2/sites-available/*.conf`を正として列挙する**ため、certbotが作った
`<host>-le-ssl.conf`を取り込むまで「[新規（未取り込み）]」として毎日出続ける。
VPSの手作業Issueに「内容を控えてvpsのIssueへコメントする」手順を置き、vpsのIssue側に
2段目として取り込みを書いてある。

**控える前に`:443`側の`X-Forwarded-Proto`を`"https"`へ直す**（#2253）。certbotは`:80`の
VirtualHostをそのまま`:443`へ複製するため、`RequestHeader set X-Forwarded-Proto "http"`が
残る。アプリは自分を`http://`だと誤認し、生成したリダイレクトURIが登録済みの`https://`と
一致せず、**本番でだけOAuthログインが失敗する**。共有知識には2026-08-09の時点で記録があった
（`guchi-apps/docs`の`knowledge/deployment.md`）のに、生成する手順に入っていなかったのが
`guchi-apps/vps#124`で顕在化した理由なので、**認証の有無にかかわらず常に手順として出す**
（後から認証を足すアプリがあるため）。

## 失敗したときの扱い

**途中で失敗しても、作り終えたものは消さない。** 作成済みのリポジトリ・Issueを`created`として
返し、画面はそれをリンクとして出す。自動で消すと、名前だけ取られたのか何も起きていないのかが
分からなくなる。**同じ内容での押し直しもしない**（リポジトリの作成で弾かれる）。続きは
作られたIssueから人が進める。

サブIssueの紐付けだけは失敗しても止めない——紐付きが欠けても各Issueは独立して読める。
