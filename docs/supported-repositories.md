# 対応リポジトリ一覧

issue-deckのマルチエージェント自動化ワークフロー一式（`@claude`起動・ラベル遷移による
計画〜実装〜PR作成〜レビューまでの無人実行）が実際に導入され、機能しているリポジトリを
記録する。導入の背景・他リポジトリへ展開する際の検討事項は
[docs/cross-repo-automation.md](cross-repo-automation.md)、実際に導入する際の手順は
[docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md)を参照。

**privateリポジトリも対象にできる。** organizationは`team`プランのため、organization secretが
privateリポジトリから参照でき、privateでもブランチ保護が効く（2026-08-15に`clip-hive`で実測。
無人実行が`PROGRESS_REPORT_SECRET`で進捗報告APIを叩けている）。#1011が前提に挙げていた制約は
解消済みで、残るのは導入作業だけになった。判断の経緯は
[docs/organization-migration.md](organization-migration.md)を参照。ここに挙がっていないprivate
リポジトリ（`vps`）は#1011配下で順次導入する。

「対応」の実態はワークフローファイル一式・ラベル体系・CLAUDE.md・ブランチ運用・Secretsなど
多軸にわたり、DBスキーマや自動判定で正確に表すのは難しいため、本ドキュメントでの手動記録に
留めている。

ただしワークフローの配布方法には**コピー方式**と**参照方式**の2種類があり、参照方式のものは
手動記録の対象外とする（後述「参照方式のワークフローは sync-state の対象外」）。

