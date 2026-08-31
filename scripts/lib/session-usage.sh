#!/usr/bin/env bash
# ローカルセッションのトークン使用量を集計する処理（#2350）。
#
# 入口は `scripts/session-usage.sh` と、そこを呼ぶ `scripts/inspect-session.sh` の1行表示。
# このファイル自体は実行せず、source して使う。
#
# ## なぜ要るか
#
# **消費の9割が計測されていない**（`guchi-apps/question#34` の調査）。無人実行は #903 が
# Job Summaryへ出し、サブスクの消費率は ops-dashboard が出すが、**ローカルセッションだけ
# 「どのIssueがいくら使ったか」がどこにも出ない**。直近21日でOpus 5のAPI換算 約$6,556、
# 全体の約93%がここに集中している。効果を測れないまま削減策を入れても、安くなったのか
# 単に手を抜くようになったのかを区別できない。
#
# ## 作法
#
# **これは計器であって役ではない**（[docs/multi-agent/gates.md](../../docs/multi-agent/gates.md)）。
# LLMを使わず決定的に集計し、判断はしない。「使いすぎ」「やめろ」は言わず、事実（応答数・
# トークン・API換算）だけを出す。常駐せず、人が叩いたときに1回読んで終わる。
#
# **読むのは`message.usage`と時刻・作業ディレクトリだけで、やり取りの中身は読まない。**
# 例外は計画レビュー・横断質問セッションのIssue番号で、これは転記の最初のユーザー発言に
# しか出てこない（`Issue #<番号>`の1箇所だけを正規表現で拾う）。**出力に本文は載せない。**
#
# **`fleet-status.sh`の相棒だが、こちらは外部の状態（転記ファイル）を読む。**
# あちらのlibが純粋関数だけを持つのに対し、ここは`session_usage_aggregate`がファイルを開く。
# 代わりに**入力は「転記のパスの一覧」（stdin）だけ**にしてあり、fixtureのディレクトリを
# 食わせればそのまま検証できる（`src/lib/session-usage.test.ts`）。
#
# **Claude Codeの内部仕様に依存している。** 転記の置き場所・JSONLの形・`message.usage`の
# フィールド名はいずれも公開仕様ではない。したがって**壊れたら黙って諦める**側へ倒し、
# 読めない行・パースできないファイルは黙って捨てる（`scripts/lib/session-transcript.sh`と
# 同じ扱い）。
#
# ## 集計の注意点（#2350の本題）
#
# **`message.usage`は同じ`message.id`を持つ全content行に重複して書かれる。**
# `message.id`で重複除去しないと、応答数もトークンも水増しされる（`question#34`の調査は
# 最初これを踏んで金額を約2.5倍に見積もった）。重複した行数は`totals.duplicateRows`へ
# 出しているので、除去が効いていることを出力から確かめられる。
#
# **キャッシュ書き込みの単価はTTLで違う**（5分で入力の1.25倍、1時間で2.0倍）。
# 転記は`usage.cache_creation.ephemeral_5m_input_tokens` /`ephemeral_1h_input_tokens`で
# 内訳を持っているので、それを使う。内訳が無いときだけ`cache_creation_input_tokens`を
# 全て5分ぶんとして扱う。ローカルセッションは1時間TTLが支配的なため、ここを一律1.25倍に
# すると2割ほど低く出る。

# python3のスクリプトをヒアドキュメントで組み立ててから `-c` へ渡す。
# `python3 - <<'PY'` の形にすると標準入力がスクリプトに奪われ、パイプで渡した本体を読めない
# （`scripts/lib/fleet-status.sh` と同じ理由）。
_session_usage_run_python() {
  local script="$1"
  shift
  python3 -c "$script" "$@"
}

# 転記の一覧を出す。第1引数は転記の置き場、第2引数は最終更新のしきい値（epoch秒。0で無制限）。
#
# **ここでの絞り込みは粗い前段でしかない。** ファイルの最終更新が新しくても中身は古い行を
# 含むため、期間の判定は`session_usage_aggregate`が各行の`timestamp`で行う。逆に、最終更新が
# しきい値より古いファイルは新しい行を持ちえないので、ここで落としてよい。
#
# **`*/*.jsonl` のグロブではなく `find` で列挙する。** 転記は1000ファイル近くあり、
# 展開した全パスを1コマンドの引数へ渡す形は、増え続けるといつか黙って壊れる。
# 深さを2に固定しているのは、転記が `<置き場>/<スラッグ>/<sessionId>.jsonl` の1階層だけに
# 置かれるため（その下の `tool-results/` にはツールの出力が入っており、集計の対象ではない）。
session_usage_transcripts() {
  local dir="$1" cutoff="${2:-0}"
  [[ -d "$dir" ]] || return 0
  find "$dir" -mindepth 2 -maxdepth 2 -name '*.jsonl' -printf '%T@\t%p\n' 2>/dev/null |
    awk -F'\t' -v cutoff="$cutoff" '$1 >= cutoff' |
    sort -n |
    cut -f2-
}

