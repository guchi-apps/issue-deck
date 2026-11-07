#!/usr/bin/env bash
# 旧名（#2597）。本体は`scripts/lib/issue-artifact.sh`（#5237でClaude Codeと共用にした）。
#
# 起動済みのセッションのプロンプトや配布先の古いランチャーがこの名前で呼ぶため、ラッパーとして残す。
set -euo pipefail
exec "$(dirname "${BASH_SOURCE[0]}")/issue-artifact.sh" "$@"
