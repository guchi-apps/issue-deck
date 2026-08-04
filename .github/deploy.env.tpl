# Vault: apps — issue-deck / DB / Server / githubaction-sshkey / Supabase
SSH_PRIVATE_KEY=op://apps/githubaction-sshkey/private_key?ssh-format=openssh
HOST=op://apps/Server/host
USERNAME=op://apps/Server/username
SSH_PORT=op://apps/Server/ssh-port
TARGET_DIR=op://apps/issue-deck/target-dir
PORT=op://apps/issue-deck/port

DB_USER=op://apps/DB/db-user
DB_PASSWORD=op://apps/DB/db-password
DB_HOST=op://apps/DB/db-host
DB_PORT=op://apps/DB/db-port
DB_NAME=op://apps/issue-deck/db-name
MIGRATE_DB_USER=op://apps/DB/migrate-user
MIGRATE_DB_PASSWORD=op://apps/DB/migrate-password

NEXT_PUBLIC_SUPABASE_URL=op://apps/Supabase/project-url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=op://apps/Supabase/publishable-key
SUPABASE_SERVICE_ROLE_KEY=op://apps/Supabase/secret-key

GITHUB_APP_ID=op://apps/issue-deck/github-app-id
GITHUB_APP_PRIVATE_KEY_BASE64=op://apps/issue-deck/github-app-private-key-base64
NEXT_PUBLIC_GITHUB_APP_SLUG=op://apps/issue-deck/github-app-slug
GITHUB_WEBHOOK_SECRET=op://apps/issue-deck/github-webhook-secret
GITHUB_USER_TOKEN_ENCRYPTION_KEY=op://apps/issue-deck/github-user-token-encryption-key
ALLOWED_EMAILS=op://apps/issue-deck/allowed-emails

CLAUDE_CODE_OAUTH_TOKEN=op://apps/issue-deck/claude-code-oauth-token

SIGNALY_WEBHOOK_URL=op://apps/issue-deck/ci-webhook-url