| リポジトリ | ステータス | 導入済み自動化ワークフロー | CLAUDE.md / ラベル体系 | 最終確認日 | 関連Issue | 備考 |
|---|---|---|---|---|---|---|
| `guchi-apps/issue-deck` | 対応済み | 一式（`claude-issue-dispatch.yml`・`issue-labels.yml`・`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`release-develop-to-main.yml`）。うち`issue-labels.yml`は`reusable-issue-labels.yml`をローカルパス参照 | あり（本体） | 2026-08-09 | #354, #501, #940 | issue-deck自身のセルフホスティング。再利用可能ワークフローの提供元でもあり、常に最新を参照するカナリアとして機能する |
| `guchi-apps/shopping-list` | 対応済み | **参照**（5つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml`・`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`。**コピー**: `release-develop-to-main.yml` | あり（新規作成） | 2026-08-13 | #357, #723, #895, #942, #1129 | DBなし・ビルドなし・npm依存パッケージゼロのため、DBセットアップ・pnpm・Playwrightの前段ステップを削除して簡素化。`24.screenshot-required`は撮影自体を独自実装済み。プレビュー環境はissue-deckとFly.ioアプリを共有しており相互に上書きされる（#892で解消予定） |
| `guchi-apps/dayspan` | 対応済み | **参照**（5つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml`・`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`。**コピー**: `release-develop-to-main.yml` | あり（新規作成） | 2026-08-13 | #971, #1129 | Next.js + Prisma + MariaDBのため`runtime-setup: node-db`・`package-manager: pnpm`・`database-name: app_dayspan`・`node-version: "24"`をcallerで指定。`24.screenshot-required`は全画面がSupabase Auth + Google OAuthの背後にありCIログインバイパスもPlaywright依存も持たないため無人撮影は成立せず、ローカル実行でのみ意味を持つラベルとして残している |
| `guchi-apps/meisai-lab` | 対応済み | **参照**（2つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`AGENTS.md`に追記。`CLAUDE.md`は`@AGENTS.md`の1行） | 2026-08-13 | #1051, guchi-apps/meisai-lab#69 | #1047の1周目。Next.js + Prisma + MariaDBで`runtime-setup: node-db`・`package-manager: npm`・`node-version: "20.19"`（`ci.yml`準拠）。`database-name`は既定の`app_ci`。`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`は入れていない（無人実装はdispatchだけで成立するため1周目はスコープを絞った。必要になれば参照方式で追加できる）。導入前は旧世代のラベル体系で、`05.develop`が付いていた#66の進捗は削除前に控えて書き戻した |
| `guchi-apps/car-care` | 対応済み | **参照**（2つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`AGENTS.md`に追記。`CLAUDE.md`は`@AGENTS.md`の1行） | 2026-08-13 | #1050, guchi-apps/car-care#32 | #1047の2周目。Next.js + Prisma 7 + MySQLで`runtime-setup: node-db`・`package-manager: npm`・`node-version: "20.19"`（`ci.yml`準拠）。`database-name`は既定の`app_ci`。**`test`・`typecheck`のnpm scriptを持たない**が、ワークフローが呼ぶのは`db:migrate:deploy`・`db:seed:ci`（どちらも`24.screenshot-required`付きの実行のみ・`--if-present`で保護）だけのため実害は無く、scriptを足さずAGENTS.mdへ実際の検証コマンド（`lint`・`build:ci`）を書く形にした。`npm run build`は`scripts/with-local-env.sh`経由でローカルの`.env`を要求するため、CI・無人実行は`build:ci`を使う点も明記 |
| `guchi-apps/subscription-lists` | 対応済み | **参照**（2つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-13 | #1052, guchi-apps/subscription-lists#45 | #1047の3周目。Next.js + Prisma + MySQLで`runtime-setup: node-db`・`package-manager: npm`・`node-version: "20.19"`（`ci.yml`準拠）。`test`・`typecheck`・`db:migrate:deploy`・`build:ci`をすべて持ち、共有ワークフローと過不足なく噛み合う。**`/install-github-app`が生成した素の`claude.yml`・`claude-code-review.yml`を削除した**（前者は`claude-issue-dispatch.yml`と同じ`issue_comment`イベントで起動し二重起動していた。詳細は下記）。`CLAUDE.md`・`AGENTS.md`のどちらも無かったため新規作成 |
| `guchi-apps/asset-manager` | 対応済み | **参照**（2つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-13 | #1053, guchi-apps/asset-manager#155 | #1047の4周目。Next.js + Prisma + MySQLで`runtime-setup: node-db`・`package-manager: npm`。**`node-version`は`"20"`**（CIが`ci.yml`ではなく`test.yml`で、そこが`'20'`。他リポジトリの`20.19`と違う）。**`build`系の命名が他アプリと逆**で、`npm run build`がラッパー無し（CI・無人実行向け）、`npm run build:local`がローカル用。`npm run check`は`build:local`を含むため無人実行では使えない。この点をCLAUDE.mdの冒頭に置いた。`.claude/settings.json`は権限許可リストのみで運用ルールは含まない |
| `guchi-apps/portfolio` | 対応済み | **参照**（2つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-13 | #1054, guchi-apps/portfolio#81 | #1047の5周目。**`runtime-setup: node`を初めて使ったリポジトリ**（`prisma/`を持たずDBを使わないため。`node-db`にすると不要なMySQLサービスコンテナの起動・マイグレーション・シードが動く）。`database-name`は`node`では使われないので指定していない。`package-manager: npm`・`node-version: "20"`（`ci.yml`準拠）。**`test`・`typecheck`のnpm scriptを持たず、`lint`と`build`だけ**でCIも同じ2つを実行している。`npm run build`はラッパー無しでCI・無人実行から使え、`npm run build:local`は**1Passwordの`op run --env-file=.env.tpl`経由**なので無人実行では使えない（car-care・asset-managerの`with-local-env.sh`とは失敗の仕方が違い、`op`コマンド自体が無いことで落ちる）。進捗ラベルが`09.main`まで進んだままcloseされずに残っていた#76は、盤面へ載せたあとStatus `Done`にしてcloseした |
| `guchi-apps/solitaire` | 対応済み | **参照**（2つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-13 | #1055, guchi-apps/solitaire#23 | #1047の6周目。**`runtime-setup: minimal`を使った唯一の周**（`dependencies`・`devDependencies`のどちらも無く、`package-lock.json`も`pnpm-lock.yaml`も無い素のJS）。`node`/`node-db`にするとロックファイル不在で`npm ci`が落ちるが、`minimal`では`npm ci`・Playwrightインストール・DB準備の各ステップが`runtime-setup != 'minimal'`の条件で丸ごとスキップされる。`node-version: "20"`（`ci.yml`準拠）は`runtime-setup`と独立した軸で、`cache:`を付けずに`setup-node`を呼ぶだけのためロックファイル無しでも失敗しない。**検証コマンドは`npm test`（`node --test tests`）と`npm run build`の2つだけで、どちらもラッパー無しで無人実行から使える**（car-care・asset-manager・portfolioと違い`.env`も1Passwordも要らない）。`npm start`が`python3 -m http.server`である点、テストは`node:test`/`node:assert`で書く点、**`24.screenshot-required`は`minimal`だとPlaywrightが入らず無人実行では成立しない**点をCLAUDE.mdに明記。旧世代の`10.`/`19.`優先度ラベル削除で失われる分は#11・#12へ`89.Priority: low`を付け直した（進捗ラベルはopen issueに1件も付いておらず復元は不要だった） |
| `guchi-apps/myroom` | 対応済み | **参照**（2つとも`@workflows/v10`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-13 | #1056, guchi-apps/myroom#111 | #1047の7周目。**Python + Node の2層構成**（それまでの6周は全てNode単体）。バックエンドはルートで`pytest tests/ -q`（`DB_MOCK=true`）、フロントエンドは**`frontend/`サブディレクトリ**で`typecheck`・`test`・`build`・`lint`。**`cd frontend`を忘れるとフロントエンドのコマンドは動かない**ため、CLAUDE.mdに実行場所をコマンドごとに明記した。`runtime-setup: minimal`（準備ステップは全てリポジトリルートで動くが、ルートの`package.json`はバージョン管理用scriptのみで依存を持たず、`package-lock.json`も空のスタブ`"packages": {}`。実際の依存は`frontend/`にあり、そこへ入るのは実装エージェント自身の仕事）。**`package-manager: npm`は`minimal`でも必要**で、実装ステップの許可ツールの出し分け（#1147）がこの値を見るため、`pnpm`にすると`npm`・`node`が許可されず`frontend/`の検証ができなくなる。Pythonは#1147で`python`・`pip`・`pytest`が常時許可されたが、**`setup-python`は入らずランナー標準のPythonを使う**ためCIの3.11固定とはズレうる。`.gitignore`への共有ディレクトリ追加（#1151）を最初から入れた最初のリポジトリ |
| `guchi-apps/signaly` | 対応済み | **参照**（2つとも`@workflows/v10`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-13 | #1057, guchi-apps/signaly#113 | #1047の8周目（最終周）。**8リポジトリで唯一Nodeが一切無い**（`package.json`がルートにも`frontend/`にも無く、`frontend/`は素のHTML/JS、`scripts/`は全てPythonかbash）。そのため**`node-version`を指定しない唯一のリポジトリ**（他7件は全て指定）。`package-manager`は使わないが**既定値の`npm`のままにする**——`pnpm`にすると実装ステップで`node`が許可されなくなる（#1147）。**`workflows/v10`未満へ下げてはいけない。** v9までは許可ツールが`pnpm`固定で`python`・`pip`・`pytest`のいずれも実行できず、**検証手段がPythonのテストしか無い**（Lintも無い）このリポジトリでは検証が一切できなくなる。テストは`DB_NAME=ci_signaly python -m unittest discover -s backend -p 'test_*.py' -v`で、**`DB_NAME`を忘れると`backend/database.py`のimport時点で落ちる**（実際のDB接続はせず全てモック）。バージョンは`package.json`ではなく`version.json`で`scripts/bump_version.py`経由 |
| `guchi-apps/clip-hive` | 対応済み | **参照**（2つとも`@workflows/v15`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-15 | #1376, guchi-apps/clip-hive#21 | **#1011（Phase 6）の1周目で、privateリポジトリを載せた最初の例。** Next.js + Prisma + MariaDB/MySQLで`runtime-setup: node-db`・`package-manager: npm`・`node-version: "20.19"`（`ci.yml`準拠）。`database-name`は既定の`app_ci`（このリポジトリのCIはサービスコンテナを使わず、ビルド時の`DATABASE_URL`にプレースホルダを渡している）。`lint`・`typecheck`・`build:ci`・`db:migrate:deploy`をすべて持ち、共有ワークフローと過不足なく噛み合う唯一のリポジトリだったため1周目に選んだ。**`npm test`は`lint && typecheck`の別名**でテストランナーは動かず、`npm run dev`は`scripts/ensure-mysql.sh`とローカルの`.env.local`を要求して無人実行では使えない点をCLAUDE.mdに明記した。旧世代ラベルは`05.develop`が#15に付いており、削除前に控えて書き戻した |
| `guchi-apps/ops-dashboard` | 対応済み | **参照**（2つとも`@workflows/v15`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`AGENTS.md`に追記。`CLAUDE.md`は`@AGENTS.md`の1行） | 2026-08-15 | #1377, guchi-apps/ops-dashboard#64 | #1011（Phase 6）の2周目。**`runtime-setup: node`をprivateで初めて使った周**（`prisma/`を持たずDBを使わない）。`package-manager: npm`・`node-version: "22.23.1"`。**`node-version`は`.nvmrc`から手で写す**——CIは`node-version-file`で`.nvmrc`を読むが、共有ワークフローはこの入力しか見ない。`test`・`typecheck`のnpm scriptを持たず、CIが`npx tsc --noEmit`を直接叩いているため、AGENTS.mdへ実際の検証コマンド（`lint`・`npx tsc --noEmit`・`build`）を書いた。**ブランチ命名が`feature/<番号>-<説明>`だった唯一のリポジトリ**で、この命名ではワークフローが対象Issueを特定できず進捗が一切遷移しないため、`issue-<番号>`へ揃えることをAGENTS.mdに明記した（既存の`feature/`ブランチ8本は、マージ済みかどうかの判断が要り作業中のものを巻き込む恐れがあるため触っていない）。旧世代ラベルは`07.m:marge`が#26に付いていたが、盤面では既に`Release`になっており書き戻しは不要だった |
| `guchi-apps/db-console` | 対応済み | **参照**（2つとも`@workflows/v15`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`AGENTS.md`に追記。`CLAUDE.md`は`@AGENTS.md`の1行） | 2026-08-15 | #1378, guchi-apps/db-console#19 | #1011（Phase 6）の3周目。**デフォルトブランチが`main`だった唯一のリポジトリ**で、`develop`へ変更した（`issues`・`issue_comment`はデフォルトブランチのワークフローしか起動しない）。変更前に`develop...main`のファイル差分が空であること——mainの内容はすべてdevelopに含まれ、コミット数の差8件はdevelop→mainのマージコミットだけであること——を実測した。`runtime-setup: node-db`・`package-manager: npm`・`node-version: "22.23.1"`（`.nvmrc`準拠）。**`prisma.config.ts`の`env("DATABASE_URL")`が未設定で即失敗し、postinstallの`prisma generate`ごと`npm ci`が落ちていた**ため、未設定時は接続できないプレースホルダーへ倒す形へ直した（共有ワークフローの依存インストールはDATABASE_URLを渡さない。car-care・clip-hive・dayspanは元から未設定でも通る作りで、`env()`を必須にしていたのはここだけ）。`npm run build`は素だと`/auth/callback`で`ERR_INVALID_URL`になるため、CIと同じプレースホルダーを渡す実行例をAGENTS.mdに書いた。CIのDBは他アプリの`mysql:8.0`ではなく`mariadb:10.11`。旧世代ラベルは`05.develop`が#13に付いており、削除前に控えて書き戻した |
| `guchi-apps/aide` | 対応済み | **参照**（2つとも`@workflows/v15`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-15 | #1379, guchi-apps/aide#11 | #1047の起票後に作られたためどの周にも入っていなかったpublicリポジトリ。**フリートで唯一のNode 24**（`ci.yml`・`engines`とも。他は20〜22帯）で、Node 24が型ストリッピングで`.ts`を直接実行するため**ビルド工程そのものが無い**。`runtime-setup`は`node`——`dependencies`は空だが`minimal`にすると`npm ci`が走らず、`devDependencies`のTypeScriptが入らないため`npm run typecheck`が通らなくなる。検証は`typecheck`と`test`（`node --test`）の2つだけで、`lint`も`build`も無い。**ラベルがGitHub既定のままだった唯一のリポジトリ**で、旧世代の進捗ラベルすら無く控える作業は不要だった（既定ラベルはどのIssueにも付いておらず、役割が重複するため削除した）。**auto-mergeもrulesetも無かった**ため、有効化と`protect develop`（必須チェックは`typecheck-and-test`）の作成をあわせて行った。`release-develop-to-main.yml`は入れていない（guchi-apps/aide#6が同じ範囲を扱っているため） |

> **参照バージョンは表に書くが、正はcallerファイル。** タグを上げたら表も直すが、
> 実態は各リポジトリの`.github/workflows/`を見るのが確実。次のコマンドで一覧できる。
>
> ```bash
> for r in dayspan shopping-list; do
>   echo "== $r"
>   for f in $(gh api repos/guchi-apps/$r/contents/.github/workflows --jq '.[].name'); do
>     gh api "repos/guchi-apps/$r/contents/.github/workflows/$f?ref=develop" --jq .content \
>       | base64 -d | grep -oE "@workflows/v[0-9]+" | head -1 | sed "s|^|  $f: |"
>   done
> done
> ```

## `claude-review-develop.yml`の配布状況（#1470）

develop向けPRを「自動マージしてよい」「ユーザーのマージが必要」のどちらかへ確定させるのは
`claude-review-develop.yml`（本体は`reusable-claude-review-develop.yml`）**だけ**である。
`risk-check`が機械的に判定し、`auto-merge`が`00.check-user`の付与と`gh pr merge --auto`に
反映する（[multi-agent/labels.md](multi-agent/labels.md)「自動マージ可否の判定方法」）。

**上の表の「導入済み自動化ワークフロー」列を見れば分かるとおり、このcallerを持つリポジトリは
少数である。** 2026-08-15時点で持つのは次の3つだけ。

| 配布済み | `issue-deck`（ローカルパス参照）・`dayspan`・`shopping-list` |
|---|---|
| **未配布** | `aide`・`asset-manager`・`db-console`・`ops-dashboard`・`clip-hive`・`signaly`・`myroom`・`solitaire`・`portfolio`・`subscription-lists`・`car-care`・`meisai-lab` |

**未配布のリポジトリでは、develop向けPRは一切自動マージされない。** #1470の時点では
`00.check-user`も付かなかったため、13本のPRが判定されないまま開いたまま残っていた
（`dayspan`・`shopping-list`は0本）。この穴は`reusable-issue-labels.yml`の`develop-pr-opened`に
保険を入れて塞いだ（callerが無ければPR作成時に`00.check-user`を付ける）が、
**保険が効いても自動マージは効かない**——未配布リポジトリのPRは常にユーザーが手でマージする。

```bash
# 配置状況の確認
for r in $(gh repo list guchi-apps --limit 60 --json name --jq '.[].name'); do
  gh api "repos/guchi-apps/$r/contents/.github/workflows/claude-review-develop.yml" \
    --jq .name >/dev/null 2>&1 && echo "$r: あり"
