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
| 6 | **リポジトリ外**: `shopping-list`・`dayspan`のcaller計4ファイル | `uses: m-guchi/issue-deck/.github/workflows/reusable-*.yml@workflows/vN`。shopping-list: `issue-labels.yml:34`（v1）・`claude-issue-dispatch.yml:46`（v6）、dayspan: `issue-labels.yml:33`（v6）・`claude-issue-dispatch.yml:37`（v6）。いずれも実測で確認済み |

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

### `WORKFLOW_PAT`はresource ownerを1つしか持てない（移行の順序を縛る制約）

`secrets.WORKFLOW_PAT`は**Fine-grained PAT**で、Repository accessは「All repositories」
（[actions-token-model.md](actions-token-model.md#3-7-そもそも-fine-grained-pat-はリポジトリを明示追加しないと読めない)・
[multi-agent-workflow.md](multi-agent-workflow.md)）。Fine-grained PATは
**resource ownerを1つしか指定できない**ため、個人アカウントを対象に発行された現在のPATは、
Organizationへ移したリポジトリには届かない。

つまりリポジトリを個人アカウントとOrganizationに分割して運用すると、**PATを2本併存させる**
ことになる。`secrets.WORKFLOW_PAT`の参照は31箇所あり、どちらのPATを使うかがリポジトリごとに
変わるため、設定ミスの温床になりやすい。

特に注意が要るのが共有知識リポジトリ`docs`で、`reusable-issue-dispatch.yml`・
`claude-review-develop.yml`・`shared-knowledge-propose.yml`の3つが`WORKFLOW_PAT`でcheckoutしている。
issue-deckだけをorgへ移して`docs`を個人アカウントに残すと、共有知識のcheckoutが失敗する
（各ワークフローは`continue-on-error`で続行するため停止はしないが、共有知識なしで動くことになる）。

**したがって、自動化に参加するリポジトリは分割せず一度にまとめて移す。** 移行の前に、
Organizationをresource ownerとする新しいFine-grained PATを発行し、`WORKFLOW_PAT`を差し替える。

### 手当てが必要なもの

- **GitHub Appのorganizationへの再インストール。** リポジトリのtransferではApp
  インストールは追従しない。org側でインストールし、対象リポジトリを選択し直す。
  App自体（App ID・秘密鍵・Webhook URL）は変更不要なので、`.env`や1Password側の値はそのまま使える。
- **`WORKFLOW_PAT`の再発行と差し替え**（上記の制約による）。1Password側の値も更新する。
- **Supabase Authが使うOAuth Appに対する、organizationのサードパーティアクセス許可。**
- **ブランチ保護ルールの再確認。** transfer後に必須ステータスチェックが維持されているか確認する。
- **ローカル`git remote`の更新。** 本体リポジトリと`~/apps/issue-deck-worktrees/`配下の各worktree。
  リダイレクトは効くが、明示的に更新しておくほうが混乱がない。

## 移行手順案

### 順序の原則：リポジトリを先に全部移し、GitHub Appの所有権移管は最後に行う

privateなGitHub Appは**App所有者のアカウント1つにしかインストールできない**
（GitHub Docs [Making a GitHub App public or private](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/making-a-github-app-public-or-private):
"Private GitHub Apps can only be installed on the user or organization account of the app owner"）。
さらにissue-deckは[app-auth.ts](../src/lib/github/app-auth.ts)が単一の`GITHUB_APP_ID`と秘密鍵で
動いているため、**Appを2つ使い分けることもできない**（同一Appの複数インストールは扱えるが、
複数のAppは扱えない）。

したがって移行の過渡期には、個人アカウントと`guchi-apps`のどちらか一方しかissue-deckに映せない。
順序で影響を最小化する。

- **Appを先に移すと**: 個人アカウント側のインストールが外れ、まだ移していないリポジトリが
  issue-deckから消える。残りを移し終わるまでその状態が続く
- **リポジトリを先に移すと**: 移した分だけが一時的に見えなくなり、最後にAppを移した瞬間に
  まとめて復帰する

**後者を採る。** 稼働中の全リポジトリを`guchi-apps`へ移す方針（後述の「移行対象」）のため、
Appをpublicにする必要はなく、privateのまま所有権だけを移せる。

なお、一部のリポジトリを個人アカウントに残したまま両方をissue-deckに映したい場合は、
Appをpublic（"Any account"）にする以外に方法がない。今回はその必要がない。

### 手順

1. ✅ **Organization `guchi-apps` を作成する**（GitHub Free、$0）。**完了済み**。
2. **`guchi-apps`をresource ownerとするFine-grained PATを発行する**（前述の制約）。

   <https://github.com/settings/personal-access-tokens/new>（Settings → Developer settings →
   Personal access tokens → **Fine-grained tokens** → Generate new token）で作成する。

   - **Resource owner**: ドロップダウンで**`guchi-apps`を選ぶ**。既定は個人アカウントのままなので
     必ず切り替える。Organizationを作成した後でないとドロップダウンに出てこない
   - **Expiration**: 最長366日。切れるとこれを使う全ワークフローが同時に停止する（3-6参照）
   - **Repository access**: All repositories（現行の`WORKFLOW_PAT`と同じ）
   - **Repository permissions**: Contents / Issues / Pull requests / Actions を
     Read and write、**Workflows を Read and write**、Metadata は Read（自動付与）。
     Workflowsが`WORKFLOW_PAT`の存在理由で、既定の`GITHUB_TOKEN`はGitHubの仕様上
     `.github/workflows/`配下へpushできない（[cross-repo-setup-guide.md](cross-repo-setup-guide.md)参照）

   orgのリソースを要求するFine-grained PATは既定で管理者承認が必要だが、
   **org owner自身が作成したトークンは承認不要**（GitHub Docs
   [Setting a personal access token policy for your organization](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization)）。

   発行後、1Passwordへ保存し、各リポジトリのActions secret `WORKFLOW_PAT`を差し替え、
   有効期限を`FineGrainedToken`台帳へ記録する。

   **organization secretへは一本化しない。** GitHub Freeではorganization secretを
   privateリポジトリから参照できず、privateリポジトリを含む構成のため、publicだけorg secret・
   privateはrepo secretという分かれ方になって混乱を招く。当面はこれまでどおりrepo secretに
   置き、Team（選択肢C）へ上げた時点でorg secretへ一本化する。

3. **稼働中の全リポジトリを`guchi-apps`へtransferする。**

   **リポジトリごとに毎回行う共通操作**（4つ）。

   1. **transfer する。** UIならリポジトリ → **Settings** → **General** の最下部
      **Danger Zone** → **Transfer** → New ownerに`guchi-apps` → リポジトリ名を入力して確認。
      CLIなら次のとおり。

      ```bash
      gh api -X POST /repos/m-guchi/<repo>/transfer -f new_owner=guchi-apps
      ```

   2. **引き継ぎを確認する。** secretsとdeploy keyはtransferで保持されるはずだが、実測で確かめる。

      ```bash
      gh secret list   --repo guchi-apps/<repo>
      gh variable list --repo guchi-apps/<repo>
      gh api /repos/guchi-apps/<repo>/branches/develop/protection \
        --jq '.required_status_checks.contexts'   # ブランチ保護が残っているか
      ```

   3. **`WORKFLOW_PAT`を手順2の新しいPATへ差し替える。** 旧PATはresource ownerが`m-guchi`
      のため、org配下へ移ったリポジトリには届かない。これを忘れるとワークフローが軒並み失敗する。

      ```bash
      gh secret set WORKFLOW_PAT --repo guchi-apps/<repo>   # 値を貼り付けてCtrl-D
      ```

   4. **ローカルのremoteを更新する。** リダイレクトは効くが、明示更新しておく。
      **linked worktreeは本体と`.git/config`を共有する**ため、リポジトリごとに1回で足りる
      （`~/apps/<repo>-worktrees/`配下を個別に直す必要はない。実測で確認済み）。

      ```bash
      git -C ~/apps/<repo> remote set-url origin github:guchi-apps/<repo>.git
      ```

   **transferの順序と、リポジトリ固有の追加作業。**

   1. ✅ `uptime-kuma` — 検証用。URLリダイレクトとgit操作を確認する。**完了済み**
   2. `docs` — transfer後、`SHARED_CONTEXT_REPO`の参照先を切り替える。issue-deck側の
      既定値`m-guchi/docs`を書き換える（`reusable-issue-dispatch.yml:687`・
      `claude-review-develop.yml:226`・`shared-knowledge-propose.yml:128/221/298`）か、
      リポジトリ変数で上書きする。ローカルは`~/apps/_docs`（ディレクトリ名がリポジトリ名と
      異なる点に注意）。

      ```bash
      gh variable set SHARED_CONTEXT_REPO --body guchi-apps/docs --repo guchi-apps/issue-deck
      git -C ~/apps/_docs remote set-url origin github:guchi-apps/docs.git
      ```

   3. `issue-deck` — 「書き換えが必要な箇所」の1〜5を修正してPRを出し、CI・deploy・
      issue-labelsが通ることを確認する。表示のみのドキュメント参照もあわせて更新する。
   4. `shopping-list`・`dayspan` — issue-deckより後にする。**両リポジトリの計4ファイル**で
      `uses:`のownerを`guchi-apps`へ書き換える必要があるため（前掲の表の6）。
      タグ（`@workflows/v1` / `@workflows/v6`）はそのままでよい。
   5. 残りのpublicアプリ（`car-care`・`asset-manager`）
   6. 稼働中のprivate 4件（`vps`・`ops-dashboard`・`db-console`・`clip-hive`）。
      Free organizationではブランチ保護が使えないままなので、マルチエージェント運用へ載せる際は
      最後のマージを手動にする（前述の`auto-merge-fallback`経由）
   7. その他の個人アプリ（`gucchii-os`・`meisai-lab`・`myroom`・`portfolio`・`signaly`・
      `solitaire`・`subscription-lists`・`wifi-speed`・`pi0w_260719`・`sensor_260218`・
      `sensor_260531`）。ワークフローを持たないものはtransferとremote更新だけでよい

   **この間、org側へ移したリポジトリはissue-deckに表示されない**（Appがまだ個人アカウント
   所有のため）。GitHub側のデータは無事で、手順5のインストール後に再同期すれば戻る。

4. **GitHub Appの所有権を`guchi-apps`へ移す。**

   移管前に、現在の値を控えておく（移管後に変わっていないかを突き合わせるため）。
   App ID・slug・Client ID・Webhook URL・Setup URLを`https://github.com/settings/apps`の
   対象Appの画面から控える。

   手順: <https://github.com/settings/apps> → 対象App → **Advanced** → **Transfer ownership**
   → 移管先に`guchi-apps`を入力（同名のEnterprise/Organizationがあり得るためドロップダウンで
   正しいものを選ぶ）→ **Transfer this GitHub App**。移管後は
   `https://github.com/organizations/guchi-apps/settings/apps`側で管理する。

   - **本番Appと開発App（`issue-deck-dev`, App ID 4445268）の2つとも移す**
     （開発Appはプレビュー環境が使用）。
   - App ID・秘密鍵・Webhook URLは移管しても変わらないはずだが、GitHubのドキュメントに
     明記が無い。移管後に控えた値と一致するかを確認し、変わっていれば`.env`・1Password・
     `.github/deploy.env.tpl`が指す1Passwordのitem（`apps/issue-deck`の`github-app-id`・
     `github-app-private-key-base64`・`github-app-slug`）を更新する。

5. **Appを`guchi-apps`へインストールする。** App設定ページの**Install App**から`guchi-apps`を選び、
   **All repositories**（または対象を明示選択）でインストールする。
   ただし実際には**issue-deckの画面のインストール導線から踏むほうが確実**で、
   [src/app/github/setup/route.ts](../src/app/github/setup/route.ts)を経由することで
   インストール情報が`GithubInstallation`テーブルへ入る（このルートを通らないと
   `GithubInstallation`・`UserInstallation`の行が作られず、画面に何も出ない）。

6. **issue-deckの画面で再同期し、リポジトリとIssueが揃うことを確認する。**
   再同期ボタン（`POST /api/sync/issues`）を実行し、リポジトリ一覧とIssue件数が
   移行前と一致することを見る。あわせて、Webhookが新しいownerからも届くことを、
   どれか1つのIssueにラベルを付けて画面へ反映されるかで確認する。

7. **ドキュメント・スクリプトの残りの参照を更新する。**
   手順3で各リポジトリのremoteは更新済みなので、ここでは表示のみの参照
   （`docs/cross-repo-setup-guide.md`の`uses:`スニペット・`docs/supported-repositories.md`の
   一覧・`docs/shared-knowledge.md`の提案テンプレート）と、取りこぼしの確認を行う。

   ```bash
   grep -rn "m-guchi/" --include="*.md" --include="*.yml" --include="*.sh" . | grep -v node_modules
   ```

8. **archivedな大学系7件（thesis系・tyuujitu系）は個人アカウントに残す。**
   Appが`guchi-apps`所有のprivateになるとこれらはissue-deckに表示できなくなるが、
   運用対象ではないため支障はない。

## ロールバック策

リポジトリは個人アカウントへtransferで戻せる。戻すときも同様にURLリダイレクトが張られ、
Issue・PR・コミット履歴・secretsは保持される。必要になるのはGitHub Appの再インストールと
`git remote`の再更新で、いずれも移行時と同じ作業になる。

各段階で確認しておくべき点。

- **手順1・2で止めれば影響ゼロ。** Organizationを作りPATを発行しただけの状態。
- **手順3-1（`uptime-kuma`のtransfer）で止めても影響は軽微。** 検証用の1件を戻すだけで済む。
- **手順3-3（issue-deck）以降は書き換えたowner参照も巻き戻す必要がある。**
  さらに手順3-4（`shopping-list`）以降は、caller側のタグ固定参照（`@workflows/v1`）の
  owner部分も戻す。
- **手順4（Appの所有権移管）が実質的な後戻り点。** 個人アカウントへ再度transferすれば戻せるが、
  移管のたびにインストールがやり直しになる。ここを越える前に、移管後もApp ID・秘密鍵・
  Webhook URLが変わらないことを実測で確認しておく。
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

### 決定（2026-08-10、#996）

**選択肢Bを採用する。** Organization Free（$0）へ移行する。

- **Organization名**: `guchi-apps`
- **移行対象**: **稼働中の全リポジトリ**。publicアプリ群（issue-deck・car-care・asset-manager・
  dayspan・shopping-list）、privateリポジトリ5件（`docs`・`vps`・`ops-dashboard`・`db-console`・
  `clip-hive`）に加え、その他の個人アプリ（`gucchii-os`・`meisai-lab`・`myroom`・`portfolio`・
  `signaly`・`solitaire`・`subscription-lists`・`wifi-speed`・`uptime-kuma`・`pi0w_260719`・
  `sensor_260218`・`sensor_260531`）も含める
- **個人アカウントに残す**: archivedな大学系7件（thesis系・tyuujitu系）のみ

分割せず全件移す理由は2つある。

- `WORKFLOW_PAT`がFine-grained PATで**resource ownerを1つしか持てず**、分割するとPATが
  2本必要になる（前述）
- issue-deckが使えるGitHub Appは1つだけで、privateなAppは**所有者アカウント1つにしか
  インストールできない**。分割したままissue-deckに両方を映すにはAppをpublicにするしかなく、
  全件移せばprivateのまま運用できる（後述の「順序の原則」）

Teamへの引き上げ（選択肢C）は**当面見送る。** Free → Teamはいつでも切り替えられるため、
先に払う理由がない。$4/月で追加的に得られるものは、実測にもとづくと次の2点に絞られる。

- privateリポジトリ4件の「最後のマージ1クリック」の自動化
- privateリポジトリ4件でのorganization secrets

Actions分数の増枠は実測上不要（199分/月に対して2,000分）、publicリポジトリの
organization secretsはFreeで足りる。privateリポジトリを実際に無人運用へ載せてみて、
手動マージが煩わしいと感じた時点でCへ上げる。

## 参考リンク

- GitHub Docs: [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)（`projects_v2_item`の提供条件）
- GitHub Docs: [Using the API to manage Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- GitHub Docs: [Permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- GitHub Docs: [Use secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)（organization secretsのプラン制約）
- GitHub Docs: [GitHub's plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans) / [FAQ about changes to GitHub's plans](https://docs.github.com/en/get-started/learning-about-github/faq-about-changes-to-githubs-plans)
- GitHub Docs: [Transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository)
- GitHub Docs: [Rate limits for the GraphQL API](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api)
- 関連ドキュメント: [github-app-permissions.md](github-app-permissions.md)（GitHub Appの権限棚卸し）・[cross-repo-setup-guide.md](cross-repo-setup-guide.md)（他リポジトリへの展開手順）・[supported-repositories.md](supported-repositories.md)（導入済みリポジトリの記録）
