#!/usr/bin/env bash
# 並行状況スナップショットの純粋関数（#1215）。
#
# **これは計器であって役ではない**（[docs/multi-agent/gates.md](../../docs/multi-agent/gates.md)
# 「計器」）。判断はせず、tmux・git・GitHubから読める事実を突き合わせて並べるだけで、LLMも
# 人への問い合わせも挟まない。俯瞰の**情報**は要るが、俯瞰の**常駐する人格**は要らない。
#
# **このファイルには外部の状態を読む処理を置かない。** tmux・git・ghを叩くのは入口
# （`scripts/fleet-status.sh`）の役目で、ここに置くのは「渡された文字列を別の文字列にする」
# 関数だけにする。こうしておくと、tmux・ghの出力を固定したfixtureをそのまま食わせて
# 検証できる（`src/lib/fleet-status.test.ts`）。
#
# このファイル自体は実行せず、source して使う。
#
# ## 中間表現
#
# 入口が集めた事実は、**レコード種別を先頭列に持つTSVの1本のストリーム**として受け渡す。
# 種類ごとに引数やファイルを分けると、受け渡しの形の数だけfixtureを用意することになる。
#
#   base     <ブランチ> <SHA> <件名> <リポジトリ>
#   session  <セッション名> <リポジトリ> <Issue番号> <worktree> <ブランチ> <分岐元SHA> <遅れ> <未コミット> <自分自身か>
#   sfile    <セッション名> <パス>
#   pr       <番号> <Issue番号> <headRefName> <ファイル数> <打ち切りか> <タイトル>
#   prfile   <番号> <パス>
#
# 空欄は「取れなかった」を表す。**取れなかったことと0を混同しない**（別リポジトリのセッションは
# 変更ファイルを集めないので空欄になるが、これは「0件触っている」ではない）。

# python3のスクリプトをヒアドキュメントで組み立ててから `-c` へ渡す。
# `python3 - <<'PY'` の形にすると標準入力がスクリプトに奪われ、パイプで渡した本体を読めない。
# ヒアドキュメントを経由するのは、`python3 -c '...'` に直接書くとPython側で `'` を使えず、
# f-stringのキーが書けなくなるため。
_fleet_status_run_python() {
  python3 -c "$1"
}

# tmuxのセッション名を `<リポジトリ名> <Issue番号>` に分解する。
# **末尾の区切りで割る**（`src/lib/dispatch/session-state.ts` の `parseSessionName` と同じ規則）。
# 先頭から探すと `foo-issue-tracker-issue-12` が `foo` と `tracker-issue-12` に割れて番号が取れない。
#
# Issueに紐づかない名前（人が手で立てたセッション等）では何も出力せず非0で返る。
fleet_status_session_key() {
  local name="$1"
  [[ "$name" =~ ^(.+)-issue-([1-9][0-9]*)$ ]] || return 1
  printf '%s\t%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
}

# `tmux list-sessions -F '#{session_name}'` の出力（stdin）から、Issueに紐づくセッションだけを
# `<セッション名> <リポジトリ名> <Issue番号>` のTSVで返す。
#
# **tmuxサーバーが起動していない場合、入口は空を渡してくる。** そのときは何も出力しない
# （エラーにはしない。走っているセッションが0本なのと区別する意味が無い）。
fleet_status_parse_sessions() {
  local script
  script="$(
    cat <<'PY'
import re
import sys

PATTERN = re.compile(r"^(.+)-issue-([1-9][0-9]*)$")

for line in sys.stdin:
    name = line.strip()
    if not name:
        continue
    matched = PATTERN.match(name)
    if not matched:
        continue
    print("\t".join([name, matched.group(1), matched.group(2)]))
PY
  )"
  _fleet_status_run_python "$script"
}