done
```

## `version-tag-check.yml`の配布状況

上の表の「導入済み自動化ワークフロー」列は無人実行（計画〜実装〜レビュー）のワークフローについて
のもので、`version-tag-check.yml`はそれとは対象の決まり方が違うため、ここに分けて記録する。

`version-tag-check.yml`（本体は`reusable-version-tag-check.yml`。#1367）は、バージョンを上げ忘れた
ままdevelop→mainをマージしたときに`deploy.yml`の`tag`ジョブが落ちて本番デプロイが止まるのを、
main宛PRのCIで先に落とすもの。**対象は「`deploy.yml`が`main`から`vX.Y.Z`タグを作るリポジトリ」だけ**
で、無人実行を入れているかどうかとは独立している。

配った14リポジトリ（#1459。`@workflows/v16`）は次のとおり。

| リポジトリ | `with:`に渡す入力 |
|---|---|
| `shopping-list`・`dayspan`・`meisai-lab`・`car-care`・`subscription-lists`・`asset-manager`・`portfolio`・`solitaire`・`clip-hive`・`ops-dashboard`・`db-console`・`aide` | なし（既定値の`package.json`・`.version`・`v`） |
| `myroom` | `version-file: frontend/package.json`（`deploy.yml`が`./frontend/package.json`を読む） |
| `signaly` | `version-file: version.json`（バージョンが`version.json`で`scripts/bump_version.py`経由） |

**対象外**

- `guchi-apps/issue-deck` — 配置済み。ローカルパス参照（`./.github/workflows/reusable-*.yml`）で
  常に最新を使うカナリア
- `guchi-apps/vps` — `deploy.yml`はあるが`tag`ジョブが無く、リリースタグを作らない。守るものが無い
- `docs`・`subpc-setup`・`claude-config`・`gucchii-os`・`pi0w_260719`・`uptime-kuma`・`sensor_260531`・
  `sensor_260218`・`wifi-speed` — `deploy.yml`を持たない

**新しくリポジトリを増やしたときは、`deploy.yml`に`tag`ジョブを入れるかどうかとセットで判断する。**
配布（`propagate-workflow-tag.yml`）は既存ファイルのタグを書き換えるだけで、callerの新規追加は
行わない（[cross-repo-setup-guide.md](cross-repo-setup-guide.md)「共有ワークフローのタグ運用」）。

```bash
# 配置状況の確認
for r in shopping-list dayspan meisai-lab car-care subscription-lists asset-manager \
         portfolio solitaire myroom signaly clip-hive ops-dashboard db-console aide; do
  echo -n "$r: "
  gh api "repos/guchi-apps/$r/contents/.github/workflows/version-tag-check.yml" --jq .name \
    2>/dev/null || echo "未配置"
