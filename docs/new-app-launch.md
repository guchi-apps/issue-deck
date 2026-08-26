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

### 相談の応答は、プロンプトではなく構造化出力で縛る（#2281）

相談は`lib/claude/`で唯一の多ターンの会話で、**履歴へ積み直すassistantの発言は`reply`の
地の文だけ**になる（画面が持っているのがそれだけのため）。モデルは自分の直前の発言が地の文
なのを見て**3往復目あたりから地の文で返し始め**、「Claudeの応答をJSONとして解析できません
でした」で会話が止まっていた。システムプロンプトに「JSONだけを出力してください」と書いても
効かない——実測で5回中4回、地の文が返る。

そこでリクエストに`output_config.format`（構造化出力）で`CONSULT_RESPONSE_SCHEMA`を渡し、
形をAPI側で縛る。同じ会話をスキーマ付きで投げると5回中5回JSONで返った。

- **`required`と`additionalProperties: false`は必須条件**で、どちらかを欠くとAPIがスキーマを
  受け付けない。まだ決まっていない項目は`anyOf`で`null`を許して表す（`type`の配列は使えない）
- `CLAUDE_CODE_OAUTH_TOKEN`（`user:inference`）で`/v1/messages`を直接叩く経路でも効く。
  対応モデルはClaude Haiku 4.5を含む（`lib/claude/`が使っているのはこれ）
- **`max_tokens`は2048**。返事＋仕様案で1024を超えると途中で切れ、切れた応答は必ず壊れたJSONに
  なる。`stop_reason`が`max_tokens`のときだけは「長すぎて途中で切れました」と原因の分かる
  文言で返す（「解析できませんでした」では短く言い直せばよいと分からない）
- **それでも地の文が返ってきたら、それを返事として扱って会話を続ける。** 詰まるのは会話の
  途中で、止めても利用者にできることが無い（仕様案が進まないだけで、設定ステップへは進める）

## 作られるもの（8件）

| 作られるもの | 場所 | 自動化 |
|---|---|---|
| リポジトリ | `guchi-apps/<name>` | 自動（`develop`既定・ラベル一式を写す・**雛形一式をコミット**） |
| 親Issue「◯◯の立ち上げ」 | `guchi-apps/issue-deck` | 自動 |
| ポート帯を足すPull Request | `guchi-apps/issue-deck` | 自動（`scripts/local-repo-ports.conf`へ1行） |
| プロジェクトを初期化する | 新しいリポジトリ | 自動（起票のみ。**実装は盤面から無人実行で回せる**） |
| 初回デプロイ前チェックと公開確認 | 新しいリポジトリ | 自動（起票のみ。同上） |
| VirtualHostを追加し、アプリ一覧に載せる | `guchi-apps/vps` | 自動（起票のみ） |
| `[手作業] サブPC: VPSへ受け入れる（置き場・DB・証明書）` | `guchi-apps/issue-deck` | 代行実行できる |
| `[手作業] サブPC: シークレットを投入する` | `guchi-apps/issue-deck` | 代行実行できる |

これに加えて、GitHub Appのインストール対象が`selected`のときだけ
`[手作業] ブラウザ: GitHub Appのインストール対象へ追加する`が9件目として作られる（#2248・#2246）。

**`guchi-apps/vps`のIssueだけは、同じ対象のopenなIssueが既にあれば作らない**（#2250。
後述「同じ対象のIssueが`guchi-apps/vps`に開いていれば、起票しない」）。そのときは既存Issueへ
コメントを書き足し、画面の一覧には「既存」の印を付けて出す。

手作業の2件（か3件）は`71.manual-step`ラベル付きで、親Issueのサブissueとして紐付く。
**進捗を追う専用の画面は持たない**——サブIssueはいつもの盤面と「ユーザーの作業待ち」に
出るので、同じ状態を2か所で持たない。

## 空振りの手順を出さない（#2246）

`aide-bot`の立ち上げ（#2213）では、手作業Issue 3件がそれぞれ人の着手を待つ形になっていた。
依存関係を洗い直すと、**実際に順序が必要なのは「初期化 → デプロイ」だけ**で、残りは
「Issueが分かれていたために直列に見えていた」か、**そもそも実施する必要が無い手順**だった。
とくに`#2215`（ブラウザの手作業）は5手順のうち独自に必要なものが実質1つも無かった。

外したものと、その根拠は次のとおり。**「一応書いておく」は選ばない**——不要な手順が1つでも
残っていると、それが済むまで後続が止まっているように見えるため。

