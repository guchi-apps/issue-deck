#!/usr/bin/env bash
# actions/checkout を行うジョブで、`permissions:` を明示しているのに `contents` が
# 無いものを検出する。
#
# ジョブに `permissions:` を書くと、書かなかったスコープは継承ではなく `none` になる。
# そのため `contents` を省くと GITHUB_TOKEN がリポジトリの読み取り権限を持たず、
# actions/checkout が `remote: Repository not found` で失敗する（#2126）。
#
# **publicリポジトリでは匿名cloneが通るため成功してしまい、privateリポジトリへ
# 配って初めて失敗する。** issue-deck自身はpublicなので、CIも実運用も緑のまま
# `reusable-claude-review-develop.yml`の`risk-check`が壊れていた。callerの
# `permissions:`は呼び出し先の上限を決めるだけで引き上げられないため、
# 配布先では回避できない。静的に検出して develop へ入る前に落とす。
set -euo pipefail

cd "$(dirname "$0")/.."

python3 - <<'PYEOF'
import glob
import sys

import yaml

READABLE = ("read", "write")

missing = []

paths = sorted(glob.glob(".github/workflows/*.yml"))
# 対象0件を「問題なし」と報告しない（#937）。ディレクトリの移動・リネームやcheckout失敗で
# 静かに素通りするのを防ぐ。
if not paths:
    print(
        "エラー: .github/workflows/*.yml が1件も見つかりません。"
        "リポジトリルートで実行しているか確認してください。",
        file=sys.stderr,
    )
    sys.exit(1)


def has_contents(permissions):
    # permissions未指定（None）はワークフロー既定またはリポジトリ既定を継承するため対象外。
    # read-all / write-all は全スコープを含むのでcontentsを持つ。
    if permissions is None:
        return True
    if isinstance(permissions, str):
        return permissions in ("read-all", "write-all")
    return permissions.get("contents") in READABLE


for path in paths:
    with open(path, encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    if not doc:
        continue
    workflow_permissions = doc.get("permissions")
    for job_name, job in (doc.get("jobs") or {}).items():
        if not isinstance(job, dict):
            continue
        steps = job.get("steps") or []
        if not any("actions/checkout" in (step.get("uses") or "") for step in steps):
            continue
        # ジョブに書いていなければワークフロー全体の指定を使う（GitHubの解決順と同じ）。
        permissions = job.get("permissions", workflow_permissions)
        if has_contents(permissions):
            continue
        missing.append((path, job_name, permissions))

if missing:
    for path, job_name, permissions in missing:
        print(
            f"不足 [contents]: {path} :: job={job_name} :: permissions={permissions}",
            file=sys.stderr,
        )
    print("", file=sys.stderr)
    print(
        "actions/checkoutを行うジョブにpermissions:を明示する場合は、contents: read（書き込みが"
        "要るならwrite）も必ず含めてください。省くとcontentsがnoneになり、privateリポジトリで"
        "checkoutが失敗します（#2126）。",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"OK: {len(paths)}ファイル中、checkoutを行うジョブはすべてcontentsの読み取り権限を持ちます")
PYEOF
