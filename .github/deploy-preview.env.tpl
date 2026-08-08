# Vault: apps — issue-deck / DB / Server / githubaction-sshkey / Supabase
# .github/workflows/deploy-preview.yml（#831）用。プレビュー環境は本番DBをコピーして動かすが、
# GitHub Appは開発App（issue-deck-dev, App ID 4445268）を使う（本番Appの秘密鍵を複製しないため）。
#
# 以下2項目は本Issue時点で1Password側に未作成。デプロイ実行前に人間が用意すること。
#   - apps/issue-deck/fly-api-token（Fly.ioのデプロイトークン）
#   - apps/issue-deck/preview-github-app-private-key-base64（開発App issue-deck-devの秘密鍵、base64）

SSH_PRIVATE_KEY=op://apps/githubaction-sshkey/private_key?ssh-format=openssh
HOST=op://apps/Server/host
USERNAME=op://apps/Server/username
SSH_PORT=op://apps/Server/ssh-port

# 本番DBダンプ取得用（ssh経由で本番サーバー上のmysqldumpに渡す。DB_HOST/DB_PORTは
# 本番サーバー上でlocalhost接続のため不要）
DB_USER=op://apps/DB/db-user
DB_PASSWORD=op://apps/DB/db-password
DB_NAME=op://apps/issue-deck/db-name

# NEXT_PUBLIC_*はビルド時に静的埋め込みされるため、本番Supabaseプロジェクトの実値を
# build-argとして渡す（プレビューもSupabase Authは本番と同一プロジェクトを流用する）
NEXT_PUBLIC_SUPABASE_URL=op://apps/Supabase/project-url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=op://apps/Supabase/publishable-key

# 以下はサーバー専用の実行時シークレットのため fly secrets set で渡す（イメージに焼き込まない）
SUPABASE_SERVICE_ROLE_KEY=op://apps/Supabase/secret-key
ALLOWED_EMAILS=op://apps/issue-deck/allowed-emails
PREVIEW_GITHUB_APP_PRIVATE_KEY_BASE64=op://apps/issue-deck/preview-github-app-private-key-base64

FLY_API_TOKEN=op://apps/issue-deck/fly-api-token