# Codex CLIの転記は年/月/日の3階層にある。Claude用とは置き場も深さも違うため入口を分ける。
codex_session_usage_transcripts() {
  local dir="$1" cutoff="${2:-0}"
  [[ -d "$dir" ]] || return 0
  find "$dir" -mindepth 4 -maxdepth 4 -name '*.jsonl' -printf '%T@\t%p\n' 2>/dev/null |
    awk -F'\t' -v cutoff="$cutoff" '$1 >= cutoff' |
    sort -n |
    cut -f2-
}

# 転記のパスの一覧（stdin）を正規化JSONへ畳む。
#
#   session_usage_aggregate [しきい値(epoch秒)] [Issue番号] [リポジトリ名]
#
# 第1引数は集計に含める最古の時刻（0で無制限）、第2・第3引数は絞り込み（空で全件）。
#
# **入力の順序には意味がある。** 同じ`message.id`が複数の転記に現れることがある
# （セッションを枝分かれさせると、それまでのやり取りごと新しいファイルへ写される）ため、
# **先に現れたほうへ計上して後は捨てる**。`session_usage_transcripts`が最終更新の古い順で
# 出すので、写しではなく元のセッションへ付く。
session_usage_aggregate() {
  local script
  script="$(
    cat <<'PY'
import json
import os
import re
import sys
from datetime import datetime, timezone

# 1Mトークンあたりの単価（USD）。claude-apiスキルの料金表（2026-08時点）。
# **サブスクの実費ではなく、規模を掴むためのAPI換算の目安**であることを表示側で断る。
PRICES = {
    "claude-fable-5": (10.0, 50.0),
    "claude-mythos-5": (10.0, 50.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-sonnet-4-5": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

# キャッシュの倍率。書き込みはTTLで違い（5分1.25倍・1時間2.0倍）、読み出しは0.1倍。
CACHE_WRITE_5M = 1.25
CACHE_WRITE_1H = 2.0
CACHE_READ = 0.1

# 作業ディレクトリ → セッションの種別。**転記の中身ではなくパスで決める**。
WORKTREE = re.compile(r"/(?P<repo>[^/]+)-worktrees/issue-(?P<issue>[1-9][0-9]*)$")
PLAN_REVIEW = re.compile(r"/\.plan-reviews/_refs/(?P<target>[^/]+)$")
QUESTION_NUMBERED = re.compile(r"/\.questions/question-(?P<issue>[1-9][0-9]*)$")
QUESTION_SESSION = re.compile(r"/\.questions/_session-(?P<target>[^/]+)$")
QUESTION_REFS = re.compile(r"/\.questions/_refs/(?P<target>[^/]+)$")
# 計画レビュー・横断質問の作業場は`<owner>-<repo>`の1階層で、機械的にはownerとrepoを割れない。
# このフリートのownerは1つなので、その前置きだけを落として実装セッションと同じ名前へ揃える
# （`scripts/fleet-status.sh`が`guchi-apps/issue-deck`を既定値に持っているのと同じ前提）。
OWNER_PREFIX = "guchi-apps-"
# 計画レビュー・横断質問はパスにIssue番号を持たない（対象リポジトリごとの作業場を使い回す）。
# 番号は起動プロンプトの冒頭にしか出てこないので、そこだけを見る。
ISSUE_IN_PROMPT = re.compile(r"Issue #([1-9][0-9]*)")
# 種別の解決に使う行は転記の先頭に固まっている。全行を舐めないための上限。
META_SCAN_LINES = 200

KIND_LABELS = {
    "implementation": "実装",
    "plan-review": "計画レビュー",
    "question": "横断質問",
    "other": "その他",
}


def arg(index):
    return sys.argv[index] if len(sys.argv) > index else ""


def as_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


CUTOFF = as_int(arg(1), 0)
ISSUE_FILTER = as_int(arg(2), 0)
REPO_FILTER = arg(3)


def price_for(model):
    """モデルID → (入力単価, 出力単価)。日付サフィックス付きは前方一致で拾う"""
    if not model:
        return None
    if model in PRICES:
        return PRICES[model]
    best = None
    for known, price in PRICES.items():
        if model.startswith(known) and (best is None or len(known) > len(best[0])):
            best = (known, price)
    return best[1] if best else None


def strip_owner(target):
    return target[len(OWNER_PREFIX):] if target.startswith(OWNER_PREFIX) else target


def classify(cwd):
    """作業ディレクトリ → (種別, 対象リポジトリ, Issue番号)"""
    if not cwd:
        return ("other", None, None)
    matched = WORKTREE.search(cwd)
    if matched:
        return ("implementation", matched.group("repo"), int(matched.group("issue")))
    matched = PLAN_REVIEW.search(cwd)
    if matched:
        return ("plan-review", strip_owner(matched.group("target")), None)
    matched = QUESTION_NUMBERED.search(cwd)
    if matched:
        return ("question", "question", int(matched.group("issue")))
    for pattern in (QUESTION_SESSION, QUESTION_REFS):
        matched = pattern.search(cwd)
        if matched:
            return ("question", strip_owner(matched.group("target")), None)
    return ("other", os.path.basename(cwd) or None, None)


def first_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                return block.get("text") or ""
    return ""


def local_date(stamp):
    """ISO8601（UTC）→ ローカルの日付。人は手元の日付で見るため、UTCのままにしない"""
    try:
        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None, None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(), parsed.timestamp()


def blank_bucket():
    return {
        "responses": 0,
        "input": 0,
        "cacheCreate5m": 0,
        "cacheCreate1h": 0,
        "cacheRead": 0,
        "output": 0,
        "costUsd": 0.0,
        # 入力側（素の入力＋キャッシュ書き込み＋キャッシュ読み出し）と出力側の内訳（#2626）。
        # **表示側でトークン比から按分し直さないために、単価を持っているここで割っておく。**
        # キャッシュ読み出しは入力単価の0.1倍なので、トークン比で割ると出力側が桁で過小に出る。
        "inputCostUsd": 0.0,
        "outputCostUsd": 0.0,
    }


def add(bucket, delta):
    for key in ("responses", "input", "cacheCreate5m", "cacheCreate1h", "cacheRead", "output"):
        bucket[key] += delta[key]
    for key in ("costUsd", "inputCostUsd", "outputCostUsd"):
        bucket[key] += delta[key]


def finish(bucket):
    context = bucket["input"] + bucket["cacheCreate5m"] + bucket["cacheCreate1h"] + bucket["cacheRead"]
    bucket["cacheCreate"] = bucket["cacheCreate5m"] + bucket["cacheCreate1h"]
    bucket["contextTokens"] = context
    bucket["avgContext"] = round(context / bucket["responses"]) if bucket["responses"] else 0
    bucket["costUsd"] = round(bucket["costUsd"], 4)
    bucket["inputCostUsd"] = round(bucket["inputCostUsd"], 4)
    bucket["outputCostUsd"] = round(bucket["outputCostUsd"], 4)
    return bucket


seen_message_ids = set()
sessions = []
by_day = {}
by_model = {}
unknown_models = set()
totals = blank_bucket()
duplicate_rows = 0
read_files = 0
unreadable_files = 0

for raw_path in sys.stdin:
    path = raw_path.strip()
    if not path:
        continue

    cwd = None
    prompt_issue = None
    meta_lines = 0
    bucket = blank_bucket()
    models = set()
    first_at = None
    last_at = None
    # 計画（Plan mode）と実装の境界（#2646）。**最後の`ExitPlanMode`呼び出しの時刻**を境に、
    # それ以前を「計画」、以降を「実装」とする。計画の修正で複数回呼ばれても、最後の1回だけを
    # 境に使う（それより前の往復はやり取りごと「計画」に含める）。1度も呼ばれていなければ
    # `None`のままで、画面は「区分なし」として扱う。
    plan_exit_ts = None
    responses_log = []

    try:
        handle = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        unreadable_files += 1
        continue

    with handle:
        read_files += 1
        for line in handle:
            # 転記の行の大半はツールのやり取りで、usageを持たない。
            # **JSONへ起こす前に文字列で振るう**（863MBを舐めるため、ここが効く）。
            if '"usage"' not in line:
                if cwd is not None and prompt_issue is not None:
                    continue
                if meta_lines >= META_SCAN_LINES:
                    continue
                meta_lines += 1
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if cwd is None and isinstance(record.get("cwd"), str):
                    cwd = record["cwd"]
                if prompt_issue is None and record.get("type") == "user":
                    message = record.get("message")
                    if isinstance(message, dict):
                        found = ISSUE_IN_PROMPT.search(first_text(message.get("content")))
                        if found:
                            prompt_issue = int(found.group(1))
                continue

            try:
                record = json.loads(line)
            except ValueError:
                continue
            if cwd is None and isinstance(record.get("cwd"), str):
                cwd = record["cwd"]
            message = record.get("message")
            if not isinstance(message, dict):
                continue
            usage = message.get("usage")
            if not isinstance(usage, dict):
                continue

            # `ExitPlanMode`のtool_use呼び出し（#2646）。重複行でも同じ内容なので、
            # dedupより前で見ておく。
            if record.get("type") == "assistant":
                content = message.get("content")
                if isinstance(content, list):
                    for block in content:
                        if (
                            isinstance(block, dict)
                            and block.get("type") == "tool_use"
                            and block.get("name") == "ExitPlanMode"
                        ):
                            ts = record.get("timestamp")
                            if isinstance(ts, str) and (plan_exit_ts is None or ts > plan_exit_ts):
                                plan_exit_ts = ts

            # **同じ`message.id`は同じ応答の重複行**。最初の1行だけを数える。
            message_id = message.get("id")
            if isinstance(message_id, str) and message_id:
                if message_id in seen_message_ids:
                    duplicate_rows += 1
                    continue
                seen_message_ids.add(message_id)

            stamp = record.get("timestamp")
            local, epoch = local_date(stamp) if isinstance(stamp, str) else (None, None)
            if CUTOFF and (epoch is None or epoch < CUTOFF):
                continue

            model = message.get("model") or ""
            price = price_for(model)
            # `<synthetic>`はClaude Codeが自分で差し込む行で、APIの課金対象ではない。
            if price is None and not model.startswith("<"):
                unknown_models.add(model or "(不明)")

            creation = usage.get("cache_creation")
            if isinstance(creation, dict):
                create_5m = as_int(creation.get("ephemeral_5m_input_tokens"))
                create_1h = as_int(creation.get("ephemeral_1h_input_tokens"))
            else:
                # 内訳が無い転記では全て5分TTL（安いほう）として扱う。低く出るほうへ倒す。
                create_5m = as_int(usage.get("cache_creation_input_tokens"))
                create_1h = 0

            delta = {
                "responses": 1,
                "input": as_int(usage.get("input_tokens")),
                "cacheCreate5m": create_5m,
                "cacheCreate1h": create_1h,
                "cacheRead": as_int(usage.get("cache_read_input_tokens")),
                "output": as_int(usage.get("output_tokens")),
                "costUsd": 0.0,
                "inputCostUsd": 0.0,
                "outputCostUsd": 0.0,
            }
            if price:
                in_price, out_price = price
                delta["inputCostUsd"] = (
                    delta["input"] * in_price
                    + delta["cacheCreate5m"] * in_price * CACHE_WRITE_5M
                    + delta["cacheCreate1h"] * in_price * CACHE_WRITE_1H
                    + delta["cacheRead"] * in_price * CACHE_READ
                ) / 1_000_000
                delta["outputCostUsd"] = delta["output"] * out_price / 1_000_000
                delta["costUsd"] = delta["inputCostUsd"] + delta["outputCostUsd"]

            add(bucket, delta)
            responses_log.append((stamp, delta))
            if model:
                models.add(model)
            if local is not None:
                key = local.strftime("%Y-%m-%d")
                add(by_day.setdefault(key, blank_bucket()), delta)
            model_key = model or "(不明)"
            add(by_model.setdefault(model_key, blank_bucket()), delta)
            if stamp:
                if first_at is None or stamp < first_at:
                    first_at = stamp
                if last_at is None or stamp > last_at:
                    last_at = stamp

    if not bucket["responses"]:
        continue

    # 計画/実装のコスト内訳（#2646）。`ExitPlanMode`が1度も無ければ区分不明としてnullのまま
    # 出す（画面は「区分なし」として合算のみを見せる）。
    if plan_exit_ts is not None:
        plan_bucket = blank_bucket()
        implementation_bucket = blank_bucket()
        for response_stamp, response_delta in responses_log:
            target = (
                plan_bucket
                if isinstance(response_stamp, str) and response_stamp <= plan_exit_ts
                else implementation_bucket
            )
            add(target, response_delta)
        plan_cost_usd = round(plan_bucket["costUsd"], 4)
        implementation_cost_usd = round(implementation_bucket["costUsd"], 4)
    else:
        plan_cost_usd = None
        implementation_cost_usd = None

    kind, repository, issue = classify(cwd)
    if issue is None:
        issue = prompt_issue
    if ISSUE_FILTER and issue != ISSUE_FILTER:
        continue
    if REPO_FILTER and repository != REPO_FILTER:
        # 計画レビュー・横断質問の作業場は`<owner>-<repo>`の形なので、末尾でも突き合わせる。
        if not (repository or "").endswith("-" + REPO_FILTER):
            continue

    add(totals, bucket)
    sessions.append(
        dict(
            finish(bucket),
            kind=kind,
            kindLabel=KIND_LABELS.get(kind, kind),
            repository=repository,
            issue=issue,
            cwd=cwd,
            transcript=path,
            models=sorted(models),
            firstAt=first_at,
            lastAt=last_at,
            planCostUsd=plan_cost_usd,
            implementationCostUsd=implementation_cost_usd,
        )
    )

sessions.sort(key=lambda row: (-row["costUsd"], row["transcript"]))
totals = finish(totals)
totals["sessions"] = len(sessions)
totals["duplicateRows"] = duplicate_rows
totals["transcripts"] = read_files
totals["unreadableTranscripts"] = unreadable_files

json.dump(
    {
        "sinceEpoch": CUTOFF or None,
        "filter": {"issue": ISSUE_FILTER or None, "repository": REPO_FILTER or None},
        "totals": totals,
        "sessions": sessions,
        "byDay": [dict(finish(v), date=k) for k, v in sorted(by_day.items())],
        "byModel": [dict(finish(v), model=k) for k, v in sorted(by_model.items())],
        "unknownModels": sorted(unknown_models),
    },
    sys.stdout,
    ensure_ascii=False,
    indent=2,
)
print()
PY
  )"
  _session_usage_run_python "$script" "${1:-0}" "${2:-}" "${3:-}"
}

# Codex CLIの転記をClaude側と同じ正規化JSONへ畳む。
# token_countは累積値なので、セッション内の最後の値だけを使う。
codex_session_usage_aggregate() {
  local script
  script="$(cat <<'PY'
import json, os, re, sys
PRICES={"gpt-5.6-sol":(4,.4,20),"gpt-5.6":(4,.4,20),"gpt-5.6-terra":(2,.2,12),"gpt-5.6-luna":(.2,.02,1.2),"gpt-5.5":(5,.5,30),"gpt-5.4":(2.5,.25,15)}
WORKTREE=re.compile(r"/(?P<repo>[^/]+)-worktrees/issue-(?P<issue>[1-9][0-9]*)$")
LABELS={"implementation":"実装","plan-review":"計画レビュー","question":"横断質問","other":"その他"}
def number(value):
    try:return max(0,int(value))
    except (TypeError,ValueError):return 0
def classify(cwd):
    matched=WORKTREE.search(cwd or "")
    if matched:return "implementation",matched.group("repo"),int(matched.group("issue"))
    if "/.plan-reviews/" in (cwd or ""):return "plan-review",os.path.basename(cwd).removeprefix("guchi-apps-"),None
    if "/.questions/" in (cwd or ""):return "question",os.path.basename(cwd).removeprefix("guchi-apps-"),None
    return "other",os.path.basename(cwd or "") or None,None
def price_for(model):
    matches=[(key,value) for key,value in PRICES.items() if model==key or model.startswith(key+"-")]
    return max(matches,key=lambda pair:len(pair[0]))[1] if matches else None
sessions=[];totals={"responses":0,"input":0,"cacheCreate5m":0,"cacheCreate1h":0,"cacheRead":0,"output":0,"costUsd":0.0,"inputCostUsd":0.0,"outputCostUsd":0.0};unknown=set();read_files=0;unreadable=0
for raw_path in sys.stdin:
    path=raw_path.strip()
    if not path:continue
    try:handle=open(path,encoding="utf-8",errors="replace")
    except OSError:unreadable+=1;continue
    read_files+=1;cwd=None;model="";first_at=None;last_at=None;latest=None;responses=0
    with handle:
        for line in handle:
            if '"token_count"' not in line and '"session_meta"' not in line and '"turn_context"' not in line:continue
            try:record=json.loads(line)
            except ValueError:continue
            payload=record.get("payload") or {};stamp=record.get("timestamp")
            if record.get("type")=="session_meta":cwd=payload.get("cwd") or cwd
            if record.get("type")=="turn_context":model=payload.get("model") or model;cwd=payload.get("cwd") or cwd
            if payload.get("type")=="token_count":
                usage=(payload.get("info") or {}).get("total_token_usage")
                if isinstance(usage,dict):latest=usage;responses+=1
            if stamp:first_at=stamp if first_at is None or stamp<first_at else first_at;last_at=stamp if last_at is None or stamp>last_at else last_at
    if not latest or not first_at or not last_at:continue
    total_input=number(latest.get("input_tokens"));cached=number(latest.get("cached_input_tokens"));created=number(latest.get("cache_write_input_tokens"));uncached=max(0,total_input-cached-created);output=number(latest.get("output_tokens"));price=price_for(model);in_cost=0.0;out_cost=0.0
    # 入力側・出力側の内訳も出す（#2626）。表示側でトークン比から按分し直させないため。
    if price:in_cost=(uncached*price[0]+cached*price[1]+created*price[0]*1.25)/1_000_000;out_cost=output*price[2]/1_000_000
    elif model:unknown.add(model)
    cost=in_cost+out_cost
    kind,repo,issue=classify(cwd);row={"responses":responses,"input":uncached,"cacheCreate5m":created,"cacheCreate1h":0,"cacheRead":cached,"output":output,"costUsd":round(cost,4),"inputCostUsd":round(in_cost,4),"outputCostUsd":round(out_cost,4),"contextTokens":total_input,"avgContext":round(total_input/responses),"kind":kind,"kindLabel":LABELS[kind],"repository":repo,"issue":issue,"cwd":cwd,"transcript":path,"models":[model] if model else [],"firstAt":first_at,"lastAt":last_at};sessions.append(row)
    for key in ("responses","input","cacheCreate5m","cacheCreate1h","cacheRead","output"):totals[key]+=row[key]
    totals["costUsd"]+=cost;totals["inputCostUsd"]+=in_cost;totals["outputCostUsd"]+=out_cost
sessions.sort(key=lambda row:(-row["costUsd"],row["transcript"]));totals.update({"costUsd":round(totals["costUsd"],4),"inputCostUsd":round(totals["inputCostUsd"],4),"outputCostUsd":round(totals["outputCostUsd"],4),"sessions":len(sessions),"transcripts":read_files,"unreadableTranscripts":unreadable,"duplicateRows":0})
json.dump({"totals":totals,"sessions":sessions,"byDay":[],"byModel":[],"unknownModels":sorted(unknown)},sys.stdout,ensure_ascii=False);print()
PY
)"
  _session_usage_run_python "$script"
}

