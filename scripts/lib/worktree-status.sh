#!/usr/bin/env bash
# Issue専用worktreeの状態判定（マージ済みか・消してよいか）を共有する（#1100）。
#
# scripts/start-issue.sh（再開時の警告・作り直し）と scripts/cleanup-worktrees.sh（掃除）の
# 両方から source する。「消しても失われないか」の判定は、片方だけを緩めるとその側が単独で
# 事故になるため1か所に置く。
#
# **リポジトリ名とマージ先のブランチは引数で受ける**（#2123）。掃除はissue-deck専用ではなく、
# 汎用ランチャー（scripts/generic-start-issue.sh）で起こした他リポジトリのworktreeも見るため、
# `guchi-apps/issue-deck` と `origin/develop` を決め打ちにできない。省略したときの既定だけを
# issue-deck に寄せてあり、start-issue.sh は従来どおり引数なしで呼べる。
#
# このファイル自体は実行せず、source して使う。

ISSUE_DECK_REPO="${ISSUE_DECK_REPO:-guchi-apps/issue-deck}"

# gh の1回の呼び出しに被せる制限時間（秒）。ネットワークが片側だけ切れたときなど、`gh`は
# 応答を待ったまま戻らないことがあり、呼び出し側には「終わらない」としか見えない（#1680）。
# マージ済みPRの番号は表示にしか使わないため、待ち続けるより諦めた方がよい。
ISSUE_DECK_GH_TIMEOUT="${ISSUE_DECK_GH_TIMEOUT:-60}"

# `timeout` があれば被せて実行する。無い環境ではそのまま実行する。
worktree_gh_run() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$ISSUE_DECK_GH_TIMEOUT" "$@"
  else
    "$@"
  fi
}

# ブランチ issue-<番号> をheadとするマージ済みPRの番号を出力する（無ければ何も出力しない）。
# gh の失敗（ネットワーク断・未認証・応答なし）も「マージ済みPRなし」として扱う。
#
# **これは「消してよいか」の判定には使わない**（#1192）。消して失われるものが無いことは
# worktree_dirty_count と worktree_commits_not_in_base だけで決まり、PRの有無はそこへ
# 何も足さない。start-issue.sh は「マージ済みのブランチで再開していないか」の警告に、
# cleanup-worktrees.sh は削除理由の表示に使う。
#
# **worktreeの数だけ繰り返し呼ばないこと**（#1680）。1件あたり0.5秒前後のAPI往復があり、
# 100件を超えると走査だけで数分かかる。まとめて引くときは worktree_merged_pr_map を使う。
worktree_merged_pr() {
  local n="$1" repo="${2:-$ISSUE_DECK_REPO}"
  worktree_gh_run gh pr list --repo "$repo" --head "issue-$n" --state merged \
    --json number --jq '.[0].number // empty' 2>/dev/null || true
}

# マージ済みPRの「ブランチ名 → PR番号」を**1回のAPI呼び出しで**まとめて出力する（#1680）。
# 出力は `issue-123<TAB>456` 形式の行で、head が `issue-` で始まるPRだけを含む。
# gh の失敗は空出力（＝マージ済みPRなし）として扱う。
#
# $1 に対象リポジトリ（省略時はissue-deck）、$2 に取得件数の上限（既定1000）を渡せる。
# 上限を超えて古いPRは落ちるが、番号は表示にしか使わないため、落ちたものは「マージ先に
# 未反映のコミットが0件」という一般的な理由で表示される。
worktree_merged_pr_map() {
  local repo="${1:-$ISSUE_DECK_REPO}" limit="${2:-1000}"
  worktree_gh_run gh pr list --repo "$repo" --state merged --limit "$limit" \
    --json number,headRefName \
    --jq '.[] | select(.headRefName | startswith("issue-")) | "\(.headRefName)\t\(.number)"' \
    2>/dev/null || true
}

# 未コミットの変更の件数を出力する（追跡対象の変更＋未追跡ファイル。`.gitignore`対象の
# node_modules・.env.local は含まれない）。
worktree_dirty_count() {
  local dir="$1"
  git -C "$dir" status --porcelain | wc -l
}

# ブランチのコミットがすべて origin/develop に入っているか（＝worktreeを消しても失われないか）。
# 呼ぶ前に origin/develop を最新化しておくこと。古いままだと「入っていない」と判定され、
# 削除しない側（安全側）に倒れる。
worktree_branch_in_develop() {
  local root="$1" branch="$2"
  git -C "$root" merge-base --is-ancestor "$branch" "origin/develop" 2>/dev/null
}

# そのリポジトリで「作業のマージ先」になりうるremote-trackingのrefを列挙する（#2123）。
#
# **マージ先は掃除する側からは1つに決められない。** issue-deckは`develop`だが、`develop`を
# 持たないリポジトリ（guchi-apps/docs・claude-config）は`main`へ直接マージし、`subpc`・`vps`は
# GitHubの既定ブランチが`main`である一方でPRの宛先は`develop`になる。**ここで挙げたrefの
# どれか1つにでも入っていれば、そのコミットは公開済みで、worktreeを消しても失われない。**
#
# 実在するものだけを、確からしい順（develop → main → master）で出力する。1つも無ければ1を返す
# （fetchできたことのないclone。呼び出し側は「判定不能」として消さない側へ倒すこと）。
worktree_base_refs() {
  local root="$1" ref found=0
  for ref in origin/develop origin/main origin/master; do
    if git -C "$root" rev-parse --verify --quiet "refs/remotes/$ref" >/dev/null 2>&1; then
      printf '%s\n' "$ref"
      found=1
    fi
  done
  [[ "$found" -eq 1 ]]
}

