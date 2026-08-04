# GitHub上の操作名義（誰が誰として記録されるか）

issue-deckが行う各種操作（Issue作成・コメント投稿・ラベル操作・ブランチpush・PR作成）が、
実際にGitHub上で**誰の名義として記録されるか**を整理する。

発端は issue #364。「コメントの投稿者が誰名義になるのか」を確認する過程で、経路ごとに
「実際に操作した人間」と「GitHub上の記録名義」が一致したりしなかったりすることが分かった
ため、その整理を残す。

[docs/actions-token-model.md](actions-token-model.md)がトークンの使い分け・自己ループ防止の
観点でこの話題を扱っているのに対し、本ドキュメントは**名義（誰の操作として記録されるか）**
という観点に絞って整理する。自己ループ防止機構の第2層（Bot判定）は本ドキュメントで扱う
「アプリ経由のラベル操作が`issue-deck[bot]`名義になる」という性質に依存している。詳細は
[actions-token-model.md](actions-token-model.md)の「2. 自己ループ防止機構（3層構造）」
「第2層: Bot 判定」を参照。

## 名義早見表

| 操作 | 経路 | 使用トークン | GitHub上の名義 |
|---|---|---|---|
| Issue作成 | アプリ画面（`POST /api/issues`） | GitHub Appインストールトークン（`src/app/api/issues/route.ts`） | `issue-deck[bot]`（操作した人間によらず固定） |
| サブIssue作成（計画の分割、`mode=split`） | `claude-issue-dispatch.yml` | `GITHUB_TOKEN` | `github-actions[bot]` |
| コメント投稿（通常コメント・「Claudeに質問する」・承認/修正ボタン） | アプリ画面（`POST /api/issues/comments`） | 操作した人間個人のOAuthトークン（`user.githubAccessToken`） | **操作した人間本人** |
| コメント投稿（計画提示・実装完了報告・質問への回答等） | `claude-issue-dispatch.yml`ほか | `GITHUB_TOKEN` | `github-actions[bot]` |
| ラベル操作 | アプリ画面 | GitHub Appインストールトークン | `issue-deck[bot]` |
| ラベル操作 | GitHub Actions（`issue-labels.yml`等） | `GITHUB_TOKEN` | `github-actions[bot]` |
| ブランチpush・develop向けPR作成 | `claude-issue-dispatch.yml`実装ステップ | `secrets.WORKFLOW_PAT` | PAT所有者個人（現状`m-guchi`固定） |
| develop向けPRの自動マージ | `claude-review-develop.yml` | `secrets.WORKFLOW_PAT` | PAT所有者個人 |
| develop→mainのPR作成・バージョンbump | `release-develop-to-main.yml` | `secrets.WORKFLOW_PAT` | PAT所有者個人 |
| コンフリクト解消コミット | `claude-conflict-resolve.yml` | `secrets.WORKFLOW_PAT` | PAT所有者個人 |

各ワークフローでの`WORKFLOW_PAT`/`GITHUB_TOKEN`の使用箇所の網羅的な棚卸しは
[actions-token-model.md](actions-token-model.md)の「使用箇所の棚卸し」を参照。

## 一致する経路・しない経路

コメント投稿はアプリ画面から人間個人のOAuthトークンを使うため、GitHub上も実際に操作した
人間の名義になる。一方、Issue作成・ラベル操作（アプリ経由）は常に`issue-deck[bot]`、
develop向けPR作成・マージは常にPAT所有者（`m-guchi`）名義になり、**実際に画面を操作した
人間が誰であってもこの名義は変わらない**（現状は事実上ユーザーが`m-guchi`のみのため
問題が表面化していない。将来マルチユーザー化する場合は「実際の操作者が分からなくなる」
設計上の制約として残る）。

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
