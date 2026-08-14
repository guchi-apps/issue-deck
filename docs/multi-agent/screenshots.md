# Phase 7: 無人実行でのスクリーンショット撮影・画像埋め込み（#199, #255, #256, #257, #258）

`24.screenshot-required`が付いたIssueで、Playwrightによる撮影とIssueコメントへの埋め込みを無人実行する仕組み。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)


issue #199（「PC画面とスマホ画面のデザインを確認したい」）は複数の技術的障壁があるため4つの
サブIssueに分割された。

- #255: 任意のPNG画像をGitHub Issueコメントに画像として埋め込む手段の確立（DB・認証には
  触れない）
- #256: 無人実行フローにMySQLサービスコンテナを追加し、開発サーバーを起動できるようにする
- #257: Supabaseを経由しないCI専用ログインバイパス機構
- #258: 上記3件の上に実際のPlaywright撮影処理を統合し、Phase5の`24.screenshot-required`の
  挙動を「撮影できないので`00.check-user`を付与して停止する」から「実際に撮影してIssue
  コメントに埋め込んだうえで通常どおり完了処理まで進める」に変更する

## 画像埋め込みの仕組み（#255）

- 画像は`develop`/`main`の祖先には含まれない専用のorphanブランチ`screenshots`にコミットする
  （通常のリリースフローではマージしない）。
- コミットした画像を`https://raw.githubusercontent.com/<owner>/<repo>/screenshots/issue-<番号>/<ファイル名>.png`
  のURLとして参照し、Markdownの`![...](...)`記法で`gh issue comment`の本文に埋め込む。公開
  リポジトリのため認証なしで表示できる（`scripts/post-issue-screenshot.sh`実行時に実機検証済み、
  `raw.githubusercontent.com`から`content-type: image/png`で200が返ることを確認した）。
- `scripts/post-issue-screenshot.sh <issue番号> <画像ファイルパス> [画像ファイルパス...]`が、
  画像を`screenshots`ブランチの`issue-<番号>/`配下にコミット・pushし、上記raw URLを標準出力に
  1行1URLで出力する。呼び出し側（将来のPlaywright統合サブIssueなど）はこの出力をそのまま
  `gh issue comment`の本文に埋め込めばよい。ファイル名には取得時刻を接頭辞として付与しており、
  同名ファイルで撮り直した場合でも`raw.githubusercontent.com`側の古いキャッシュを参照し続けない
  ようにしている。

## 権限

`screenshots`ブランチは`.github/workflows/`配下を含まないため、pushには
issue #106のようなworkflow書き込み権限を持つPAT（`secrets.WORKFLOW_PAT`）は不要で、既定の
`GITHUB_TOKEN`（`contents: write`権限）で足りる（懸念点として#255のissue本文に挙げられていたが、
検証の結果PATは不要と判明した）。

## 肥大化対策

`screenshots`ブランチが際限なく肥大化しないよう、`issue-labels.yml`の`cleanup-on-close`ジョブが
Issueクローズをトリガーに対応する`issue-<番号>/`ディレクトリを削除する。定期的なバッチ削除等は
導入していない（クローズされないまま放置されるIssueは通常のIssue運用上も稀なため、クローズ時の
削除のみで十分と判断した）。

## Playwright撮影の統合（#258）

`24.screenshot-required`が付いたissueをPhase5経由（無人実行）で処理する場合、`claude-issue-
dispatch.yml`のClaude Codeステップ（実装・PR作成）が、実装・テスト・コミットを終えた後に
`pnpm run capture:issue-screenshots -- <issue番号> [対象パス]`を実行する。これは`package.json`の
`capture:issue-screenshots`スクリプト経由で`scripts/capture-issue-screenshots.sh`を実行するもの。
かつては実装ステップの`allowedTools`に`Bash(scripts/capture-issue-screenshots.sh:*)`という
前方一致の許可を直接列挙していたが、エージェントが`bash scripts/capture-issue-screenshots.sh
<issue番号>`のように`bash `を前置して呼び出すと一致せず拒否される問題があったため、既に
許可済みの`Bash(pnpm:*)`経由の呼び出しに変更し、`allowedTools`からその許可は削除した
（Issue #522）。