# 基準ref（第3引数以降）のどれにも入っていないコミットの最小件数を出力する（#2123）。
# 0 なら worktree を消しても失われるコミットは無い。**worktreeを作っただけで1コミットもして
# いない場合もここは0になる**（#1192）。
#
# 複数のrefのうち**最も少ない件数**を採る。`develop`と`main`の両方がある場合、どちらか一方に
# 入っていれば公開済みだからで、両方に入っていることまでは要求しない。
#
# 判定できなかった場合（基準refが無い・ブランチが無い等）は**何も出力しない**。呼び出し側は
# 空を「判定不能」として残す側（安全側）へ倒すこと。0を返すと消す側へ倒れてしまう。
worktree_commits_not_in_base() {
  local root="$1" branch="$2"
  shift 2
  local ref count best=""
  for ref in "$@"; do
    count="$(git -C "$root" rev-list --count "$ref..$branch" 2>/dev/null || true)"
    [[ "$count" =~ ^(0|[1-9][0-9]*)$ ]] || continue
    if [[ -z "$best" || "$count" -lt "$best" ]]; then
      best="$count"
    fi
  done
  printf '%s' "$best"
}

# origin/develop に入っていないコミットの件数を出力する（＝worktreeを消すと失われるコミットの数）。
# worktree_commits_not_in_base を origin/develop 固定で呼ぶだけの薄い包み。
#
# worktree_branch_in_develop と同じことを件数で見ている。件数は「何件失われるか」を表示に
# 使えるぶん掃除側に向く。
worktree_commits_not_in_develop() {
  local root="$1" branch="$2"
  worktree_commits_not_in_base "$root" "$branch" origin/develop
}

# そのworktreeで最後に「起動の準備」が行われてからの経過分数を出力する（#1716）。
#
# **無人で掃除を回すために要る**（#1716）。掃除の判定はどれも「いま何かが動いているか」を
# 見ておらず、`start-issue.sh`がworktreeを作ってから`run-issue-session.sh`のプロセスが立つまでの
# 数分間は、未コミットの変更もdevelopに未反映のコミットも無い（`pnpm install`が置くのは
# `.gitignore`対象のファイルだけ）。人が手で打っていた頃はその瞬間に実行される確率が低かったが、
# 定期実行では毎時ぶつかりに行くことになり、**準備中のworktreeをブランチごと消しうる**。
#
# 見るのは次の3つのうち最も新しいmtimeで、そこからの経過分数を返す。
#
#   - worktreeのディレクトリ（作成時刻。`stat`のbirth timeが取れればそちら）
#   - `.env.local`（`start-issue.sh`が**起動のたびに**`PORT`を書き直す。作り直しでも再開でも通る）
#   - 起動用プロンプト（`.prompts/issue-<番号>.md`。準備の最後に生成される）
#
# **`.next`やログのmtimeは見ない。** あちらは開発サーバーが動いている間ずっと更新されるため、
# 「準備中かどうか」ではなく「使われているかどうか」になってしまう（それは
# worktree_session_running の担当）。
#
# 取れなければ何も出力しない。呼び出し側は空を「判定不能」として**消さない側**へ倒すこと。
worktree_prepared_minutes() {
  local dir="$1" prompt_file="${2:-}" now newest=0 ts f
  now="$(date +%s)"

  # ディレクトリはbirth timeを優先する。ext4では取れるが、取れない場合は0が返るためmtimeへ落とす。
  ts="$(stat -c %W "$dir" 2>/dev/null || echo 0)"
  [[ "$ts" =~ ^[1-9][0-9]*$ ]] || ts="$(stat -c %Y "$dir" 2>/dev/null || echo 0)"
  [[ "$ts" =~ ^[1-9][0-9]*$ ]] && newest="$ts"

  for f in "$dir/.env.local" "$prompt_file"; do
    [[ -n "$f" && -e "$f" ]] || continue
    ts="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
    [[ "$ts" =~ ^[1-9][0-9]*$ ]] || continue
    ((ts > newest)) && newest="$ts"
  done

  [[ "$newest" -gt 0 ]] || return 0
  local elapsed=$(((now - newest) / 60))
  ((elapsed < 0)) && elapsed=0
  printf '%s' "$elapsed"
}

# そのIssueのセッション（run-issue-session.sh）または開発サーバーが動いているか。
worktree_session_running() {
  local n="$1" worktree_base="$2"
  local pid_file="$worktree_base/.dev-servers/issue-$n.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  # `run-issue-session.sh <番号> <ポート> ...` という起動の仕方に一致するものだけを見る。
  # Claude Codeのプロセスはプロンプト全文（Issue本文を含む）をコマンドラインに持つため、
  # 単に "run-issue-session" で引っ掛けるとIssue本文中の言及にまで一致してしまう。
  pgrep -f "run-issue-session\.sh $n " >/dev/null 2>&1
}