# 正規化JSON（stdin）を人が読む表にする。
#
#   session_usage_render_table [まとめ方] [表示件数]
#
# まとめ方は `session`（既定）・`kind`・`repo`・`day`・`model`と、合計だけを1行で出す `oneline`
# （`scripts/inspect-session.sh`の見出し用）。**単位の畳み方を2か所に持たない**ためにここへ置く。
#
# **桁は文字数ではなく表示幅で揃える**（全角は2桁ぶんの幅を取るため。`fleet-status.sh`と同じ）。
session_usage_render_table() {
  local script
  script="$(
    cat <<'PY'
import json
import sys
import unicodedata

BY = sys.argv[1] if len(sys.argv) > 1 else "session"
try:
    LIMIT = int(sys.argv[2])
except (IndexError, ValueError):
    LIMIT = 20


def width(text):
    return sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in text)


def pad(text, target):
    return text + " " * max(0, target - width(text))


def tokens(value):
    """トークン数は桁が大きいので単位で畳む（7桁の数字を並べても読めない）"""
    value = value or 0
    if value >= 1_000_000_000:
        return "{:.1f}G".format(value / 1_000_000_000)
    if value >= 1_000_000:
        return "{:.1f}M".format(value / 1_000_000)
    if value >= 1_000:
        return "{:.0f}k".format(value / 1_000)
    return str(value)


