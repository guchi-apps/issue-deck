# 対応リポジトリ一覧

issue-deckのマルチエージェント自動化ワークフロー一式（`@claude`起動・ラベル遷移による
計画〜実装〜PR作成〜レビューまでの無人実行）が実際に導入され、機能しているリポジトリを
記録する。導入の背景・他リポジトリへ展開する際の検討事項は
[docs/cross-repo-automation.md](cross-repo-automation.md)、実際に導入する際の手順は
[docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md)を参照。**導入済みのリポジトリ群へ
同じ変更を横展開する**ときの進め方は[docs/multi-repo-changes.md](multi-repo-changes.md)。

**privateリポジトリも対象にできる。** organizationは`team`プランのため、organization secretが
privateリポジトリから参照でき、privateでもブランチ保護が効く（2026-08-15に`clip-hive`で実測。
無人実行が`PROGRESS_REPORT_SECRET`で進捗報告APIを叩けている）。#1011が前提に挙げていた制約は
解消済みで、残るのは導入作業だけになった。判断の経緯は
[docs/organization-migration.md](organization-migration.md)を参照。

**インフラ設定・共有知識・個人設定のリポジトリ（`vps`・`subpc`・`docs`・`claude-config`）は、
この表には載せない。** 無人実行は入れず、ローカルセッションとリリースフローだけを載せる、
というのが#1697・#1741の判断（下記「`subpc`・`vps`・`docs`（インフラ設定・共有知識のリポジトリ）」）。
**ただし`vps`・`subpc`には#2103で`claude-review-develop.yml`（develop向けPRのレビューと
自動マージ判定）も載せる**——コードを書かない読み取りだけのレビューで、無人実装を入れる判断とは
別の軸にある（下記「`claude-review-develop.yml`の配布状況」の「`vps`・`subpc`（#2103）」）。
#1011が「順次導入する」としていた`vps`もこの扱いになる。`claude-config`（個人設定）は#1988で
同じ枠へ加えた（下記「`claude-config`（個人設定）」）。

「対応」の実態はワークフローファイル一式・ラベル体系・CLAUDE.md・ブランチ運用・Secretsなど
多軸にわたり、DBスキーマや自動判定で正確に表すのは難しいため、本ドキュメントでの手動記録に
留めている。

ただしワークフローの配布方法には**コピー方式**と**参照方式**の2種類があり、参照方式のものは
手動記録の対象外とする（後述「参照方式のワークフローは sync-state の対象外」）。

**無人実行での撮影可否だけは、画面が読む正が別にある**（#1118）。下の表の備考にも
`24.screenshot-required`の成否は書いてあるが、「実装を開始」ダイアログの出し分けは
[`src/lib/github/screenshot-support.ts`](../src/lib/github/screenshot-support.ts)の一覧だけを見る。
撮影に対応させた・できなくなったときは、表だけでなくそちらも直す（[docs/multi-agent/screenshots.md](multi-agent/screenshots.md)
「撮影に対応しないリポジトリでは選ばせない」）。

**アプリのコードを持たない`guchi-apps/question`（横断質問の置き場）は下の表に載せない。**
実装を行わず盤面にも載らないため、表の読み方（載っている＝無人実行で実装が回る）が崩れる。
扱いは後述「`guchi-apps/question`（質問専用・盤面外）」を参照。

