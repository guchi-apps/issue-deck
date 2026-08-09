# IssueDeck

複数のGitHubリポジトリのIssueを横断して確認・整理できるWebアプリ。

## 技術スタック

- [Next.js](https://nextjs.org)（App Router） / React / TypeScript
- [Prisma](https://www.prisma.io) + MySQL
- [Supabase Auth](https://supabase.com/auth)（GitHubプロバイダー）
- GitHub App連携（Octokit）
- Tailwind CSS / shadcn・Radix UI

## セットアップ

前提: pnpm、MySQLが利用できること（`sudo mysql`でroot接続できる環境を想定）。

```bash
pnpm install

# .env.local を作成し、DB/Auth/GitHub関連の値を編集する
pnpm env:init

# .env.local の DATABASE_URL を元に MySQL の DB・ユーザーをセットアップする
pnpm db:setup
pnpm db:migrate:dev
```

`.env.local`に設定する値の詳細は`.env.local.example`のコメントを参照。

## 開発サーバーの起動

```bash
pnpm dev
```

[http://localhost:3000](http://localhost:3000) で確認できる。`GITHUB_WEBHOOK_PROXY_URL`を設定している場合は、smee.io経由のWebhook転送も自動で起動する。

## 主なコマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | 開発サーバー起動 |
| `pnpm build` | 本番ビルド |
| `pnpm start` | 本番ビルドの起動 |
| `pnpm lint` | ESLint実行 |
| `pnpm typecheck` | TypeScriptの型チェック |
| `pnpm test` | lint + typecheckをまとめて実行 |
| `pnpm db:migrate:dev` | Prismaマイグレーション（開発用） |
| `pnpm db:migrate:deploy` | Prismaマイグレーション（本番用） |
| `pnpm db:studio` | Prisma Studioの起動 |

## デプロイ

`main`ブランチへのpushをトリガーに、GitHub Actions（`.github/workflows/deploy.yml`）経由で本番サーバーへPM2（`deploy/ecosystem.config.js`）でデプロイされる。

## ドキュメント

- コードの地図（どこに何があるか）: [docs/code-map.md](./docs/code-map.md)
- 開発運用ルール: [CLAUDE.md](./CLAUDE.md)
- Issueごとの複数Claude Codeエージェント運用: [docs/multi-agent-workflow.md](./docs/multi-agent-workflow.md)
- 他リポジトリへのマルチエージェント運用 導入ガイド: [docs/cross-repo-setup-guide.md](./docs/cross-repo-setup-guide.md)
