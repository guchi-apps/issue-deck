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
| 3. 確認 | 作られるもの7件を「自動 / 代行できる / あなたが実行」の内訳付きで出す | [`lib/new-app/plan.ts`](../src/lib/new-app/plan.ts) |

**相談と設定を同じ画面に混ぜない。** 会話しながら横で仕様が埋まっていく形も検討したが、
スマホでは会話と設定の両方を1画面に収めることになる。相談を先に終えて値を引き渡す形なら、
どちらのステップも393pxに素直に収まる。

**相談で決まっていない項目は空のまま渡す**（`normalizeDraft`が知らない値・使えない値を
`null`へ落とす）。埋めさせると、聞かれていない前提が既定値として設定ステップへ流れ込む。

## 作られるもの（7件）

| 作られるもの | 場所 | 自動化 |
|---|---|---|
| リポジトリ | `guchi-apps/<name>` | 自動（`develop`既定・ラベル一式を写す） |
| 親Issue「◯◯の立ち上げ」 | `guchi-apps/issue-deck` | 自動 |
| プロジェクトを初期化する | 新しいリポジトリ | 自動（起票のみ。実装はサブPCのローカルセッション） |
| VirtualHostを追加し、アプリ一覧に載せる | `guchi-apps/vps` | 自動（起票のみ） |
| `[手作業] VPS: 置き場とプロセスを用意する` | `guchi-apps/issue-deck` | あなたが実行 |
| `[手作業] サブPC: cloneして対応表に載せる` | `guchi-apps/issue-deck` | 代行実行できる |
| `[手作業] ブラウザ: DNSとシークレットを登録する` | `guchi-apps/issue-deck` | あなたが実行 |

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
- **1Password・GitHub Secrets・GitHub Appのインストール対象。** 無断で変更してよい設定ではない。

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
