# GitHub Organizationへの移行を検討する

**いつ読むか**: リポジトリのownerを個人アカウント`m-guchi`からOrganizationへ移すかどうかを判断するとき。
GitHub Projectsによる進捗管理（#991）や、privateリポジトリをマルチエージェント運用へ載せる可否を考えるとき。

issue #991 の前提整理として行った調査。**コード変更は行わず、調査結果のドキュメント化のみを行う。**
移行作業そのものの実施記録ではなく、実施するかどうかを判断するための材料である。

## 背景

#991「進捗管理をGitHub Projectsのカンバンへ移行できるか検討」を調べる過程で、**`m-guchi`が
Organizationではなく Userアカウントであること**が、この構想の成立条件を大きく変えると分かった。

GitHubのProjects v2は、Organization所有かUser所有かで使えるAPI・Webhook・トークンが大きく異なる。
Userアカウントのままでは、issue-deckが今使っている「Webhookで受けてDBへ反映し、GitHub Appの
インストールトークンで書き戻す」という経路がそのまま使えず、**GraphQLポーリング＋classic PATの
全リポジトリ配布＋OAuthスコープ追加による全ユーザー再ログイン**という別系統の認証・同期経路を
丸ごと追加することになる。

したがって#991の是非は、その前段にある「Organizationへ移るかどうか」に依存する。この依存関係を
先に片付けるため、#991は保留し、Organization移行そのものを本ドキュメントで整理する。

あわせて「privateリポジトリのうちいくつかをマルチエージェント運用の対象にしたい」という論点も
挙がっているため、privateリポジトリの扱いと費用対効果もここで扱う。

## 現状の棚卸し

すべて`gh`コマンドによる実測（2026-08-10時点）。

| 項目 | 実測値 | 確認方法 |
|---|---|---|
| アカウント種別 | **User**（Organizationではない） | `gh api /users/m-guchi` → `"type": "User"` |
| プラン | **personal Free**（Proではない） | `gh api /repos/m-guchi/docs/branches/main/protection` → `403 Upgrade to GitHub Pro or make this repository public` |
| リポジトリ数 | public 21 / private 16（うち7はarchived） | `gh repo list m-guchi --limit 200` |
| アプリ系リポジトリの可視性 | `issue-deck`・`car-care`・`asset-manager`・`dayspan`・`shopping-list`は**すべてpublic** | `gh api /repos/m-guchi/<name>` |
| issue-deckの`develop` | ブランチ保護あり（必須チェック`lint-and-build`） | `gh api /repos/m-guchi/issue-deck/branches/develop/protection` |

稼働中でGitHub Actionsを持つprivateリポジトリは4件。

| リポジトリ | 内容 | ワークフロー |
|---|---|---|
| `ops-dashboard` | VPS稼働状況・監視ダッシュボード | `ci.yml`・`deploy.yml` |
| `vps` | VPS本体のインフラ設定（Apache / systemd / MySQL / cron） | `deploy.yml`・`drift-check.yml`・`pr-diff-check.yml` |
| `db-console` | スマートフォン向けMariaDB管理画面 | `ci.yml`・`deploy.yml`・`release.yml` |
| `clip-hive` | 動画管理PWA | `ci.yml`・`deploy.yml`・`release.yml` |

`docs`（共有知識層）・`uptime-kuma`・`pi0w_260719`・`sensor_260531`・`sensor_260218`はワークフローを持たない。
thesis系・tyuujitu系の7件はarchived。

## Organization化で得られるもの

### 1. Projects v2のWebhookとGitHub Appトークン（#991の前提）

| 事実 | 根拠 |
|---|---|
| `projects_v2` / `projects_v2_item` Webhookは**Organization webhookとGitHub App限定**。必要権限はProjectsの**organization permission** | GitHub Docs [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) |
| fine-grained PATに**userアカウントレベルのProjects権限は存在しない**（Projectsはorganization permissionのみ） | GitHub Docs [Permissions required for fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) |
| Projects v2は**GraphQLのみ**（RESTなし）。必要スコープは`read:project`（参照）/ `project`（更新） | GitHub Docs [Using the API to manage Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects) |
| GraphQLのレート上限は5,000 points/hour（Appインストールあたり、最大12,500） | GitHub Docs [Rate limits for the GraphQL API](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api) |

