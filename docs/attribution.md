# GitHub上の操作名義（誰が誰として記録されるか）

issue-deckが行う各種操作（Issue作成・コメント投稿・ラベル操作・ブランチpush・PR作成）が、
実際にGitHub上で**誰の名義として記録されるか**を整理する。

発端は issue #364。「コメントの投稿者が誰名義になるのか」を確認する過程で、経路ごとに
「実際に操作した人間」と「GitHub上の記録名義」が一致したりしなかったりすることが分かった
ため、その整理を残す。

[docs/actions-token-model.md](actions-token-model.md)がトークンの使い分け・自己ループ防止の
観点でこの話題を扱っているのに対し、本ドキュメントは**名義（誰の操作として記録されるか）**
という観点に絞って整理する。自己ループ防止機構の第2層（Bot判定）は、元々本ドキュメントで扱う
「アプリ経由のラベル操作が`issue-deck[bot]`名義になる」という性質に依存していたが、#566で
アプリ画面経由のラベル操作が個人OAuthトークン化されたことでこの前提は崩れ、代わりに
`<!-- issue-deck:no-trigger -->`マーカー（後述）による対策に置き換わっている。詳細は
[actions-token-model.md](actions-token-model.md)の「2. 自己ループ防止機構（3層構造）」
「第2層: Bot 判定」を参照。

## 名義早見表

| 操作 | 経路 | 使用トークン | GitHub上の名義 |
|---|---|---|---|
| Issue作成 | アプリ画面（`POST /api/issues`） | 操作した人間個人のOAuthトークン（`user.githubAccessToken`） | **操作した人間本人** |
| サブIssue作成（計画の分割、`mode=split`） | `claude-issue-dispatch.yml` | `GITHUB_TOKEN` | `github-actions[bot]` |
| コメント投稿（通常コメント・「Claudeに質問する」・承認/修正ボタン） | アプリ画面（`POST /api/issues/comments`） | 操作した人間個人のOAuthトークン（`user.githubAccessToken`） | **操作した人間本人** |
| コメント投稿（計画提示・実装完了報告・質問への回答等） | `claude-issue-dispatch.yml`ほか | `GITHUB_TOKEN` | `github-actions[bot]` |
| ラベル操作（Issue更新、`PATCH /api/issues`） | アプリ画面 | 操作した人間個人のOAuthトークン（`user.githubAccessToken`） | **操作した人間本人** |
| Issue削除（`DELETE /api/issues`） | アプリ画面 | 操作した人間個人のOAuthトークン（`user.githubAccessToken`） | **操作した人間本人**（GraphQL `deleteIssue`ミューテーションはリポジトリのadmin権限を要求するため、write権限のみのユーザーは失敗しうる） |
| ラベル操作 | GitHub Actions（`issue-labels.yml`等） | `GITHUB_TOKEN` | `github-actions[bot]` |
| ブランチpush・develop向けPR作成 | `claude-issue-dispatch.yml`実装ステップ | `secrets.WORKFLOW_PAT` | PAT所有者個人（現状`m-guchi`固定） |
| develop向けPRの自動マージ | `claude-review-develop.yml` | `secrets.WORKFLOW_PAT` | PAT所有者個人 |
| develop→mainのPR作成・バージョンbump | `release-develop-to-main.yml` | `secrets.WORKFLOW_PAT` | PAT所有者個人 |
| コンフリクト解消コミット | `claude-conflict-resolve.yml` | `secrets.WORKFLOW_PAT` | PAT所有者個人 |

各ワークフローでの`WORKFLOW_PAT`/`GITHUB_TOKEN`の使用箇所の網羅的な棚卸しは
[actions-token-model.md](actions-token-model.md)の「使用箇所の棚卸し」を参照。

## 一致する経路・しない経路