def usd(value):
    value = value or 0.0
    if value >= 100:
        return "${:,.0f}".format(value)
    if value >= 1:
        return "${:.2f}".format(value)
    return "${:.3f}".format(value)


try:
    data = json.load(sys.stdin)
except Exception:
    print("使用量を集計できませんでした。")
    raise SystemExit(0)

totals = data.get("totals") or {}
sessions = data.get("sessions") or []

if BY == "oneline":
    if totals.get("responses"):
        print(
            "{}応答 / 出力 {} / キャッシュ読出 {} / API換算 {}".format(
                totals["responses"],
                tokens(totals.get("output")),
                tokens(totals.get("cacheRead")),
                usd(totals.get("costUsd")),
            )
        )
    raise SystemExit(0)


def session_label(row):
    repository = row.get("repository") or "?"
    issue = row.get("issue")
    return "{}#{}".format(repository, issue) if issue else repository


def group(rows, key_of, label_of):
    buckets = {}
    for row in rows:
        key = key_of(row)
        bucket = buckets.setdefault(
            key,
            {"label": label_of(row), "count": 0, "responses": 0, "output": 0, "cacheRead": 0, "contextTokens": 0, "costUsd": 0.0},
        )
        bucket["count"] += 1
        for field in ("responses", "output", "cacheRead", "contextTokens"):
            bucket[field] += row.get(field) or 0
        bucket["costUsd"] += row.get("costUsd") or 0.0
    return list(buckets.values())


