# Fly.io Machines上のオンデマンドプレビュー環境（#826）向け。
# Next.js standalone + MariaDB を1つのMachine上で動かす2プロセス構成。
# 起動順序の制御・DBダンプのロードは scripts/preview-entrypoint.sh が行う。

########################################
# deps: 依存関係のインストール
########################################
FROM node:24-slim AS deps
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

########################################
# builder: Next.js standalone ビルド
########################################
FROM node:24-slim AS builder
WORKDIR /app

RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# next build は src/lib/github/app-auth.ts がモジュール読み込み時点でGITHUB_APP_ID /
# GITHUB_APP_PRIVATE_KEY_BASE64を参照するため、ビルド時にも値が必要（.github/workflows/ci.ymlの
# ビルド時プレースホルダーと同じ考え方）。実際の値（開発App=4445268向け）は
# .github/workflows/deploy-preview.yml（#831）が `docker build --build-arg` で上書きする想定。
ARG DATABASE_URL="mysql://placeholder:placeholder@127.0.0.1:3306/app_issue_deck"
ARG NEXT_PUBLIC_SUPABASE_URL="https://preview-placeholder.supabase.co"
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="preview-placeholder"
ARG GITHUB_APP_ID="123456"
ARG GITHUB_APP_PRIVATE_KEY_BASE64="cHJldmlldy1wbGFjZWhvbGRlcg=="
ARG NEXT_PUBLIC_GITHUB_APP_SLUG="preview-placeholder"
ARG GITHUB_WEBHOOK_SECRET="preview-placeholder"

ENV DATABASE_URL=${DATABASE_URL} \
    NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY} \
    GITHUB_APP_ID=${GITHUB_APP_ID} \
    GITHUB_APP_PRIVATE_KEY_BASE64=${GITHUB_APP_PRIVATE_KEY_BASE64} \
    NEXT_PUBLIC_GITHUB_APP_SLUG=${NEXT_PUBLIC_GITHUB_APP_SLUG} \
    GITHUB_WEBHOOK_SECRET=${GITHUB_WEBHOOK_SECRET}

RUN pnpm build:ci

########################################
# runner: Next.js standalone + MariaDB
########################################
FROM node:24-slim AS runner
WORKDIR /app

RUN DEBIAN_FRONTEND=noninteractive apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends mariadb-server gzip \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DB_DATA_DIR=/var/lib/mysql \
    DB_NAME=app_issue_deck \
    DB_USER=app \
    DB_PASSWORD=app \
    DB_HOST=127.0.0.1 \
    DB_PORT=3306

# Next.js standalone出力（public/.next/staticは手動コピーが必要。Next.js公式ドキュメント参照）。
# Prismaのクエリエンジン（node_modules/.prisma配下、pnpmのvirtual store経由でシンボリックリンク
# されている）もoutput file tracingで.next/standalone配下に解決済みで含まれるため、個別コピー不要
# （実際にpnpm環境でdocker buildなしにビルドし.next/standaloneの中身を確認して検証済み）
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# デプロイworkflow（#831）が本番DBダンプ（サニタイズ・installation ID書き換え済み）を
# db-dump/dump.sql.gz に配置した上でイメージをビルドする想定。本サブIssue時点ではダンプ本体は
# 用意せず、ロードする仕組み（scripts/preview-entrypoint.sh）だけを用意する
COPY db-dump/ /app/db-dump/

# ENTRYPOINTはexec形式のため、実行ビットが落ちているとMachineが起動直後にクラッシュする
# （#880で`machine exited abruptly`となっていた原因）。git側のmodeも755にしてあるが、
# チェックアウト環境によっては実行ビットが保たれないため、イメージ内で明示的に付与する。
COPY scripts/preview-entrypoint.sh /app/preview-entrypoint.sh
RUN chmod +x /app/preview-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/preview-entrypoint.sh"]
