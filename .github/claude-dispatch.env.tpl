# claude-issue-dispatch.yml 用。
#
# 既定の GITHUB_TOKEN には `.github/workflows/` 配下のファイルを更新する権限
# （workflows権限）を付与できない（GitHub Actionsのワークフロー構文レベルの制約）ため、
# 該当権限を持つfine-grained PAT（対象リポジトリ限定、Contents: Read and write /
# Workflows: Read and write）をactions/checkoutの認証に使う。

WORKFLOW_PUSH_PAT=op://apps/issue-deck/github-workflow-pat