if BY == "session":
    header = ["種別", "対象", "応答", "出力", "ｷｬｯｼｭ読出", "平均文脈", "API換算"]
    rows = [
        [
            row.get("kindLabel") or "?",
            session_label(row),
            str(row.get("responses") or 0),
            tokens(row.get("output")),
            tokens(row.get("cacheRead")),
            tokens(row.get("avgContext")),
            usd(row.get("costUsd")),
        ]
        for row in sessions
    ]
    caption = "セッション別（多い順）"
else:
    if BY == "kind":
        buckets = group(sessions, lambda r: r.get("kind"), lambda r: r.get("kindLabel") or "?")
        first = "種別"
    elif BY == "repo":
        buckets = group(sessions, lambda r: r.get("repository"), lambda r: r.get("repository") or "?")
        first = "リポジトリ"
    elif BY == "day":
        buckets = [
            {
                "label": row.get("date") or "?",
                "count": 0,
                "responses": row.get("responses") or 0,
                "output": row.get("output") or 0,
                "cacheRead": row.get("cacheRead") or 0,
                "contextTokens": row.get("contextTokens") or 0,
                "costUsd": row.get("costUsd") or 0.0,
            }
            for row in (data.get("byDay") or [])
        ]
        first = "日付"
    elif BY == "model":
        buckets = [
            {
                "label": row.get("model") or "?",
                "count": 0,
                "responses": row.get("responses") or 0,
                "output": row.get("output") or 0,
                "cacheRead": row.get("cacheRead") or 0,
                "contextTokens": row.get("contextTokens") or 0,
                "costUsd": row.get("costUsd") or 0.0,
            }
            for row in (data.get("byModel") or [])
        ]
        first = "モデル"
    else:
        print("不明なまとめ方です: {}".format(BY))
        raise SystemExit(0)

    # 日付だけは時系列で読むもので、多い順に並べ替えると意味が壊れる。
    if BY != "day":
        buckets.sort(key=lambda b: -b["costUsd"])
    header = [first, "セッション", "応答", "出力", "ｷｬｯｼｭ読出", "平均文脈", "API換算"]
    rows = [
        [
            bucket["label"],
            str(bucket["count"]) if bucket["count"] else "-",
            str(bucket["responses"]),
            tokens(bucket["output"]),
            tokens(bucket["cacheRead"]),
            tokens(round(bucket["contextTokens"] / bucket["responses"]) if bucket["responses"] else 0),
            usd(bucket["costUsd"]),
        ]
        for bucket in buckets
    ]
    caption = {"kind": "種別別", "repo": "リポジトリ別", "day": "日別", "model": "モデル別"}[BY]

