# プロンプトの配置・使用モデル・使用量の可視化

プロンプトをどこに置くか、どのステップでどのモデルを使うか、1 runあたりの使用量をどう見るか。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## プロンプトの配置と式テンプレート長上限（#901, #907）

`claude-issue-dispatch.yml`の5つのClaude Codeステップ（計画提示・計画レビュー・分割・質問応答・
実装）のプロンプト本文は、ワークフローYAMLではなく`.github/prompts/`配下のMarkdownに置いている。

| ファイル | 対応するステップ |
|---|---|
| `.github/prompts/plan.md` | Claude Code（計画提示） |
| `.github/prompts/plan-review.md` | Claude Code（計画レビュー。計画の関門G1。#1218） |
| `.github/prompts/split.md` | Claude Code（分割） |
| `.github/prompts/question.md` | Claude Code（質問応答） |
| `.github/prompts/implement.md` | Claude Code（実装・PR作成） |

各Claude Codeステップの直前に「〜プロンプトを組み立てる」ステップを置き、`envsubst`で動的な値を
埋めたうえで`$GITHUB_ENV`へヒアドキュメント形式で格納する。Claudeステップ側は
`prompt: ${{ env.PROMPT_IMPLEMENT }}`のような短い参照になる。

プレースホルダは以下の7つ。`envsubst`には置換対象をこのリストで明示指定しており、プロンプト本文の
他の`$`表記を巻き込まない。**どれが使えるかはステップごとに違う**（`envsubst`の変数リストがその
ステップで渡したものだけになっているため。検査するCIも同じリストから導出する）。

`${ISSUE_NUMBER}` `${BRANCH}` `${PR_URL}` `${MODE}` `${REPOSITORY}` `${RUN_URL}` `${PACKAGE_MANAGER}`

計画レビューだけは、これらに加えて`${FLEET_STATUS}`（`scripts/fleet-status.sh`の出力）を渡す。
走っているセッション同士の関係を見る実行体が他に無いため、**新しいLLM呼び出しを増やさずに俯瞰を
効かせる**ための差し込み（[gates.md](gates.md)「G1の実装」）。

プロンプトファイルが存在しない・空の場合は組み立てステップで明示的に失敗させる。空のプロンプトが
そのままclaude-code-actionへ渡ると、エージェントが何をすべきか分からないまま走り出すため。

**プロンプトを編集するときはワークフローYAMLではなく`.github/prompts/`配下を編集する。**

### なぜこの構成にしているか

GitHub Actionsは`${{ }}`を1つでも含む文字列を、**ブロック全体で1つの式テンプレート**として
コンパイルする。その長さには21,000バイト（UTF-8）の上限があり、超えると
`Invalid workflow file: (Line: N, Col: M): Exceeded max expression length 21000`となって
**ワークフローファイル自体が無効**になる。

無効化の影響が大きいのは、YAMLとしては妥当で、かつ気付きにくいためである。

- `issue_comment`・`issues`トリガーは**runすら作られない**。Actionsタブには何も現れず、Issueに
  `@claude`とコメントしても無反応になるだけで、失敗の痕跡が残らない
- 痕跡が残るのはpush時のみで、そのワークフローに`push`トリガーが無くても、pushのたびに
  「失敗した1件のrun」として記録される。これが唯一の手がかりになる
- 該当ファイルのジョブは全て止まるため、実装・計画・質問応答・サブIssue分割が同時に停止する

判定は展開後ではなく元テキストの長さで行われる。日本語は1文字3バイトのため、21,000バイトは
おおよそ日本語7,000文字にすぎない。プロンプトの加筆で容易に到達する（#901では
「共有知識」「知見の記録」の2セクション追加で19,582→24,127バイトとなり、丸半日、無人実装が
全面停止した）。

#901ではひとまず大きいセクションをステップの`env:`へ切り出して回避したが、加筆のたびに上限を
意識し続ける必要が残るため、#907でプロンプト本文そのものを外部ファイルへ移した。これにより
ワークフロー側の式は`${{ env.PROMPT_X }}`の数十バイトで済み、上限の問題は構造的に消えている
（`claude-issue-dispatch.yml`は168,705→124,417バイトになった。残りは設計コメントと検証・
フォールバック用のシェルステップで、ファイルサイズ削減自体は主目的ではない）。