done
```

## ローカル起動プロトコルの適合状況

> **`.gitignore`の`/.shared-context/`・`/.shared-prompts/`は全リポジトリで必要。** 無人実行の
> たびにcheckoutされるが、#1047で導入した6リポジトリ（meisai-lab・car-care・subscription-lists・
> asset-manager・portfolio・solitaire）では導入手順から漏れて一貫して抜けていた（#1151で追加）。
> 先行のshopping-list・dayspanには最初から入っている。

上の表はGitHub Actions側の自動化についてのもの。**ローカルのワンクリック起動**（issue-deckの画面の
「ローカルで開始」）は別の軸で、**#1224以降は起動先ごとにさらに2つへ分かれている**。

| 起動先 | 起動できる条件 | 正の所在 |
|---|---|---|
| 起動コマンドをコピー（WSL・SSH） | 対象リポジトリの`scripts/start-issue.sh`が**マーカー行**（`# issue-deck-local-session: vN`）を宣言している | マーカー行そのもの |
| サブPC（`subpc`） | サブPCにcloneされ、対応表（`~/.config/issue-deck/local-repos.conf`）に載っている。**マーカー行は要らない** | サブPCの申告 |

**マーカー行が無いことは「未対応」を意味しない**（#1224）。宣言していないリポジトリはissue-deck側の
汎用ランチャー（`scripts/generic-start-issue.sh`）が起こし、宣言しているリポジトリだけが自前の
スクリプトで起動する。判定の詳細は[multi-agent/generic-launcher.md](multi-agent/generic-launcher.md)
「「実行できるリポジトリ」の判定」を参照。