out = []
hidden = 0
if LIMIT > 0 and len(rows) > LIMIT:
    hidden = len(rows) - LIMIT
    rows = rows[:LIMIT]

out.append("## {}（{}件）".format(caption, len(rows) + hidden))
if not rows:
    out.append("  （集計対象がありません）")
else:
    table = [header] + rows
    widths = [max(width(row[i]) for row in table) for i in range(len(header))]
    for row in table:
        out.append("  " + " ".join(pad(row[i], widths[i]) for i in range(len(header))).rstrip())
    if hidden:
        out.append("  …他{}件（--limit で増やせます）".format(hidden))

out.append("")
out.append(
    "合計: {}セッション / {}応答 / 出力 {} / キャッシュ読出 {} / API換算 {}".format(
        totals.get("sessions") or 0,
        totals.get("responses") or 0,
        tokens(totals.get("output")),
        tokens(totals.get("cacheRead")),
        usd(totals.get("costUsd")),
    )
)
out.append(
    "　（転記 {}件 / `message.id`で重複除去した行 {}件）".format(
        totals.get("transcripts") or 0, totals.get("duplicateRows") or 0
    )
)
unknown = data.get("unknownModels") or []
if unknown:
    out.append("　⚠ 単価表に無いモデルはAPI換算に含めていません: " + " / ".join(unknown))