`scripts/check-workflow-expression-length.mjs`（`pnpm check:workflows`）がCIで上限を検査する。
上限超過でCIを落とし、85%超過で警告する。他のワークフロー（`claude-review-develop.yml`等）の
プロンプトは今もYAML内に置いているため、加筆時はこの警告を確認する。

## `run:`の中にリテラルの`${{`を書かない（#2181）

**GitHub Actionsは`run:`の中身も式テンプレートとして解釈する。** シェルのコメントであっても、
ヒアドキュメントで書いたPythonの文字列リテラルであっても変わらない。式として読めない
`${{ ... }}`が1つでもあると、上の長さ超過とまったく同じ壊れ方——**ワークフローファイル自体が
無効**になる。

#2181では`reusable-version-tag-check.yml`の`deploy-config-check`（YAMLへ直接書いたPython）に

- `# GitHubの式 `${{ ... }}` は …` というコメント
- `if "${{" in command:` という判定

の2つを書いたことで、`8c6fe3dd`のpushから4時間半で**54件の失敗runが積み上がり、その全部が
失敗**した。同時に、main宛PRから呼ばれるこのワークフロー自体がstartup failureで起動しなく
なり、リリース前の検査が黙って無効になっていた。

気付きにくさの理由は長さ超過と同じで、**ジョブが1つも作られないためログが空**なこと。
Actionsの一覧にはワークフロー名の代わりに`.github/workflows/<ファイル名>`がそのまま並ぶ。
`gh run list`で`.github/workflows/`から始まる名前が並んでいたら、この壊れ方を疑う。

リテラルとして書きたい場合は次のどちらかにする。

- **文字列を連結する。** Pythonなら`EXPR_OPEN = "$" + "{{"`、シェルなら`'$''{{'`のように、
  `$`と`{{`が隣り合わないように書く
- **`run:`の外のYAMLコメントへ置く。** YAMLコメントはパーサに落とされるため式にならない
  （このリポジトリの解説コメントに出てくる`${{ }}`はこれ）

`scripts/check-workflow-expression-syntax.mjs`（`pnpm check:workflows`）がCIで検査する。
`.github/workflows/`配下の全`${{ ... }}`を式として解析し、読めないもの・閉じていないものを
落とす。**YAMLコメントは対象から外す**（解説の`${{ }}`で全PRが赤くなるため）。

## 出力言語をどこで効かせているか（#1395）

エージェントの出力を日本語に揃える指示は、**起動フラグとプロンプト本文の二層**で持っている。

| 層 | 正の所在 | 効く範囲 |
|---|---|---|
| 起動フラグ | [scripts/lib/agent-language.sh](../../scripts/lib/agent-language.sh) の`AGENT_LANGUAGE_SYSTEM_PROMPT`を`--append-system-prompt`で渡す | サブPCのローカルセッション（`run-issue-session.sh`・`start-reviewer.sh`から起こしたもの） |
| プロンプト本文 | 各プロンプトの「## 出力言語」（`.github/prompts/`・`scripts/prompts/`） | 無人実行を含む全経路 |

**文面は2か所に同じものを置いている。変えるときは両方を揃える。** 片方だけ変えると、起動経路に
よって指示が食い違う。

二層にしているのは、それぞれ穴が違うため。

- これまで応答本文を日本語にしていたのは個人設定（`~/.claude/CLAUDE.md`）の1行だけで、
  メインPC・サブPCで同期が遅れていると効かず（[personal-config-sync.md](personal-config-sync.md)）、
  無人実行では読まれない。リポジトリ側の規約として持ち直したのが今回の変更
- 起動フラグはサブPCのセッションに確実に効くが、GitHub Actionsの無人実行は
  `run-issue-session.sh`を通らないため届かない
- プロンプト本文は全経路に届くが、長い指示の一部として埋もれる

`--append-system-prompt` を解釈しない古いClaude Codeへ渡すと起動ごと失敗するため、`--name`・
`--remote-control` と同じく`claude --help`にフラグがあるときだけ付ける。無い場合は情報行を出して
素通りし、プロンプト本文側で受ける。

