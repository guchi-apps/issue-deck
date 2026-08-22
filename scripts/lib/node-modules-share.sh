#!/usr/bin/env bash
# worktreeの`node_modules`を本体チェックアウトとハードリンクで共有する（#2124）。
#
# `scripts/generic-start-issue.sh`（worktree作成時のシード）と
# `scripts/dedupe-node-modules.sh`（既存worktreeの回収）が共有する。
# **除外の判断を2か所に持たない**ためにここへ寄せている。片方だけが緩むと、そこが単独の穴になる。
#
# ## なぜ要るか
#
# pnpm・bunは`~/.local/share/pnpm/store`のようなグローバルストアからハードリンクを張るため、
# worktreeを増やしても実データは増えない（実測: dayspan 31本で2,830MB＝1本あたり91MB）。
# **npm・yarn(classic)にはこの共有が無く、worktreeごとに実体をコピーする**（実測:
# ops-dashboard 16本で8,566MB＝1本あたり571MB。`node_modules/next/package.json`のリンク数は1）。
# サブPCの`~/apps`配下の`node_modules`は合計51.3GBに達し、ルートFS 98GBの過半を占めていた。
#
# 本体チェックアウトの`node_modules`を`cp -al`で複製すれば、実データを増やさずに同じツリーを
# 用意できる。その後の`npm install`はロックファイルとの差分だけを入れ直すので、内容は
# 通常のインストールと変わらない（実測: car-care 941MB のシード0.6秒＋install 1.9秒、
# 実ディスク増分12MB。依存を1つ足したブランチでも正しく解決し、既存のリンクは保たれた）。

# 共有の対象にするパッケージマネージャ。pnpm・bunは自前のストアで共有済みなので何もしない
# （余計に触ると、ストアへのリンクを本体経由のリンクへ張り替えてしまう）。
node_modules_share_targets_pm() {
  case "${1:-}" in
    npm | yarn) return 0 ;;
    *) return 1 ;;
  esac
}

# 共有から外す`node_modules`直下のディレクトリ（先頭の`.`は含めない）。
#
# **ハードリンクを張った先へその場書き込みをするツールがあると、本体と他worktreeまで壊れる。**
# 実測で`prisma generate`は`node_modules/.prisma/client/`の`schema.prisma`・
# `query_engine_bg.wasm`・`query_engine_bg.js`を**inodeを保ったまま**書き換えた（同じディレクトリの
# `index.js`等はunlink+再作成でリンクが切れる）。スキーマを変えたブランチのworktreeで
# generateすると、本体チェックアウトの生成物がそのブランチの内容に化ける——しかも
# `node_modules`は`.gitignore`対象なので、gitのどこにも差分として出ない。
#
# ここに挙げるのはいずれもインストール・初回利用で作り直せるキャッシュ・生成物なので、
# 共有せずに捨てる。数MB〜数十MBなので、捨てても効果はほとんど落ちない。
NODE_MODULES_SHARE_EXCLUDES=(prisma cache vite)

# hardlink(1) の `--exclude` へ渡す正規表現（パス全体に対して照合される）。
node_modules_share_exclude_regex() {
  local IFS='|'
  printf '%s\n' "/node_modules/\\.(${NODE_MODULES_SHARE_EXCLUDES[*]})/"
}

# 共有から外すディレクトリを消す。シードした直後に呼ぶ（`npm install`のpostinstallが作り直す）。
#   $1 対象の node_modules ディレクトリ
node_modules_share_drop_excluded() {
  local dir="$1" name
  for name in "${NODE_MODULES_SHARE_EXCLUDES[@]}"; do
    rm -rf "$dir/.$name"
  done
}

# 本体チェックアウトの`node_modules`をworktreeへハードリンクで複製する。
#   $1 ログの見出しに使うラベル（Issue番号など）
#   $2 本体チェックアウトのディレクトリ
#   $3 worktreeのディレクトリ
#   $4 パッケージマネージャ（detect_package_manager の戻り値）
#
# **失敗しても呼び出し元を止めない。** シードは速度とディスクのためだけの前倒しで、
# 揃えるのはこの後の`<pm> install`の仕事。ファイルシステムが違う（`cp -al`が
# "Invalid cross-device link"で落ちる）場合も、黙って通常のインストールに任せる。
seed_node_modules_from_main() {
  local label="$1" source_dir="$2" target_dir="$3" package_manager="$4"

  node_modules_share_targets_pm "$package_manager" || return 0
  [[ -d "$source_dir/node_modules" ]] || return 0
  # **worktreeを再利用する場合は触らない**（#1076でworktreeは再利用されるようになった）。
  # そのブランチで入れた依存が既に入っており、本体の内容を混ぜると辻褄が合わなくなる。
  [[ ! -e "$target_dir/node_modules" ]] || return 0

  if ! cp -al "$source_dir/node_modules" "$target_dir/node_modules" 2>/dev/null; then
    rm -rf "$target_dir/node_modules"
    echo "#$label: node_modules のハードリンク複製に失敗しました。通常のインストールに任せます。" >&2
    return 0
  fi
  node_modules_share_drop_excluded "$target_dir/node_modules"
  echo "#$label: node_modules を本体からハードリンクで複製しました（実ディスクは消費しません）。"
}

# 同じリポジトリの本体チェックアウトと全worktreeの`node_modules`を突き合わせ、内容が同じ
# ファイルを1つのinodeへまとめる。既にコピーで増えてしまったぶんの回収用。
#   $1 dry-run なら 1
#   $2.. 対象の node_modules ディレクトリ（2つ以上）
#
# `hardlink`(util-linux) を使う。**リポジトリをまたいで突き合わせない**——`next`のように
# 複数リポジトリで共通のパッケージも多いが、まとめるほど1つのその場書き込みが波及する範囲が
#広がるため、境界はリポジトリに置く。
#
# 標準出力に hardlink(1) の要約（`Saved:` 行など）をそのまま流す。
node_modules_share_dedupe() {
  local dry_run="$1"
  shift
  local args=(--ignore-time --respect-name --maximize --exclude "$(node_modules_share_exclude_regex)")
  [[ "$dry_run" -eq 1 ]] && args+=(--dry-run)
  # `--respect-name`（同名のファイルだけを突き合わせる）で、内容がたまたま一致しただけの
  # 別物をまとめない。`--ignore-time`はmtimeの違いを無視する（同じパッケージでも展開時刻は
  # worktreeごとに違うため、付けないとほぼ何もまとまらない）。所有者・パーミッションは既定どおり
  # 一致を要求する。
  hardlink "${args[@]}" "$@" 2>&1 | grep -E '^(Files|Linked|Saved|Duration):' || true
}