| 外した手順 | 根拠 |
|---|---|
| DNSのAレコードの登録 | `*.gucchii.com`のワイルドカードAレコードを登録済み（`guchi-apps/vps#131`）。新しいサブドメインは追加登録なしで引ける |
| リポジトリごとのActions secretsの登録 | `OP_SERVICE_ACCOUNT_TOKEN`・`CLAUDE_CODE_OAUTH_TOKEN`・`WORKFLOW_PAT`はorganizationに`visibility=all`で登録済み |
| VPSへSSHしての置き場作成・`CREATE DATABASE`・`pm2 start`・certbot | `guchi-apps/vps`の「アプリをプロビジョニングする」ワークフローが実機の`scripts/provision-app.sh`を叩く（`guchi-apps/vps#132`） |
| 2つの再同期（リポジトリ・Issue） | 立ち上げ自身が実行する（#2248・`lib/new-app/resync.ts`） |
| Signalyのチャンネル作成とWebhook URLの登録 | `SIGNALY_WEBHOOK_URL`をorganization secretへ寄せた（#2255） |

**手順は外しても、確認は残す。** ワイルドカードのAレコードと共通secretは`## 完了の確認方法`の
コマンドとしてサブPCの手作業Issueへ移した（`sharedSecretCheck`・`wildcardDnsCheck`）。
`visibility`が`selected`へ戻されたときや、DNSが壊れたときに、定期巡回がそれを拾えるようにしておく。

### VPS実機の受け入れは、ワークフローへ流すだけにする

`guchi-apps/vps#132`が`scripts/provision-app.sh`と「アプリをプロビジョニングする」ワークフロー
（`workflow_dispatch`）を作ったので、issue-deckが出す手順は`gh workflow run`の1行になった。
`sudo`は`github-user`のNOPASSWD設定で通る（`guchi-apps/vps`のREADME「運用方針」）。

- **同じコマンドを2回流す。** スクリプトは冪等で、済んだ段は`(変更なし)`と出る。
  PM2への登録は`deploy/ecosystem.config.js`が配置されてからでないと進まないので、
  初回デプロイの前に1回、後にもう1回流す
- **実行するデバイスがサブPCになったので、手作業アシスタントの代行実行で流せる。**
  タイトルの先頭も`[手作業] VPS:`から`[手作業] サブPC:`へ変えている
  （CLAUDE.mdの`[手作業] <実行する場所>: <やること>`）
- **常駐プロセスを持たない種別（静的サイト）だけは、従来どおり実機の手順を出す。**
  ワークフローの`app_port`が必須で、`provision-app.sh`も1024〜65535を要求するため
  （`vpsProvisionable`）

## 自動化できないこと（そう決めた理由）

- **GitHub Secrets（`OP_SERVICE_ACCOUNT_TOKEN`など）の変更。** 無断で変更してよい設定ではない。
  ただし新規リポジトリでは**登録そのものが要らない**（organizationに`visibility=all`で
  入っている）。アプリ自身の値（配置先・DB名・許可メール）は後述のとおり自動で投入する。
- **GitHub Appのインストール対象への追加は、必要なときだけ残す**（#2248）。`issue-deck`・
  `issue-deck-dev`とも`repository_selection=all`で入っているので、新しく作ったリポジトリは
  何もしなくても対象に入る。`selected`へ戻されたとき（と選び方を読めなかったとき）だけ、
  ブラウザの手作業Issueを作る。**それ以外のときはIssue自体を作らない**（#2246。
  中身が空のIssueが人の着手を待つ形になっていた）。

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
（[cross-repo-setup-guide.md](cross-repo-setup-guide.md)）。これは次の節の雛形コミットで
作成時点から満たしている。

### リポジトリを作った直後に、雛形一式をコミットする

盤面へ載る条件（`claude-issue-dispatch.yml`）を作るのが初期化Issue自身だったため、以前は
初期化Issueだけが無人実行で回せず、実行経路をサブPCのローカルセッションに固定し、その前提と
してcloneと`local-repos.conf`への追記を`## 前提条件`に置いていた。**リポジトリを作った時点で
callerを置いてしまえば、初期化Issueも最初から無人実行で回せる**（#2247）。

- 置くファイルの宣言は[`lib/new-app/scaffold.ts`](../src/lib/new-app/scaffold.ts)、
  ワークフローの中身は[`lib/new-app/scaffold-workflows.ts`](../src/lib/new-app/scaffold-workflows.ts)、
  GitHubとのやり取りは[`lib/github/scaffold-api.ts`](../src/lib/github/scaffold-api.ts)。
