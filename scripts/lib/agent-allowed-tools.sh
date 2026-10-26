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
# **例外は`agent_pr_allowed_tools`（#5082）。** PRを自動で作る実装セッションに限り、
# 指示ファイルが明示的に求める`gh pr create`と、範囲を絞ったsecretの同期だけを別に足す。
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
# そこで、worktreeの外にあってそのセッションが読むファイルの**絶対パスを引数で受け取り**、
# `Read`規則として足せるようにしてある。ディレクトリごと開けるのではなく、渡された1ファイル
# ずつを許可する（`--add-dir`で`.prompts`を渡す案は、そこが書き込み可能になり他Issueの指示
# ファイルまで触れるので採らない）。
#
# **渡す側には3種類ある**（呼び出し元の`run-issue-session.sh`を参照）。
#
#   - 起動直後に必ず読む指示ファイル。承認プロンプトが実際に出ていたのはこちら
#   - 開発サーバーへ繋がらないときに見るログ。必ず読むものではなく、要るときだけ読む
#   - Issueに貼られた画像の保存先（ディレクトリ・#3039）。#2967で画像の配信に認証が要るように
#     なり、`fetch-issue-images.sh`で`/tmp/issue-deck-images/`へ落としてから`Read`する形に
#     変わった。そこが作業ディレクトリの外なので、画像を開くたびに承認待ちになっていた
#     （9/17〜18の転記で、承認待ちになった`Read`はほぼ全件がこの画像だった）
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
# 引数には、そのセッションが読む**作業ディレクトリの外のファイルの絶対パス**を必要なだけ
# 渡せる（渡さなくてもよい。レビュー・統合セッションは渡さない）。末尾を`/`にするとディレクトリ
# として扱い、その中を丸ごと許可する（#3039）。
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
  # **絶対パスで、区切り文字とグロブを含まないものだけを規則にする。** 置き場所は環境変数で
  # 差し替えられる（`ISSUE_DECK_WORKTREE_BASE`など）ため、素通しにはしない。
  #
  #   - 相対パス          設定ファイルからの相対として扱われ、意図した場所に当たらない
  #   - 空白・カンマ入り  `--allowedTools`は "Comma or space-separated list"（`claude --help`）。
  #                       そのまま足すと1つの規則が2つに割れ、意図しないパスを許可しかねない
  #   - `*`入り           グロブとして解釈され、渡した1ファイルより広い範囲を通す
  #
  # 当てはまるものは**黙って落とす**。効かない規則や広すぎる規則を渡すより、承認プロンプトが
  # 1件出るほうが安全。
  #
  # **末尾が`/`のものはディレクトリとして`Read(//<dir>/**)`にする**（#3039）。添付画像の保存先
  # （`fetch-issue-images.sh`が落とす先）のように、中のファイル名が起動時に決まらない場所だけに使う。
  # 1ファイルずつの許可より広いので、渡すのは「そのセッションのために作られ、読んで困るものが
  # 入らない」ディレクトリに限る。ルート（`/`）そのものは落とす。
  local extra_read
  for extra_read in "$@"; do
    [[ "$extra_read" == /* ]] || continue
    [[ "$extra_read" != *[[:space:],*]* ]] || continue
    if [[ "$extra_read" == */ ]]; then
      [[ "$extra_read" =~ [^/] ]] || continue
      extra_read="${extra_read%/}"
      while [[ "$extra_read" == */ ]]; do extra_read="${extra_read%/}"; done
      rules+=("Read(/$extra_read/**)")
    else
      rules+=("Read(/$extra_read)")
    fi
  done

  local IFS=,
  printf '%s' "${rules[*]}"
}

# PRを自動で作る実装セッションにだけ足す許可規則をカンマ区切りで1行に出す（#5082）。
#
# ## なぜ上の`agent_allowed_tools`と分けるか
#
# 実装セッションの指示ファイルは「このプロンプトがPR作成の明示的な指示」「マニフェストへキーを
# 足したら1Passwordへの登録とGitHubへの同期まで済ませる」と書き、`--append-system-prompt`でも
# 同じ趣旨を渡している（#3752）。それでも**auto modeのクラシファイアは`gh pr create`を
# `External System Writes`、secretの同期を`Secret-Store Writes`として拒否した**
# （guchi-apps/vps#319。1操作ずつ別のBash呼び出しにしても拒否されたので、結合が原因ではない）。
# 指示どおりの操作が拒否のたびに人待ちになるので、規則として渡して判断を通さない。
#
# 上の「入れないもの」を覆すのではなく、**範囲を「PRを自動で作る実装セッション」に絞る**。
# レビュー・統合セッション、手作業セッション、PRを人の指示で作るリポジトリ（`pr-policy.sh`）
# には渡さない（呼び出し元の`run-issue-session.sh`が`append_pr_system_prompt`と同じ条件で判定する）。
#
# ## 何を入れるか
#
#   - `gh pr create`——PRを作るだけで、マージは後段（自動レビュー・自動マージ不可カテゴリ）が持つ。
#     `gh pr merge`・`git push`は引き続き入れない
#   - `provision-secret.sh --repo <このセッションのリポジトリ>`——**`--repo`まで前方一致させ、
#     他リポジトリのsecretには届かせない。** 絶対パス（汎用ランチャーのプロンプトが
#     `{{ISSUE_DECK_SCRIPTS_DIR}}`を絶対パスへ直して示す形）と、issue-deck自身のプロンプトが示す
#     `scripts/`からの相対パスの両方
#   - `sync-github-secrets.sh --only`——**`--only`で対象キーを絞った同期だけ。** マニフェスト全体の
#     同期は値の上書き範囲が広すぎるので通さない。実体はリポジトリごとにあり、置き場所が
#     `.github/scripts/`（配布先）と`scripts/`（issue-deck）で違うため両方を書く
#
# 相対パスの規則は**作業ツリーのスクリプトをそのまま走らせる**（セッション自身が書き換えうる）。
# ただし`pnpm test`の規則も同じ性質を持っており、ここで新たに開く穴ではない。
#
# 引数:
#   $1  このセッションのリポジトリ（`owner/repo`）。形式が違えば`provision-secret.sh`の規則を足さない
#   $2  issue-deckのスクリプトの絶対パス（`run-issue-session.sh`の`SCRIPT_DIR`）。省略可
agent_pr_allowed_tools() {
  local repo_slug="${1:-}"
  local scripts_dir="${2:-}"
  scripts_dir="${scripts_dir%/}"
  local rules=(
    "Bash(gh pr create:*)"
    "Bash(.github/scripts/sync-github-secrets.sh --only:*)"
    "Bash(scripts/sync-github-secrets.sh --only:*)"
  )

  # `owner/repo`以外（空・空白やカンマ・グロブ入り）は黙って落とす。理由は上の`Read`規則と同じで、
  # 規則が割れたり広がったりするより、承認プロンプトが1件出るほうが安全。
  if [[ "$repo_slug" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    rules+=("Bash(scripts/provision-secret.sh --repo $repo_slug:*)")
    if [[ "$scripts_dir" == /* && "$scripts_dir" != *[[:space:],*]* ]]; then
      rules+=("Bash($scripts_dir/provision-secret.sh --repo $repo_slug:*)")
    fi
  fi

  local IFS=,
  printf '%s' "${rules[*]}"
}