> **契約マーカー（`# issue-deck-local-session: vN`）を宣言するリポジトリを増やす場合は注意。**
> 宣言していないリポジトリはissue-deckの`run-issue-session.sh`を共有するのでそのまま効くが、
> 宣言したリポジトリは自前の起動スクリプトを使うため、同じ手当てをそちら側にも入れる必要がある
> （[generic-launcher.md](generic-launcher.md)）。現状の宣言はissue-deck自身のみ。

## 計画は要約から書き、30〜40行に収める（#1744・#1892）

`21.plan-required`のIssueでローカルセッションが出す計画は、**冒頭に`## 要約`を置いてから**
変更するファイルを挙げる。承認する人が最初に読むのは「何をするのか・何が変わるのか・
何が危ないのか・他に案は無いのか」であり、それが本文の中ほどに散っていると、承認の可否を決めるのに
全文を読むことになるため。要約に置くのは次の6つ。

| 順 | 項目 | 中身 |
|---|---|---|
| 1 | タイトル | 「何をするか」を1行 |
| 2 | 概要 | なぜやるか・どう解決するかを2〜3行 |
| 3 | 追加・変更・削除する機能 | 利用者から見た変化を「追加」「変更」「削除」に分けた箇条書き |
| 4 | 影響範囲 | 効く経路・画面（ローカルのみか、無人実行にも効くか等） |
| 5 | 懸念点 | 承認の判断に影響するリスク・副作用・不確かな前提 |
| 6 | 他の案 | 検討して採らなかった案とその理由（無ければ省略可） |

要約の後は`## 変更するファイル`を置き、触るファイルを1ファイル1行（目安10件まで）で挙げて
終わりにする。**計画全体は30〜40行が上限**で、手順の逐条説明・コード片・調査の経過・テストケースの
列挙は書かない（#1892）。上限を設けたのは、**承認する人がこれをClaude Codeアプリの承認画面で
読むから**で、要約先頭化（#1744）だけでは本文が100行を超えて画面に収まらなかった。アプリ内の
表示そのものはissue-deckからは変えられないため、短くできるのは計画本文の側しかない。収まらない
計画は書き足して収めるのではなく、Issueが大きすぎるサインとしてサブIssueへの分割を提案する。

Plan modeで`ExitPlanMode`へ渡した本文は、フックがそのままIssueコメントとして投稿する（#1342・
[session-notify.md](session-notify.md)）。**端末での提示とIssueに残る記録が同じ本文なので、
書式を決める場所はプロンプトだけでよい。** 投稿側（`src/lib/dispatch/session-plan.ts`）は
`<!-- plan-base: -->`とRemote Controlのリンクを足すだけで、本文の書式には関与しない。

文面の正は次の2つで、**変えるときは両方を揃える**（出力言語と同じ二重管理）。

| ファイル | 効く範囲 |
|---|---|
| [scripts/prompts/implementation-agent.md](../../scripts/prompts/implementation-agent.md) | issue-deck自身のローカルセッション（`scripts/start-issue.sh`） |
| [scripts/prompts/generic-implementation-agent.md](../../scripts/prompts/generic-implementation-agent.md) | 他リポジトリのローカルセッション（汎用ランチャー） |

後者は`src/lib/prompts/templates.generated.ts`へ生成物として写しているため、編集したら
`node scripts/generate-prompt-templates.mjs`を実行し直す（忘れると`src/lib/prompts/templates.test.ts`
が落ちる）。

計画の関門（G1）のプロンプト（`scripts/prompts/plan-review-agent.md`・
`generic-plan-review-agent.md`）には、**計画が短いこと自体を指摘しない**旨を書いてある。
書式で意図的に落とした手順・テスト計画を「不足」として指摘されると、上限を設けた意味が消えるため。

**GitHub Actionsの無人実行（`.github/prompts/plan.md`）は対象外**で、従来どおりの書式のまま。
#1744で対象をサブPCのローカル実行に限定したため。無人実行へ広げる場合は、`.github/prompts/`が
`prompts-ref`で他リポジトリにも配られる（[cross-repo-setup-guide.md](../cross-repo-setup-guide.md)）
ことを踏まえ、配布タグを切る判断とセットで行う。