- **雛形の正はissue-deck内に置く。** `uses:`のタグ（`workflows/vN`）と`prompts-ref`を揃え
  続ける必要があり、タグを切るのも配るのもissue-deck側だから。ただし
  **`.github/templates/`には置けない**——本番の配布物（`deploy.yml`の`tar`）に`.github/`は
  入らず、実行中のNext.jsサーバーからは読めない。TypeScriptのモジュールにしてビルド成果物へ
  入れている。
- **issue-deck自身が実物を持っているファイルは、写しを作らず`main`からそのまま配る**
  （`.github/scripts/signaly-notify.sh`・`scripts/update-env-file.sh`・
  `scripts/construct-database-url.sh`・`scripts/sync-github-secrets.sh`・
  `scripts/generate-workflow-env-block.sh`・`scripts/version-changelog.mjs`）。写しを置くと
  「実物を直したのに配られるのは古い写し」という食い違いが起こる（#2240で共有スクリプトの
  配布に同じ方針を採った）。**そのままでは置けない1行だけを、行を丸ごと指定して差し替える**
  （`sync-github-secrets.sh`の`REPO`の既定値）。目印が見つからなければ配らずに警告へ回す。
- **`develop`を切る前にコミットする。** そうすると`main`と`develop`の両方が最初から雛形を
  持つ（`develop`はこのコミットから枝分かれする）。
- **1コミットにまとめる**（Git Data APIのblob → tree → commit → ref）。Contents APIで
  1ファイルずつPUTすると、失敗したときに「どこまで置かれたのか」が履歴からしか分からない。
- **参照タグを読めなかったらcallerを1枚も置かない。** 存在しないタグを指すcallerは、置いた
  瞬間から全イベントで失敗し続ける。`warnings`で画面へ返す。
- **雛形のコミットに失敗しても立ち上げを止めない。** 初期化Issueの本文が従来の
  （サブPCのローカルセッション前提の）書き方へ切り替わる。
- **`.github/workflows/`への書き込みにはWorkflows権限が要る**（issue-deckのGitHub Appは
  `Workflows: Read and write`を持つ。[github-app-permissions.md](github-app-permissions.md)）。
  外れるとここだけが403で落ちる。

雛形に含めないものは3つ。**アプリ本体の雛形**（`create-next-app`が作るもの。空の
ディレクトリを前提にするため、初期化Issueが一時ディレクトリで作って取り込む）、
**アイコンのPNGとテーマカラーの確定**（#2254）、**自動修復系のcaller**（既存の
「設定＞フリート運用」から配る経路がある）。

**サブPCの手作業Issueは残る。** あちらの目的は1Passwordへの値の投入（#2249）で、雛形では
代われない。ただし初期化Issueの前提ではなくなり、`.github/secrets-manifest.tsv`が作成時点で
あるぶん、GitHubのsecretへの同期もその場で終わる。

### 失敗が静かに通るものは、雛形かIssue本文で先回りする（#2378）

`guchi-apps/trainroute`を**この機能を使わず手写しで**立ち上げたときに踏んだ3点は、いずれも
**失敗が警告どまりか、別の経路では成功する**ため、初期化を担当するエージェントが自力で
気づけない。テストや型チェックが通ることと動くことが別、という形で出てくる。

- **`typecheck`は`next typegen && tsc --noEmit`にする。** Next.js 16の`PageProps`・
  `LayoutProps`・`RouteContext`は`.next/types`へ生成されるグローバル型で、生成前は
  `Cannot find name 'LayoutProps'`になる。`next build`は内部で型生成するため、
  **ビルドは通るのに`typecheck`だけが落ちる**。初期化Issueにnpm scriptsごと書いてある
  （[`lib/new-app/plan.ts`](../src/lib/new-app/plan.ts)の`typecheckScript`）。
- **依存のビルドスクリプトは`pnpm-workspace.yaml`で承認済みにして始める。** pnpm 10系は
  依存の`install`/`postinstall`を既定で実行せず、**警告だけ出して終了コード0で素通りする**
  （実測: 未承認だと`Ignored build scripts: …`の枠が出るだけで`pnpm install`は成功扱い、
  `allowBuilds`を書くと`postinstall`が走る）。Prismaはこの段でクエリエンジンを取りに行く。
  承認は対話的な`pnpm approve-builds`でしか求められないので、CIでも無人実行でも承認漏れに
  気づけない。**効くのはCIとローカルだけで、VPSへは配られない**——`deploy.yml`が作るtarの
  中身（`scaffold-workflows.ts`の`archiveEntries`）にこのファイルは無く、本番で要る
  `prisma generate`はアプリ自身の`postinstall`（＝依存のビルドスクリプトではない）なので
  承認の対象外。**要否を確かめずに配布物へ足さないこと。** あわせて初期化Issueで
  `package.json`の`packageManager`を書かせる——`pnpm/action-setup@v4`もVPSの
  `corepack enable pnpm`も、ここを見てpnpmの版を決める。