out.append("")
out.append("※ API換算はサブスクの実費ではなく、規模を掴むための目安です。")

print("\n".join(out))
PY
  )"
  _session_usage_run_python "$script" "${1:-session}" "${2:-20}"
}

# 正規化JSON（stdin）を、issue-deckの受け口（`POST /api/dispatch/session-usage`）へ送る
# 本文に畳む。
#
#   session_usage_report_payload <ホスト名> [1本あたりの最大セッション数]
#
# **本文は1行1つのJSONとして出す**（NDJSON）。過去ぶんの埋め戻しでは1,000件を超えるため、
# 1回のPOSTへ全部載せるとVPS側で数十秒のupsertを1トランザクションで抱えることになる。
# 呼び出し側は行ごとに送る（受け口は「送られてきた行を上書きする」だけで、全件置換ではない）。
#
# **送るのは数値と分類だけ。** 転記のパスは手元で元ファイルを辿るために残すが、やり取りの
# 本文は集計の時点で読んでいない（このファイル冒頭の「作法」を参照）。
#
# **`sessionId`は転記のファイル名（Claude CodeのUUID）。** issue-deck側はこれとホスト名で
# 一意にして上書きするため、走っている最中のセッションを何度送っても二重に積まれない。
#
# **期間で絞るのは呼び出し側の仕事**（`session_usage_transcripts`のしきい値）で、ここでは
# 渡された行をそのまま畳む。**転記単位の集計は常にその転記の全期間ぶんにしておくこと**——
# `session_usage_aggregate`へしきい値を渡すと行の中身が「期間内だけ」になり、上書きした
# 時点でそれ以前の消費が消える。
session_usage_report_payload() {
  local script
  script="$(
    cat <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

HOST = sys.argv[1] if len(sys.argv) > 1 else ""
AGENT = sys.argv[3] if len(sys.argv) > 3 else "claude"
try:
    CHUNK = max(1, int(sys.argv[2]))
except (IndexError, ValueError):
    CHUNK = 200

data = json.load(sys.stdin)
sessions = []
for row in data.get("sessions") or []:
    transcript = row.get("transcript") or ""
    session_id = os.path.splitext(os.path.basename(transcript))[0]
    # 転記のパスからIDを取れないものは送らない（受け口が一意にできない）。
    if not session_id:
        continue
    # 時刻が1つも無いセッションは期間の絞り込みに載せられないので送らない。
    if not row.get("firstAt") or not row.get("lastAt"):
        continue
    sessions.append(
        {
            "sessionId": session_id,
            "agent": AGENT,
            "transcript": transcript,
            "kind": row.get("kind") or "other",
            "repository": row.get("repository"),
            "issue": row.get("issue"),
            "responses": row.get("responses") or 0,
            "input": row.get("input") or 0,
            "cacheCreate5m": row.get("cacheCreate5m") or 0,
            "cacheCreate1h": row.get("cacheCreate1h") or 0,
            "cacheRead": row.get("cacheRead") or 0,
            "output": row.get("output") or 0,
            "costUsd": row.get("costUsd") or 0.0,
            # 入力側・出力側の内訳（#2626）。**単価を知っているのはここだけ**なので、
            # 画面がトークン比で按分し直さずに済むよう金額のまま送る。
            "inputCostUsd": row.get("inputCostUsd"),
            "outputCostUsd": row.get("outputCostUsd"),
            # 計画/実装の内訳（#2646）。`ExitPlanMode`が無いセッション・Codexの行は無いので
            # `.get`はNoneのまま送る（画面は「区分なし」として扱う）。
            "planCostUsd": row.get("planCostUsd"),
            "implementationCostUsd": row.get("implementationCostUsd"),
            "models": row.get("models") or [],
            "startedAt": row.get("firstAt"),
            "endedAt": row.get("lastAt"),
        }
    )

reported_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
# 送るものが無くても1行は出す。呼び出し側が「呼んだのに何も起きなかった」と
# 「送る対象が無かった」を区別できるようにするため。
for start in range(0, max(len(sessions), 1), CHUNK):
    json.dump(
        {
            "host": HOST,
            "reportedAt": reported_at,
            "sessions": sessions[start:start + CHUNK],
        },
        sys.stdout,
        ensure_ascii=False,
    )
    print()
PY
  )"
  _session_usage_run_python "$script" "${1:-}" "${2:-200}" "${3:-claude}"
}