コメント投稿・Issue作成・ラベル操作・Issue削除はいずれもアプリ画面から人間個人のOAuthトークンを
使うため、GitHub上も実際に操作した人間の名義になる。一方、develop向けPR作成・マージは常にPAT
所有者（`m-guchi`）名義になり、**実際に画面を操作した人間が誰であってもこの名義は変わらない**
（現状は事実上ユーザーが`m-guchi`のみのため問題が表面化していない。将来マルチユーザー化する場合は
「実際の操作者が分からなくなる」設計上の制約として残る）。

## コメント投稿元マーカー（同じ名義の中でも「どの処理が投稿したか」を判別する）

上記のとおり`github-actions[bot]`名義には複数の異なるワークフロー・処理（`claude-issue-dispatch.yml`
のClaude Code、`claude-review-develop.yml`のレビュー結果、`claude-conflict-resolve.yml`の
コンフリクト解消、`issue-labels.yml`の純粋なシェルスクリプト）が混在しており、login名だけでは
「Claude Codeが投稿したのか、それ以外の機械的なCI処理が投稿したのか」を判別できない（issue #563）。

これを解決するため、自動投稿コメントの本文末尾に不可視のHTMLコメントマーカーを付与し、
`src/lib/github/comment-source.ts`の`resolveCommentSource()`がそれを読み取って
`comment-thread.tsx`にバッジ表示する仕組みを設けている。判定の優先順位は以下のとおり
（詳細は`comment-source.ts`のコメントを参照）。

1. `<!-- issue-deck-fallback-notice -->`（`fallback-notice.ts`、既存） — 行き詰まり・エラー終了時のフォールバック通知
2. `<!-- issue-deck-qa-answer -->`（`ask-claude.ts`、既存） — 「Claudeに質問する」への回答
3. `<!-- issue-deck-plan-type:implement|split -->`（`comment-source.ts`で新たにTS側の判定関数を用意） — 計画コメント
4. `<!-- issue-deck-source:<id> -->`（`comment-source.ts`で新設） — 上記に該当しない定型コメントの投稿元ワークフロー
   - id一覧: `claude-issue-dispatch` / `claude-review-develop` / `claude-conflict-resolve` / `issue-labels`
   - 4ワークフロー全てで`gh issue comment`によるIssue側への投稿箇所にマーカー付与を適用済み
     （`claude-issue-dispatch.yml`は#563、残り3つは#564で対応）
5. 上記いずれにも該当せずbotログインの場合は「不明な自動投稿」（過去に投稿された、マーカー無しの旧コメントが該当）
6. bot以外のログインの場合はバッジを表示しない

各ワークフローとも、bashで直接組み立てるコメント本文には末尾に直接マーカー文字列を追記し、
Claude Codeへの指示文で本文を組み立てるコメント（計画提示・実装完了報告・質問応答等）は
プロンプト内で「マーカーを必ず付与する」よう指示する形で対応している。`gh pr create` / `gh pr comment`
によるPR側への投稿は、`comment-thread.tsx`が表示するIssueコメントスレッドに現れないためマーカー
付与の対象外。

## ローカルセッションのコメントは本人名義になる（マーカーで表示上ボットへ寄せる）

サブPC・手元のClaude Codeセッション（`scripts/start-issue.sh`・`scripts/start-reviewer.sh`）は
`gh`がユーザー個人の認証で動くため、エージェントが投稿したIssueコメントもGitHub上は**ユーザー本人
名義**になる。無人実行（`github-actions[bot]`名義）と違い、login名からはボットの発言と本人の発言を
区別できない。

そのため`comment-thread.tsx`がlogin名の一致だけで「自分の発言」と判定していた頃は、ローカル
セッションの実装完了報告がユーザー自身の吹き出し（右寄せ）として表示されていた（issue #1346）。
現在は`comment-source.ts`の`isMarkedAutomationComment()`が**本文のマーカーだけ**で自動投稿かを
判定し、自分の名義でも左寄せのボット表示にしている。

- ローカルセッションのプロンプト（`scripts/prompts/implementation-agent.md`・
  `generic-implementation-agent.md`・`review-agent.md`）が、投稿するコメントの末尾に
  `<!-- issue-deck-agent:planner|implementer|reviewer -->`を付けるよう指示している
