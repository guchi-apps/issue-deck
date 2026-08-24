# GitHubの課金を増やさないための決まりごと

`guchi-apps` organization（Teamプラン）で、**リポジトリの設定ひとつで月額課金が発生する項目**を
記録する。どれも「機能を有効にしたこと」ではなく「privateリポジトリで有効にしたこと」が課金の
条件になっており、気付かないまま増える。organization化そのものの費用対効果（$4/月の判断）は
[docs/organization-migration.md](organization-migration.md)を参照。

## 原則: privateで有効にすると課金される機能がある

| 機能 | publicリポジトリ | privateリポジトリ |
|---|---|---|
| GitHub Actions | 標準ランナーなら**無料**（分数を消費しない） | 無料枠3,000分/月を消費し、超過は従量課金 |
| secret scanning / push protection | **無料** | GHAS `Secret Protection`として**$19/月**（下記） |

どちらも「publicにすれば無料」で共通しているが、**publicにできないリポジトリでは機能ごと
落とすしかない**。`vps`・`docs`のようにprivate必須のものがある以上、public化だけでは片付かない
（[organization-migration.md](organization-migration.md)「public化での回避は部分的にしか効かない」）。

## secret scanningはprivateだとGHAS `Secret Protection`の課金対象（#2098）

**課金はリポジトリ数ではなく「有効なリポジトリへコミットしたアクティブコミッターの数」で決まる。**
1人が2つのprivateリポジトリで有効にしていても$19/月だが、**片方だけ無効にしても$19/月のまま**で、
有効なリポジトリが1つも残らなくなって初めて$0になる。この性質のため「1件ずつ直す」と、
最後の1件が片付くまで請求額はまったく動かない。

- 実際に2026-08-14から課金が始まり、`uptime-kuma`と`clip-hive`の2件だけが`enabled`だった
  （他のprivate 8件は`disabled`）。日割りで計上され、8日ぶんで$4.90
- organizationの既定（`secret_scanning_enabled_for_new_repositories`）は`false`で、
  「GitHub recommended」のセキュリティ構成もどのリポジトリにも適用されていない。
  つまり**リポジトリごとに個別に有効化されたもの**であり、無効にすれば再有効化されない
- 無効化すると**push protection（誤ってトークンをpushしたときの阻止）も同時に失われる**。
  実シークレットをリポジトリに置かず1Passwordと`.env`に置く運用（`CLAUDE.md`「シークレットの
  扱い」）が守られている前提でのみ、落としてよい判断になる

### 確認コマンド

```bash
# privateリポジトリの有効・無効を一覧する（enabledが1件でもあれば課金される）
for r in $(gh api "orgs/guchi-apps/repos?per_page=100&type=private" --jq '.[].name'); do
  printf "%s: " "$r"
  gh api "repos/guchi-apps/$r" --jq '.security_and_analysis.secret_scanning.status'
done

# 課金の発生状況（ghasの行が出なくなれば止まっている。反映は翌日）
gh api "/organizations/guchi-apps/settings/billing/usage?year=2026&month=8" \
  --jq '.usageItems[] | select(.product == "ghas")'

# 無効化する
gh api -X PATCH repos/guchi-apps/<リポジトリ名> --input - <<'JSON'
{"security_and_analysis":{"secret_scanning":{"status":"disabled"},
 "secret_scanning_push_protection":{"status":"disabled"}}}
JSON
```

**課金レポートは即時に反映されない。** 無効化した当日ではなく翌日以降に上のコマンドを実行して、
`product == "ghas"`の行が増えていないことを確認する。

## Actions分数はpublic化で実質ゼロになっている

2026-08時点で、org全体のActions実行 約25,800分のうちpublicぶん（約24,300分）は全額割引で
$0になっており、**Actionsの課金はorg全体でnet $0.00**だった。無料枠の逼迫はprivateリポジトリ
（`ops-dashboard`・`clip-hive`・`db-console`）に集中していたため、public化で解消した
（guchi-apps/ops-dashboard#120・guchi-apps/clip-hive#51）。

