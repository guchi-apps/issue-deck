# 対応リポジトリ一覧

issue-deckのマルチエージェント自動化ワークフロー一式（`@claude`起動・ラベル遷移による
計画〜実装〜PR作成〜レビューまでの無人実行）が実際に導入され、機能しているリポジトリを
記録する。導入の背景・他リポジトリへ展開する際の検討事項は
[docs/cross-repo-automation.md](cross-repo-automation.md)、実際に導入する際の手順は
[docs/cross-repo-setup-guide.md](cross-repo-setup-guide.md)を参照。

「対応」の実態はワークフローファイル一式・ラベル体系・CLAUDE.md・ブランチ運用・Secretsなど
多軸にわたり、DBスキーマや自動判定で正確に表すのは難しいため、本ドキュメントでの手動記録に
留めている。

ただしワークフローの配布方法には**コピー方式**と**参照方式**の2種類があり、参照方式のものは
手動記録の対象外とする（後述「参照方式のワークフローは sync-state の対象外」）。

| リポジトリ | ステータス | 導入済み自動化ワークフロー | CLAUDE.md / ラベル体系 | 最終確認日 | 関連Issue | 備考 |
|---|---|---|---|---|---|---|
| `m-guchi/issue-deck` | 対応済み | 一式（`claude-issue-dispatch.yml`・`issue-labels.yml`・`claude-review-develop.yml`・`claude-conflict-resolve.yml`・`release-develop-to-main.yml`）。うち`issue-labels.yml`は`reusable-issue-labels.yml`をローカルパス参照 | あり（本体） | 2026-08-09 | #354, #501, #940 | issue-deck自身のセルフホスティング。再利用可能ワークフローの提供元でもあり、常に最新を参照するカナリアとして機能する |
| `m-guchi/shopping-list` | 対応済み | **参照**: `issue-labels.yml`（`@workflows/v1`）・`claude-issue-dispatch.yml`（`@workflows/v6`）。**コピー**: `claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`・`release-develop-to-main.yml` | あり（新規作成） | 2026-08-09 | #357, #723, #895, #942 | DBなし・ビルドなし・npm依存パッケージゼロのため、DBセットアップ・pnpm・Playwrightの前段ステップを削除して簡素化。`24.screenshot-required`は撮影自体を独自実装済み。プレビュー環境はissue-deckとFly.ioアプリを共有しており相互に上書きされる（#892で解消予定） |
| `m-guchi/dayspan` | 対応済み | **参照**: `issue-labels.yml`・`claude-issue-dispatch.yml`（ともに`@workflows/v6`）。**コピー**: `claude-review-develop.yml`・`claude-conflict-resolve.yml`・`claude-ci-fix.yml`・`release-develop-to-main.yml` | あり（新規作成） | 2026-08-09 | #971 | Next.js + Prisma + MariaDBのため`runtime-setup: node-db`・`package-manager: pnpm`・`database-name: app_dayspan`・`node-version: "24"`をcallerで指定。`24.screenshot-required`は全画面がSupabase Auth + Google OAuthの背後にありCIログインバイパスもPlaywright依存も持たないため無人撮影は成立せず、ローカル実行でのみ意味を持つラベルとして残している |

## sync-state マーカー（ワークフロー同期状態の記録）

リポジトリが実際にワークフローファイルを導入した際、issue-deckのどのコミット時点から
コピー・改変したかを、機械可読な形で以下のHTMLコメント形式で記録する。

```html
<!-- sync-state: repo=<owner/repo> workflow=<ワークフローファイル名> base-commit=<issue-deck側のコミットSHA> -->
```

実際の記録例は下記「m-guchi/shopping-list」の節を参照する。`scripts/check-workflow-sync-drift.sh`は
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

### m-guchi/shopping-list

<!-- sync-state: repo=m-guchi/shopping-list workflow=claude-review-develop.yml base-commit=bb7d0f7f48bd0eae0f90c86bd1e7dd35ba2c2200 -->
<!-- sync-state: repo=m-guchi/shopping-list workflow=claude-ci-fix.yml base-commit=bb7d0f7f48bd0eae0f90c86bd1e7dd35ba2c2200 -->
<!-- sync-state: repo=m-guchi/shopping-list workflow=release-develop-to-main.yml base-commit=bb7d0f7f48bd0eae0f90c86bd1e7dd35ba2c2200 -->
<!-- sync-state: repo=m-guchi/shopping-list workflow=claude-conflict-resolve.yml base-commit=29958837e7569c852740742dfd30daa2c03e89fc -->

