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
$0になっており、**Actionsの課金はorg全体でnet $0.00**。無料枠の逼迫はprivateリポジトリ
（`ops-dashboard`・`clip-hive`・`db-console`）に集中していたため、public化で解消した
（guchi-apps/ops-dashboard#120・guchi-apps/clip-hive#51）。

privateのまま残すリポジトリでActionsの分数が問題になった場合、削れるのは`schedule`の間引きと
ジョブの統合だが、実測で3割程度にとどまる。**分数を根本的に減らしたいならpublic化を検討する**
のが先で、それができないなら実行そのものを減らす。

## 新しくリポジトリを作るときの確認

- **privateで作るなら、secret scanning / push protectionを有効にしない。** 有効にした瞬間から
  $19/月が始まる。GitHubのUIから「Enable」を押すだけで有効になるため、意図せず踏みやすい
- **publicで作るなら、両方とも有効にしてよい**（無料）
- private必須かどうかは、接続先の構成情報（ホスト名・ポート・ユーザー名・DB名・内部エンドポイント）が
  含まれるかで判断する。単体では資格情報でなくとも、このフリートではsecret扱いにしている
  （`CLAUDE.md`「シークレットの扱い」）