- **初回の`main`マージが`v<version>`のタグを作る。** その後versionを上げずに次の
  `develop`→`main`を出すと、`deploy.yml`のtagジョブが`Tag v0.1.0 already exists`で落ちて
  本番デプロイが止まる。**雛形の`version-tag-check.yml`がmain宛PRのCIで先に落とす**ので、
  trainrouteが詰まったのは手写しでこのcallerが無かったから。初回デプロイ前チェックIssueには
  「リリースPRは`release-develop-to-main.yml`から作る」と書いてある。
  **初期versionを`0.0.0`にする案は採らなかった**——タグが無ければ`version-tag-check`は
  素通りするので、最初のリリースがリリースワークフローを通ることを強制できず、詰まる位置が
  1つずれるだけだった。
- **`release-develop-to-main.yml`と`version-tag-check.yml`は`multiAgent`で出し分けない**
  （Next.js系のみ）。どちらもリリース衛生のワークフローでエージェント運用とは関係がなく、
  雛形の`CLAUDE.md`も両方が存在する前提で一覧に載せている。fastapi・静的サイトは
  `version-file`の既定値（`package.json`）がそのままでは合わないため、現状のまま
  `multiAgent`に従わせてある。

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
**「登録されたか」を見ていなかった**こと。手作業Issueはいずれも、
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
- DNSの`dig`と共通secretの数え上げは、**手順を丸ごと外した後も確認だけ残してある**（#2246。
  サブPCの手作業Issueの`## 完了の確認方法`）。確認節に置いたものだけが代行実行・巡回の対象に
  なるので、ワイルドカードDNSやorganization secretが壊れたときはここが拾う
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

現在の分担は**vhostの追加と`-le-ssl.conf`の取り込み＝vps側、置き場・DB・PM2・certbot＝
プロビジョニングのワークフローを流すサブPCの手作業**で、DNSは分担ごと消えた（#2246）。
分担を固定するために、`guchi-apps/vps`のIssueへ**「このIssueが持たない作業」の表を置いた**。
読んだ人・エージェントが、足りない手順を見つけたときに新しいIssueを立てず、担当のIssueへ
書き足せるようにする。

**1件へ統合はしない。** `guchi-apps/vps#132`（プロビジョニングの受け口）が入ったことで
置き場・DB・PM2・certbotはワークフロー1本になったが、`-le-ssl.conf`の取り込みは
`guchi-apps/vps`のリポジトリへのコミットなので、担当はvps側のままにする。

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
VPS受け入れの手作業Issueに「実行ログの末尾『リポジトリへ取り込む差分』を控えてvpsのIssueへ
コメントする」手順を置き、vpsのIssue側に2段目として取り込みを書いてある
（`provision-app.sh`が取り込むべき`:80`・`:443`両方の内容をそのまま貼れる形で出力する）。

**`:443`側の`X-Forwarded-Proto`は`"https"`でなければならない**（#2253）。certbotは`:80`の
VirtualHostをそのまま`:443`へ複製するため、`RequestHeader set X-Forwarded-Proto "http"`が
残る。アプリは自分を`http://`だと誤認し、生成したリダイレクトURIが登録済みの`https://`と
一致せず、**本番でだけOAuthログインが失敗する**。共有知識には2026-08-09の時点で記録があった
（`guchi-apps/docs`の`knowledge/deployment.md`）のに、生成する手順に入っていなかったのが
`guchi-apps/vps#124`で顕在化した理由。**認証の有無にかかわらず必ず通す**（後から認証を足す
アプリがあるため）。

現在は`scripts/provision-app.sh`がcertbotの直後にこれを直すので（`guchi-apps/vps#132`）、
issue-deckが手順として書くのは**プロビジョニングのワークフローを使えない種別（静的サイト）
だけ**になった（#2246）。

## 失敗したときの扱い

**途中で失敗しても、作り終えたものは消さない。** 作成済みのリポジトリ・Issueを`created`として
返し、画面はそれをリンクとして出す。自動で消すと、名前だけ取られたのか何も起きていないのかが
分からなくなる。**同じ内容での押し直しもしない**（リポジトリの作成で弾かれる）。続きは
作られたIssueから人が進める。

サブIssueの紐付けだけは失敗しても止めない——紐付きが欠けても各Issueは独立して読める。