Userアカウントのままだと、上記の帰結として次の3つが同時に効いてくる。

- **Status変更のWebhookを受け取れない。** カンバンをドラッグして動かしてもissue-deckには届かず、
  GraphQLポーリングで拾いに行くしかない。表示に遅延が出るうえ、`/api/webhooks/github`という
  既存の取り込み経路に乗らない別系統を作ることになる。
- **GitHub Appのインストールトークンが使えない。** ユーザー所有Projects v2へのアクセスは公式に
  案内されておらず、実質`project`スコープ付きのclassic PATかOAuthユーザートークンに限られる。
- **OAuthスコープの追加が要る。** issue-deckの現在のスコープは`repo user:email`
  （[src/lib/supabase/github-oauth.ts](../src/lib/supabase/github-oauth.ts)）。`project`を足すと
  全ユーザーの再ログインが必要になる。

Organizationであれば、いずれもGitHub Appのorganization permission「Projects」で解決し、
既存のWebhook・Appトークンの延長線上で実装できる。

### 2. Organization secretsによるシークレットの一元管理

現在、`WORKFLOW_PAT`・`OP_SERVICE_ACCOUNT_TOKEN`・`CLAUDE_CODE_OAUTH_TOKEN`はリポジトリごとに
設定している。クロスリポジトリ運用（[cross-repo-setup-guide.md](cross-repo-setup-guide.md)）で
対象リポジトリが増えるほど、配布と更新の手間が線形に増える。Organization secretsにすれば1箇所で済む。

ただし**GitHub Freeでは、organization secretsをprivateリポジトリから参照できない**
（GitHub Docs [Use secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)）。
publicリポジトリからは Free でも参照できるため、issue-deck・car-care・asset-manager・dayspan・
shopping-listについては**費用ゼロでこの利点が得られる**。

### 3. Organizationルールセット

リポジトリ横断のルールセットをorganizationレベルで定義できる。ただしprivateリポジトリへの
適用は有料プランが必要。

## privateリポジトリの扱いと$4/月の費用対効果

ここが判断の核心になる。

### プラン比較

| | privateでブランチ保護・必須レビュアー・CODEOWNERS | organization secretsをprivateで使用 | Projects v2のWebhook / Appトークン | Actions分/月 | 費用 |
|---|---|---|---|---|---|
| personal Free（現状） | ✗ | — | ✗ | 2,000 | $0 |
| personal Pro | ✓ | — | ✗ | 3,000 | **$4/月** |
| Organization Free | ✗ | ✗ | ✓ | 2,000 | $0 |
| Organization Team | ✓ | ✓ | ✓ | 3,000 | **$4/月** |