- 判定に使うのは**マーカーが明示された種別だけ**。書き出しの絵文字による推測（`emoji-fallback`）は
  含めない。含めるとユーザー本人が🔧などで書き始めたコメントまでボット扱いになる
- 役割を持たない`<!-- issue-deck-source:project-status-dispatch -->`は対象外。カンバンのドラッグ
  起点の起動コメントは、逆に**操作した人間へ寄せて**表示する（#1026・前掲の`posted-by`マーカー）
- **プロンプト遵守が前提の仕組みで、強制はできない。** マーカーの無いコメント（この対応より前の
  ローカルセッションの投稿を含む）は従来どおり本人の発言として右寄せで表示される

## `no-trigger`マーカー（ワークフロー起動条件の除外。投稿元マーカーとは別概念）

上記の「コメント投稿元マーカー」は投稿されたコメントが**どの処理由来か**を判別してUI表示に使う
ためのものだが、`<!-- issue-deck:no-trigger -->`（`src/lib/github/approval-labels.ts`）は
**そのコメント自体が`claude-issue-dispatch.yml`の起動条件を満たさないようにする**ためのマーカーで、
目的・作用先が異なる（コメント自体は通常どおり投稿・表示され、UI上のバッジ表示にも影響しない）。

#566でラベル操作が個人OAuthトークン化されたことにより、アプリの承認・修正ボタンが行う
「ラベル更新→確認コメント投稿」のうち、ラベル更新（`issues.unlabeled`イベント）がGitHub上
操作した本人の操作として記録されるようになった。`21.plan-required`保持時（ブランチ未作成の
計画承認・練り直し）はこのラベル除去イベント単独で実装再開に必要な情報が揃うため、続けて送る
確認コメント（`issue_comment`イベント）が同じ操作を二重にトリガーしてしまう。この場合に限り
`approveCommentBody`/`rejectCommentBody`がコメント本文に`no-trigger`マーカーを付与し、
`claude-issue-dispatch.yml`の`issue_comment`トリガーの`if:`条件がこのマーカー付きコメントを
起動対象から除外することで、ラベル除去イベント側のみを正規のトリガーとする。詳細は
[actions-token-model.md](actions-token-model.md)の「第2層: Bot 判定」を参照。

## デッドコードの疑い

`src/lib/github/issue-mapper.ts`の`POSTER_MARKER_PATTERN`／`stripPosterMarker`、および
`claude-issue-dispatch.yml`の`state`ステップ（自己ループ防止の第2層）にある投稿者マーカー
（`<!-- issue-deck:posted-by:<login> -->`）復元ロジックは、コメント本文末尾にこのマーカーが
付与されている前提で書かれている（`claude-issue-dispatch.yml`のコメントには
「`src/app/api/issues/comments/route.ts`のPOSTで付与」と明記されている）。

しかし実際の`POST /api/issues/comments`（`src/app/api/issues/comments/route.ts`）はこの
マーカーを本文に付与していない。承認ボタン押下時のコメントも同じPOSTエンドポイントを経由し
人間個人のOAuthトークンで投稿されるため、GitHub上の名義自体が既に本人になっており、マーカー
方式に頼らず自己ループ防止の第2層（Bot判定）を素通りできる設計になっている
（`src/lib/github/approval-labels.ts`のコメント、issue #173 参照）。

そのため、マーカー関連のコード・ワークフローロジックは現状**実質的に到達しないデッドコードに
なっている可能性が高い**。削除するかどうかは自己ループ防止という安全機構に関わる部分のため、
本ドキュメントでは事実の記録に留め、削除の判断・実施は別Issueとする。

#566でラベル操作も個人OAuthトークン化されたが、この`posted-by`マーカーは`POST /api/issues/comments`
（コメント投稿）専用のものであり今回の変更対象外のため、上記の状況（実質到達しないデッドコードの
疑い）に変化はない。