| リポジトリ | ステータス | 導入済み自動化ワークフロー | CLAUDE.md / ラベル体系 | 最終確認日 | 関連Issue | 備考 |
|---|---|---|---|---|---|---|
| `guchi-apps/issue-deck` | 対応済み | 一式（`claude-issue-dispatch.yml`・`issue-labels.yml`・`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`release-develop-to-main.yml`）。うち`issue-labels.yml`は`reusable-issue-labels.yml`をローカルパス参照 | あり（本体） | 2026-08-09 | #354, #501, #940 | issue-deck自身のセルフホスティング。再利用可能ワークフローの提供元でもあり、常に最新を参照するカナリアとして機能する |
| `guchi-apps/shopping-list` | 対応済み | **参照**（5つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml`・`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`。**コピー**: `release-develop-to-main.yml` | あり（新規作成） | 2026-08-13 | #357, #723, #895, #942, #1129 | DBなし・ビルドなし・npm依存パッケージゼロのため、DBセットアップ・pnpm・Playwrightの前段ステップを削除して簡素化。`24.screenshot-required`は撮影自体を独自実装済み。プレビュー環境はissue-deckとFly.ioアプリを共有しており相互に上書きされる（#892で解消予定） |
| `guchi-apps/dayspan` | 対応済み | **参照**（5つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml`・`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`。**コピー**: `release-develop-to-main.yml` | あり（新規作成） | 2026-08-13 | #971, #1129 | Next.js + Prisma + MariaDBのため`runtime-setup: node-db`・`package-manager: pnpm`・`database-name: app_dayspan`・`node-version: "24"`をcallerで指定。`24.screenshot-required`は全画面がSupabase Auth + Google OAuthの背後にありCIログインバイパスもPlaywright依存も持たないため無人撮影は成立せず、ローカル実行でのみ意味を持つラベルとして残している |
| `guchi-apps/meisai-lab` | 対応済み | **参照**（2つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`AGENTS.md`に追記。`CLAUDE.md`は`@AGENTS.md`の1行） | 2026-08-13 | #1051, guchi-apps/meisai-lab#69 | #1047の1周目。Next.js + Prisma + MariaDBで`runtime-setup: node-db`・`package-manager: npm`・`node-version: "20.19"`（`ci.yml`準拠）。`database-name`は既定の`app_ci`。`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`は入れていない（無人実装はdispatchだけで成立するため1周目はスコープを絞った。必要になれば参照方式で追加できる）。**この保留は#1475で解除した**（下記「12リポジトリすべてへ配ると決めた」）。導入前は旧世代のラベル体系で、`05.develop`が付いていた#66の進捗は削除前に控えて書き戻した |
| `guchi-apps/car-care` | 対応済み | **参照**（2つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`AGENTS.md`に追記。`CLAUDE.md`は`@AGENTS.md`の1行） | 2026-08-13 | #1050, guchi-apps/car-care#32 | #1047の2周目。Next.js + Prisma 7 + MySQLで`runtime-setup: node-db`・`package-manager: npm`・`node-version: "20.19"`（`ci.yml`準拠）。`database-name`は既定の`app_ci`。**`test`・`typecheck`のnpm scriptを持たない**が、ワークフローが呼ぶのは`db:migrate:deploy`・`db:seed:ci`（どちらも`24.screenshot-required`付きの実行のみ・`--if-present`で保護）だけのため実害は無く、scriptを足さずAGENTS.mdへ実際の検証コマンド（`lint`・`build:ci`）を書く形にした。`npm run build`は`scripts/with-local-env.sh`経由でローカルの`.env`を要求するため、CI・無人実行は`build:ci`を使う点も明記 |
| `guchi-apps/subscription-lists` | 対応済み | **参照**（2つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-13 | #1052, guchi-apps/subscription-lists#45 | #1047の3周目。Next.js + Prisma + MySQLで`runtime-setup: node-db`・`package-manager: npm`・`node-version: "20.19"`（`ci.yml`準拠）。`test`・`typecheck`・`db:migrate:deploy`・`build:ci`をすべて持ち、共有ワークフローと過不足なく噛み合う。**`/install-github-app`が生成した素の`claude.yml`・`claude-code-review.yml`を削除した**（前者は`claude-issue-dispatch.yml`と同じ`issue_comment`イベントで起動し二重起動していた。詳細は下記）。`CLAUDE.md`・`AGENTS.md`のどちらも無かったため新規作成 |
| `guchi-apps/asset-manager` | 対応済み | **参照**（2つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-13 | #1053, guchi-apps/asset-manager#155 | #1047の4周目。Next.js + Prisma + MySQLで`runtime-setup: node-db`・`package-manager: npm`。**`node-version`は`"20"`**（CIが`ci.yml`ではなく`test.yml`で、そこが`'20'`。他リポジトリの`20.19`と違う）。**`build`系の命名が他アプリと逆**で、`npm run build`がラッパー無し（CI・無人実行向け）、`npm run build:local`がローカル用。`npm run check`は`build:local`を含むため無人実行では使えない。この点をCLAUDE.mdの冒頭に置いた。`.claude/settings.json`は権限許可リストのみで運用ルールは含まない |
| `guchi-apps/portfolio` | 対応済み | **参照**（2つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-13 | #1054, guchi-apps/portfolio#81 | #1047の5周目。**`runtime-setup: node`を初めて使ったリポジトリ**（`prisma/`を持たずDBを使わないため。`node-db`にすると不要なMySQLサービスコンテナの起動・マイグレーション・シードが動く）。`database-name`は`node`では使われないので指定していない。`package-manager: npm`・`node-version: "20"`（`ci.yml`準拠）。**`test`・`typecheck`のnpm scriptを持たず、`lint`と`build`だけ**でCIも同じ2つを実行している。`npm run build`はラッパー無しでCI・無人実行から使え、`npm run build:local`は**1Passwordの`op run --env-file=.env.tpl`経由**なので無人実行では使えない（car-care・asset-managerの`with-local-env.sh`とは失敗の仕方が違い、`op`コマンド自体が無いことで落ちる）。進捗ラベルが`09.main`まで進んだままcloseされずに残っていた#76は、盤面へ載せたあとStatus `Done`にしてcloseした |
| `guchi-apps/solitaire` | 対応済み | **参照**（2つとも`@workflows/v9`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-13 | #1055, guchi-apps/solitaire#23 | #1047の6周目。**`runtime-setup: minimal`を使った唯一の周**（`dependencies`・`devDependencies`のどちらも無く、`package-lock.json`も`pnpm-lock.yaml`も無い素のJS）。`node`/`node-db`にするとロックファイル不在で`npm ci`が落ちるが、`minimal`では`npm ci`・Playwrightインストール・DB準備の各ステップが`runtime-setup != 'minimal'`の条件で丸ごとスキップされる。`node-version: "20"`（`ci.yml`準拠）は`runtime-setup`と独立した軸で、`cache:`を付けずに`setup-node`を呼ぶだけのためロックファイル無しでも失敗しない。**検証コマンドは`npm test`（`node --test tests`）と`npm run build`の2つだけで、どちらもラッパー無しで無人実行から使える**（car-care・asset-manager・portfolioと違い`.env`も1Passwordも要らない）。`npm start`が`python3 -m http.server`である点、テストは`node:test`/`node:assert`で書く点、**`24.screenshot-required`は`minimal`だとPlaywrightが入らず無人実行では成立しない**点をCLAUDE.mdに明記。旧世代の`10.`/`19.`優先度ラベル削除で失われる分は#11・#12へ`89.Priority: low`を付け直した（進捗ラベルはopen issueに1件も付いておらず復元は不要だった） |
| `guchi-apps/myroom` | 対応済み | **参照**（2つとも`@workflows/v10`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-13 | #1056, guchi-apps/myroom#111 | #1047の7周目。**Python + Node の2層構成**（それまでの6周は全てNode単体）。バックエンドはルートで`pytest tests/ -q`（`DB_MOCK=true`）、フロントエンドは**`frontend/`サブディレクトリ**で`typecheck`・`test`・`build`・`lint`。**`cd frontend`を忘れるとフロントエンドのコマンドは動かない**ため、CLAUDE.mdに実行場所をコマンドごとに明記した。`runtime-setup: minimal`（準備ステップは全てリポジトリルートで動くが、ルートの`package.json`はバージョン管理用scriptのみで依存を持たず、`package-lock.json`も空のスタブ`"packages": {}`。実際の依存は`frontend/`にあり、そこへ入るのは実装エージェント自身の仕事）。**`package-manager: npm`は`minimal`でも必要**で、実装ステップの許可ツールの出し分け（#1147）がこの値を見るため、`pnpm`にすると`npm`・`node`が許可されず`frontend/`の検証ができなくなる。Pythonは#1147で`python`・`pip`・`pytest`が常時許可されたが、**`setup-python`は入らずランナー標準のPythonを使う**ためCIの3.11固定とはズレうる。`.gitignore`への共有ディレクトリ追加（#1151）を最初から入れた最初のリポジトリ |
| `guchi-apps/signaly` | 対応済み | **参照**（2つとも`@workflows/v10`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-13 | #1057, guchi-apps/signaly#113 | #1047の8周目（最終周）。**8リポジトリで唯一Nodeが一切無い**（`package.json`がルートにも`frontend/`にも無く、`frontend/`は素のHTML/JS、`scripts/`は全てPythonかbash）。そのため**`node-version`を指定しない唯一のリポジトリ**（他7件は全て指定）。`package-manager`は使わないが**既定値の`npm`のままにする**——`pnpm`にすると実装ステップで`node`が許可されなくなる（#1147）。**`workflows/v10`未満へ下げてはいけない。** v9までは許可ツールが`pnpm`固定で`python`・`pip`・`pytest`のいずれも実行できず、**検証手段がPythonのテストしか無い**（Lintも無い）このリポジトリでは検証が一切できなくなる。テストは`DB_NAME=ci_signaly python -m unittest discover -s backend -p 'test_*.py' -v`で、**`DB_NAME`を忘れると`backend/database.py`のimport時点で落ちる**（実際のDB接続はせず全てモック）。バージョンは`package.json`ではなく`version.json`で`scripts/bump_version.py`経由 |
| `guchi-apps/clip-hive` | 対応済み | **参照**: `issue-labels.yml`・`claude-issue-dispatch.yml`・`version-tag-check.yml`（`@workflows/v18`）・`release-develop-to-main.yml`（`@workflows/v19`） | あり（`CLAUDE.md`を新規作成） | 2026-08-15 | #1376, #1591, guchi-apps/clip-hive#21, guchi-apps/clip-hive#31 | **#1011（Phase 6）の1周目で、privateリポジトリを載せた最初の例。** Next.js + Prisma + MariaDB/MySQLで`runtime-setup: node-db`・`package-manager: npm`・`node-version: "20.19"`（`ci.yml`準拠）。`database-name`は既定の`app_ci`（このリポジトリのCIはサービスコンテナを使わず、ビルド時の`DATABASE_URL`にプレースホルダを渡している）。`lint`・`typecheck`・`build:ci`・`db:migrate:deploy`をすべて持ち、共有ワークフローと過不足なく噛み合う唯一のリポジトリだったため1周目に選んだ。**`npm test`は`lint && typecheck`の別名**でテストランナーは動かず、`npm run dev`は`scripts/ensure-mysql.sh`とローカルの`.env.local`を要求して無人実行では使えない点をCLAUDE.mdに明記した。旧世代ラベルは`05.develop`が#15に付いており、削除前に控えて書き戻した。**リリースフロー（`release-develop-to-main.yml`）は#1591で後から足した**（guchi-apps/clip-hive#31・#32）——`preversion`（`npm test`）を持つため、callerに`bump-command`で`--ignore-scripts`を渡している（後述「`release-develop-to-main.yml`の配布状況」） |
| `guchi-apps/ops-dashboard` | 対応済み | **参照**: `issue-labels.yml`・`claude-issue-dispatch.yml`・`version-tag-check.yml`（`@workflows/v18`）・`release-develop-to-main.yml`（`@workflows/v19`） | あり（`AGENTS.md`に追記。`CLAUDE.md`は`@AGENTS.md`の1行） | 2026-08-15 | #1377, #1591, guchi-apps/ops-dashboard#64, guchi-apps/ops-dashboard#81 | #1011（Phase 6）の2周目。**`runtime-setup: node`をprivateで初めて使った周**（`prisma/`を持たずDBを使わない）。`package-manager: npm`・`node-version: "22.23.1"`。**`node-version`は`.nvmrc`から手で写す**——CIは`node-version-file`で`.nvmrc`を読むが、共有ワークフローはこの入力しか見ない。`test`・`typecheck`のnpm scriptを持たず、CIが`npx tsc --noEmit`を直接叩いているため、AGENTS.mdへ実際の検証コマンド（`lint`・`npx tsc --noEmit`・`build`）を書いた。**ブランチ命名が`feature/<番号>-<説明>`だった唯一のリポジトリ**で、この命名ではワークフローが対象Issueを特定できず進捗が一切遷移しないため、`issue-<番号>`へ揃えることをAGENTS.mdに明記した（既存の`feature/`ブランチ8本は、マージ済みかどうかの判断が要り作業中のものを巻き込む恐れがあるため触っていない）。旧世代ラベルは`07.m:marge`が#26に付いていたが、盤面では既に`Release`になっており書き戻しは不要だった。**リリースフロー（`release-develop-to-main.yml`）は#1591で後から足した**（guchi-apps/ops-dashboard#81・#84）——`preversion`を持たないためcallerの`with:`は`bump-kind`だけで済み、あわせて`"version"` lifecycleスクリプト（`scripts/version-changelog.mjs`）を新設して更新履歴（`src/data/changelog.ts`）がバンプPRに入るようにした |
| `guchi-apps/db-console` | 対応済み | **参照**（3つとも`@workflows/v18`）: `issue-labels.yml`・`claude-issue-dispatch.yml`・`release-develop-to-main.yml` | あり（`AGENTS.md`に追記。`CLAUDE.md`は`@AGENTS.md`の1行） | 2026-08-15 | #1378, #1551, guchi-apps/db-console#19, guchi-apps/db-console#28 | #1011（Phase 6）の3周目。**デフォルトブランチが`main`だった唯一のリポジトリ**で、`develop`へ変更した（`issues`・`issue_comment`はデフォルトブランチのワークフローしか起動しない）。変更前に`develop...main`のファイル差分が空であること——mainの内容はすべてdevelopに含まれ、コミット数の差8件はdevelop→mainのマージコミットだけであること——を実測した。`runtime-setup: node-db`・`package-manager: npm`・`node-version: "22.23.1"`（`.nvmrc`準拠）。**`prisma.config.ts`の`env("DATABASE_URL")`が未設定で即失敗し、postinstallの`prisma generate`ごと`npm ci`が落ちていた**ため、未設定時は接続できないプレースホルダーへ倒す形へ直した（共有ワークフローの依存インストールはDATABASE_URLを渡さない。car-care・clip-hive・dayspanは元から未設定でも通る作りで、`env()`を必須にしていたのはここだけ）。`npm run build`は素だと`/auth/callback`で`ERR_INVALID_URL`になるため、CIと同じプレースホルダーを渡す実行例をAGENTS.mdに書いた。CIのDBは他アプリの`mysql:8.0`ではなく`mariadb:10.11`。旧世代ラベルは`05.develop`が#13に付いており、削除前に控えて書き戻した。**リリースフロー（`release-develop-to-main.yml`）は#1551で後から足した**（guchi-apps/db-console#28・#29）——導入の周では入れておらず、issue-deckの画面のリリースボタンが出ない唯一の対応済みリポジトリになっていた。callerに`with:`は渡していない（ルートの`package.json`の`.version`・npm・更新履歴ファイル無しで、3つのinputはすべて既定値でよい）。`claude-review-develop.yml`は今回も入れていない（develop向けPRの自動マージは、他アプリのDBを直接操作する管理コンソールという性質から保留のまま）。**この保留は#1475で解除した**（下記「12リポジトリすべてへ配ると決めた」） |
| `guchi-apps/aide` | 対応済み | **参照**（2つとも`@workflows/v15`）: `issue-labels.yml`・`claude-issue-dispatch.yml` | あり（`CLAUDE.md`を新規作成） | 2026-08-15 | #1379, guchi-apps/aide#11 | #1047の起票後に作られたためどの周にも入っていなかったpublicリポジトリ。**Node 24を最初に使ったリポジトリ**（`ci.yml`・`engines`とも。当時の他は20〜22帯。#2213の`aide-bot`が2件目）で、Node 24が型ストリッピングで`.ts`を直接実行するため**ビルド工程そのものが無い**。`runtime-setup`は`node`——`dependencies`は空だが`minimal`にすると`npm ci`が走らず、`devDependencies`のTypeScriptが入らないため`npm run typecheck`が通らなくなる。検証は`typecheck`と`test`（`node --test`）の2つだけで、`lint`も`build`も無い。**ラベルがGitHub既定のままだった唯一のリポジトリ**で、旧世代の進捗ラベルすら無く控える作業は不要だった（既定ラベルはどのIssueにも付いておらず、役割が重複するため削除した）。**auto-mergeもrulesetも無かった**ため、有効化と`protect develop`（必須チェックは`typecheck-and-test`）の作成をあわせて行った。`release-develop-to-main.yml`はこの周では入れず、後からguchi-apps/aide#6（クローズ済み）で`@workflows/v18`参照のcallerが追加された（2026-08-15に実測） |
| `guchi-apps/aide-bot` | 対応済み | **参照**（8つとも`@workflows/v25`）: `issue-labels.yml`・`claude-issue-dispatch.yml`・`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`・`claude-pr-repair.yml`・`release-develop-to-main.yml`・`version-tag-check.yml` | あり（`CLAUDE.md`を新規作成。`AGENTS.md`は`CLAUDE.md`を読ませる薄い1枚） | 2026-08-23 | #2213, guchi-apps/aide-bot#1 | **画面の「新規アプリを立ち上げる」（#2188）から立ち上げた最初のリポジトリ**（[new-app-launch.md](new-app-launch.md)）。Next.js 16 + Prisma + MariaDBで`runtime-setup: node-db`・**`package-manager: pnpm`**（`issue-deck`・`dayspan`に続く3件目）・`database-name: app_aide_bot`・`node-version: "24"`（`ci.yml`準拠）。**フリートで唯一、8つのcallerを最初から揃えて始めたリポジトリ**——他リポジトリが#1475・#1948で後追いしている自動修復3つと`claude-review-develop.yml`を、初期化の時点で置いてある。`develop`のブランチ保護（必須チェックは`lint-and-build`）と`Allow auto-merge`も揃っており、`scripts/setup-develop-auto-merge.sh`の後追いは要らなかった（2026-08-23にdry-runで実測）。**`pnpm test`は`lint && typecheck`の別名**でテストランナーは動かず、`pnpm dev`は`scripts/dev.sh`（`ensure-mysql.sh`とローカルの`.env.local`を要求）のため無人実行では使えない。`24.screenshot-required`は撮影の仕組みを持たないため無人実行では成立しない（[`screenshot-support.ts`](../src/lib/github/screenshot-support.ts)にも載せていない） |
| `guchi-apps/trainroute` | 対応済み | **参照**（10個とも`@workflows/v26`）: `issue-labels.yml`・`claude-issue-dispatch.yml`・`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`・`claude-pr-repair.yml`・`release-develop-to-main.yml`・`version-tag-check.yml`・`deploy-retry.yml`・`sync-secrets.yml` | あり（`AGENTS.md`に追記。`CLAUDE.md`は`@AGENTS.md`の1行） | 2026-08-26 | guchi-apps/aide#33 | **guchi-apps/aide#33（AIDEから通勤路線を読む）の依存として立ち上げたpublicリポジトリ。** Next.js 16 + Prisma + MariaDBで`runtime-setup: node-db`・`package-manager: npm`・`node-version: "24"`（`ci.yml`準拠）。`database-name`は既定の`app_ci`。**callerはcar-careから写したため`@workflows/v26`で、v27へは未追従。** 検証コマンドは`lint`・`typecheck`・`build:ci`の3つを揃えてあり共有ワークフローと過不足なく噛み合う（`npm test`は`lint && typecheck`の別名でテストランナーは動かない）。`npm run typecheck`は`next typegen && tsc --noEmit`で、Next.jsが生成する`PageProps`等のグローバル型を先に作らないと`tsc`が解決できないため前段が要る。`develop`のブランチ保護（必須チェックは`lint-and-build`）と`Allow auto-merge`は設定済み。**`24.screenshot-required`は現状成立しない**（Playwrightを持たないため）。ただし認証バイパス（`DISABLE_AUTH=true`。`NODE_ENV=production`では常に無効）は最初から入れてあるので、撮影を足す場合にログイン突破の設計から始める必要はない |

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

## `guchi-apps/question`（質問専用・盤面外）

`guchi-apps/question`は**複数リポジトリ横断の質問Issueの置き場**で（#1454）、アプリのコードを
持たない。画面の「横断質問」で質問Issueがここに作られ、サブPCの
読み取り専用セッション（`scripts/start-cross-repo-question.sh`）が回答コメントを投稿する。
参照するのは「そのホストが実行できると申告した全リポジトリ」のチェックアウトであり、
このリポジトリの中身ではない。

導入前は**Gitリポジトリが空**（コミット0件）で、ラベルもGitHub既定のまま9個だった。#1527で
次の状態にした（**最終確認日: 2026-08-15**）。

| 項目 | 内容 |
|---|---|
| ワークフロー | **参照**（`@workflows/v18`）: `issue-labels.yml`のみ。`on:`は`issues: [closed]`だけ |
| ラベル | 質問運用に使う11個（`00.check-user`・`01.check-input`・`01.check-answered`・`01.check-blocked`・`11.local`・`80.Priority: High`・`89.Priority: low`・`90.Close: *`4種）。GitHub既定ラベル9個は削除 |
| CLAUDE.md | あり（新規作成）。「コードを持たない」「ここで実装しない」「盤面に載らない」を明記 |
| デフォルトブランチ | `main`のまま（実装しないため`develop`を作らない） |
| 盤面（Projects Status） | **載せない** |

### 判断の理由

- **盤面に載せない。** 載せる条件は`claude-issue-dispatch.yml`を持つこと（`hasClaudeWorkflow`。
  `src/lib/github/sync-project-status.ts`）で、実装を行わないこのリポジトリには置いていない。
  質問Issueは#1514で分離した画面の「質問」ビューで見る。載せたい場合の手段は
  「`claude-issue-dispatch.yml`を置く」か「issue-deck側の掲載条件を広げる」の2つだが、
  どちらも質問に実装フローの導線（「実装を開始」・リリース）を持ち込むため採らなかった
- **ラベルは質問運用に使うものだけ配る。** 実装オプション（`21.plan-required`〜`25.artifact-required`）・
  分類（`30.bug`・`50.feature`など）・`71.manual-step`・`01.check-plan`・`01.check-merge`は、
  計画もPRも手作業Issueも発生しないため配っていない。**ラベル一覧はGitHub APIから直接引くため
  （`src/lib/github/issues-api.ts`）、作った時点で画面のラベル選択に出る。DBの再同期は要らない**
- **`on:`をIssueのcloseだけに絞る。** `push`・`pull_request`はコードもPRも無く発火しない。
  `schedule`は盤面を持たないのに15分ごとに`GET /api/progress`を叩くだけになる。
  `issues: opened/edited`は`manual-step-label`ジョブ（#1492）が対象で、`71.manual-step`が
  未定義のため`gh issue edit`がexit 1でジョブごと落ちる（#975と同じ失敗）——**タグを上げるときも
  足さない**
- **`PROGRESS_REPORT_SECRET`は渡していない**（呼ばれる側で`required: false`）。盤面に載らない
  ため報告先が無く、報告のステップは警告を出してスキップされる

### v18では理由ラベル`01.check-*`は外れない（#1527で実測）

質問Issueをクローズしたときに効くのは`cleanup-on-close`ジョブだけだが、**`@workflows/v18`の
時点で外すのは`00.check-user`のみ**である。理由ラベル`01.check-*`もまとめて外す改修（#1490）と
`manual-step-label`ジョブ（#1492）はdevelopに入っているが、**v18より後のコミットのためタグに
乗っていない**。

```bash
# タグと develop の差を見る
git log workflows/v18..origin/develop --oneline -- .github/workflows/reusable-issue-labels.yml
```

**これはquestion固有ではない。** 2026-08-15時点で`issue-labels.yml`のcallerを持つリポジトリは
すべて`@workflows/v18`を参照しており、同じ状態にある。次のタグを切って各callerを上げた時点で
まとめて解消する（[cross-repo-setup-guide.md](cross-repo-setup-guide.md)「共有ワークフローの
タグ運用」）。

## `issue-labels.yml`callerの`issues:`トリガーの揃い方（#2010）

`manual-step-label`ジョブ（#1492。タイトルが`[手作業]`のIssueへ`71.manual-step`を付ける）は
`issues: types:`に`opened`・`edited`が無いと発火しない。**`on:`はcaller側にしか無く、
`@workflows/vN`のタグを上げても増えない。** 2026-08-22時点の実測は次のとおり。

| `types: [opened, edited, closed]` | `issue-labels.yml`のcallerを持つ全リポジトリ（`db-console`・`question`を除く） |
|---|---|
| `types: [closed]`のみ | `db-console`（#1501の配布から漏れたもの）・`question`（意図的。下記） |

```bash
# 揃っているかの確認
for r in $(gh repo list guchi-apps --limit 60 --json name --jq '.[].name'); do
  body=$(gh api "repos/guchi-apps/$r/contents/.github/workflows/issue-labels.yml" \
    --jq .content 2>/dev/null | base64 -d 2>/dev/null) || continue
  [ -n "$body" ] || continue
  echo "$r: $(grep -A2 '^  issues:' <<< "$body" | grep 'types:' | head -1)"