| リポジトリ | 起動コマンド（マーカー行） | サブPC |
|---|---|---|
| `guchi-apps/issue-deck` | v2 | ○ |
| `guchi-apps/dayspan` | —（※） | ○ |
| `guchi-apps/shopping-list` | —（※） | ○ |
| `guchi-apps/meisai-lab` | — | ○ |
| `guchi-apps/car-care` | — | ○ |
| `guchi-apps/subscription-lists` | — | ○ |
| `guchi-apps/asset-manager` | — | ○ |
| `guchi-apps/portfolio` | — | ○（※2） |
| `guchi-apps/solitaire` | — | ○（※2） |
| `guchi-apps/myroom` | — | ○（※2） |
| `guchi-apps/signaly` | — | ○（※2） |
| `guchi-apps/clip-hive` | — | ○（※3） |
| `guchi-apps/ops-dashboard` | — | ○（※3） |
| `guchi-apps/db-console` | — | ○（※3） |
| `guchi-apps/aide` | — | ○（※3） |

※ `scripts/start-issue.sh`自体は持つが、マーカー行を宣言していない（2026-08-14に`develop`・`main`の
両方で実測）。#1224以降は**宣言しないことが通常**で、宣言が無いリポジトリはサブPCから汎用ランチャーで
起動する。

