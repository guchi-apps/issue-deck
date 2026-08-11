# コードの地図

**いつ読むか**: このリポジトリのコードを初めて触るとき。どこに何があるかを掴みたいとき。

重複を避けるため、他が一次情報源のものはここに書かない。

- スタック・セットアップ・コマンド一覧: [../README.md](../README.md)
- 運用ルール（ブランチ・ラベル・共有知識）: [../CLAUDE.md](../CLAUDE.md)
- GitHub上の操作が誰の名義になるか: [attribution.md](attribution.md)
- Actions側のトークンと自己ループ防止: [actions-token-model.md](actions-token-model.md)
- 無人実行フローの全体像: [multi-agent-workflow.md](multi-agent-workflow.md)・[multi-agent/](multi-agent/)

## ディレクトリ

```
src/
  app/
    api/            Route Handler。画面からのデータ取得・更新はすべてここ経由
    auth/callback   Supabase Authのコールバック。Userレコードの作成とトークン保存
    dashboard/      メイン画面
    github/setup    GitHub Appインストール後の受け口
  components/
    dashboard/      画面固有のコンポーネント（mobile/ にモバイル専用）
    ui/             shadcn/uiの生成物。手で書き換えない
  hooks/            use-* のクライアントフック。データ取得・更新はここに集約する
  lib/
    github/         GitHub APIとの境界。コンポーネントから直接叩かない
    claude/         Claude APIを使う機能（要約・提案・本文整形）
    supabase/       client / server / middleware / admin / github-oauth
    crypto/         ユーザートークンの暗号化
  proxy.ts          リクエスト前段の処理（後述）
prisma/schema.prisma
scripts/            開発・CI用スクリプト（dev.sh ほか）
deploy/             PM2の ecosystem.config.js
```

規約として守られていること。

- **GitHub APIの呼び出しは `lib/github/` を経由する。** コンポーネントやページから直接`fetch`しない。
- **ユーザー本人のトークンを使う呼び出しは
  [`lib/github/with-user-github-token.ts`](../src/lib/github/with-user-github-token.ts) を通す。**
  トークン未保存時の409応答と、期限切れ時のリフレッシュ・再暗号化をここで一元的に扱っている。
  個別のRoute Handlerで復号処理を書き足さない。
- **ロジックは純粋関数として `lib/` に切り出し、隣に `*.test.ts` を置く。** コンポーネントに
  埋め込むとテストできなくなる。既存の `issue-status.ts` / `workflow-status.ts` /
  `search-query.ts` などがこの形。
- `components/ui/` はshadcnの生成物なので、変更したい場合は生成物を直接編集せず
  ラップするコンポーネント側で対応する。

## `middleware.ts` は無い。`src/proxy.ts` を見る

Next.js 16 で `middleware.ts` は `proxy.ts` にリネームされた。Supabaseのセッション更新は
[../src/proxy.ts](../src/proxy.ts) が `lib/supabase/middleware.ts` の `updateSession` を呼んでいる。
`middleware.ts` を探しても見つからないのはこのため。

## データの流れ

- **Issueの一次情報源はGitHub、MySQLはキャッシュ。** `lib/github/sync-issues.ts` が取得結果を
  `Issue` テーブルへupsertする。画面の一覧はDBを読む。
- **GitHub → DBの取り込み経路は2つ。** `/api/webhooks/github`（HMAC署名を検証）で受けるプッシュ型と、
  `POST /api/sync/issues`（画面の再同期ボタン、`hooks/use-issue-sync.ts`）で明示的に走らせるプル型。
- 画面の更新は別の話で、`hooks/use-issue-polling.ts` が10秒間隔で `/api/issues`（＝DB）を読み直す。
  ポーリングしてもGitHubには問い合わせないため、Webhookが届いていない変更はここでは拾えない。