## 調査は往復を減らす形で行う（#2351）

セッションのコストは**応答の回数**でほぼ決まる。1往復ごとに積み上がった文脈を丸ごと再送するため、
往復が増えるほど1回あたりの単価も上がり、コストは応答数に対して超線形に伸びる。1セッションあたりの
API換算（Opus 5）は、1〜50応答で約2ドル、51〜100で約7ドル、101〜200で約16ドル、201〜400で約39ドル
だった（起点は`guchi-apps/question#34`の調査）。文脈は単調に増えるだけで、直近21日の979セッションの
うちcompact境界の記録は2件しかない。

内訳を見ると、**払っているのは出力の中身ではなく往復そのもの**だった。直近10日の実装セッション603件で、
ツール呼び出し39,728回のうち`Bash`が39,686回を占め、中身は`sed -n`が5,925回・`grep -n`が3,424回・
`grep -rn`が2,019回。1回あたりの出力は平均3KB未満。またツールを呼んだ応答64,305件のうち、1応答で複数
ツールを同時に呼んだものは4,413件（6.9%）だけだった。

そこで実装エージェントのプロンプトへ、探索の作法として次の3点を置いた。**計画を30〜40行に収める指針
（上記#1744・#1892）と同じく、書式ではなく往復の量を抑えるための指針**。

| 指針 | 中身 |
|---|---|
| 読む・探すは`Read`・`Grep`・`Glob` | `Bash`の`sed -n`・`cat`・`head`・`grep -rn`・`find`で代用しない。`Bash`は`git`・`gh`・テスト実行など、これらで表現できない処理に使う |
| 依存の無い調査は1応答でまとめて呼ぶ | 前の結果を待つ必要がない呼び出しは1応答に並べて発行する。順に呼ぶのは、前の結果で次に読む場所が決まるときだけ |
| 文脈が伸びた状態で粘らない | 見通しが立たないまま往復が積み上がったらIssueが大きすぎるサイン。区切れる範囲をPRにし、残りは`70.confirm`付きの新規Issueへ切り出す |

**ローカルセッションはauto mode（`--permission-mode auto`、#1205）で起動する**（`scripts/run-issue-session.sh`）。
auto modeのハーネスは「Bashでできることは`cat`・`sed -n`・`grep`で行い、専用ツールは代替できないときだけ
使う」という案内をセッションへ差し込むため、**上の1点目はその案内と正面から衝突する**。実測の`Bash`偏重
（39,686/39,728）はこの案内で説明が付く。プロンプト側では「読む・探すことについてはプロンプトを優先する」と
明記して解いてある——`Read`・`Grep`・`Glob`はいずれも読み取り専用で承認を挟まず、auto modeでも往復は
増えないため。**ファイルの編集についてはauto modeの案内どおりで、こちらは触っていない。**

文面の正は3つ。前2つは計画の書式と同じ二重管理で、**変えるときは揃える**。

| ファイル | 効く範囲 |
|---|---|
| [scripts/prompts/implementation-agent.md](../../scripts/prompts/implementation-agent.md) | issue-deck自身のローカルセッション |
| [scripts/prompts/generic-implementation-agent.md](../../scripts/prompts/generic-implementation-agent.md) | 他リポジトリのローカルセッション（汎用ランチャー） |
| [.github/prompts/implement.md](../../.github/prompts/implement.md) | 無人実行の実装ステップ |

無人実行版だけ2点違う。auto modeの断りは入れていない（無人実行は許可リスト方式でauto modeを使わない）ことと、
区切れないときの止まり方が`AskUserQuestion`ではなく`00.check-user`＋`01.check-blocked`を付けての停止で
あること。`.github/prompts/`は`prompts-ref`で他リポジトリへも配られるため、**配布先へ届くのは次の
`workflows/vN`タグを切ってからになる**（[cross-repo-setup-guide.md](../cross-repo-setup-guide.md)）。

## 使用するモデルの設定（#622）