# `git worktree list --porcelain` の出力（stdin）から `<ブランチ> <パス>` のTSVを返す。
# detached HEAD のworktree（`branch` 行を持たない）は落とす。
fleet_status_parse_worktrees() {
  local script
  script="$(
    cat <<'PY'
import sys

PREFIX = "branch refs/heads/"
path = None

for raw in sys.stdin:
    line = raw.rstrip("\n")
    if line.startswith("worktree "):
        path = line[len("worktree "):]
    elif line.startswith(PREFIX):
        if path:
            print("\t".join([line[len(PREFIX):], path]))
    elif not line:
        path = None
PY
  )"
  _fleet_status_run_python "$script"
}

# `gh pr list --json number,title,headRefName,files` の出力（stdin）から `pr` / `prfile`
# レコードを返す。JSONが壊れている・ghが失敗して空だった場合は何も出力しない。
#
# **`files` は100件で打ち切られる**（GitHub APIの1ページぶん）。打ち切られたPRは重なりを
# 取りこぼすので、その旨をレコードへ残して表示に添える。取りこぼしても「重なりが出ない」
# だけで、無い重なりを出すことはない。
fleet_status_parse_prs() {
  local script
  script="$(
    cat <<'PY'
import json
import re
import sys

FILE_LIMIT = 100
BRANCH = re.compile(r"^issue-([1-9][0-9]*)$")


def clean(value):
    return str(value or "").replace("\t", " ").replace("\n", " ").strip()


try:
    rows = json.load(sys.stdin)
except Exception:
    rows = []
if not isinstance(rows, list):
    rows = []

for pr in rows:
    if not isinstance(pr, dict):
        continue
    number = pr.get("number")
    if not isinstance(number, int):
        continue
    head = clean(pr.get("headRefName"))
    matched = BRANCH.match(head)
    issue = matched.group(1) if matched else ""
    files = [
        f.get("path")
        for f in (pr.get("files") or [])
        if isinstance(f, dict) and f.get("path")
    ]
    truncated = "1" if len(files) >= FILE_LIMIT else "0"
    print(
        "\t".join(
            [
                "pr",
                str(number),
                issue,
                head,
                str(len(files)),
                truncated,
                clean(pr.get("title")),
            ]
        )
    )
    for path in files:
        print("\t".join(["prfile", str(number), path]))
PY
  )"
  _fleet_status_run_python "$script"
}

