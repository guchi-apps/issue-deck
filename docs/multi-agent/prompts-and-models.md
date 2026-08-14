# プロンプトの配置・使用モデル・使用量の可視化

プロンプトをどこに置くか、どのステップでどのモデルを使うか、1 runあたりの使用量をどう見るか。

索引: [Issueごとの複数Claude Codeエージェント運用 設計](../multi-agent-workflow.md)

## プロンプトの配置と式テンプレート長上限（#901, #907）

`claude-issue-dispatch.yml`の4つのClaude Codeステップ（計画提示・分割・質問応答・実装）の
プロンプト本文は、ワークフローYAMLではなく`.github/prompts/`配下のMarkdownに置いている。

| ファイル | 対応するステップ |
|---|---|
| `.github/prompts/plan.md` | Claude Code（計画提示） |
| `.github/prompts/split.md` | Claude Code（分割） |
| `.github/prompts/question.md` | Claude Code（質問応答） |
| `.github/prompts/implement.md` | Claude Code（実装・PR作成） |

各Claude Codeステップの直前に「〜プロンプトを組み立てる」ステップを置き、`envsubst`で動的な値を
埋めたうえで`$GITHUB_ENV`へヒアドキュメント形式で格納する。Claudeステップ側は
`prompt: ${{ env.PROMPT_IMPLEMENT }}`のような短い参照になる。

プレースホルダは以下の6つ。`envsubst`には置換対象をこのリストで明示指定しており、プロンプト本文の
他の`$`表記を巻き込まない。

`${ISSUE_NUMBER}` `${BRANCH}` `${PR_URL}` `${MODE}` `${REPOSITORY}` `${RUN_URL}`

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
| `claudeModel`（実装・計画） | 計画提示、実装・PR作成 |
| `claudeModelAssist`（補助処理） | サブIssue分割、質問応答 |

`claude_model`ステップは`model_flag`と`assist_model_flag`の2つを出力し、各`claude_args`が
どちらかを埋め込む。フォールバックの考え方は両者で同じ（不正値・取得失敗時は`"auto"`扱い）。
`claudeModelAssist`は後から追加した項目のため、レスポンスに項目自体が無い場合も`"auto"`へ倒れる。

**develop向けPRの自動レビュー（`claude-review-develop.yml`）は対象外とし、`--model`を指定しない
既定のままにしている。** レビュー品質の低下は自動マージ不可判定の見落としに直結し、コスト削減と
釣り合わないため。`claude-ci-fix.yml`・`claude-conflict-resolve.yml`・`claude-pr-repair.yml`・
`shared-knowledge-propose.yml`・`release-develop-to-main.yml`も同様に`--model`を指定していない
（そもそもこの設定を参照していない）。

削減効果と品質の両方を見ながら割り当てを調整できるよう、実際のコストは#903のJob Summaryで確認する。
品質は自動では測れないため、倒すステップは保守的に選び、問題があれば個別に戻す。

## Claude使用量の可視化（#903）

各Claude Codeステップの直後に、`.github/scripts/summarize-claude-usage.sh`を呼ぶステップを置いている。
`claude-code-action`の`execution_file`出力から、そのステップのコスト・ターン数・所要時間・
トークン内訳・権限拒否を抽出し、GitHub ActionsのJob Summaryへ表として出力する。

対象は`claude-issue-dispatch.yml`の4ステップ（計画提示・分割・質問応答・実装）に加え、
`claude-review-develop.yml`・`claude-ci-fix.yml`・`claude-conflict-resolve.yml`・
`claude-pr-repair.yml`・`shared-knowledge-propose.yml`・`release-develop-to-main.yml`の各1ステップ。

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
