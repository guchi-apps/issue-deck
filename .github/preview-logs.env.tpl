# Vault: apps — issue-deck
# .github/workflows/preview-logs.yml 用。Fly.ioのログ取得にしか使わないため、
# deploy-preview.env.tplのようなDB・SSH・Supabase系のシークレットは読み込まない。

FLY_API_TOKEN=op://apps/issue-deck/fly-api-token