done
```

- **`db-console`は`schedule`（`*/30`）を持つため、#2010の定期巡回では結果的に救われる**
  （タイトルが`[手作業]`で始まるopenなIssueのうちラベルの無いものを埋め直す）。ただし最大30分
  遅れるため、トリガー定義自体はguchi-apps/db-console#60で揃える
- **`question`は`schedule`も持たないため巡回も届かない。** 盤面に載らず手作業Issueも
  `71.manual-step`の定義も無いリポジトリなので、意図どおり（上記「`on:`をIssueのcloseだけに絞る」）

## `claude-review-develop.yml`の配布状況（#1470）

develop向けPRを「自動マージしてよい」「ユーザーのマージが必要」のどちらかへ確定させるのは
`claude-review-develop.yml`（本体は`reusable-claude-review-develop.yml`）**だけ**である。
`risk-check`が機械的に判定し、`auto-merge`が`00.check-user`の付与と`gh pr merge --auto`に
反映する（[multi-agent/labels.md](multi-agent/labels.md)「自動マージ可否の判定方法」）。

**2026-08-15時点では`issue-deck`（ローカルパス参照）・`dayspan`・`shopping-list`の3つしか
持っていなかった。** #1475で12件すべてへ配ると決め、#2103で`vps`・`subpc`も配ると決めた
結果、2026-08-25時点では下の「対象外」を除く全リポジトリへ行き渡っている。

| 配布済み | `issue-deck`（ローカルパス参照）・`aide`・`aide-bot`・`asset-manager`・`car-care`・`clip-hive`・`dayspan`・`db-console`・`meisai-lab`・`myroom`・`ops-dashboard`・`portfolio`・`shopping-list`・`signaly`・`solitaire`・`subscription-lists`・**`vps`・`subpc`**（#2103。callerの新規配布は画面のボタンの対象外なので手で配った。参照タグの配布は#2303で対象に入った。下記「`vps`・`subpc`（#2103）」） |
|---|---|
| **対象外** | **`docs`・`claude-config`**（どちらも`develop`を持たず、PRが`issue-<番号>` → `main`の直行になる。`base: develop`のトリガーが一度も発火しないため、置いても効かない） |

**`aide-bot`は立ち上げ（#2213）の時点から配布済み。** 初期化Issue（guchi-apps/aide-bot#1）で
callerを8つまとめて置いたため、この配布経路の後追いが要らなかった。同じことが下の
`release-develop-to-main.yml`・自動修復3つ・`version-tag-check.yml`にも当てはまる。
**新しいリポジトリでこう置けるとは限らない**——揃えたのは初期化を実装したセッションで、
画面の「新規アプリを立ち上げる」が自動で配るわけではない。

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

**リリースフロー（`release-develop-to-main.yml`）とは配布の軸が別。** 実際、`db-console`は#1551で
リリースフローだけを足し、`claude-review-develop.yml`は未配布のままにしていた。

### 12リポジトリすべてへ配ると決めた（#1475）

**除外したリポジトリは無い。** 起票時の想定は「更新頻度が低いリポジトリでは手動マージのままで
困らない」だったが、2026-08-22の実測ではそれに当たるリポジトリが1つも無かった。

| リポジトリ | develop向けPR（直近8〜12日） | 機能PRのうち低リスク |
|---|---|---|
| `aide` | 62 | 8 / 20 |
| `ops-dashboard` | 49 | 7 / 10 |
| `car-care` | 41 | 3 / 9 |
| `subscription-lists` | 41 | 2 / 5 |
| `myroom` | 40 | 6 / 10 |
| `asset-manager` | 37 | 3 / 6 |
| `meisai-lab` | 36 | 5 / 7 |
| `solitaire` | 32 | 4 / 5 |
| `portfolio` | 32 | 1 / 5 |
| `signaly` | 31 | 2 / 4 |
| `db-console` | 28 | 1 / 6 |
| `clip-hive` | 27 | 2 / 4 |

「機能PRのうち低リスク」は、`issue-<番号>`ブランチのPRから**`.github/`だけを触ったPR**
（フリート展開の波で一時的に増えているぶん）を除き、内蔵リスクパターンに当たらなかったものの
割合。全体で **91件中44件（約45%）** が自動マージの取り分になる。

過去に記録されていた2つの保留理由も、この回で解消した。

- **`meisai-lab`** — 導入1周目で意図的にスコープを絞っていた（上の表の備考）。当時の記述自体が
  「必要になれば参照方式で追加できる」であり、その後`claude-conflict-resolve.yml`・
  `claude-ci-fix.yml`・`claude-pr-repair.yml`とリリースフローが入って前提が変わった。
- **`db-console`** — 「他アプリのDBを直接操作する管理コンソールという性質から保留」（#1551）。
  リスク判定は**入力でリスクを追加できるが削減はできない**設計で、内蔵パターン
  （`.env*`・`**/auth/**`・`prisma/migrations/**`・`.github/workflows/**`）が当たれば
  自動マージは止まる。実測でも機能PR6件中5件がリスク該当で、自動マージされるのは残り1件だけ。
  **保留を続けても止まるPRの本数がほとんど変わらない**ため、他と揃えて配る。

### 配る前に`develop`のブランチ保護が要る（#1475）

**未配布12リポジトリすべてに、`develop`のブランチ保護が無かった**（配布済み3つはいずれも
必須ステータスチェックを持つ。`issue-deck`・`dayspan`は`lint-and-build`、`shopping-list`は`lint`）。

保護が無いと`auto-merge`ジョブの`gh pr merge --auto`が**「既にマージ可能」として断られる**。
ジョブは失敗し、`auto-merge-fallback`が`00.check-user`を付ける——**callerを置いても
自動マージは1本も成立せず、失敗したジョブのぶんノイズが増えるだけ**になる
（[organization-migration-checklist.md](organization-migration-checklist.md)にも既知として記載）。

**設定はGitHub Actionsからは変えられない。** `WORKFLOW_PAT`の権限は Contents / Issues /
Pull requests / Actions / Workflows / Metadata だけで、**Administration を持たない**
（[organization-migration.md](organization-migration.md)）。`PATCH /repos/{repo}`
（`allow_auto_merge`）もブランチ保護APIも Administration: write が要る。実際
`propagate-workflow-tag.sh`は配布のたびに`allow_auto_merge=true`を`|| true`付きで試して
いたが、タグ配布PRが何度もマージされたリポジトリを含む**12件中8件が今も`false`**だった——
握り潰していたため失敗が一度も表に出ていない。

そのため次の順で行う。

1. **前提を揃える**（org owner本人が一度だけ）: `scripts/setup-develop-auto-merge.sh`。
   既定はdry-runで、`--apply`で`Allow auto-merge`の有効化と`develop`のブランチ保護作成を行う。
   **必須チェック名はワークフローのジョブ名から推測せず**、直近のdevelop向けPRで実際に
   成功したcheck runと突き合わせて一致したものだけを使う（実在しない名前を必須にすると
   永久に埋まらずマージ不能になるため、突き合わせに失敗したら保護を作らない）。
   CIのジョブ名はリポジトリごとに違う（実測: `lint-and-build`が4件、`test`が3件、
   `verify`が2件、`typecheck-and-test`・`backend`が各1件、`myroom`だけ`backend`と`frontend`の2件）
2. **callerを配る**: issue-deckの画面（設定＞フリート運用）の「不足・破損しているワークフローを配る」
   （[multi-agent/auto-repair.md](multi-agent/auto-repair.md)「配布状況と、不足しているcallerの配布」）。
   配布スクリプトは前提が揃っているかを**読んで警告するだけ**で、設定は変えない
3. 各リポジトリで配布PRを確認してマージする（GitHub Actionsの変更なので自動マージしない）

**同じ保護が`release-develop-to-main.yml`のバンプPRにも効く。** バンプPRも
`gh pr merge --auto --merge`で自動マージを予約しており、保護が無いリポジトリでは同じ理由で
失敗して警告だけ出し、実際には画面のリリース操作で手動マージされていた。

### `vps`・`subpc`（#2103）

**この2件へも配ると決めた**（起点は guchi-apps/question#26「すべてのリポジトリで、developへの
マージ前に問題ないかをClaude Codeがチェックする機能はあるか。**特にVPSやsubPC**」）。#1475の
12件とは別枠で、「無人実行は入れない」4件（下記「`subpc`・`vps`・`docs`」「`claude-config`」）
のうち`develop`を持つ2つが対象。**無人実装（`claude-issue-dispatch.yml`）は入れないままで、#1741の
判断は変えない**——レビュージョブの許可ツールは`Read`/`Grep`/`Glob`と`gh`の読み取り、および
Issueへのコメント・ラベル付与だけで、コードを書かない。

**#1475の12件と違い、配る前の前提はもう揃っている**（2026-08-22実測。`setup-develop-auto-merge.sh`
を掛ける必要が無い）。

| 項目 | `guchi-apps/vps` | `guchi-apps/subpc` |
|---|---|---|
| `Allow auto-merge` | 有効 | 有効 |
| `develop`のブランチ保護 | ruleset `protect develop`（id=20909317） | 同（id=20909724） |
| 必須ステータスチェック | `verify`（`ci.yml`の実ジョブ名） | `shell`（同左） |
| CIのワークフロー名 | `CI`（`wait-for-ci`は`name == "CI"`で探す） | 同左 |
| org secrets | `CLAUDE_CODE_OAUTH_TOKEN`・`WORKFLOW_PAT`とも到達済み（`release-develop-to-main.yml`が使用中） | 同左 |

**自動マージの取り分は文書だけになる。** 直近のdevelop向けPR（vps 16本・subpc 14本）を内蔵
パターンと下記`risk-paths`で判定すると、自動マージされるのは7本で、**すべてREADME.md・
CLAUDE.md・docs/のみのPR**。`apache/`・`scripts/`・`setup.sh`・`configs/`・`.github/`を触るPRは
全部止まる。**これは「レビューが要らない」ではなく「実配置の変更は全部レビュー対象になる」で、
mainマージが即本番反映になるこの2件ではむしろ望ましい。** 得られるのは自動マージ本数ではなく、
人がマージする前に読めるレビューコメントの方である。

> **バンプPRではレビューだけが走る。** `release/vX.Y.Z`は`issue-<番号>`でないため
> `identify-issue`が空になり、`auto-merge`はスキップされる一方、`risk-check`は
> 「対応Issue番号を特定できないため（安全側でレビューを実行）」で`claude-review`を起動する
> （issue-deck自身のバンプPRでも実際に走っている）。この2件はバンプPRの比率が高い
> （vps 5/16・subpc 4/14）ため、callerの`on:`へ`paths-ignore: [version.json]`を入れて避ける。
> バンプPRは`version.json`1ファイルなので、`paths-ignore`が全ファイルに当たり丸ごとスキップされる。

#### `main`へ届くまでは「レビュー無しの自動マージ」だけが効く

**この2件はデフォルトブランチが`main`のまま**（`drift-check.yml`のschedule実行がデフォルト
ブランチを実機と突き合わせるため。下記「`subpc`・`vps`・`docs`」）。ここに次の食い違いがある。

- `develop-pr-opened`の保険は**PRのbase（＝`develop`）側**のcallerの有無しか見ない
  （`reusable-issue-labels.yml`の`repos/$GH_REPO/contents/.github/workflows?ref=$BASE_REF`）。
  callerが`develop`へ入った瞬間に`00.check-user`を付けなくなる
- 一方`claude-code-action`は**ワークフローファイルがデフォルトブランチ（＝`main`）の同ファイルと
  一致しない限りClaudeを実行しない**。しかも**ステップもジョブも`success`で終わる**
  （[multi-agent/labels.md](multi-agent/labels.md)「ワークフローファイルを変更するPRでは
  claude-reviewが必ずスキップされる」）
- `auto-merge`の条件は`claude-review`が`success`または`skipped`であることだけで、
  レビューが実際に行われたかは見ない

つまり**callerを`develop`へマージしてから`main`へ届くまでの間、低リスクPRはレビュー無しで
自動マージされる。** 配るときは`develop`へのマージで止めず、続けてリリース（develop→main）を
回して`main`へ入れ、その次のdevelop向けPRで`claude-review`の`execution_file`が出ている
（＝Claudeが実際に走った）ことまで確認する。

#### 画面の配布ボタンの対象外なので手で配る

「不足・破損しているワークフローを配る」（#1948・#1475）は`claude-review-develop.yml`の`requires`を
`claude-issue-dispatch.yml`としており（[`lib/workflow-tags.ts`](../src/lib/workflow-tags.ts)の
`REPAIR_WORKFLOW_SPECS`）、無人実行を入れないこの2件は永久に対象にならない。**`requires`は
緩めない**——`issue-labels.yml`へ替えると`develop`を持たない`docs`まで対象に入り、置いても
発火しないcallerを配ることになる。代わりに各リポジトリへIssueを立てて手で配る
（guchi-apps/vps#108・guchi-apps/subpc#45）。

**対象外なのは「callerの新規配布」だけで、参照タグの配布は#2303で対象に入った。** 一覧の
母集団は`hasClaudeWorkflow`ではなく「`.github/workflows/`が`@workflows/vN`を参照して
いるか」で決まるようになったため、`vps`・`subpc`・`docs`・`claude-config`・`question`にも
画面のボタンからタグ更新PRが配られる（共有スクリプトの更新も同じ）。手で配り続ける必要が
あるのは、無人実行のcallerを持たないリポジトリへの**新しいcallerの追加**だけ。

**`claude-issue-dispatch.yml`はどのcallerの`requires`にも入っている**（#2303）。
`vps`・`subpc`は`release-develop-to-main.yml`・`deploy.yml`を持つため、入っていないと
`claude-pr-repair.yml`・`deploy-retry.yml`が不足として挙がるが、
`.github/scripts/propagate-repair-workflows.sh`は参照タグと`with:`の写し元である
`claude-issue-dispatch.yml`が無いと`fail`で落ちるので、押した時点で必ず失敗する。
**条件は`REPAIR_WORKFLOW_SPECS`の`requires`にだけ書き、`missingRepairWorkflows`側に特例を
足さない**——同じ`requires`をPR詳細の文言（`resolveMissingState`）も読むため、片方だけ
変えると「一覧には出ないのに、PR詳細は配れますと案内する」行き止まり（#1960）が復活する。
この2件はPR詳細でも「配布の対象外のため、必要なら手動で追加してください」と案内される。

雛形は`.github/templates/callers/claude-review-develop.yml`を写し、`__TAG__`（`uses:`と
`prompts-ref`の2か所）を現行タグへ置換したうえで、共通の`risk-paths` 4行へリポジトリ固有の
行を足す。**固有の行は`deploy.yml`の`paths`（＝実機へ反映される受け口）に合わせる。**

> **参照タグは`workflows/v26`以降にする**（#2126）。`workflows/v25`までの
> `reusable-claude-review-develop.yml`は`risk-check`の`permissions:`に`contents: read`を
> 持たず、**privateリポジトリではcheckoutが`Repository not found`で必ず失敗する。**
> `risk-check`が落ちると`claude-review`・`auto-merge`・両fallbackがすべてskipされるため、
> リスク判定も自動レビューも自動マージも効かず、**PRには失敗した旨の通知すら出ない**
> （guchi-apps/subpc#46で実測）。callerの`permissions:`は呼び出し先の上限を決めるだけなので
> caller側では回避できない。**この2件はどちらもprivateなので、v25のまま配ってはいけない。**

**書式は`<正規表現> :: <理由>`（区切りは半角スペース2つのコロン）で、正規表現だけを書くと
`risk-check`が`::error::`で落ちる。** 落ち方が静かなのが厄介で、`risk-check`が失敗すると
`auto-merge`は条件（`needs.risk-check.result == 'success'`）を満たさずskip、
`auto-merge-fallback`は`auto-merge`がfailureのときしか動かないのでこちらもskipになり、
**`00.check-user`が付かないまま自動マージもされない**PRになる（PR作成時の保険は、callerの実在を
見た時点で通り抜けている）。下の表は正規表現だけを載せているので、写すときに理由を足すこと。

| | 足す`risk-paths`の正規表現 | 由来 |
|---|---|---|
| `vps` | `^(apache\|systemd\|cron\|scripts\|fail2ban)/`・`^\.github/scripts/` | `deploy.yml`の`paths`と同じ5つ。`mysql/`（記録用）・`.claude/`は`paths`外 |
| `subpc` | `^(setup\.sh$\|scripts/\|configs/)`・`^\.github/scripts/` | 同じく`deploy.yml`の`paths`の3つ |

**`dependency-check`は指定しない。** 判定はルートの`package.json`の変更しか見ず
（`reusable-claude-review-develop.yml`の`grep -q '^package\.json$'`）、この2件はどちらも
ルートに`package.json`を持たない方針のため、`any`・`none`のどちらでも結果が変わらない。

## `release-develop-to-main.yml`の配布状況（#1551）

**issue-deckの画面のリリースボタンが出るかどうかは、このcallerの実在だけで決まる**
（#1538。判定は[`lib/github/release-workflow-cache.ts`](../src/lib/github/release-workflow-cache.ts)の
`releaseWorkflowExists`で、結果は10分キャッシュする）。無人実行（計画〜実装）を入れているかとは
独立しているため、ここに分けて記録する。

**通知ベル（PC・スマホ）とリポジトリ一覧のバッジ（スマホ）も同じ基準になった**（#1727。
ベルは#1772でスマホのヘッダーにも置いた）。こちらは
`/api/repositories/release-pending-merges`が母集団を`hasClaudeWorkflow: true`で先に絞っており、
#1538がボタンについて取り除いたのと同じ代用（`claude-issue-dispatch.yml`の有無で
「リリースworkflow導入済み」を代用する）が残っていた。無人実行を入れずにリリースフローだけを
載せたリポジトリでは、**ボタンは出るのに「マージ待ち」の通知だけ出ない**という食い違いになる。

2026-08-16時点の実測。

| 配布済み | `issue-deck`（ローカルパス参照）・`shopping-list`・`dayspan`（この2つはコピー方式）・`car-care`・`meisai-lab`・`asset-manager`・`subscription-lists`・`portfolio`・`solitaire`・`myroom`・`signaly`・`aide`・`db-console`（#1551で追加）・**`clip-hive`・`ops-dashboard`**（#1591で追加）・**`subpc`・`vps`**（#1706・#1727。2026-08-16に導入） |
|---|---|
| **未配布** | なし |
| **対象外** | **`docs`**（デプロイを持たず「マージ＝全アプリへ反映」のため、リリースという段階を挟む意味が無い。guchi-apps/docs#15） |

**`aide-bot`はこの実測の後に作られ、立ち上げ（#2213）の時点で配布済み。**

### `subpc`・`vps`・`docs`（インフラ設定・共有知識のリポジトリ）

無人実行（計画〜実装）は入れないまま、**リリースフローだけを載せた**対象
（#1706・#1727。作業は guchi-apps/subpc#13・guchi-apps/vps#80。**2026-08-16に完了**）。
`docs`だけはリリースフローも入れない（後述）。

**その後#2103で、`subpc`・`vps`には`claude-review-develop.yml`（develop向けPRのレビューと
自動マージ判定）も載せると決めた**（`docs`は`develop`を持たないため対象外）。**「リリース
フローだけ」ではなくなったが、無人実装（`claude-issue-dispatch.yml`）を入れない判断は
変えていない**——レビュージョブはコードを書かず、Issueへのコメントとラベル付与だけを行う。
判断・前提・配り方は上記「`claude-review-develop.yml`の配布状況」の「`vps`・`subpc`（#2103）」を
参照（作業は guchi-apps/vps#108・guchi-apps/subpc#45）。

> **ローカル起動（サブPC）は#1741で対応済み。** 配布の軸が違うので混同しない——リリース
> フローはGitHub Actions側の話で、こちらは「issue-deckの画面の『サブPCで開始』が押せるか」。
> 無人実行を入れていない2件でも、**この2件のIssueはサブPCのローカルセッションで回せる**
> （下記「ローカル起動プロトコルの適合状況」の※4）。`docs`も同じ回で載せた。
2026-08-16の導入後の状態は次のとおり。

| 項目 | `guchi-apps/subpc` | `guchi-apps/vps` | `guchi-apps/docs` |
|---|---|---|---|
| デフォルトブランチ | `main`（据え置き） | `main`（据え置き） | `main` |
| `develop` | あり（`main`から作成） | あり（**#79で`main`へ揃え直した**） | **持たない**（作ったうえで削除） |
| バージョンファイル | `version.json`（`1.0.0`） | `version.json`（`1.0.0`） | 無い |
| `release-develop-to-main.yml` | `@workflows/v19`（`develop`・`main`の両方） | 同左 | 入れない |
| `deploy.yml` | ある（`push: main`。**サブPC上のセルフホストランナー**） | ある（`push: main`。SSHでVPSへ反映） | 無い |
| Allow auto-merge | 有効 | 有効 | 有効（使わない） |
| `version-tag-check.yml` | 対象外（`deploy.yml`に`tag`ジョブが無い） | 対象外（同左） | 対象外 |
| `CLAUDE.md` | あり（新設） | あり（新設） | あり（自リポジトリ実装向けの節を追記） |
| ラベル体系 | issue-deckと同一へ統一 | 同左 | 同左 |
| `issue-labels.yml` | `@workflows/v25`（guchi-apps/subpc#32で2026-08-18に追加） | `@workflows/v25`（#1901の残課題だったが配置済み。2026-08-22に実測） | `@workflows/v23`（#1901。main直行の遷移ジョブが要る） |
| `claude-review-develop.yml` | **#2103で配ると決定**（guchi-apps/subpc#45） | **#2103で配ると決定**（guchi-apps/vps#108） | 対象外（`develop`を持たない） |

> **進捗を`Implementation`から先へ進める経路は`issue-labels.yml`が持っている。** 3件とも当初は
> 持っておらず、ローカルセッションが起動時に付ける`Implementation`のまま、PRをマージしても
> issueが盤面の「実行中」に残り続けた（`subpc`の#10・#14・#19、`docs`の#3で実際に発生し、
> 手で`Done`にしてcloseした）。**このワークフローはClaude Codeを一切起動しない**——
> issue-deckの進捗報告API（`POST /api/progress`）を叩くのと`00.check-user`を外すだけなので、
> 「無人実行は入れない」という#1741の判断とは別の軸にある。
>
> **`docs`はcallerを入れるだけでは解消しない**（#1901）。`develop`を持たずPRが
> `issue-<番号>` → `main`の形になるため、`base.ref == 'develop'`か`head.ref == 'develop'`を
> 見る既存ジョブがどれも発火しない。`workflows/v23`の`main-direct-pr-opened`・
> `main-direct-merged`が要る（[cross-repo-setup-guide.md](cross-repo-setup-guide.md)の
> 「`develop`を持たないリポジトリ（main直行）」）。

**`vps`の`develop`は`main`から21コミット遅れ・3コミット先行で分岐していた**（guchi-apps/vps#79）。
先行分は`main`側により新しい形で入っており固有の成果が無かったため、退避ブランチ
（`backup/develop-before-realign-260816`）を作ってから`develop`を`main`へ強制更新した。
**Issueブランチを`main`へ直接マージすると同じ状態に戻る**ため、両リポジトリの`CLAUDE.md`に
その旨を書いてある。

> **既定ブランチを`main`に据え置くなら、`delete_branch_on_merge`を切る**（#1786）。
> `develop`→`main`のリリースPRは**headが`develop`**なので、この設定が`true`だとマージした瞬間に
> **`develop`ブランチごと消える**。2026-08-16に`vps`・`subpc`の両方で実際に消えた
> （guchi-apps/vps#84・guchi-apps/subpc#18のマージ直後。guchi-apps/vps#71で気づいた）。
> GitHubは既定ブランチを削除しないため、**既定が`develop`の他リポジトリでは起きない**。
> リリース自体は成功して`main`へ反映されるので、その回は何も問題が起きず気づけない——
> 次のリリースで`push: develop`が発火せず、`ref: develop`のdispatchが404になって初めて分かる。
> `delete_branch_on_merge: false`にし、rulesetに`deletion`制限も入れて二重に防ぐ
> （`vps`は`protect develop`（id=20909317）で対応済み）。

**`docs`はリリースフローを入れない**（guchi-apps/docs#15）。共有知識への反映PRは`main`宛に届く
（`vars.SHARED_CONTEXT_REF || 'main'`）ため、`develop`を挟むと提案PRのマージのたびに`develop`が
behindになり、guchi-apps/vps#79と同じ分岐状態に向かう。**この変数は「提案PRの宛先」と
「各アプリが共有知識を読むref」の両方に使われている**ので、`develop`へ切り替えると全アプリが
未リリースの共有知識を読むことになる。分離する改修なしには成立しないため、`main`直運用を正とした。

**どちらもNodeを使わないため、バージョンの持ち方は`signaly`と同じ形になる**
（`version.json` + `version-file`・`bump-command`。上記「リリースワークフローのバージョン管理方式」）。
`package.json`を置いてしまうと、依存を持たないインフラ設定リポジトリにnpmの体裁だけが増える。

**デフォルトブランチが`main`のままでも載せられるが、callerは`main`にも入れる。**
`workflow_dispatch`はワークフローファイルがデフォルトブランチに無いと有効にならず、
issue-deckの起動（`ref: develop`のdispatch）が404になる。**この2件はデフォルトを`develop`へ
移さない**——どちらも`drift-check.yml`が`schedule`で動き、スケジュール実行はデフォルトブランチの
内容を実機と突き合わせるため、`develop`をデフォルトにすると`main`未反映の変更が毎日ドリフトとして
報告される（`db-console`でデフォルトを`develop`へ移したときとは事情が違う。あちらは
`issues`・`issue_comment`のワークフローを載せるための変更だった）。

> **issue-deckのリリース画面のバージョン表示は`package.json`固定**
> （[`lib/github/release-api.ts`](../src/lib/github/release-api.ts)の`fetchPackageVersion`）。
> `version.json`を使うリポジトリでは`main`/`develop`の版数が`-`と表示され、
> `release_pending`（developだけbump済みの過渡状態）も判定されない。**起動・PR作成・マージ待ちの
> 通知はいずれもPRの実在から判定するため動く。** 既に`signaly`が同じ状態にある。

**未配布のリポジトリではリリースボタンが出ない。** 押せないだけでなく、develop→mainのリリースPRも
バージョンbumpも自動化されないため、リリースは手作業になる（手作業リリースはタグ重複などの
リポジトリ固有の制約を毎回踏む。[multi-agent/release.md](multi-agent/release.md)参照）。

### `claude-config`（個人設定）

個人設定（`~/.claude/CLAUDE.md`・個人skill）の実体
（[multi-agent/personal-config-sync.md](multi-agent/personal-config-sync.md)）。上の3件と同じ枠で、
**無人実行は入れずサブPCのローカルセッションだけで回す**（#1988。起点は guchi-apps/question#19、
この経路が要る最初の実例は guchi-apps/claude-config#1）。`~/.claude/`へsymlinkで直結している資産で、
GitHub Actionsの実行環境には存在しないため、無人実行に実装させる意味が薄い。

**リリースフローも入れない。** `docs`と同じく`develop`を持たず、デプロイも無い
（反映は各マシンの`git pull`）ため、リリースという段階を挟む先が無い。

2026-08-19に実測した状態と、#1988で行った作業は次のとおり。

| 項目 | #1988の前 | #1988の後 |
|---|---|---|
| ラベル体系 | GitHub既定の9個のまま（`11.local`・`00.check-user`が無い） | issue-deckと同一（既定9個は削除） |
| `~/.config/issue-deck/local-repos.conf` | 未記載 | `/home/guchi/apps/claude-config`を追記 |
| ポート帯（[scripts/local-repo-ports.conf](../scripts/local-repo-ports.conf)） | 未確保 | 23000 |
| フォルダの信頼確認（#1838） | 未承認 | 手作業として起票（#1994） |
| `.github/workflows/` | 無し | 無し（`issue-labels.yml`は guchi-apps/claude-config#2 で別途） |
| ブランチ | `main`のみ（`develop`なし・`origin/HEAD`未設定） | 据え置き |

- **対応表を足すだけで申告に載る。pollerの再起動は要らない**（#1988で実測。追記から次の巡回で
  18件→19件になった）。`local_repo_list_runnable()`が申告のたびに`local-repos.conf`を読み直す
- **`origin/HEAD`が未設定でも起動には影響しない。** 汎用ランチャーの`resolve_base_branch`が
  `git remote set-head origin --auto`で引き直す（[scripts/generic-start-issue.sh](../scripts/generic-start-issue.sh)）。
  `develop`を持たないので、PRは`docs`と同じく`issue-<番号>` → `main`の直行になる
- **`main`のブランチ保護は入れない。** `docs`にもruleset は無く、マージするのは人だけで、
  守るべき自動マージ経路（`claude-review-develop.yml`）がそもそも走らない。
  `delete_branch_on_merge: true`のままでよいのも`docs`と同じ理由で、#1786が問題にしたのは
  **headが`develop`のリリースPR**であり、`develop`を持たないリポジトリでは起こらない
- **進捗は`Implementation`で止まる。** ローカルセッションが起動時に`Implementation`を報告した後、
  `Develop PR`以降を報告するのは`issue-labels.yml`で、このリポジトリには`.github/workflows/`自体が
  無い（`docs`#3・`subpc`#10・#14・#19と同じ状態）。**入れるまでは手で`Done`にしてcloseする。**
  導入は guchi-apps/claude-config#2 で分けた——`develop`を持たないため`workflows/v23`の
  `main-direct-pr-opened`・`main-direct-merged`が要る（#1901・#1917）
- **マージしただけでは実機に反映されない。** `~/.claude/CLAUDE.md`・`~/.claude/skills`は
  `~/apps/claude-config`（本体チェックアウト）へのsymlinkなので、`main`へマージしたあと両機で
  `git pull`するまで効かない。取り残しは`check-sync.sh`（[scripts/lib/personal-config-sync.sh](../scripts/lib/personal-config-sync.sh)が
  各セッションの起動時に呼ぶ）が「originより遅れている」として警告するため、経路自体は閉じている
- **`package.json`を持たない。** 依存インストールとenvの配置は不要
  （[multi-agent/generic-launcher.md](multi-agent/generic-launcher.md)「envは既定では置かない」）。
  ポート帯だけは、上の3件と同じ理由（既定の`3000 + Issue番号`への相乗りを避ける）で確保する

> **このリポジトリの`CLAUDE.md`は個人グローバルルールそのもの。** worktreeのルートに置かれた
> `CLAUDE.md`はプロジェクト指示として読まれ、同時に`~/.claude/CLAUDE.md`（本体チェックアウトへの
> symlink）もグローバルルールとして読まれるため、**同じ内容が2枠に載る**。実害は2つあり、
> どちらも「読み込まれない」側ではなく「読み込まれすぎる」側に出る。
>
> - 同じ文面がコンテキストに二重に入る（内容が同じなので判断は壊れないが、無駄が出る）
> - **リポジトリ固有の運用ルールを`CLAUDE.md`へ書けない。** 書くと全マシン・全セッションの
>   グローバルルールになる。ブランチ運用やPRの宛先を残すなら`README.md`側にする
>   （`README.md`はセッションへ自動で読み込まれない）。`subpc`・`vps`・`docs`が
>   `CLAUDE.md`に自リポジトリ向けの節を持っているのと、ここだけ扱いが違う

### callerの`bump_kind`入力の配布状況（#1603）

**`@workflows/v19`への引き上げだけでは、画面から上げ幅（major/minor/patch）を指定できない。**
`reusable-release-develop-to-main.yml`が`bump-kind`を受け取れるようになっても、指定を運ぶのは
caller側の`workflow_dispatch`の`inputs`で、そこは配布（`propagate-workflow-tag.yml`）が
書き換える`@workflows/vN`・`prompts-ref`の外にあるため、**タグ配布とは別に手で足す必要がある**
（#1565の②）。足すまでは画面で上げ幅を選ぶと「上げ幅の指定に未対応です」になる
（自動判定での起動は従来どおり動く）。

callerに置く形は次の2か所で、`issue-deck`自身の
[`release-develop-to-main.yml`](../.github/workflows/release-develop-to-main.yml)が手本になる。

```yaml
on:
  workflow_dispatch:
    inputs:
      bump_kind:
        description: "バージョンの上げ幅（autoならコード差分から自動判定）"
        required: false
        type: choice
        default: auto
        options: [auto, patch, minor, major]

jobs:
  release:
    with:
      # pushトリガー（バンプPRのマージ）で起動したときは`inputs`自体が無いため空文字を渡す。
      bump-kind: ${{ github.event_name == 'workflow_dispatch' && inputs.bump_kind || '' }}
```

`with:`を持たないcallerでは`with:`ごと足す。`bump-kind`は`version-file`・`bump-command`と
並べて書けるが、`workflow_dispatch`の入力名は`bump_kind`（アンダースコア）、
再利用可能ワークフローの入力名は`bump-kind`（ハイフン）で**綴りが違う**。

2026-08-15時点の実測。

| caller対応済み | `issue-deck`・**`clip-hive`・`ops-dashboard`**（#1591。新規配置時に最初からv19+`bump_kind`で置いた）・**`car-care`・`dayspan`・`aide`・`asset-manager`・`myroom`・`subscription-lists`・`shopping-list`・`portfolio`・`signaly`・`solitaire`・`meisai-lab`・`db-console`**（#1603。v19配布PRへ追加コミット。**develop（またはmain）へマージされるまでは効かない**） |
|---|---|
| **未対応** | なし |

**`aide-bot`もcaller対応済み**（立ち上げ時点で`bump-kind`付きのv25 callerを置いている）。

> **`db-console`は#1565の対象リストから漏れていた。** #1551で後から`release-develop-to-main.yml`を
> 足したリポジトリで、リストが書かれた時点の11件に入っていなかった。配布状況を数えるときは、
> 上の「配布済み」の表（callerの実在）を起点にする。

**`workflow_dispatch`はdevelopのworkflow定義を見る。** そのため上げ幅を指定できるようになるのは
callerがdevelopへマージされた後で、PRブランチにコミットした時点ではまだ指定できない
（[multi-agent/release.md](multi-agent/release.md)「pushトリガーで起動したときは、ワークフロー
ファイルもdevelop側のものが使われる」も参照）。

### `npm version` は依存関係の無いところで走る（#1591）

**共有ワークフローはバージョンbumpのために依存関係をインストールしない。**
`reusable-release-develop-to-main.yml`には`setup-node`も`npm ci`も無く、`actions/checkout`直後の
チェックアウトでいきなり`npm version <新版> --no-git-tag-version`を叩く。そのため
**`preversion`にテスト・Lintを置いているリポジトリは、既定のbumpコマンドでは必ず落ちる。**

```
> eslint
sh: 1: eslint: not found
npm error code 127
npm error command sh -c npm test
```

該当するのは`preversion: npm test`を持つ`meisai-lab`と`clip-hive`の2件で、どちらも
callerで同じ`bump-command`を渡して回避している（`--ignore-scripts`が更新履歴を書く
`version`フックまで止めてしまうため、その中身を明示的に実行して補う）。

```yaml
bump-command: npm version "$NEW_VERSION" --no-git-tag-version --ignore-scripts && npm_package_version="$NEW_VERSION" node scripts/version-changelog.mjs
```

**`preversion`自体は消さない。** ローカルで`npm version`を叩いたときのガードとして機能しており、
品質確認はバンプPR上のCIでも行われる。逆に、これから`version` lifecycleを足すリポジトリでは
**`preversion`を作らず、`version`フックから呼ぶスクリプトもNode標準モジュールだけで書く**
（#1591の`ops-dashboard`はこの形にしたため`bump-command`が要らなかった）。

### 更新履歴の自動追記（`RELEASE_CHANGELOG`）の対応状況

共有ワークフローは、mainとdevelopのコード差分から利用者向けの更新履歴を生成し、
`"version"` lifecycleスクリプトへ`RELEASE_CHANGELOG`環境変数として渡す（#800）。
受け取る側を持つかどうかはリポジトリごとに違う。

| `RELEASE_CHANGELOG`を反映する | `shopping-list`・`dayspan`・`meisai-lab`・`solitaire`・**`clip-hive`**（#1591で対応へ改修）・**`ops-dashboard`**（#1591で新設）・**`issue-deck`**（#1764で新設） |
|---|---|
| 追記はするが**枠だけ**（`RELEASE_CHANGELOG`を読まない） | `signaly`（`scripts/bump_version.py`が`frontend/changelog.js`へスタブを足す。`bump-command`経由のため`npm`のlifecycleではない） |
| 何もしない（バージョンだけが上がる） | `car-care`・`subscription-lists`・`asset-manager`・`portfolio`・`myroom`・`db-console`・`aide`・**`aide-bot`**（更新履歴ファイルと`"version"` lifecycleスクリプトのどちらも持たない） |

**生成された文面はそのままバンプPRに入る。** 利用者が読む文章のため、バンプPRのレビュー時に
内容を確認する（記載してよい内容の基準はchangelog-ja skill）。

**あわせて`.github/release-notes.md`へも書き出す（#2391）。** 上の表のとおり受け取り側を持つのは
7リポジトリだけで、残りでは生成された文面がバンプPR本文にしか残らなかった。共有ワークフローが
バンプコミットへこのファイルを含めるようにしたため、**更新履歴ファイルを持たないアプリでも
リリース通知の本文に変更内容が載る**。ファイルは最新リリースぶんだけを持ち、毎回上書きする
（履歴として積まない。積む場所は各アプリの更新履歴ファイル）。

### 使い方の自動生成（`RELEASE_USAGE`）の対応状況

同じ判定ステップが利用者向けの操作手順も生成し、`RELEASE_USAGE`環境変数として同じ経路で渡す
（#1729）。更新履歴が「何が変わったか」であるのに対し、こちらは「どこを開く / 何を押す /
どうなれば成功か」。**画面で使える変化が無いリリースでは空になる**ため、更新履歴があっても
使い方が無いことがある。

| `RELEASE_USAGE`を反映する | **`issue-deck`**（#1764。`src/lib/changelog.ts`の`usage`として持ち、設定 →「更新履歴」に出す。最初の1件） |
|---|---|
| 受け取れる状態にある | `shopping-list`・`dayspan`・`meisai-lab`・`solitaire`・`clip-hive`・`ops-dashboard`（`"version"` lifecycleスクリプトを持つ。反映はリポジトリごとのIssueで順次対応する） |
| 生成されるが使われない | 上記以外（`RELEASE_CHANGELOG`と同じ扱い。バンプPR本文には出る） |

**issue-deckの画面では、バンプPRが開いている間だけスマホのリリースシートに「使い方（利用者向け）」
として出る**（`src/components/dashboard/release-progress.tsx`）。恒久的な置き場所は各アプリの
更新履歴画面で、そちらが本来の届け先。issue-deck自身の届け先は設定 →「更新履歴」
（`src/components/dashboard/settings/changelog-section.tsx`・#1764）。受け取り方は
[docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md)の「`RELEASE_USAGE`（使い方）の受け取り方」を参照。

```bash
# 配置状況の確認
for r in $(gh repo list guchi-apps --limit 60 --json name --jq '.[].name'); do
  gh api "repos/guchi-apps/$r/contents/.github/workflows/release-develop-to-main.yml" \
    --jq .name >/dev/null 2>&1 && echo "$r: あり"
done
```

## 不足しているcallerの配布状況（#1948・#1475）

**issue-deckの画面の「CI失敗を自動修正」「コンフリクトを自動解消」が実際に起動するかどうかは、
配布先のcallerの実在だけで決まる**（`workflow_dispatch`の受け口はファイルの実在で解決される）。
無いリポジトリでは押しても404になり、**押すまでそれが分からなかった**——起票のきっかけも
guchi-apps/aideでこれを押したことだった。

2026-08-18時点の実測（`claude-review-develop.yml`とも`release-develop-to-main.yml`とも独立した軸）。

| ワークフロー | 配布済み | 未配布 |
|---|---|---|
| `claude-conflict-resolve.yml`・`claude-ci-fix.yml` | `issue-deck`（ローカルパス参照）・`dayspan`・`shopping-list` | `aide`・`car-care`・`asset-manager`・`portfolio`・`solitaire`・`signaly`・`myroom`・`meisai-lab`・`subscription-lists`・`clip-hive`・`db-console`・`ops-dashboard` |
| `claude-pr-repair.yml` | `issue-deck`のみ | リリースフローを持つ他の全リポジトリ |

```bash
# 配置状況の確認
for r in $(gh repo list guchi-apps --limit 60 --json name --jq '.[].name'); do
  out="$r:"
  for f in claude-conflict-resolve.yml claude-ci-fix.yml claude-pr-repair.yml; do
    gh api "repos/guchi-apps/$r/contents/.github/workflows/$f" --jq .name >/dev/null 2>&1 \
      && out="$out $f"
  done
  echo "$out"
done
```

**`aide-bot`は3つとも立ち上げ（#2213）の時点で配置済み**で、この表の母集団に入っていない。
`claude-pr-repair.yml`を`issue-deck`以外で持つ最初のリポジトリでもある。

**この配布経路は自動修復専用ではない**（#1475）。上の
「`claude-review-develop.yml`の配布状況」で配ると決めた`claude-review-develop.yml`も、
同じ一覧・同じボタンから配る（画面の見出しは「不足・破損しているワークフロー」）。

**配布はissue-deckの画面（設定＞フリート運用＞共有ワークフローのバージョン）から行う。**
不足しているcallerの検知は参照タグと同じGraphQL取得に相乗りしており、押すと
`propagate-repair-workflows.yml`が配布先ごとにPRを作る。**自動マージはしない**ため、
各リポジトリでPRを確認してマージするまでボタンは効かない。生成の仕組み・写す入力・
`workflow_run`の購読先の決め方・`claude-review-develop.yml`を配るときのリポジトリ設定は
[multi-agent/auto-repair.md](multi-agent/auto-repair.md)
「配布状況と、不足しているcallerの配布」を参照。

**この表は手動記録なので、正は各リポジトリの`.github/workflows/`と画面の「未配布」欄。**
配布PRをマージしたら、画面の欄から消えたことを確認したうえでこの表も直す。

## `.github/scripts/signaly-notify.sh`の配布状況（#2240）

**ワークフローではないが、同じ画面の同じパネルから配る**（設定＞フリート運用＞共有ワークフローの
バージョン ＞「共有スクリプト」）。各リポジトリの`.github/scripts/`へコピーして使う運用のため、
issue-deckを直しても自動では行き渡らない。

2026-08-28時点で同じスクリプトを持つのは次の17リポジトリで、**全件がissue-deckの`main`と
同一の内容**（blobのSHAが一致。#2391のリリース本文と#2237・#2239の`exit 0`を含む）。

`clip-hive` / `aide-bot` / `signaly` / `meisai-lab` / `dayspan` / `asset-manager` /
`shopping-list` / `car-care` / `myroom` / `aide` / `ops-dashboard` / `subscription-lists` /
`solitaire` / `portfolio` / `db-console` / `subpc` / `trainroute`

**`guchi-apps/subpc`だけは独自の変更がある。** そのリポジトリだけの`NOTIFY_NOTE`（反映は成功
したが再起動などの操作が残っていることを通知へ足す）が入っており、配布は中身をそのまま上書き
するため消える。画面の行に「独自の変更あり」が出て、消える記述は配布PRの本文に書き出されるので、
**マージ前に取り込むかどうかを判断すること。**

**この表は手動記録なので、正は各リポジトリの`.github/scripts/`と画面の「未更新」欄。**
判定・配布の仕組みは[multi-agent/auto-repair.md](multi-agent/auto-repair.md)
「ワークフロー以外の配布物を配る」を参照。

### 配布PRは`deploy.yml`・`release.yml`への1行追加も運ぶ（#2391）

リリース通知の分離（`SIGNALY_RELEASE_WEBHOOK_URL`）は、**スクリプトを配るだけでは効かない。**
GitHub Actionsのsecretはワークフローが`env:`へ渡さないとスクリプトから読めないためで、
配布先の`deploy.yml`・`release.yml`にも1行が要る。しかしこの2つはリポジトリごとに中身が違い、
既存の配布経路（丸ごとコピー・固定の置換・新規追加）はどれも部分編集ができない。

そこで`.github/scripts/propagate-shared-files.sh`が、スクリプトのコピーに加えて
**`NOTIFY_KIND: リリース`の行の隣へ1行足す**（既に入っていれば何もしない）。同じ配布PRに
含まれるので、押すボタンは今までどおり1つ。

- **アンカーは全リポジトリにあるが、書き方は揃っていない**（#2421）。`NOTIFY_KIND: リリース`
  という**文字列との一致**で見ていたときは2件が黙って外れ、配布PRは作られるのにこの1行だけが
  入らない状態が続いた。突き合わせは**コロンの後の空白の幅を問わず、行末のCRを無視する**形にし、
  足す行の行末も元の行に合わせる（CRLFのファイルへLFの行だけを混ぜない）
  - `guchi-apps/signaly` … 値を桁揃えしていて`NOTIFY_KIND:     リリース`
  - `guchi-apps/asset-manager` … 改行がCRLFで、行末に`\r`が残る（#2330の`claude-ci-fix.yml`と同じ性質）
- **画面の「配布が必要」判定はこの1行の有無も見る**（#2421）。以前は通知スクリプトの中身しか
  見ておらず、スクリプトが既に最新のリポジトリは対象に挙がらないため、**この1行だけが未適用の
  状態は画面から見えなかった**。いまは`missingReleaseWebhookWorkflows`（`src/lib/workflow-tags.ts`）が
  `deploy.yml`・`release.yml`を見て、欠けていれば「共有スクリプト」の未更新欄へ
  `deploy.ymlのリリース通知env`として出す。**判定の条件は配布スクリプト側の挿入条件と同じにする**
  ——片方だけ緩めると、画面には不足と出るのに配布PRが何も足さない行き止まりになる
- 配るファイルが無く**この1行だけ**が対象のときは、配布ワークフローへ渡す`files`が空配列になる。
  `propagate-shared-files.yml`の入力検証はそれを通す

```bash
# リリース通知のenvが入っているか（未適用のリポジトリだけが出る）
# **grepは -aE で引く。** CRLFのリポジトリがあり、値を桁揃えしているリポジトリもある
for r in clip-hive aide-bot signaly meisai-lab dayspan asset-manager shopping-list car-care \
         myroom aide ops-dashboard subscription-lists solitaire portfolio db-console subpc; do
  br="$(gh api "repos/guchi-apps/$r" --jq .default_branch)"
  for f in deploy release; do
    body="$(gh api "repos/guchi-apps/$r/contents/.github/workflows/$f.yml?ref=$br" --jq .content 2>/dev/null | base64 -d)"
    printf '%s' "$body" | grep -qaE 'NOTIFY_KIND:[[:space:]]+リリース' || continue
    printf '%s' "$body" | grep -qa 'SIGNALY_RELEASE_WEBHOOK_URL' || echo "$r: $f.yml 未適用"
  done
done
```

2026-08-28に#2429で`asset-manager`・`signaly`へ配布し（`guchi-apps/asset-manager#267`・
`guchi-apps/signaly#225`）、**リリース通知ステップを持つ全リポジトリへ行き渡った**。
`aide`にはこの時点で`notify-release`ステップがあり、1行も適用済み（2026-08-27時点の
「ステップ自体が無い」という記述は古かった）。`vps`・`subpc`はリリース通知を出していない。

```bash
# 配布状況の確認（issue-deckのmainと同じ内容かどうか）
gh api "repos/guchi-apps/issue-deck/contents/.github/scripts/signaly-notify.sh?ref=main" \
  --jq .content | base64 -d > /tmp/signaly-notify-source.sh
for r in clip-hive aide-bot signaly meisai-lab dayspan asset-manager shopping-list car-care \
         myroom aide ops-dashboard subscription-lists solitaire portfolio db-console subpc; do
  br="$(gh api "repos/guchi-apps/$r" --jq .default_branch)"
  gh api "repos/guchi-apps/$r/contents/.github/scripts/signaly-notify.sh?ref=$br" --jq .content \
    2>/dev/null | base64 -d > /tmp/signaly-notify-target.sh \
    || { echo "$r: 未配置"; continue; }
  cmp -s /tmp/signaly-notify-source.sh /tmp/signaly-notify-target.sh \
    && echo "$r: 最新" || echo "$r: 未更新"
done
```

## `version-tag-check.yml`の配布状況

上の表の「導入済み自動化ワークフロー」列は無人実行（計画〜実装〜レビュー）のワークフローについて
のもので、`version-tag-check.yml`はそれとは対象の決まり方が違うため、ここに分けて記録する。

`version-tag-check.yml`（本体は`reusable-version-tag-check.yml`。#1367）は、バージョンを上げ忘れた
ままdevelop→mainをマージしたときに`deploy.yml`の`tag`ジョブが落ちて本番デプロイが止まるのを、
main宛PRのCIで先に落とすもの。**対象は「`deploy.yml`が`main`から`vX.Y.Z`タグを作るリポジトリ」だけ**
で、無人実行を入れているかどうかとは独立している。

**#2135で検査項目が増え、ジョブが2つになった。** `version-tag-check`（タグの重複）に加えて
`deploy-config-check`が、`deploy.yml`のうち**mainへ入るまで露見しない設定漏れ**を見る。

| ジョブ | 見るもの | 落ちると分かること |
|---|---|---|
| `version-tag-check` | `package.json`のバージョンと既存タグ | バージョンの上げ忘れ（#1367） |
| `deploy-config-check` | `appleboy/ssh-action`の`env:`／`with.envs:`／リモートスクリプトの3者 | 環境変数を増やしたときの`envs:`への追記漏れ（**本番だけ値が空になる**） |
| 〃 | 配布物を固める`tar`の対象 | 追跡されていないパス（`tar: public: Cannot stat`でビルドが落ちる） |
| 〃 | `packageManager`のpnpmメジャー | VPSのNode 20で動かないpnpm 11（`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`） |

**配り直しは要らない。** 検査は既存の`reusable-version-tag-check.yml`へジョブとして足してあり、
callerの`with:`も変えていないため、**参照タグ（`@workflows/vN`）を上げるだけで14リポジトリ全部で
効き始める**。逆に、参照タグを上げるまではどのリポジトリでも効かない。

`deploy-config-check`は`appleboy/ssh-action`を使わないリポジトリ（`myroom`・`signaly`は`rsync`、
`solitaire`は`easingthemes/ssh-deploy`）ではその検査をスキップする。判定できない形（`cd`を挟む
`run:`、GitHubの式や変数を含む`tar`の引数）も黙って通し、理由をログに残す——**誤検知でmain宛PRを
止める方が、見逃すより高くつく**ため。配布前に14リポジトリすべての`deploy.yml`へ通して、
誤検知が出ないことを確かめてある。

配った14リポジトリ（#1459。`@workflows/v16`）は次のとおり。

| リポジトリ | `with:`に渡す入力 |
|---|---|
| `shopping-list`・`dayspan`・`meisai-lab`・`car-care`・`subscription-lists`・`asset-manager`・`portfolio`・`solitaire`・`clip-hive`・`ops-dashboard`・`db-console`・`aide` | なし（既定値の`package.json`・`.version`・`v`） |
| `myroom` | `version-file: frontend/package.json`（`deploy.yml`が`./frontend/package.json`を読む） |
| `signaly` | `version-file: version.json`（バージョンが`version.json`で`scripts/bump_version.py`経由） |

**対象外**

- `guchi-apps/issue-deck` — 配置済み。ローカルパス参照（`./.github/workflows/reusable-*.yml`）で
  常に最新を使うカナリア
- `guchi-apps/vps`・`guchi-apps/subpc` — `deploy.yml`はあるが`tag`ジョブが無く、リリースタグを
  作らない。守るものが無い（`subpc`の`deploy.yml`はサブPC上のセルフホストランナーで動く。
  guchi-apps/issue-deck#1616）
- `docs`・`claude-config`・`gucchii-os`・`pi0w_260719`・`uptime-kuma`・`sensor_260531`・
  `sensor_260218`・`wifi-speed` — `deploy.yml`を持たない

**`aide-bot`は#2213の立ち上げ時に、`deploy.yml`の`tag`ジョブとセットで最初から配置した**
（`with:`は無し＝既定値の`package.json`・`.version`・`v`）。下の確認コマンドの一覧にも足してある。

**新しくリポジトリを増やしたときは、`deploy.yml`に`tag`ジョブを入れるかどうかとセットで判断する。**
配布（`propagate-workflow-tag.yml`）は既存ファイルのタグを書き換えるだけで、callerの新規追加は
行わない（[cross-repo-setup-guide.md](cross-repo-setup-guide.md)「共有ワークフローのタグ運用」）。
**新規追加まで自動化してあるのは自動修復の3つと`claude-review-develop.yml`だけ**で、
そちらは別の配布（`propagate-repair-workflows.yml`。#1948・#1475。上記
「不足しているcallerの配布状況」）が受け持つ。

```bash
# 配置状況の確認
for r in shopping-list dayspan meisai-lab car-care subscription-lists asset-manager \
         portfolio solitaire myroom signaly clip-hive ops-dashboard db-console aide \
         aide-bot; do
  echo -n "$r: "
  gh api "repos/guchi-apps/$r/contents/.github/workflows/version-tag-check.yml" --jq .name \
    2>/dev/null || echo "未配置"
done
```

## デプロイのヘルスチェックの実装状況（#2141）

`guchi-apps/docs`の`standards/ci-deploy.md`は、デプロイ後のヘルスチェックを**「成功するまで2秒間隔で
最大60秒くり返す」**形と定めている（guchi-apps/docs#29）。固定の`sleep`1回だと起動を待ちきれず、
**本番へは反映済みなのにデプロイが赤くなる**。逆にヘルスチェックが無いと、アプリが起動に失敗しても
`deploy`ジョブは緑で終わり、Signalyには「成功」の通知だけが飛ぶ。

`deploy.yml`を持つ17リポジトリのうち、**#2141の時点で持っていなかったのは次の6件**。上の
`deploy-config-check`（#2135）には含めていない——**これは検査ではなく実装の横展開**で、直せるまで
毎回のmain宛PRで警告が出続けるため。

| リポジトリ | デプロイの形 | 要るヘルスチェックの形 | 子Issue |
|---|---|---|---|
| `myroom` | SSH → pm2（uvicorn `127.0.0.1:8000`） | 標準どおり（`/api/health`） | myroom#205 |
| `portfolio` | `appleboy/ssh-action` → pm2（Next.js `PORT=3105`） | 標準どおり | portfolio#133 |
| `signaly` | SSH → `deploy/restart-service.sh` → user systemd（uvicorn `127.0.0.1:8002`） | 標準どおり（`/`はStaticFiles配信） | signaly#168 |
| `solitaire` | rsyncのみ（プロセス無し・Apacheが静的配信） | **起動待ちが無いのでリトライループは過剰。** 公開URLへの短い確認 | solitaire#81 |
| `subpc` | セルフホストランナー → `setup-apply.sh` | **HTTPの待受が無い。** `systemctl is-active`の確認 | subpc#52 |
| `vps` | SSH → `scripts/apply.sh` | **Apache側は対応済み**（下記）。残るのはuser systemdユニットの起動失敗 | vps#112 |

**`deploy.yml`だけをgrepすると`vps`を取りこぼす。** `vps`の疎通確認は`deploy.yml`ではなく
`scripts/apply.sh`の中にあり、`apache2ctl configtest` → `systemctl reload apache2` →
`scripts/check-https.sh`（SSLが有効な全vhostへ実際にHTTPS接続し、1つでも失敗すれば`exit 1`）を
実行している。**他アプリの`curl -fsS http://127.0.0.1:${PORT}/`より広い。** 残っている穴は
`deploy_user_unit`が`"${sc[@]}" start "$unit" && echo ... || echo "(警告) ..."`の形で書かれていて、
**`|| echo`が`set -euo pipefail`の発火を止めてしまう**こと。ユニットが上がらなくても`apply.sh`は0で
終わる。ヘルスチェックの有無を機械的に判定するなら、**`deploy.yml`から呼ばれるスクリプトまで
追う必要がある**。

残り11リポジトリは標準どおり実装済み（`for i in $(seq 1 30)` + `sleep 2`）。ただし**`aide`だけは
`seq 1 15`で待ち時間が30秒**しかない（形は同じ）。

**#2213で増えた`aide-bot`も標準どおり**（`appleboy/ssh-action` → pm2、`seq 1 30` + `sleep 2`で
`http://127.0.0.1:${PORT}/`を叩く）。立ち上げ時点で満たしているため、この横展開の対象外。

```bash
# 実装状況の確認。deploy.yml に health が無いリポジトリは、呼び出し先のスクリプトも見ること
for r in shopping-list dayspan meisai-lab car-care subscription-lists asset-manager \
         portfolio solitaire myroom signaly clip-hive ops-dashboard db-console aide \
         aide-bot subpc vps issue-deck; do
  printf '%-20s ' "$r"
  gh api "repos/guchi-apps/$r/contents/.github/workflows/deploy.yml?ref=main" --jq .content \
    2>/dev/null | base64 -d | grep -oiE 'seq 1 [0-9]+' | head -1 || echo "なし"
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
| `guchi-apps/aide-bot` | — | ○（※6） |
| `guchi-apps/subpc` | — | ○（※4） |
| `guchi-apps/vps` | — | ○（※4） |
| `guchi-apps/docs` | — | ○（※4） |
| `guchi-apps/claude-config` | — | ○（※5） |

※ `scripts/start-issue.sh`自体は持つが、マーカー行を宣言していない（2026-08-14に`develop`・`main`の
両方で実測）。#1224以降は**宣言しないことが通常**で、宣言が無いリポジトリはサブPCから汎用ランチャーで
起動する。

※2 `portfolio`・`myroom`・`signaly`・`solitaire`は#1276で追加した。本体チェックアウトに
`.env.local`／`.env`は置いていないが、**先行7件もissue-deck以外は同じく置いていない**（2026-08-14に実測）。
汎用ランチャーは既定で開発サーバーを起動せず（#1224）、envが無ければ`supply_env_files`は何もしないため、
セッションの起動には影響しない。開発サーバーを動かすセッションでだけ配置する。

サブPC列は**2026-08-16時点の申告18件**（pollerのログで直接実測）。※2の4件は#1224のロールアウト対象に
入っておらず、**除外した理由は記録に残っていない**（#1269で確認）。単に未着手だったため#1276で追加し、
あわせてポート帯も確保した（[scripts/local-repo-ports.conf](../scripts/local-repo-ports.conf)）——
載っていないと汎用ランチャーの既定`3000 + Issue番号`に落ち、4件が同じ帯に相乗りするため。

※3 `clip-hive`は#1376、`ops-dashboard`は#1377、`db-console`は#1378、`aide`は#1379で追加した
（`aide`以外はprivate）。
`ops-dashboard`はサブPCへcloneはされていたが対応表に載っておらず、`clip-hive`・`db-console`はcloneも
されていなかった。ポート帯も`clip-hive`の10000以外は未確保だったため、あわせて足した（17000・18000）。**`claude-issue-dispatch.yml`・`issue-labels.yml`を持たないため
`11.local`の付与とProject Statusの遷移が成立せず保留していた**（#1224）が、両方を導入して前提が揃ったため、
サブPCの対応表でコメントアウトされていた行を有効化した。ポート帯（10000）は#1224の時点で確保済み。

※4 `subpc`・`vps`・`docs`は#1741で追加した（3件ともprivate）。**上の「対応リポジトリ一覧」の表には
載らないインフラ設定・共有知識のリポジトリで、`claude-issue-dispatch.yml`を持たない。**
そのため無人実行は回らず、**実行経路はこのローカルセッションだけ**になる
（起動そのものは汎用ランチャーが行うので成立する）。**`issue-labels.yml`（進捗報告）は別の軸で、
#1741の時点では3件とも持っていなかったが、その後`subpc`へ追加した**（guchi-apps/subpc#32。
`docs`は#1901、`vps`は未配置）。実測した特徴と、載せるにあたっての判断は次のとおり。

- **ラベル体系は2026-08-16に整備済み**（guchi-apps/vps#81・guchi-apps/subpc#15・guchi-apps/docs#13）。
  それ以前は3件ともラベルが未定義で、`11.local`の付与が`'11.local' not found`で落ちていた
  （警告のみで起動は続く）。`AskUserQuestion`で付く`00.check-user`は逆に**付与エンドポイントが
  色も説明も無いラベルをその場で作ってしまう**（`src/lib/dispatch/check-user-labels.ts`）。
  整備は**リポジトリごとの子Issue**で行った（`CLAUDE.md`「複数リポジトリに影響する変更は、
  リポジトリごとにIssueを分ける」）。旧世代の進捗ラベルが付いたopen Issueは3件とも無く、
  カンバンへの書き戻しは不要だった
- **進捗（Project Status）は起動したIssueだけが盤面に載る。** 報告API（`POST /api/progress`）は
  未登録なら`addProjectItem`で追加する（`src/lib/github/report-progress.ts`）が、一括同期
  （`syncProjectStatuses`）は`hasClaudeWorkflow: true`で絞るため取り込まれない
- **3件とも既定ブランチは`main`のまま。** 汎用ランチャーは`origin/HEAD`を正とするので`main`から
  分岐し`main`宛PRになる。`subpc`・`vps`は`deploy.yml`が`push: main`なので、**マージがそのまま
  本番反映**になる。2026-08-16に`subpc`・`vps`へ`develop`とリリースフローを入れたが、
  **既定ブランチは移していない**（`drift-check.yml`のschedule実行が既定ブランチの内容を実機と
  突き合わせるため）。`docs`は`develop`を持たない（上記）
- **`docs`のチェックアウト先は`~/apps/_docs`**で、ディレクトリ名がリポジトリ名と一致しない。
  これは全セッションが`--add-dir`で読む共有知識の参照先と**同一実体**のため、そのリポジトリの
  Issueを起動するときだけ参照を付けない（[multi-agent/generic-launcher.md](multi-agent/generic-launcher.md)
  「共有知識リポジトリ自身のIssueを起動するとき」）
- 3件とも`package.json`を持たず開発サーバーを起動しないが、ポート帯（20000・21000・22000）は
  確保した。載っていないと既定の`3000 + Issue番号`に落ち、未登録のリポジトリ同士が相乗りするため

※5 `claude-config`（個人設定。private）は#1988で追加した。**※4の3件と同じ枠**で、
`claude-issue-dispatch.yml`を持たず実行経路はローカルセッションだけ。**`issue-labels.yml`も
持たないため進捗が`Implementation`で止まる**（導入は guchi-apps/claude-config#2）。
`package.json`を持たないがポート帯（23000）は同じ理由で確保した。フォルダの信頼確認（#1838）だけは
対話が要るので手作業として起票した（#1994）。実測と判断は上記「`claude-config`（個人設定）」を参照。

※6 `aide-bot`は#2213で追加した（public）。**画面の「新規アプリを立ち上げる」（#2188）が起票した
手作業Issue（#2214）でcloneと`local-repos.conf`への記載を済ませてある**ため、サブPCからは
汎用ランチャーで起動できる。**ただしポート帯（[scripts/local-repo-ports.conf](../scripts/local-repo-ports.conf)）は
立ち上げの流れが面倒を見ておらず、#2213で手で足した**（24000）。載せないと汎用ランチャーの既定
`3000 + Issue番号`に落ち、同じく未登録のリポジトリと相乗りする。**次に立ち上げるアプリでも同じ穴が
開く**ので、ウィザードが生成するもの（[new-app-launch.md](new-app-launch.md)「作られるもの」）に
帯の払い出しを足すかどうかは#2225で扱う。

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

`shared-knowledge-propose.yml`（共有知識層、#889）のマーカーは追加しない。#2029でissue-deck側の
ワークフローを廃止したため、ドリフトを監視する対象が無い。

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
