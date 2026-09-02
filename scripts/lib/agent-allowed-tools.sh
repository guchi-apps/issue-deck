#!/usr/bin/env bash
# auto modeのローカルセッションへ渡す許可規則（`--allowedTools`）を1か所で持つ（#2762）。
#
# 誰が使うか:
#   scripts/run-issue-session.sh  実装セッション（Issueごと・汎用ランチャー経由も含む）
#   scripts/start-reviewer.sh     レビュー・統合セッション
#
# ## なぜ要るか
#
# ローカルセッションは`--permission-mode auto`（#1205）で起動しており、権限モード自体は
# 正しく`auto`になっている（会話転記の`permission-mode`レコードで実測できる）。それでも
# **auto modeの権限クラシファイアは「同じコマンドでも実行のたびに判断が変わる」**ため、
# `gh issue view`・`git log`のような読み取りだけのコマンドが、セッション開始直後から
# 1件ずつ承認待ちになることがある（#2762で実測。#2017の`gh issue create`と同じ現象）。
#
# サブPCの無人に近い起動では誰も答えられず、セッションはそこで止まる。人が居る起動でも、
# 「承認したはずなのにまた聞かれる」という形になり、auto modeを使う意味が薄れる。
#
# **許可規則はクラシファイアより先に評価される**（拒否メッセージ自身が「add a Bash permission
# rule to their settings」と案内する）。そこで、実装・レビューのセッションが必ず通る
# 定型のコマンドを規則として渡し、判断のブレを無くす。
#
# ## 何を入れて、何を入れないか
#
# 入れるのは次の3種類だけ。**どれも「読む」か「検証する」か「Issueへ書き残す」に限る。**
#
#   - 読み取りだけのgit・ghの副コマンド（`git log`・`gh pr view`など）
#   - 検証コマンド（lint・型チェック・テスト・ビルド）。この4つはPRを出す前に必ず走らせる
#   - Issueへの起票とコメント（#2017・#1486・#2009・#1119の運用で必ず使う）
#
# **入れないもの。** 書き込み・破壊・本番へ出る操作・シークレットに触れる操作は、
# 引き続きauto modeのクラシファイアに判断させる。ここへ足すと、issue-deckの後段の防御
# （Pull Request必須・`claude-review-develop.yml`のレビュー・自動マージ不可カテゴリ）より
# 手前で無条件に通ってしまう。
#
#   - `git commit`・`git push`・`git merge`・`git reset`・`git checkout`・`git branch`
#   - `gh pr create`・`gh pr merge`・`gh issue edit`・`gh issue close`・`gh workflow run`
#   - `gh api`（POST・DELETEを同じ規則で通してしまうため、読み取り用途でも入れない）
#   - `rm`・`sudo`・`ssh`・`op`・`sed -i`のような書き換え系
#
# **ファイルを読むための`Bash`の規則はここに入れない。** `cat`・`head`・`grep`のような規則は、
# `cat > file`のように出力をリダイレクトする書き込みまで前方一致で拾いうる。読む・探すのは
# `Read`・`Grep`・`Glob`を使う方針（各実装プロンプトの「調査は往復を減らす形で行う」）で、
# この3つは**作業ディレクトリの中なら**承認を挟まない。
#
# ## 作業ディレクトリの外のファイルは`Read`規則で渡す（#2778）
#
# `Read`が承認不要なのは作業ディレクトリの中だけで、**外のファイルは`Read`でも1件ずつ承認を
# 求められる。** セッションのキックオフ文面はworktreeの外にある指示ファイル
# （`<worktree親>/.prompts/issue-<番号>.md`）を読ませるため、起動直後に必ず承認プロンプトが
# 1件出て、無人に近い起動ではそこで止まっていた。
#
# そこで、そのセッションが必ず読むファイルの**絶対パスを引数で受け取り**、`Read`規則として
# 足せるようにしてある。ディレクトリごと開けるのではなく、渡された1ファイルずつを許可する
# （`--add-dir`で`.prompts`を渡す案は、そこが書き込み可能になり他Issueの指示ファイルまで
# 触れるので採らない）。
#
# **絶対パスはスラッシュ2つで始める**（`Read(//home/…/issue-2778.md)`）。1つだけだと設定ファイル
# からの相対として扱われて当たらない——`--permission-mode default`（規則に無いものは即座に
# 承認待ち）で規則あり・なし・スラッシュ1つの3通りを試して確かめた（#2778）。
#
# ## 効くのは静的解析できる形だけ
#
# `--body "$(cat <<'EOF' … EOF)"`のようにコマンド置換を含むものは規則の対象外で、
# `Contains shell syntax (string) that cannot be statically analyzed`として扱われる
# （#2017で実測）。**規則を足しても承認プロンプトが完全に消えるわけではない。**
# 各プロンプトが「起票の`--body`は複数行のままそのまま渡す」と指示しているのはこのため。
#
# `--allowedTools`は許可の**追加**であり、ここに挙げていないツールを禁止するものではない
# （禁止は`--disallowedTools`が持つ）。
#
# **Codexでは使わない。** あちらは`--ask-for-approval never`で走らせるため個々の許可規則が
# 無く、コマンドが権限で弾かれること自体が起きない（#2377）。
#
# このファイル自体は実行せず、source して使う。