`claude-issue-dispatch.yml`の各モード（計画提示・分割・質問応答・実装/追加対応）の
`claude-code-action`起動時、`claude_args`に含める`--model`の値は、自動リトライ上限
（`autoRetryLimit`）と同じ`AppSetting`シングルトンテーブルで管理する全リポジトリ共通の設定
（`claudeModel`。既定値は`"auto"`）から決める。アプリ設定ダイアログ（歯車アイコン）で
「自動」「Opus」「Sonnet」「Haiku」のいずれかを選択でき、値は`GET /api/settings/claude-model`
（読み取り専用、認証不要）経由でワークフローから参照する。

- ジョブの先頭付近（実行者・状態判定ステップの直後）に専用ステップを設け、`APP_BASE_URL`未設定
  時やAPI疎通失敗時、または許可された値（`opus`/`sonnet`/`haiku`）以外が返った場合は安全側で
  `"auto"`扱いにフォールバックする（autoRetryLimitの取得ステップと同じ方針）。
- `claudeModel`が`"auto"`の場合は`--model`を一切付与せず、`claude-code-action`側のデフォルト
  モデルに委ねる。それ以外の場合は`--model <値>`を各`claude_args`に追記する。
- モデル値はスナップショット日付を含む具体的なモデルIDではなく、Claude Code CLIが解決する
  エイリアス（`opus`/`sonnet`/`haiku`）のみを許可する。特定のスナップショットに固定すると、
  将来Anthropic側でデフォルトモデルが更新されても自動的に恩恵を受けられなくなるため。

### 実装用と補助用の2系統に分ける（#905）

すべてのステップを同じモデルで動かすと、実装ほどの精度を必要としない処理まで上位モデルのコストを
払うことになる。そのため`AppSetting`に`claudeModelAssist`を追加し、2系統で管理する。

| 設定 | 適用されるステップ |
|---|---|
| `claudeModel`（実装・計画） | 計画提示、計画レビュー、実装・PR作成 |
| `claudeModelAssist`（補助処理） | サブIssue分割、質問応答 |

**計画レビュー（#1218）を補助系に寄せていないのは、見落としの損失が大きいため。** 計画段階で
潰せなかった設計ミスは「実装30分＋実装run 1本（$1.70〜3.18）の作り直し」になり、レビュー1本を
安いモデルにして浮く額と釣り合わない。

`claude_model`ステップは`model_flag`と`assist_model_flag`の2つを出力し、各`claude_args`が
どちらかを埋め込む。フォールバックの考え方は両者で同じ（不正値・取得失敗時は`"auto"`扱い）。
`claudeModelAssist`は後から追加した項目のため、レスポンスに項目自体が無い場合も`"auto"`へ倒れる。

**develop向けPRの自動レビュー（`claude-review-develop.yml`）は対象外とし、`--model`を指定しない
既定のままにしている。** レビュー品質の低下は自動マージ不可判定の見落としに直結し、コスト削減と
釣り合わないため。`claude-ci-fix.yml`・`claude-conflict-resolve.yml`・`claude-pr-repair.yml`・
`release-develop-to-main.yml`も同様に`--model`を指定していない
（そもそもこの設定を参照していない）。

### サブPCのClaude Codeモデル

設定の「サブPC（Claude）：計画・実装」は、サブPCで新しく起動するClaude Codeセッションだけに
適用する。既定はSonnet。1つのローカルセッションが計画から実装・PR作成まで続けて行うため、
GitHub Actionsのように計画用と補助用には分けない。

払い出しAPIが`claudeLocalModel`をジョブへ付け、pollerが`ISSUE_DECK_CLAUDE_MODEL`として
ランチャーへ渡し、`run-issue-session.sh`が`claude --model <値>`へ反映する。`auto`の場合は
環境変数を渡さず、Claude Code側の既定モデルへ委ねる。