上記のうち`claude-conflict-resolve.yml`だけは**意図的に古いbase-commitのまま**にしている。
`#814`（pull_requestトリガー時に無関係な他PRを巻き込まないようトリガー元のPR1件に絞る修正）が
shopping-list側へ未反映であることを確認済みで、ドリフト検知にそのまま出続けてよいため。
残る3ファイルは、m-guchi/shopping-list#62（ワークフロー改善のバックポート）および
m-guchi/shopping-list#64（共有知識層の導入）で`bb7d0f7`時点の内容へ同期した。

`claude-issue-dispatch.yml`のマーカーは削除した。同ファイルは参照方式
（`reusable-issue-dispatch.yml@workflows/v6`）へ移行済みで、後述「参照方式のワークフローは
sync-state の対象外」のとおり記録の対象外になったため。

`shared-knowledge-propose.yml`（共有知識層、#889）のマーカーは、issue-deck側とshopping-list側の
双方のPull Requestがマージされた時点で追加する。

### m-guchi/dayspan

<!-- sync-state: repo=m-guchi/dayspan workflow=claude-review-develop.yml base-commit=b198601c22aea091124b9734326032ec65b6cee1 -->
<!-- sync-state: repo=m-guchi/dayspan workflow=claude-conflict-resolve.yml base-commit=b198601c22aea091124b9734326032ec65b6cee1 -->
<!-- sync-state: repo=m-guchi/dayspan workflow=claude-ci-fix.yml base-commit=b198601c22aea091124b9734326032ec65b6cee1 -->
<!-- sync-state: repo=m-guchi/dayspan workflow=release-develop-to-main.yml base-commit=b198601c22aea091124b9734326032ec65b6cee1 -->

base-commitは各ワークフローファイル冒頭の「移植元コミット」コメント（dayspan側に記載がある）と同じ値。
`issue-labels.yml`・`claude-issue-dispatch.yml`は参照方式のためマーカーを持たない。

**最終同期日: 2026-08-09**

## 参照方式のワークフローは sync-state の対象外

`reusable-*.yml`（`on: workflow_call`）を`uses:`で参照する方式へ移行したワークフローは、**`sync-state`マーカーを記録しない**（#940・#942）。

理由は、参照方式では**caller側ファイルの`@<タグ>`という参照そのものがバージョン記録**であり、機械可読で常に正確だからである。ここに二重に書くと、手書きゆえに再び実態とずれる。#895 で「マーカーの更新漏れ → 当たりと外れが混在した一覧 → 誰も見なくなる」という劣化が実際に起きており、それを構造的に避けるのが#934で定めた方向である。

そのため`scripts/check-workflow-sync-drift.sh`の出力にも、参照方式のワークフローは現れない（現れないことが正常である）。

**どのリポジトリがどのバージョンを参照しているかは、対象リポジトリのcallerファイルを見る。**

```bash
# 例: shopping-list が参照しているバージョンを確認する
gh api repos/m-guchi/shopping-list/contents/.github/workflows/issue-labels.yml?ref=develop \
  -q .content | base64 -d | grep 'uses:'
```

```bash
# issue-deck側で提供している再利用可能ワークフローと、切られているタグを確認する
ls .github/workflows/reusable-*.yml
git tag --list 'workflows/*'
```

issue-deck自身は`./.github/workflows/reusable-*.yml`（ローカルパス）を参照し、常に最新の内容で動く。他リポジトリはタグ固定のため、issue-deck側の変更は**新しいタグを切り、各リポジトリのcallerを1行更新するPRを出す**まで波及しない。issue-deckが先に壊れて他リポジトリには届かない、カナリア構成である（#934）。

移行済みのワークフローは以下のとおり。

| ワークフロー | 実体 | 移行時期 |
|---|---|---|
| `issue-labels.yml` | `reusable-issue-labels.yml` | 2026-08-09（#940、m-guchi/shopping-list#77） |
| `claude-issue-dispatch.yml` | `reusable-issue-dispatch.yml` | 2026-08-09（#945。導入先は m-guchi/shopping-list・m-guchi/dayspan） |

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
- **プレビュー環境（`23.preview-required`）はissue-deckとFly.ioアプリを共有している**:
  `fly.toml`の`app`がissue-deckと同じ`issue-deck-preview`で、かつconcurrencyグループが
  リポジトリごとに別のため、後からデプロイした側の内容で上書きされる。shopping-listのIssueで
  案内されたプレビューURLがissue-deckの画面を表示する状態が実際に発生する。複数プレビュー環境の
  同時起動による解消は#892で検討する
- `claude-ci-fix.yml`: pnpm/Prisma/Next.js前提のセットアップとビルド用プレースホルダー環境変数を
  削除し、検証コマンドを`npm run check`とmanifestのJSON検証へ置換（m-guchi/shopping-list#62で導入）