npmとは異なりpnpm（10.34.5で確認）は`pnpm run <script> -- <args>`の`--`をオプション区切りとして
消費せず、そのまま第1引数としてスクリプトへ転送する。そのため`pnpm run capture:issue-screenshots
-- <issue番号>`と呼び出すと`scripts/capture-issue-screenshots.sh`側の`$1`が`--`になり、Issue番号の
数字チェックで毎回失敗していた（#673）。エージェントはこの失敗を誤診断し、代わりに`bash
scripts/capture-issue-screenshots.sh <issue番号>`を直接呼び出そうとして#522と同じ「`bash `前置で
`allowedTools`に一致せず拒否される」問題を再度踏んでいた。呼び出し規約（`pnpm run
capture:issue-screenshots -- <issue番号> [対象パス]`）自体は変更せず、`scripts/capture-issue-
screenshots.sh`側で`--`が単独の第1引数として渡された場合はこれを読み飛ばすようにして対応した
（#673）。

第2引数（対象パス）は実装エージェントが今回の変更内容から判断して指定する（#567）。

第3引数（クリック対象セレクタ、任意）を指定すると、ダイアログ等クリック操作でしか到達できない
画面状態を撮影できる（#756）。Playwright互換のセレクタ（`text=`・`role=`等を含む）を指定でき、
撮影対象パスへ遷移した後、撮影前にそのセレクタを`page.click()`でクリックする。`scripts/
capture-issue-screenshots.sh`はこれを`scripts/capture-screenshots.mjs`側の`<名前:パス:device
[:クリック対象セレクタ]>`という撮影対象指定フォーマット（第4フィールドとしてセレクタを追加、
コロンを含むセレクタにも対応するため4分割目以降を再結合）にそのまま渡す。第2引数（対象パス）を
省略するフォールバック撮影モードでは対応していない（対象パスが不明な時点でクリック対象も
指定しようがないため）。

1. `next dev`をバックグラウンドで起動する（DB・CIバイパス用ユーザーは、この前段の
   シェルスクリプトのステップ（DBマイグレーション・`scripts/ci-seed-user.mjs`・
   `scripts/db:seed:ci`）で既に用意済み）
2. Playwright（`scripts/capture-screenshots.mjs`）で、CIバイパス用Cookie
   （`src/lib/ci-auth-bypass.ts`の`CI_BYPASS_COOKIE_NAME`）をセットしたうえで撮影対象へ
   アクセスし、スクリーンショットを撮影する。
   - **対象パスを明示指定した場合**: そのパスをデスクトップビューポート（1440x900）と
     モバイルデバイスプリセット（`devices['iPhone 15']`）の両方で撮影する（`desktop.png`・
     `mobile.png`の2枚）。
   - **対象パスを省略した場合（フォールバック）**: デスクトップは`/dashboard`1枚
     （`desktop.png`）、モバイルはホーム（`/dashboard`、`mobile-home.png`）・イシュー一覧
     （`/dashboard?mscreen=issues`、`mobile-issues.png`）・イシュー詳細
     （`/dashboard?mscreen=issue-detail&missue=<id>`、`mobile-issue-detail.png`）の計3枚を
     撮影する。スマホUIは別ルートではなく`/dashboard`単体ページ内でURLクエリ
     （`mscreen`/`missue`等、`src/hooks/use-mobile-screen.ts`）によって画面を切り替える
     SPA構成のため、これらは同一ページへの異なるクエリとして表現できる。デスクトップ/
     モバイルの出し分けはTailwindの`md:hidden`等によるCSS制御のため、モバイルデバイス
     プリセットで撮影すれば自動的にモバイルUIが撮れる。イシュー詳細の`missue`はGitHubの
     Issue番号ではなくPrisma `Issue.id`（`cuid()`）が必要なため、`scripts/ci-get-sample-
     issue-id.mjs`でCI用ダミーデータ（`scripts/seed-ci-db.mjs`）のIssue idを取得してから
     撮影する。
   - 撮影対象を`/`ではなく`/dashboard`に固定しているのは、CIバイパスCookie使用時は
     `src/lib/supabase/middleware.ts`の認証チェック自体をスキップするため、`/`が本来の遷移先
     （未ログインなら`/login`、ログイン済みなら`/login`経由で`/dashboard`へリダイレクト）に
     到達せずログイン画面がそのまま表示されてしまうため
3. 開発サーバーを停止し、`scripts/post-issue-screenshot.sh`（#255）で`screenshots`ブランチへ
   コミット・pushする

`scripts/capture-issue-screenshots.sh`は撮影対象パスの有無に応じて上記いずれかの構成で
`scripts/capture-screenshots.mjs`（複数の`名前:パス:device`の組を任意個数受け取る汎用形）を
呼び出し、埋め込み用のraw URLを標準出力に出力する（対象パス明示指定時は2行、省略時は4行）。

呼び出し元のClaude Codeエージェントは、取得したURLを対象パス明示指定時は`![PC画面](...)`・
`![スマホ画面](...)`、省略時は`![PC画面](...)`・`![スマホ:ホーム](...)`・
`![スマホ:イシュー一覧](...)`・`![スマホ:イシュー詳細](...)`というMarkdown画像記法で、PR本文・
PRコメントではなくIssue側の完了報告コメント（`gh issue comment`）に埋め込む（#589。以前はPR本文・
PRコメントに埋め込んでいたが、視覚確認・承認をイシューコメント側で完結させるため変更した）。

develop向けPRのマージ前には、`risk-check`ジョブが`24.screenshot-required`ラベルの有無を見て
常に`00.check-user`を付与するため（「developへのマージ前確認要否をIssueラベルでトグルする」・
「自動マージ可否の判定方法」参照、#567）、撮影したスクリーンショットを人間が確認するまで
developへは自動マージされない。`23.preview-required`についても、Phase5の説明のとおり
`00.check-user`で停止せずPR作成まで進める運用は変わらない。一時期はFly.io Machines上のプレビュー
環境（#826・#830・#831・#832）から実URLを通知していたが、#1265でサブPC上のローカルセッションが
`tailscale serve`でtailnetへ開発環境を出す方式へ移行し、Fly.io側は#1308で廃止した。

#### CIバイパス用ユーザーとダミーデータの紐付け

`/dashboard`のリポジトリ・Issue一覧は`UserInstallation`（ユーザーとGitHub Appインストールの
紐付け）経由で絞り込まれる（`src/app/dashboard/page.tsx`, `src/lib/issues-for-user.ts`）。
`scripts/ci-seed-user.mjs`（#257）はCIバイパス用ユーザーの作成のみ、`scripts/seed-ci-db.mjs`
（#256）はダミーのリポジトリ・Issueの作成のみを行っており、両者を紐付ける`UserInstallation`が
どちらにも存在しなかった（#258で発覚）。そのため`seed-ci-db.mjs`に、CIバイパス用ユーザーが
存在する場合に限り対応する`UserInstallation`をupsertする処理を追加した。ワークフロー上も
`scripts/ci-seed-user.mjs`を`seed-ci-db.mjs`より先に実行する順序に固定している。

#### DBセットアップ・Playwrightブラウザのインストールを実行する条件

`Setup pnpm`・`Setup Node.js`・依存関係インストール・DBマイグレーション・CIバイパス用ユーザーの
シード・ダミーデータのシード・Playwrightブラウザ（chromium）のインストールは、いずれも上記の
スクリーンショット撮影でのみ使われる。当初はDBセットアップ一式（chromiumのダウンロードを除く）
を`24.screenshot-required`の有無によらず毎回実行していたが、撮影しないissueでは完全に無駄な
処理のため、chromiumダウンロード（数分かかる）と同様にstate stepが出力する
`screenshot_required`が`true`の場合のみ実行するよう変更した（#319）。
