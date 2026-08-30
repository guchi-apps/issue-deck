#!/usr/bin/env bash
# Codex CLIの転記から、最新のプラン枠だけを抽出する（#2535）。
# 会話本文・トークン数・クレジット残高は出力せず、壊れた行は黙って無視する。

_codex_usage_run_python() {
  local script="$1"
  shift
  python3 -c "$script" "$@"
}

# codex_usage_latest <~/.codex/sessions>
# 読めるスナップショットが無ければ何も出力せず成功する。
codex_usage_latest() {
  local sessions_dir="$1" script
  [[ -d "$sessions_dir" ]] || return 0
  script="$(
    cat <<'PY'
import json
import heapq
import os
import sys
from datetime import datetime, timezone

root = sys.argv[1]
latest = None
candidates = []

def stamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed

def window(value):
    if not isinstance(value, dict):
        return None
    used = value.get("used_percent")
    minutes = value.get("window_minutes")
    reset = value.get("resets_at")
    if not isinstance(used, (int, float)) or isinstance(used, bool) or not 0 <= used <= 100:
        return None
    if not isinstance(minutes, int) or isinstance(minutes, bool) or minutes <= 0:
        return None
    if not isinstance(reset, int) or isinstance(reset, bool) or reset <= 0:
        return None
    return {"usedPercent": used, "windowMinutes": minutes,
            "resetsAt": datetime.fromtimestamp(reset, timezone.utc).isoformat().replace("+00:00", "Z")}

for base, _, names in os.walk(root):
    for name in names:
        if not name.endswith(".jsonl"):
            continue
        path = os.path.join(base, name)
        try:
            modified = os.path.getmtime(path)
        except OSError:
            continue
        # 全履歴を5分ごとに開かない。最新値は更新日時が新しい転記にあるため、候補だけ読む。
        if len(candidates) < 20:
            heapq.heappush(candidates, (modified, path))
        elif modified > candidates[0][0]:
            heapq.heapreplace(candidates, (modified, path))

for _, path in candidates:
    try:
        handle = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        continue
    with handle:
        for line in handle:
            if '"token_count"' not in line or '"rate_limits"' not in line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            observed = stamp(record.get("timestamp"))
            payload = record.get("payload")
            if observed is None or not isinstance(payload, dict) or payload.get("type") != "token_count":
                continue
            limits = payload.get("rate_limits")
            if not isinstance(limits, dict):
                continue
            primary = window(limits.get("primary"))
            secondary = window(limits.get("secondary"))
            plan = limits.get("plan_type")
            if primary is None or secondary is None:
                continue
            if plan is not None and (not isinstance(plan, str) or len(plan) > 64):
                plan = None
            if latest is None or observed > latest[0]:
                latest = (observed, {
                    "observedAt": observed.isoformat().replace("+00:00", "Z"),
                    "planType": plan,
                    "primary": primary,
                    "secondary": secondary,
                })

if latest is not None:
    print(json.dumps(latest[1], ensure_ascii=False, separators=(",", ":")))
PY
  )"
  _codex_usage_run_python "$script" "$sessions_dir"
}