# 中間表現のストリーム（stdin）を正規化JSONへ畳む。**重なりの判定もここで行う。**
#
# 重なりは「同じファイルを触っている組」で、次の2つは除く。
#   - リポジトリが違う組。`docs/README.md` のような名前は別リポジトリ間で偶然一致するが、
#     衝突はしない
#   - 同じIssueに属する組。セッションとそのIssueのPRは同じ作業の表と裏で、重なって当然
fleet_status_build_json() {
  local script
  script="$(
    cat <<'PY'
import json
import sys


def cell(cols, index):
    return cols[index] if index < len(cols) else ""


def number(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


base = {"branch": None, "sha": None, "subject": None}
repository = None
sessions = {}
prs = {}
session_order = []
pr_order = []

for raw in sys.stdin:
    line = raw.rstrip("\n")
    if not line:
        continue
    cols = line.split("\t")
    kind = cols[0]

    if kind == "base":
        base = {
            "branch": cell(cols, 1) or None,
            "sha": cell(cols, 2) or None,
            "subject": cell(cols, 3) or None,
        }
        repository = cell(cols, 4) or None
    elif kind == "session":
        name = cell(cols, 1)
        if not name:
            continue
        if name not in sessions:
            session_order.append(name)
        files = sessions.get(name, {}).get("files", [])
        sessions[name] = {
            "name": name,
            "repository": cell(cols, 2) or None,
            "issue": number(cell(cols, 3)),
            "worktree": cell(cols, 4) or None,
            "branch": cell(cols, 5) or None,
            "baseSha": cell(cols, 6) or None,
            "behind": number(cell(cols, 7)),
            "dirty": number(cell(cols, 8)),
            "self": cell(cols, 9) == "1",
            "files": files,
        }
    elif kind == "sfile":
        name = cell(cols, 1)
        path = cell(cols, 2)
        if not name or not path:
            continue
        if name not in sessions:
            session_order.append(name)
            sessions[name] = {"name": name, "files": []}
        sessions[name].setdefault("files", []).append(path)
    elif kind == "pr":
        num = number(cell(cols, 1))
        if num is None:
            continue
        if num not in prs:
            pr_order.append(num)
        files = prs.get(num, {}).get("files", [])
        prs[num] = {
            "number": num,
            "issue": number(cell(cols, 2)),
            "headRefName": cell(cols, 3) or None,
            "fileCount": number(cell(cols, 4)) or 0,
            "filesTruncated": cell(cols, 5) == "1",
            "title": cell(cols, 6) or "",
            "files": files,
        }
    elif kind == "prfile":
        num = number(cell(cols, 1))
        path = cell(cols, 2)
        if num is None or not path:
            continue
        if num not in prs:
            pr_order.append(num)
            prs[num] = {"number": num, "files": []}
        prs[num].setdefault("files", []).append(path)

SESSION_DEFAULTS = {
    "repository": None,
    "issue": None,
    "worktree": None,
    "branch": None,
    "baseSha": None,
    "behind": None,
    "dirty": None,
    "self": False,
    "files": [],
}

session_list = []
for name in session_order:
    row = sessions[name]
    for key, value in SESSION_DEFAULTS.items():
        row.setdefault(key, value)
    session_list.append(row)

PR_DEFAULTS = {
    "issue": None,
    "headRefName": None,
    "filesTruncated": False,
    "title": "",
    "files": [],
}

pr_list = []
for num in pr_order:
    row = prs[num]
    for key, value in PR_DEFAULTS.items():
        row.setdefault(key, value)
    row["fileCount"] = row.get("fileCount") or len(row["files"])
    pr_list.append(row)

# --- 重なりの判定 ---
items = []
for row in session_list:
    items.append(
        {
            "kind": "session",
            "label": row["name"],
            "repository": row["repository"],
            "issue": row["issue"],
            "files": set(row["files"]),
        }
    )
for row in pr_list:
    items.append(
        {
            "kind": "pr",
            "label": "#{}".format(row["number"]),
            "repository": repository,
            "issue": row["issue"],
            "files": set(row["files"]),
        }
    )

overlaps = []
for i in range(len(items)):
    for j in range(i + 1, len(items)):
        a, b = items[i], items[j]
        if not a["repository"] or a["repository"] != b["repository"]:
            continue
        if a["issue"] is not None and a["issue"] == b["issue"]:
            continue
        shared = sorted(a["files"] & b["files"])
        if not shared:
            continue
        overlaps.append(
            {
                "a": {k: a[k] for k in ("kind", "label", "repository", "issue")},
                "b": {k: b[k] for k in ("kind", "label", "repository", "issue")},
                "files": shared,
            }
        )

overlaps.sort(key=lambda o: (-len(o["files"]), o["a"]["label"], o["b"]["label"]))

json.dump(
    {
        "repository": repository,
        "base": base,
        "sessions": session_list,
        "pullRequests": pr_list,
        "overlaps": overlaps,
    },
    sys.stdout,
    ensure_ascii=False,
    indent=2,
)
print()
PY
  )"
  _fleet_status_run_python "$script"
}

# 正規化JSON（stdin）を人が読む表にする。
#
# **桁は文字数ではなく表示幅で揃える。** 見出しやタイトルに日本語が混ざり、全角は1文字で
# 2桁ぶんの幅を取る。`str.ljust` をそのまま使うと見出しの行だけ右へずれる。
fleet_status_render_table() {
  local script
  script="$(
    cat <<'PY'
import json
import sys
import unicodedata

OVERLAP_FILE_LIMIT = 10


def width(text):
    """端末上の表示幅（全角は2桁）"""
    return sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in text)