※2 `portfolio`・`myroom`・`signaly`・`solitaire`は#1276で追加した。本体チェックアウトに
`.env.local`／`.env`は置いていないが、**先行7件もissue-deck以外は同じく置いていない**（2026-08-14に実測）。
汎用ランチャーは既定で開発サーバーを起動せず（#1224）、envが無ければ`supply_env_files`は何もしないため、
セッションの起動には影響しない。開発サーバーを動かすセッションでだけ配置する。

サブPC列は**2026-08-15時点の申告15件**（pollerのログで直接実測）。この4件は#1224のロールアウト対象に
入っておらず、**除外した理由は記録に残っていない**（#1269で確認）。単に未着手だったため#1276で追加し、
あわせてポート帯も確保した（[scripts/local-repo-ports.conf](../scripts/local-repo-ports.conf)）——
載っていないと汎用ランチャーの既定`3000 + Issue番号`に落ち、4件が同じ帯に相乗りするため。

※3 `clip-hive`は#1376、`ops-dashboard`は#1377、`db-console`は#1378、`aide`は#1379で追加した
（`aide`以外はprivate）。
`ops-dashboard`はサブPCへcloneはされていたが対応表に載っておらず、`clip-hive`・`db-console`はcloneも
されていなかった。ポート帯も`clip-hive`の10000以外は未確保だったため、あわせて足した（17000・18000）。**`claude-issue-dispatch.yml`・`issue-labels.yml`を持たないため
`11.local`の付与とProject Statusの遷移が成立せず保留していた**（#1224）が、両方を導入して前提が揃ったため、
サブPCの対応表でコメントアウトされていた行を有効化した。ポート帯（10000）は#1224の時点で確保済み。

**版が違っても切り捨てない。** 受け口は「宣言された版数が自分の扱える版数以下か」だけを見るため、
v1を宣言したリポジトリが現れてもそのまま動く（v2で増えたのはWindows Terminalが無い環境向けの
tmux出口とポート帯の既定値。#1178）。現時点でマーカー行を宣言しているのはissue-deck自身だけで、
CIが`scripts/check-local-session-contract.sh`で適合を検査している。

**この表は要約であって真実の源ではない。** 実態は起動先ごとに次で読む。

```bash
# 起動コマンド: マーカー行を読む。宣言の無いリポジトリは ○（汎用ランチャーで起動する）と出る
scripts/check-local-session-contract.sh --all

# サブPC: 申告を読む。サブPC上で実行する
journalctl --user -u issue-deck-dispatch-poller
```

Actions側の対応とローカル起動の対応は**必ずしも一致しない**。導入順が「ワークフロー→ローカル」に
なるため、Actionsは対応済みでローカルは未対応、という状態が普通に発生する。

約束の内容と移植手順は [multi-agent/local-quick-start.md](multi-agent/local-quick-start.md)
「ローカル起動プロトコル v2」を参照。サブPCへ対象を増やす手順は
[multi-agent/generic-launcher.md](multi-agent/generic-launcher.md)「対象リポジトリを増やす（サブPC側の作業）」。

## sync-state マーカー（ワークフロー同期状態の記録）

リポジトリが実際にワークフローファイルを導入した際、issue-deckのどのコミット時点から
コピー・改変したかを、機械可読な形で以下のHTMLコメント形式で記録する。

```html
<!-- sync-state: repo=<owner/repo> workflow=<ワークフローファイル名> base-commit=<issue-deck側のコミットSHA> -->
```

実際の記録例は下記「guchi-apps/shopping-list」の節を参照する。`scripts/check-workflow-sync-drift.sh`は
本ドキュメント中のマーカーを（コードブロック内や説明用の記述であっても）すべて実データとして
読み取るため、ここに架空のサンプル行は置かない。

導入したワークフローファイルごとに1行記録する（複数ファイルを導入した場合は複数行）。
`scripts/check-workflow-sync-drift.sh`がこのマーカーを読み取り、issue-deck側にbase-commit以降
加わった変更を一覧表示する（詳細は[docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md)の
「ワークフロー同期のずれ検知」を参照）。

**マーカーは初回導入時だけでなく、issue-deck側の改善をバックポートするたびに更新する。**
更新を怠ると、既に取り込み済みの変更まで「未反映」として報告され、一覧に当たりと外れが混在する。
そうなると「常に大量に出るので誰も見ない」方向へ劣化し、検知の仕組み自体が機能しなくなる
（実際に#895で発生した）。

### guchi-apps/shopping-list