**ただし無料枠は2026-08-23に枯れ、以後はprivateリポジトリの全量が課金される**（#2294。
割引額が0になり、`vps` 265分・`docs` 113分・`claude-config` 75分・`subpc` 66分が
1日で$2.4になった）。**public化していないリポジトリが残っている限り、この状態は毎月続く。**

privateのまま残すリポジトリでActionsの分数が問題になった場合、`schedule`の間引きとジョブの
統合で削れるのは実測で3割程度にとどまる。**分数を根本的に減らしたいなら、その定期実行を
Actionsの外へ出せないかを先に考える**（下記#2294）。出せないならpublic化を検討し、
それもできないなら実行そのものを減らす。

### 画面から見る（#2212）

issue-deckの設定 ▸「状態」▸ GitHub使用量の`ACTIONS`に、今日・今月の実行時間とリポジトリ別の
内訳が出る。**上のコマンドを叩かなくても、課金が出ているリポジトリは金額付きで並ぶ。**
取得元は上の確認コマンドと同じ`/organizations/{org}/settings/billing/usage`で、実装は
[`src/lib/github/actions-billing.ts`](../src/lib/github/actions-billing.ts)。

### 課金レポートのAPIで気を付けること

- **旧`/orgs/{org}/settings/billing/actions`は410（This endpoint has been moved）を返す。**
  新しい課金プラットフォームの`/organizations/{org}/settings/billing/usage`に置き換わっており、
  **無料枠（`included_minutes`）を返す手段はもう無い**
- **classicのOAuthトークン・PATでしか読めない**（実測）。必要なスコープは`repo`または`admin:org`
  （応答の`X-Accepted-Oauth-Scopes`）。GitHub Appのインストールトークンは
  `403 Resource not accessible by integration`になり、GitHubのドキュメントにも
  fine-grained権限の記載が無い。**Supabase Authが使っているGitHubの資格情報はGitHub App**
  （`<SUPABASE_URL>/auth/v1/authorize?provider=github`のリダイレクト先の`client_id`が`Iv23li…`）
  なので、**issue-deckが保持しているユーザートークンでも読めない**（`signInWithOAuth`の
  `scopes: "repo user:email"`はGitHub Appでは無視される）。そのため画面の`ACTIONS`だけは
  専用のclassic PAT（`GITHUB_BILLING_TOKEN`）で読む。未設定ならその表示だけが無効になる
- 個人アカウントは`/users/{username}/settings/billing/usage`で、`user`スコープが要る（別物）
- **レポート単体ではpublicとprivateを区別できない。** どちらも「grossの全額がdiscountで相殺されて
  net 0」という同じ形になる。ただし明細は`repositoryName`を持ち、public/privateは
  `Repository.private`としてDBにあるので、**突き合わせれば無料枠3,000分に対する残量は出せる**
  （画面には出していないだけ。「できない」ではない）
- **反映は半日ほど遅れる。** 2026-08-23 14:18Zの時点で最新の明細は01:55Zで、その間に
  issue-deckだけで372回の実行があった。**「今日」の数字をそのまま出すと「今日はほとんど回して
  いない」と誤読される**ため、画面には最後の明細の時刻（`lastReportedAt`）を必ず添える
- `year`・`month`を付けると明細が発生時刻の粒度で返る（2026年8月分で356件・約97KB）。
  付けないと月単位に丸められるが、リポジトリが一部しか返らないため付けて呼ぶ

## `schedule`は「対象0件でも」課金される（#2294）

**Actionsの課金はジョブ単位で、1分未満は1分に切り上げられる。** 実際に何もしなかったジョブも、
起動した以上は1分ぶんが課金される。**skipされたジョブは課金されない**（ランナーを取らないため）
ので、効くのは「起動した」ジョブの数だけになる。