根拠: GitHub Docs [GitHub's plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans) /
[FAQ about changes to GitHub's plans](https://docs.github.com/en/get-started/learning-about-github/faq-about-changes-to-githubs-plans)。
GitHub Proは$4/月、GitHub Teamは$4/user/月で、**5席の最低条件は撤廃済み**のため1人なら$4/月。

つまり「privateリポジトリでブランチ保護を使いたい」なら、Organization化するかどうかに関わらず
$4/月が必要になる。**Org化はこの費用を増やさない。**

### $4/月で実際に増えるものは2つだけ

Organization Free（$0）とOrganization Team（$4/月）の差分を実測ベースで詰めると、次のようになる。

**(a) #991の目的には$4は不要。**
Projects v2のWebhookとAppトークンはOrganization Freeで手に入る。カンバン移行だけが目的なら費用ゼロで完結する。

**(b) organization secretsの一元管理は、publicリポジトリなら Free で効く。**
$4で増えるのはprivate 4件（`ops-dashboard`・`vps`・`db-console`・`clip-hive`）の分だけ。

**(c) Actions分数の増枠には価値がない。**
直近30日のprivate 4リポジトリの実行時間合計は**約199分**だった（`gh api /repos/.../actions/runs`の
`run_started_at`〜`updated_at`から集計）。

| ops-dashboard | vps | db-console | clip-hive | 合計 |
|---|---|---|---|---|
| 44分 | 72分 | 54分 | 29分 | 199分 |

課金はジョブ単位の切り上げなので実際は1.5〜2倍として300〜400分程度。Freeの2,000分に対して
十分な余裕があり、3,000分への増枠は意味を持たない。publicリポジトリのActionsは分数を消費しない。

**(d) ブランチ保護が無くても、マルチエージェント運用は壊れない。**
privateリポジトリでブランチ保護が使えないことで壊れるのは、
[.github/workflows/claude-review-develop.yml](../.github/workflows/claude-review-develop.yml)の
`auto-merge`ジョブが実行する`gh pr merge --auto --merge`の1行だけである。
しかも失敗時の受け皿として`auto-merge-fallback`ジョブが既に実装されており、PRへ
「手動でマージしてください」とコメントする経路がある。

したがってprivateリポジトリでも、実装・PR作成・レビュー・CI・Issueコメント・ラベル遷移は
**すべてそのまま動き**、最後のマージだけ人間がissue-deckの画面からPRリンクを開いて1クリックする形になる。
これは`00.check-user`が付与されたときの既存運用とまったく同じ挙動で、新しく覚えることは無い。

失うのは「マージの自動化」だけ。年$48（約7,000円）をそこへ払うかどうか、という判断になる。

### public化での回避は部分的にしか効かない

「privateをpublicにすれば$0で全部解決する」という筋もあるが、全件には適用できない。

| リポジトリ | public化の可否 |
|---|---|
| `vps` | **不可。** Apache / systemd / MySQL / cronの実体設定であり、サーバー構成が露出する |
| `docs` | 不可に近い。全アプリ共通の運用知識で、個人運用の前提を多く含む |
| `ops-dashboard` | 要判断。監視対象ホスト名等の露出可否による |
| `db-console` | 要判断。DB構成の露出可否による |
| `clip-hive` | **現実的。** car-care・dayspan等と同性質の個人向けアプリで、既にpublicにしているものと変わらない |

`vps`と`docs`がprivate必須である以上、public化だけでは片付かない。

### 移行対象の切り分け

archivedな大学系7件（thesis系・tyuujitu系）は個人の資産であり、アプリ運用とは無関係なので
**個人アカウントに残す**のが妥当。移行対象は稼働中のリポジトリに絞る。

## 移行の影響範囲

### 書き換えが必要な箇所（実行パスに影響するもの）

リポジトリ全体を洗った結果、**実行パスに影響する`m-guchi`のハードコードは6箇所のみ**だった。

| # | 箇所 | 内容 |
|---|---|---|
| 1 | [.github/workflows/reusable-issue-dispatch.yml:708](../.github/workflows/reusable-issue-dispatch.yml) | `repository: m-guchi/issue-deck`（リポジトリ内で唯一のowner直書き。他リポジトリから呼ばれたときに`.github/prompts/`を取得する経路） |
| 2 | [scripts/check-label-diff.sh:6](../scripts/check-label-diff.sh) | `SOURCE_REPO="m-guchi/issue-deck"` |
| 3 | [scripts/start-issue.sh:64](../scripts/start-issue.sh) | `gh issue view --repo m-guchi/issue-deck` |
| 4 | [scripts/start-reviewer.sh:48](../scripts/start-reviewer.sh) | `gh pr list --repo m-guchi/issue-deck` |
| 5 | `.claude/skills/release-to-main/SKILL.md:10` | `gh api repos/m-guchi/issue-deck/branches/develop` |
| 6 | **リポジトリ外**: `m-guchi/shopping-list/.github/workflows/issue-labels.yml` | `uses: m-guchi/issue-deck/.github/workflows/reusable-issue-labels.yml@workflows/v1` |

加えて、表示のみの参照（[cross-repo-setup-guide.md](cross-repo-setup-guide.md)の`uses:`スニペット・
[supported-repositories.md](supported-repositories.md)の一覧・[shared-knowledge.md](shared-knowledge.md)の
提案テンプレート）と、各開発環境のローカル`git remote`。

### 影響を受けないことが確認できた領域

移行の心理的ハードルを下げるうえで重要なので、確認済みの範囲を明記しておく。

- **VPSデプロイ**: `scp`でアーカイブを転送して`tar`展開する方式。`deploy.yml`・`deploy-preview.yml`・
  `deploy/`・`Dockerfile`に対する`git clone|pull|remote|fetch`の検索ヒットは**0件**で、
  VPS上にリポジトリのクローンが存在しない。ownerが変わっても何も起きない。
- **アプリの本番コード**: ownerのハードコードなし。ownerはGitHub Appのインストール情報から取得して
  DB（`GithubInstallation.accountLogin` / `Repository.ownerLogin`）へ永続化し、各APIはそこから読む。
  [src/app/github/setup/route.ts](../src/app/github/setup/route.ts)の`toAccountType()`は
  `ORGANIZATION`を**最初から実装済み**で、[src/lib/github/app-auth.ts](../src/lib/github/app-auth.ts)は
  App IDと秘密鍵のみを使いインストール先アカウントに非依存。
  （`src/components/dashboard/create-issue-dialog.tsx`の`DEFAULT_ASSIGNEE = "m-guchi"`は
  assignee＝個人ユーザーのloginであってownerではないため、変更不要。）
- **ワークフロー内の`gh`コマンド**: すべて`${{ github.repository }}`経由でownerのリテラル指定は0件。
  `scripts/check-workflow-gh-repo.sh`（CIで実行）がこの規約を静的に強制している。
- **シークレット**: `op://apps/...`の参照パス・`.env.local.example`・`.github/*.env.tpl`は
  すべてowner非依存。
- **リポジトリtransferで引き継がれるもの**: Issue / PR / Wiki / Star / Watcher / コミット履歴 /
  **Webhook・secrets・deploy key** / 旧URLからのリダイレクト（`git clone`・`push`を含む）。
  GitHub Docs [Transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository) 参照。

### 手当てが必要なもの

- **GitHub Appのorganizationへの再インストール。** リポジトリのtransferではApp
  インストールは追従しない。org側でインストールし、対象リポジトリを選択し直す。
  App自体（App ID・秘密鍵・Webhook URL）は変更不要なので、`.env`や1Password側の値はそのまま使える。
- **Supabase Authが使うOAuth Appに対する、organizationのサードパーティアクセス許可。**
- **ブランチ保護ルールの再確認。** transfer後に必須ステータスチェックが維持されているか確認する。
- **ローカル`git remote`の更新。** 本体リポジトリと`~/apps/issue-deck-worktrees/`配下の各worktree。
  リダイレクトは効くが、明示的に更新しておくほうが混乱がない。

## 移行手順案

依存の少ないものから順に進め、各段階で疎通を確認してから次へ進む。

1. **Organizationを作成する**（GitHub Free、$0）。名前を決める（`m-guchi`とは別の名前が必要）。
2. **GitHub Appをorganizationへインストールする。** この時点ではまだリポジトリを移していないので、
   インストールだけ済ませておく。
3. **影響の小さいリポジトリを1件transferして検証する。** ワークフローを持たないもの
   （`uptime-kuma`など）で、URLリダイレクト・Appの認識・issue-deckの画面表示を確認する。
4. **issue-deckをtransferする。** 上記「書き換えが必要な箇所」の1〜5を修正し、
   Actions（CI・deploy・issue-labels）が通ることを確認する。
5. **`shopping-list`をtransferする。** issue-deckより後にする。caller側の
   `uses: <org>/issue-deck/.github/workflows/reusable-issue-labels.yml@workflows/v1`の更新が要るため。
6. **残りのアプリリポジトリ**（car-care・asset-manager・dayspan）と`docs`をtransferする。
   `docs`はワークフローを持たないが、`SHARED_CONTEXT_REPO`の既定値`m-guchi/docs`を参照している箇所
   （`reusable-issue-dispatch.yml`・`claude-review-develop.yml`・`shared-knowledge-propose.yml`）が
   あるため、リポジトリ変数`SHARED_CONTEXT_REPO`で上書きするか既定値を書き換える。
7. **privateリポジトリ**（`ops-dashboard`・`vps`・`db-console`・`clip-hive`）を移すかを判断する。
   移す場合、ブランチ保護は使えないままなので、マルチエージェント運用に載せる際は
   最後のマージを手動にする（前述の`auto-merge-fallback`経由）。
8. **ローカル`git remote`とドキュメント・スクリプトの参照を更新する。**
9. archivedな大学系7件は個人アカウントに残す。

## ロールバック策

リポジトリは個人アカウントへtransferで戻せる。戻すときも同様にURLリダイレクトが張られ、
Issue・PR・コミット履歴・secretsは保持される。必要になるのはGitHub Appの再インストールと
`git remote`の再更新で、いずれも移行時と同じ作業になる。

各段階で確認しておくべき点。

- **手順3で止めれば影響はほぼゼロ。** 検証用の1件を戻すだけで済む。
- **手順5以降は`shopping-list`側のcallerも巻き戻す必要がある。** タグ固定参照（`@workflows/v1`）の
  owner部分を戻す。
- **Organization自体は削除できる**（リポジトリを空にしてから）。Free planなので解約手続きも不要。

戻せない類のものは確認した範囲では見当たらなかったが、実際に移す前にGitHub Pagesを使っている
リポジトリが無いかだけは再確認する（Pagesはtransfer時にリダイレクトされない）。

## 結論と選択肢

**選択肢A: 現状維持（User + Free）**
#991は「GraphQLポーリング＋classic PATの全リポジトリ配布＋OAuthスコープ追加による全ユーザー
再ログイン」を受け入れて実装するか、断念するかの2択になる。privateリポジトリは
ブランチ保護が無いままで、マルチエージェント運用に載せるなら最後のマージは手動になる。
費用$0だが、#991のコスト対効果が最も悪くなる選択肢。

**選択肢B: Organization Freeへ移行（推奨）**
Projects v2のWebhookとGitHub Appトークンが使えるようになり、#991が既存の
Webhook・Appトークンの延長線上で素直に解ける。publicリポジトリについては
organization secretsの一元管理も手に入る。費用$0。
privateリポジトリの制約（ブランチ保護なし・organization secrets不可）は現状と変わらない。

**選択肢C: Organization Team（$4/月）へ移行**
Bに加えて、privateリポジトリでもブランチ保護とorganization secretsが使える。
privateリポジトリのマージまで自動化できる。

### 推奨

**Bを既定とし、privateリポジトリを無人運用に載せたくなった時点でCへ上げる。**

Free → Teamはいつでも切り替えられるため、先に払う理由がない。$4/月で追加的に得られるものは、
実測にもとづくと次の2点に絞られる。

- privateリポジトリ4件の「最後のマージ1クリック」の自動化
- privateリポジトリ4件でのorganization secrets

Actions分数の増枠は実測上不要（199分/月に対して2,000分）、publicリポジトリの
organization secretsはFreeで足りる。まずBで移行し、privateリポジトリを実際に運用へ載せてみて
手動マージが煩わしいと感じた時点でCへ上げるのが、費用対効果として合理的である。

## 参考リンク

- GitHub Docs: [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)（`projects_v2_item`の提供条件）
- GitHub Docs: [Using the API to manage Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- GitHub Docs: [Permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- GitHub Docs: [Use secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)（organization secretsのプラン制約）
- GitHub Docs: [GitHub's plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans) / [FAQ about changes to GitHub's plans](https://docs.github.com/en/get-started/learning-about-github/faq-about-changes-to-githubs-plans)
- GitHub Docs: [Transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository)
- GitHub Docs: [Rate limits for the GraphQL API](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api)
- 関連ドキュメント: [github-app-permissions.md](github-app-permissions.md)（GitHub Appの権限棚卸し）・[cross-repo-setup-guide.md](cross-repo-setup-guide.md)（他リポジトリへの展開手順）・[supported-repositories.md](supported-repositories.md)（導入済みリポジトリの記録）