<!-- sync-state: repo=guchi-apps/shopping-list workflow=release-develop-to-main.yml base-commit=bb7d0f7f48bd0eae0f90c86bd1e7dd35ba2c2200 -->

**残っているのは`release-develop-to-main.yml`だけ。** 他はすべて参照方式へ移行済みで、後述
「参照方式のワークフローは sync-state の対象外」のとおり記録の対象外になった。

- `claude-issue-dispatch.yml`: `@workflows/v6`への移行時に削除（#940・#942）
- `claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`:
  **2026-08-13に削除**（#1129）。3ファイルとも参照方式へ移行済みだったのにマーカーだけが残り、
  ドリフト検知が意味を持たない対象を監視し続けていた。`claude-conflict-resolve.yml`を
  「意図的に古いbase-commitのまま」にしていた運用（#814が未反映であることの記録）も、
  参照方式では`uses:`のタグが実態を表すため役目を終えている

`shared-knowledge-propose.yml`（共有知識層、#889）のマーカーは、issue-deck側とshopping-list側の
双方のPull Requestがマージされた時点で追加する。

### guchi-apps/dayspan

<!-- sync-state: repo=guchi-apps/dayspan workflow=release-develop-to-main.yml base-commit=b198601c22aea091124b9734326032ec65b6cee1 -->

base-commitは各ワークフローファイル冒頭の「移植元コミット」コメント（dayspan側に記載がある）と同じ値。

**残っているのは`release-develop-to-main.yml`だけ。** `issue-labels.yml`・
`claude-issue-dispatch.yml`は当初から参照方式でマーカーを持たず、
`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`の3つは
**2026-08-13にマーカーを削除**した（#1129。shopping-listと同じ理由）。

**最終同期日: 2026-08-13**

## 参照方式のワークフローは sync-state の対象外

`reusable-*.yml`（`on: workflow_call`）を`uses:`で参照する方式へ移行したワークフローは、**`sync-state`マーカーを記録しない**（#940・#942）。

理由は、参照方式では**caller側ファイルの`@<タグ>`という参照そのものがバージョン記録**であり、機械可読で常に正確だからである。ここに二重に書くと、手書きゆえに再び実態とずれる。#895 で「マーカーの更新漏れ → 当たりと外れが混在した一覧 → 誰も見なくなる」という劣化が実際に起きており、それを構造的に避けるのが#934で定めた方向である。

そのため`scripts/check-workflow-sync-drift.sh`の出力にも、参照方式のワークフローは現れない（現れないことが正常である）。

**どのリポジトリがどのバージョンを参照しているかは、対象リポジトリのcallerファイルを見る。**

```bash
# 例: shopping-list が参照しているバージョンを確認する
gh api repos/guchi-apps/shopping-list/contents/.github/workflows/issue-labels.yml?ref=develop \
  -q .content | base64 -d | grep 'uses:'
```

```bash
# issue-deck側で提供している再利用可能ワークフローと、切られているタグを確認する
ls .github/workflows/reusable-*.yml
git tag --list 'workflows/*'
```

issue-deck自身は`./.github/workflows/reusable-*.yml`（ローカルパス）を参照し、常に最新の内容で動く。他リポジトリはタグ固定のため、issue-deck側の変更は**新しいタグを切り、各リポジトリのcallerを1行更新するPRを出す**まで波及しない。issue-deckが先に壊れて他リポジトリには届かない、カナリア構成である（#934）。

### タグが記録しないもの — `on:`と`with:`はcallerが持つコピー（#1366）

`@<タグ>`がバージョン記録として機能するのは**ジョブ本体（`reusable-*.yml`側）だけ**である。callerが自分で持つ以下の2つは、issue-deck側の同名ファイルからコピーした断片であり、**タグを上げても波及しないうえ、ずれていても`uses:`の行を見る限り検知できない。**

- `on:`（トリガー定義）
- `with:`（リポジトリ固有の入力値）

`with:`はリポジトリごとに異なるのが正常なので差分があっても問題にならないが、**`on:`は原則として全リポジトリで同じであるべき**で、ここがずれると「参照先は最新なのに起動経路だけ古い」という状態になる。#1366では、issue-deck側で`push`（`develop`）→`workflow_run`（`CI` / `requested`）へ直した（#1330・#1365）あとも、guchi-apps/dayspan・guchi-apps/shopping-listのcallerには`push`が残り、`Unsupported event type: push`で失敗し続けていた。

**issue-deck側でトリガーを変更したら、そのワークフローの全callerを横断して確認する。**

```bash
# 例: claude-conflict-resolve.yml のトリガーを全リポジトリで確認する
for r in $(gh repo list guchi-apps --limit 50 --json name --jq '.[].name'); do
  c=$(gh api "repos/guchi-apps/$r/contents/.github/workflows/claude-conflict-resolve.yml" --jq .content 2>/dev/null | base64 -d 2>/dev/null)
  [ -n "$c" ] && echo "== $r" && echo "$c" | sed -n '/^on:/,/^jobs:/p'
done
```