- **コメントはキャッシュせず、都度GitHub APIから取得する**（`/api/issues/comments`）。
- **Issueの進捗はGitHub Projects v2のStatusで持ち、進捗ラベルはフォールバック。**
  判定は必ず [`lib/issue-progress.ts`](../src/lib/issue-progress.ts) の `resolveProgressStatus`
  を通す（`01.planning`等のラベル名やStatus名を直接見ない）。Statusは`projects_v2_item`
  Webhookと再同期（`lib/github/sync-project-status.ts`）で`Issue.projectStatus`へ入り、
  未登録なら`null`のままラベルから解決する。Projects v2はGraphQLのみのため境界は
  [`lib/github/projects-api.ts`](../src/lib/github/projects-api.ts)。
  Projectの場所は`PROJECT_V2_OWNER`・`PROJECT_V2_NUMBER`で指定し、**未設定なら
  Project連携を一切行わない**。設計の一次情報源は
  [progress-status-architecture.md](progress-status-architecture.md)（#991）。
- **Projectへの書き込み経路は`POST /api/progress`の1本だけ。** ワークフローもローカル実行も
  Projectを直接更新せず、このAPIへ`ProgressStatusKey`を報告する
  （[`lib/github/report-progress.ts`](../src/lib/github/report-progress.ts)）。Projects v2の
  書き込み権限を持つのをissue-deckのGitHub Appだけに閉じるための一本化で、認証は共有シークレット
  `PROGRESS_REPORT_SECRET`。**呼び出し側はこのAPIの失敗で処理を止めない**取り決めのため、
  取りこぼしは再同期（`reconcileProjectStatusesFromLabels`）がラベルを正として是正する。
- 独自テーブルを持つのは、既読状態・お気に入り・クイックフィルタ・リポジトリの非表示など
  **GitHub側に存在しない情報だけ**。GitHubにある情報を二重に持たない。

## 画像はVPSのローカルディスクに置く

- `POST /api/issues/images` … ログイン必須。`uploads/images/` へUUID名で保存する。
- `GET /api/issues/images/[filename]` … **認証を要求しない。** GitHub.com側のIssue画面からも
  画像を表示できるようにするため。代わりにUUID形式のファイル名だけを許可して、パストラバーサルと
  ファイルの列挙を防いでいる。
- `uploads/` は`.gitignore`済みで配布物にも含まれず、`deploy.yml` のクリーンアップ対象にも
  入っていないため本番で永続する。**`deploy.yml` の `rm -rf` の行に `uploads` を足すと
  ユーザーがアップロードした画像が消える。**

## 画面のボタンは`@claude`コメントで動く

「実装を開始」「計画を承認」などのボタンは、ワークフローを直接起動するのではなく、
**Issueへ定型の`@claude`コメントを投稿する**ことで `claude-issue-dispatch.yml` のトリガーを踏む
（[`lib/github/start-implementation.ts`](../src/lib/github/start-implementation.ts)・
[`lib/github/approval-labels.ts`](../src/lib/github/approval-labels.ts)）。
ボタンの表示条件はIssueのラベルから判定する（[`lib/github/workflow-status.ts`](../src/lib/github/workflow-status.ts)）。

定型文やマーカーコメントを変更するときは、ワークフロー側のトリガー条件と対になっているため
両方を確認する。

## テスト

```bash
pnpm test        # lint + typecheck + vitest run
pnpm test:unit   # vitestのみ
```

`pnpm dev` は `next dev` の単純なラッパーではなく、[../scripts/dev.sh](../scripts/dev.sh) が
`.env.local` の読み込み・LAN内の別端末から見るためのポートフォワード設定・smeeによるWebhook中継の
起動を行う。`next dev` を直接叩くとGitHubからのWebhookがローカルに届かない。

## 環境変数

`.env.local.example` が一次情報源。DB・Supabase・GitHub Appの3系統に分かれる。

追加するときはローカルの`.env.local.example`だけでなく、1Password・`.github/deploy.env.tpl`・
`deploy.yml` の `env:` と `envs:`・サーバー側`.env`を書く`update_env`行まで更新する。詳細は共有知識の
[knowledge/deployment.md](https://github.com/guchi-apps/docs/blob/main/knowledge/deployment.md) を参照。
