#!/usr/bin/env bash
# actions/checkout を行わないジョブの中で `gh` を使いながら、リポジトリの指定
# （env の GH_REPO、または --repo/-R オプション）が無いステップを検出する。
#
# checkout しないジョブではカレントディレクトリがgitリポジトリではないため、
# gh は対象リポジトリを特定できず `fatal: not a git repository` で失敗する（#929）。
# 構文としては妥当なので、実際にそのステップが発火するまで気付けない。
# 発火条件が稀なステップだと長期間潜伏するため、静的に検出して落とす。
set -euo pipefail

cd "$(dirname "$0")/.."

python3 - <<'PYEOF'
import glob
import re
import sys

import yaml

GH_COMMAND = re.compile(r"\bgh (api|issue|pr|run|workflow|label|release|search)\b")
EXPLICIT_REPO = re.compile(r"--repo\b|\s-R\s")

missing = []

paths = sorted(glob.glob(".github/workflows/*.yml"))
# 対象0件を「問題なし」と報告しない（#937）。本スクリプトは「構文としては妥当なのに静かに
# 壊れる」欠落を検出するためのものなので、自身が同じ失敗モードを持ち込まないようにする。
# ディレクトリの移動・リネーム、checkout失敗、他リポジトリへ展開した際の配置ミスで沈黙する。
if not paths:
    print(
        "エラー: .github/workflows/*.yml が1件も見つかりません。"
        "リポジトリルートで実行しているか確認してください。",
        file=sys.stderr,
    )
    sys.exit(1)

for path in paths:
    with open(path, encoding="utf-8") as fh:
        doc = yaml.safe_load(fh)
    if not doc:
        continue
    workflow_env = doc.get("env") or {}
    for job_name, job in (doc.get("jobs") or {}).items():
        steps = job.get("steps") or []
        if any("actions/checkout" in (step.get("uses") or "") for step in steps):
            continue
        job_env = job.get("env") or {}
        for step in steps:
            run = step.get("run") or ""
            if not GH_COMMAND.search(run):
                continue
            if EXPLICIT_REPO.search(run):
                continue
            env = {**workflow_env, **job_env, **(step.get("env") or {})}
            if "GH_REPO" in env:
                continue
            missing.append((path, job_name, step.get("name") or "(名前なし)"))

if missing:
    for path, job_name, step_name in missing:
        print(f"未指定 [GH_REPO]: {path} :: job={job_name} :: step={step_name}", file=sys.stderr)
    print("", file=sys.stderr)
    print(
        "checkoutしないジョブでghを使う場合は、env に GH_REPO: ${{ github.repository }} を"
        "指定するか、ghコマンドに --repo を渡してください（#929）。",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"OK: {len(paths)}ファイル中、checkoutしないジョブのghコマンドは全てリポジトリを特定できます")
PYEOF