def pad(text, target):
    return text + " " * max(0, target - width(text))

try:
    data = json.load(sys.stdin)
except Exception:
    print("並行状況を組み立てられませんでした。")
    raise SystemExit(0)

base = data.get("base") or {}
sessions = data.get("sessions") or []
prs = data.get("pullRequests") or []
overlaps = data.get("overlaps") or []
repository = data.get("repository") or "(不明)"
branch = base.get("branch") or "?"

out = ["リポジトリ: " + repository]
if base.get("sha"):
    tip = "{} {}".format(base["sha"][:7], base.get("subject") or "").strip()
else:
    tip = "（取得できませんでした）"
out.append("{} の先端: {}".format(branch, tip))
out.append("")


def dash(value):
    return "-" if value in (None, "") else str(value)


def render(rows, fixed_columns):
    """先頭 fixed_columns 列だけ幅を揃え、残りはそのまま後ろへ繋ぐ"""
    widths = [max(width(row[i]) for row in rows) for i in range(fixed_columns)]
    lines = []
    for row in rows:
        cells = [pad(row[i], widths[i]) for i in range(fixed_columns)]
        cells.extend(row[fixed_columns:])
        lines.append("  " + " ".join(cells).rstrip())
    return lines


out.append("## 走っているセッション（{}件）".format(len(sessions)))
if not sessions:
    out.append("  （走っているセッションはありません）")
else:
    rows = [["", "セッション", "Issue", "ブランチ", "分岐元", "遅れ", "変更", ""]]
    for s in sessions:
        # **別リポジトリのセッションは変更ファイルを集めていない**（パスが偶然一致しても
        # 衝突しないため）。集めた結果が0件なのと区別が付くよう、数ではなく `-` を出す
        other_repo = bool(s.get("repository")) and s.get("repository") != repository
        if other_repo:
            note = "（別リポジトリ）"
        elif not s.get("worktree"):
            note = "（worktree不明）"
        else:
            note = ""
        counted = bool(s.get("worktree")) and not other_repo
        rows.append(
            [
                "*" if s.get("self") else "",
                s.get("name") or "?",
                "#{}".format(s["issue"]) if s.get("issue") else "-",
                dash(s.get("branch")),
                (s.get("baseSha") or "")[:7] or "-",
                dash(s.get("behind")),
                str(len(s.get("files") or [])) if counted else "-",
                note,
            ]
        )
    out.extend(render(rows, 7))
out.append("")

out.append("## 未マージPR → {}（{}件）".format(branch, len(prs)))
if not prs:
    out.append("  （未マージのPRはありません）")
else:
    rows = []
    for pr in prs:
        count = "{}ファイル".format(pr.get("fileCount") or 0)
        if pr.get("filesTruncated"):
            count += "以上"
        rows.append(
            [
                "#{}".format(pr["number"]),
                "#{}".format(pr["issue"]) if pr.get("issue") else "-",
                pr.get("headRefName") or "-",
                count,
                pr.get("title") or "",
            ]
        )
    out.extend(render(rows, 4))
out.append("")

out.append("## 重なりうる組（{}件）".format(len(overlaps)))
if not overlaps:
    out.append("  （同じファイルを触っている組はありません）")
else:
    for o in overlaps:
        files = o.get("files") or []
        out.append(
            "  {} × {}（{}ファイル）".format(o["a"]["label"], o["b"]["label"], len(files))
        )
        for path in files[:OVERLAP_FILE_LIMIT]:
            out.append("    " + path)
        if len(files) > OVERLAP_FILE_LIMIT:
            out.append("    …他{}件".format(len(files) - OVERLAP_FILE_LIMIT))

print("\n".join(out))
PY
  )"
  _fleet_status_run_python "$script"
}