# セッションへ渡す許可規則をカンマ区切りで1行に出す。
#
# 引数には、そのセッションが必ず読む**作業ディレクトリの外のファイルの絶対パス**を必要なだけ
# 渡せる（渡さなくてもよい。レビュー・統合セッションは渡さない）。
#
# **順序と内容を変えたらテスト（`src/lib/agent-allowed-tools.test.ts`）も直す。**
# ここは「何を無条件に通すか」を決めている場所なので、足したことに気付かないまま
# 増えていくのがいちばん危ない。
agent_allowed_tools() {
  local rules=(
    # --- Issueへの起票とコメント（#2017・#1486・#2009・#1119） ---
    # 起票は「調べる過程で見つけた別件を残す」運用、コメントは計画・完了報告・知見メモで必ず使う。
    # どちらも拒否されると、記録が残らないまま作業だけが進む（いちばん困る落ち方）。
    "Bash(gh issue create:*)"
    "Bash(gh issue comment:*)"
    # --- 読み取りだけのgh ---
    "Bash(gh issue view:*)"
    "Bash(gh issue list:*)"
    "Bash(gh pr view:*)"
    "Bash(gh pr list:*)"
    "Bash(gh pr diff:*)"
    "Bash(gh run view:*)"
    "Bash(gh run list:*)"
    # --- 読み取りだけのgit ---
    # `git fetch`はリモート追跡ブランチを更新するだけで、作業ツリーもローカルブランチも動かさない。
    "Bash(git status:*)"
    "Bash(git diff:*)"
    "Bash(git log:*)"
    "Bash(git show:*)"
    "Bash(git ls-files:*)"
    "Bash(git rev-parse:*)"
    "Bash(git fetch:*)"
    # --- 検証（PR前に必ず走らせる4つ） ---
    "Bash(pnpm lint:*)"
    "Bash(pnpm test:*)"
    "Bash(pnpm vitest:*)"
    "Bash(pnpm build:*)"
    "Bash(pnpm tsc:*)"
    "Bash(npx tsc:*)"
    "Bash(npx vitest:*)"
  )

  # --- 起動時に読む作業ディレクトリ外のファイル（#2778） ---
  # **絶対パスだけを受け付ける。** 相対パスは規則が当たらない（設定ファイルからの相対に
  # なる）ので、黙って効かない規則を増やさないよう落とす。**カンマを含むパスも落とす**
  # ——規則の区切りがカンマなので、そのまま足すと1つの規則が2つに割れる。
  local extra_read
  for extra_read in "$@"; do
    [[ "$extra_read" == /* ]] || continue
    [[ "$extra_read" != *,* ]] || continue
    rules+=("Read(/$extra_read)")
  done

  local IFS=,
  printf '%s' "${rules[*]}"
}