**選べる候補にHaikuは無い**（#2756）。ローカルセッションは前述のとおりauto mode
（`--permission-mode auto`）で起動しており、Haikuはauto modeで動作しない
（[anthropics/claude-code#43235](https://github.com/anthropics/claude-code/issues/43235)）。
候補の一覧は`CLAUDE_MODEL_OPTIONS`から`haiku`を除いた`CLAUDE_LOCAL_MODEL_OPTIONS`
（`src/lib/app-settings.ts`）で、設定画面の「サブPC（Claude）：計画・実装」、「実装を開始」
ダイアログのモデル欄（次項）、「おまかせ」の判定候補（`MODEL_PICK_CANDIDATES`）の3か所が
これを参照する。値の検証も`parseClaudeLocalModel`に分け、既存の値がHaikuのままでも
既定（Sonnet）へフォールバックする。**GitHub Actions向け（`claudeModel`・
`claudeModelAssist`）は許可リスト方式でauto modeを使わないため対象外**——引き続きHaikuを
選べる（前掲「使用するモデルの設定」）。

削減効果と品質の両方を見ながら割り当てを調整できるよう、実際のコストは#903のJob Summaryで確認する。
品質は自動では測れないため、倒すステップは保守的に選び、問題があれば個別に戻す。

### 重いIssueだけモデルを上げる（#2717）

**モデルはIssueごとに、起動のたびに選べる。**「実装を開始」ダイアログの「モデル」欄で、
そのIssueだけFableやOpusへ上げられる。既定は「設定に従う」で、選ばなければ従来どおり
上の設定で立つ。選んだ値は`DispatchJob.claudeModel`に入り、払い出しAPIが
`claudeLocalModel`として載せ直す——**pollerとランチャーは従来どおり`claudeLocalModel`しか
読まない**ので、この経路にpoller側の変更は要らない。

欄の中身は#2723で作り直した（下の「モデル欄には金額を出さない」「おまかせ」を参照）。

**選択欄が出るのはサブPCでClaude Codeを起こすときだけ。** GitHub Actionsは
`reusable-issue-dispatch.yml`が設定を全体で読む別経路で、ジョブに積んだ値は届かない
（Issueごとに変えるならラベルの新設と全リポジトリへの配布が要る）。Codexのモデルは
別の設定（`CODEX_MODEL_OPTIONS`）で、ここでは扱わない。

**全体の既定ではなく起動ごとの選択にしたのは、割高さが対話の長さで変わるから。**
`SessionUsage`の実測（直近90日・実装セッション619件・すべてOpus 5）では、1件あたりの
平均トークンは入力164・キャッシュ書き込み23.5万・**キャッシュ読み出し1,358万**・出力5.6万で、
Opus 5では**費用の64%がキャッシュ読み出し**になる。

| モデル | 入力 / 出力 / キャッシュ読み出し（$/MTok） | 実装セッション1件の目安 |
|---|---|---|
| Claude Haiku 4.5 | 1.00 / 5.00 / 0.10 | $2.11 |
| Claude Sonnet 5 | 2.00 / 10.00 / 0.20 | $4.22 |
| Claude Opus 5 | 5.00 / 25.00 / 0.50 | $10.55（実測の平均と一致） |
| Claude Fable 5.1 | 10.00 / 50.00 / **0.25** | $10.92（Opus 5比1.03倍） |

Fable 5.1は入力・出力がOpus 5の2倍だが、**キャッシュ読み出しだけは$0.25/MTokと半額**で、
長い対話ではこれが値上がりをほぼ相殺する。逆に数往復で終わるIssueや、キャッシュが効かない
アプリ内AIの単発呼び出しでは相殺が働かず、素の単価差がそのまま出る（Sonnet 5の5倍）。
**「Fableは一律に高い」ではなく「短い用途でだけ高い」**というのが実測の結論で、
だから既定を上げるのではなく重いIssueで選ぶ形にしている。

単価表は2か所にある。`scripts/lib/session-usage.sh`の`PRICES`（転記から金額を割る側）と
[`src/lib/ai-model-pricing.ts`](../../src/lib/ai-model-pricing.ts)（画面が実績の金額を出す側）で、
**料金が変わったら両方を直す**。どちらも**キャッシュ読み出しを倍率ではなく単価で持つ**
——一律0.1倍で数えると、Fable 5.1のセッションが実際の$10.92ではなく$21.11として記録される。

### モデル欄には金額を出さない（#2723）

上の表の「1件あたりの目安」を、起動ダイアログのチップの右端に出していたが**やめた**。

- **何の金額か画面から決まらない。** 1回ぶんなのか月額なのか、実費なのかAPI換算なのかが
  読み取れず、断り書きを足すほど欄が重くなる
- **差が判断に効かない。** 費用の6割強がキャッシュ読み出しのため、$10.92（Fable）と
  $10.55（Opus）はほぼ並ぶ。数字を見比べても選べない
- **実績は「AI使用量」の画面にある**（`session-usage-panel.tsx`）。モデル別・Issue別に、
  実測のトークンから割った額が出る。起動前の欄が目安を持つ必要はない

代わりにチップの2行目へ**向いている作業**を出す（`CLAUDE_MODEL_FIT_LABELS`・
`CLAUDE_MODEL_FIT_DESCRIPTIONS`。どちらも`src/lib/app-settings.ts`）。
見積りを出していた`estimateSessionCostUsd`と、その元の平均トークン数の定数は消した。

### 「おまかせ」はissue-deckが選ぶ（#2723）

**旧「おまかせ」は「CLIの既定」へ改名した。** 実体は`--model`を付けないことで、どのモデルで
立つかはClaude Code側の設定・アカウントの既定で決まる——**作業の内容に応じて選ばれるわけでは
ない**のに、「おまかせ」は賢く選ぶように読める。受付コメント（`lib/dispatch/session-start.ts`）が
先に使っていた呼び方へ揃えた。

新しい「おまかせ」（全幅のチップ）は、**Issueの内容からissue-deckがモデルを選ぶ**。

- 押したときだけ`POST /api/issues/model-pick`を呼ぶ（開いただけでは呼ばない）
- 材料は**DBのIssue**（タイトル・本文・ラベル・コメント数）と、画面が既に持っていれば
  承認済みの計画コメント。**GitHubへは取りに行かない**
- 判定はアプリ内AI（既定はHaiku。`lib/claude/model-pick.ts`）。**呼べなかった・応答を読めなかった
  ときはラベルと分量からのルールへ倒す**（`pickModelByRule`）。ルールでは最上位（Fable）を
  選ばない——AIが落ちている間ずっと重いモデルで走ることになるため
- **選んだ理由を必ず画面に出す。** 当たり外れのある判定なので、納得できなければその場で別の
  チップを押せることが前提。判定が終わるまで「開始する」は押させない
- 積むのは**決まった具体的なモデル名**で、`auto`ではない。実行キューの印にも受付コメントにも
  そのモデルが出る（APIへ送る値の集合は#2717から変えていない）

### 実際に動いているモデルをセッションに出す（#2723）

Issue詳細のセッション表示（`issue-session-status.tsx`）に「モデル Opus」の印が出る。
**起動時に指定した値ではなく、転記の集計（`SessionUsage.models`）から引いた実物。**
「CLIの既定」「設定に従う」で立てたときに何で動いているかは、これでしか分からない。

**出どころが転記の集計しか無いため、遅れがある。** pollerが5分ごとに報告するので、
**最初の応答が集計されるまで印は出ない**（そのときは欄ごと出さない）。突き合わせは
ホスト・リポジトリ名・Issue番号で行い（`SessionUsage`はtmuxのセッション名を持たない）、
**同じIssueの前回のセッションを拾わないよう`endedAt`がそのセッションの`firstSeenAt`以降の行
だけを見る**（`lib/dispatch/sessions.ts`の`resolveSessionModels`）。Claude Codeが小さな処理で
別のモデルを使うと2つ以上並ぶので、「AI使用量」の画面と同じく全部を「・」で並べる。

## Claude使用量の可視化（#903）

各Claude Codeステップの直後に、`.github/scripts/summarize-claude-usage.sh`を呼ぶステップを置いている。
`claude-code-action`の`execution_file`出力から、そのステップのコスト・ターン数・所要時間・
トークン内訳・権限拒否を抽出し、GitHub ActionsのJob Summaryへ表として出力する。

対象は`claude-issue-dispatch.yml`の5ステップ（計画提示・計画レビュー・分割・質問応答・実装）に加え、
`claude-review-develop.yml`・`claude-ci-fix.yml`・`claude-conflict-resolve.yml`・
`claude-pr-repair.yml`・`release-develop-to-main.yml`の各1ステップ。

**このスクリプトはジョブを失敗させない。** 計測は補助情報であり、`execution_file`が無い・
`claude-code-action`側のJSONスキーマが変わった・`jq`が失敗した場合でも、本来の処理（実装・
レビュー等）の成否に影響を与えてはならない。そのため`set -e`を使わず、抽出できなかった項目は
`-`と表示して常に`exit 0`する。

見るべき点は主に2つ。

- **キャッシュ読み出しトークンが極端に大きいステップ** — 大きいファイルを文脈に載せたまま何ターンも
  回している疑いがある。#901の調査時の実測では、`.github/workflows/claude-issue-dispatch.yml`
  （当時161KB）を丸ごと1回Readしたrunで、平均文脈が10.8万トークンに達していた
- **権限拒否（`permission_denials`）** — プロンプトが指示している操作が`--allowedTools`に
  無いという設定漏れの可能性が高い。拒否1回はそのまま1往復であり、その時点の文脈をまるごと
  再送するため、放置するとコストに効く

トークン使用量の削減施策全体は#910で管理している。効果測定なしに削ると、安くなったのか単に
手を抜くようになったのかを区別できないため、この可視化を先に入れている。

## アプリ内AIのモデルとプロバイダー（#2562・#2568）

issue-deck自身が外部AI APIを呼ぶ機能は、必要な判断力に合わせて2系統のモデル設定へ分ける。

| 設定画面の表記 | 対象機能 | 既定モデル |
|---|---|---|
| アプリ内AI：要約・検索・文章整理 | Issue・コメント要約、類似Issue検索、本文整理、並び替え、Issue作成補助 | Claude Haiku 4.5（高速） |
| アプリ内AI：原因診断・新規アプリ相談 | 手作業失敗の原因診断、新規アプリの構成相談 | Claude Sonnet 5（標準） |

定型的な抽出・整形に上位モデルを使わず、誤った判断の影響が大きい診断・相談にはSonnetを使う。
`src/lib/claude/request.ts`が機能名から設定を選ぶ唯一の送信口で、`claude-`モデルはAnthropic
Messages API、`gpt-`モデルはOpenAI Responses APIへ送る。

Claudeモデルは`CLAUDE_CODE_OAUTH_TOKEN`、GPTモデルは`OPENAI_API_KEY`を使用する。選択中のモデルに
対応する認証情報が無い場合だけ、各APIは`not_configured`を返す。OpenAIの応答は共通送信口で既存の
テキスト・usage形式へ正規化するため、各AI機能はプロバイダーごとの分岐を持たない。モデル別の実測
トークン数は、どちらのプロバイダーも設定の「AI使用量」へ同じ機能別集計として記録する。
**その集計にはAPI換算の目安金額も並べる**（#2717）。単価は
[`src/lib/ai-model-pricing.ts`](../../src/lib/ai-model-pricing.ts)から引き、**単価を知らない
モデルが1つでも混じっている機能には金額を出さない**——足りない分を0として足すと実際より安く見える。

**Claude Fable 5.1も候補に入っている**（#2717）が、ここでの呼び出しは1往復で終わり
キャッシュがほとんど効かないため、単価差（Sonnet 5の5倍）がそのまま金額に出る。上の
「重いIssueだけモデルを上げる」で書いたセッションの話とは逆向きになる点に注意する。

## 自動投稿コメントへの実行ログリンク付与

`claude-issue-dispatch.yml`・`issue-labels.yml`がGitHub Actions上で`gh issue comment`を使って
自動投稿するコメント（着手通知・計画提示・計画提示失敗時のフォールバック・画面確認待ちの通知・
develop向けPR作成完了・developマージ完了）には、末尾に`実行ログ: <ワークフロー実行のURL>`を
追記している（issue #106）。URLは`${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}`
で組み立てられ、そのコメントを投稿した1回のワークフロー実行を指す。人間がコメントから該当する
Actionsの実行ログへワンクリックで辿れるようにし、無人実行時のトラブルシュートを追跡しやすくする
のが狙い。計画提示ステップの計画コメント自体はClaude Codeエージェントが投稿するため、シェル
スクリプト側でURLを組み立てて渡すのではなく、プロンプトの指示に組み込んでエージェントに
追記させている。