移行済みのワークフローは以下のとおり。

| ワークフロー | 実体 | 移行時期 |
|---|---|---|
| `issue-labels.yml` | `reusable-issue-labels.yml` | 2026-08-09（#940、guchi-apps/shopping-list#77） |
| `claude-issue-dispatch.yml` | `reusable-issue-dispatch.yml` | 2026-08-09（#945。導入先は guchi-apps/shopping-list・guchi-apps/dayspan） |
| `claude-ci-fix.yml` | `reusable-claude-ci-fix.yml` | 2026-08-11（#1066。issue-deck側のみ。他リポジトリへの適用は別Issue） |
| `claude-conflict-resolve.yml` | `reusable-claude-conflict-resolve.yml` | 2026-08-11（#1066。issue-deck側のみ。他リポジトリへの適用は別Issue） |
| `claude-review-develop.yml` | `reusable-claude-review-develop.yml` | 2026-08-11（#1078。issue-deck側のみ。他リポジトリへの適用は別Issue） |
| `claude-pr-repair.yml` | `reusable-claude-pr-repair.yml` | 2026-08-14（#1293。新規のため最初から再利用可能ワークフローとして作成。issue-deck側のみ） |

導入時の改変内容は各ワークフローファイル冒頭のコメントに記載されている。主な差異は以下のとおり。

- `claude-issue-dispatch.yml`: MySQLサービスコンテナ・pnpmセットアップ・Prismaマイグレーション・
  CIバイパス用ユーザーとダミーデータのシード・Playwrightインストールの前段ステップを削除。
  検証コマンドは`npm run check`（`node --check`による構文チェックのみ）
- `claude-review-develop.yml`: `risk-check`のパスパターンから`prisma/migrations/**`を削除し、
  `deploy/**`・`scripts/update-env-file.sh`・`**/*.env.tpl`を追加。依存関係はメジャー更新だけでなく
  新規追加もリスク判定対象（依存パッケージを持たない方針自体の変更にあたるため）
- `claude-conflict-resolve.yml`: pnpm/DB前提の検証ステップを`npm run check`へ置換
- `release-develop-to-main.yml`: バージョンbumpを`npm pkg set version`から
  `npm version <新バージョン> --no-git-tag-version`へ変更（npmのversion lifecycleフックで
  `frontend/changelog.js`のスタブを生成する必要があるため）。あわせてバージョン判定の構造化出力に
  `changelog`を追加し、利用者向け更新履歴の本文もコード差分から生成する。生成文面が公開されるため
  バンプPRの自動マージは行わない。この改修は#800より前に、shopping-list側で個別に手改造する
  形で行われたもの。#800でissue-deck本体の`release-develop-to-main.yml`にも同種の
  `npm version --no-git-tag-version`化・`changelog`生成・`RELEASE_CHANGELOG`環境変数による
  汎用フックが追加されたため、今後同様の更新履歴同期を導入するリポジトリは個別改造なしで
  `"version"` lifecycleスクリプトを定義するだけで済むようになった（詳細は
  [docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md)の「6. リポジトリ差異の吸収
  チェックリスト」参照）。shopping-list自身をこの汎用フックへ移行する作業は本Issueのスコープ外
  のため未実施
- `issue-labels.yml`: `screenshots`ブランチの掃除ジョブを削除
- **`24.screenshot-required`は対応済み（独自実装）**: 導入検討時は「全画面がSupabase Auth +
  Google OAuthログインの背後にあり、CIログインバイパス機構とNotion APIのスタブが無いため無人撮影が
  成立しない」としていた（[docs/cross-repo-automation.md](cross-repo-automation.md)のケーススタディ）が、
  その後shopping-list側で`CI_AUTH_BYPASS_TOKEN`（`backend/auth.js`）と`backend/notion-stub.js`が
  実装され、`scripts/capture-screenshots.mjs`によるPlaywright撮影が動くようになった。issue-deckの
  実装（Claude Codeステップのプロンプト内で撮影）とは異なり、実装ステップの後段に独立したシェル
  ステップとして持つ構成のため、この部分はissue-deckからの同期対象ではない
- **プレビュー環境（`23.preview-required`）**: 以前はissue-deckとFly.ioアプリ
  （`issue-deck-preview`）を共有しており、後からデプロイした側の内容で上書きされる問題があった。
  issue-deck側はサブPCの`tailscale serve`方式へ移行（#1265）してFly.io構成を廃止した（#1308）ため、
  共有による衝突は起きなくなった。**shopping-listには自前の`deploy-preview.yml`が残っている**ので、
  こちらも使われているかどうかを確認して要否を判断する
- `claude-ci-fix.yml`: pnpm/Prisma/Next.js前提のセットアップとビルド用プレースホルダー環境変数を
  削除し、検証コマンドを`npm run check`とmanifestのJSON検証へ置換（guchi-apps/shopping-list#62で導入）