2026年8月に無料枠が枯れた時点で、privateリポジトリのActions課金のほぼ全部が
`issue-labels.yml`（ワークフロー名: Issue Progress）の15分ごとのcronだった。

- 呼び出し先の`reusable-issue-labels.yml`は11ジョブだが、`schedule`で起きるのは
  `develop-merge-sweep`と`manual-step-label`の2つだけ。残り9つはskipで課金されない
- その2つの実測は20秒・5秒。それでも切り上げで**1回の実行あたり2分**が課金される
- cronを持つprivateリポジトリは`vps`・`subpc`・`docs`・`claude-config`の4件。
  `claude-config`は他にワークフローを持たず、月間消費180分すべてがこれだった。
  `docs`も月306実行のうち301がIssue Progressで、月間消費302分とほぼ一致する

**対処は「間引き」ではなく「Actionsの外へ出す」。** どちらのジョブも定期的に全体を見直す
安全網で、GitHubのイベントとは無関係に動けばよい。issue-deckには同じ形の巡回が既に2本あった
（コンフリクト巡回#2116・デプロイ失敗巡回#2236。サブPCのpollerが1巡ごとにissue-deckのAPIを
叩き、issue-deckが連携済みリポジトリ全部を見る）ので、その3本目として
`POST /api/issues/progress-sweep`へ移した（[progress-status-architecture.md](progress-status-architecture.md)
「取り残しの回収はissue-deck側の巡回が担う」）。

- **cronはcaller側（各リポジトリの`issue-labels.yml`）にあり、issue-deckから配る仕組みが無い。**
  それでも課金は止まる——reusable側に`schedule`で動くジョブが1つも無くなれば、cronが起きても
  全ジョブがskipになるため。**caller側のcronを消して回る必要はない**（空のrunが並ぶだけ）
- **公開リポジトリぶんの無駄も同時に消える。** 課金されていなかっただけで、フリート全体では
  月4万分規模のランナー時間をこの2ジョブが使っていた
- **確認方法**は下記の「1回の実行で何分課金されたかを見る」

### 1回の実行で何分課金されたかを見る

```bash
# 直近のscheduleのrunを1本取り、ジョブごとの実行・skipを見る
rid=$(gh api "repos/guchi-apps/<repo>/actions/workflows/issue-labels.yml/runs?event=schedule&per_page=1" \
  --jq '.workflow_runs[0].id')
gh api "repos/guchi-apps/<repo>/actions/runs/$rid/jobs" \
  --jq '.jobs[] | "\(.name)\t\(.conclusion)\t\(.started_at)→\(.completed_at)"'
```

`conclusion`が`skipped`のジョブは課金されない。`success`／`failure`のジョブの数が、
そのまま**そのrunの課金分数の下限**（1ジョブ＝最低1分）になる。

**ワークフロー別の内訳は実行回数から見る。** 課金レポート（下記API）はリポジトリ単位までしか
分けてくれないため、どのワークフローが食っているかは実行回数で当たりを付ける。

```bash
gh api "repos/guchi-apps/<repo>/actions/runs?per_page=100&created=>=2026-08-23" \
  --jq '[.workflow_runs[] | {n:.name, e:.event}] | group_by(.n)
        | map("\(.[0].n): \(length) (\([.[].e]|unique|join(",")))") | .[]'
```

## 新しくリポジトリを作るときの確認

- **privateで作るなら、secret scanning / push protectionを有効にしない。** 有効にした瞬間から
  $19/月が始まる。GitHubのUIから「Enable」を押すだけで有効になるため、意図せず踏みやすい
- **publicで作るなら、両方とも有効にしてよい**（無料）
- private必須かどうかは、接続先の構成情報（ホスト名・ポート・ユーザー名・DB名・内部エンドポイント）が
  含まれるかで判断する。単体では資格情報でなくとも、このフリートではsecret扱いにしている
  （`CLAUDE.md`「シークレットの扱い」）
