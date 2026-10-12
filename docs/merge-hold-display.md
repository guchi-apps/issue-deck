# 自動マージの保留理由の表示と要修正PRのマージ確認（#4377）

**いつ読むか**: PR一覧・詳細・ブランチ画面の「自動マージ保留」表示や、要修正PRの「マージする」の確認画面・サーバー側ガードを触るとき。

## 保留理由の表示

- 導出は純関数`deriveMergeHold`（`src/lib/pull-request-merge-hold.ts`）。材料はPRが既に持つ状態（`linkedIssueNumber`・`linkedIssueCheckUser/Reason`・`reviewVerdict`・`mergeJudgement`）だけで、**ワークフローが実際にスキップした記録は持たない**。表示は「いまの状態から判定すると保留になる」根拠。
- 状態は4つ。`held`（理由が確定）・`pending`（判定ジョブ実行中）・`unknown`（判定を読めない）・`none`。**`unknown`を保留理由の確定や成功に置き換えない。**
- DBスキーマ変更などの具体的理由は、読める根拠（Issueの`01.check-*`理由ラベル等）が無い限り出さない。PR本文の「確認不要」は読まない。
- 表示部品は`MergeHoldNotice`（`pull-request-merge-hold.tsx`）。一覧・詳細・ブランチ画面・確認ダイアログで共通。

## 要修正PRのマージ確認

- 全入口が共通の`PullRequestMergeButton`。判定が要修正・要確認（現在のHEAD、または判定時点が不明）のPRでは確認画面（`PullRequestMergeReviewGate`）を必ず通す。主操作は「PRを自動修正」（#3970の`/api/pull-requests/repair`）、「修正せずマージする」は確認チェック後のみ。閉じる・戻るでは実行しない。
- 確認は画面を開いたときに取り直したHEADのSHA（`/api/pull-requests/review`が返す`headSha`）に紐付けて`acknowledgeReviewSha`で送る。
- サーバー（`POST /api/issues/pull-request-merge`）は`evaluateReviewMergeGuard`で、要修正・要確認（判定が`current`または`unknown`）かつ確認が無い／HEAD不一致なら409`review_confirmation_required`。`stale`（判定後にコミットが積まれた）と判定が読めない場合は塞がない。リリース検証ゲートを先に評価し、`acknowledgeVerification`とは独立。確認時は`sha`付きでGitHubのマージAPIを呼び、追いコミットを巻き込まない。

## レビュー要確認・要修正PRの主操作（#4482）

要確認（needs-check）は`repairKindsFor`の`review`に入らない（`claude-review-fix.yml`は手動実行でも要修正のコメントしか拾わず、要確認では何もせずに終わる）。そのためCI成功・競合なしの要確認PRでは修正ボタンが消え、「マージする」だけが強調されていた。

- 判定は純関数`deriveReviewAction`（`src/lib/pull-request-review-action.ts`）が1か所で持ち、PR詳細の上部と指摘タブの対応パネル（`PullRequestReviewResponse`）はこの結果だけから作る。状態は`respond`（対応を選ぶ）・`repairing`（自動修正中）・`requested`（現在のHEADへ依頼済み）・`stale`（判定が前のHEAD＝再レビュー待ち）・`none`。
- 上部は代表状態の下に指摘の要点（最大3件）と「指摘に対応する」を出す。要修正で自動修正が使えれば従来どおり「PRを自動修正」が先。未解決の間は「マージする」を枠線（副操作）にし、保留理由と「ユーザーのマージが必要です」は「マージについて（詳細）」へ畳む。
- 対応パネルの「AIに修正を依頼」は`POST /api/pull-requests/fix-request`から、IssueDeck Chatと共用の`requestPullRequestFix`（#4045）を`source: "pull-request-detail"`で呼ぶ。紐づくIssueへ利用者本人のトークンで`@claude`コメントを書き、dispatchが同じブランチを直してpushする（CI・再レビューはpushを契機に走る）。方針は任意で、方針の無い判断は推測で直さず質問させる文面にしてある。新しいIssue・PRは作らない。
- 依頼済みは、依頼コメントの印`<!-- issue-deck-chat-fix-request:<key> sha=<HEAD> -->`を`GET /api/pull-requests/detail`が`reviewResponse.currentFixRequest`として返して判定する（要修正・要確認のレビュー判定が付いたopenなPRでだけIssueコメントを1回読む）。HEADが進めば前の依頼は「現在の依頼」ではなくなり、新しいHEADのCI・再レビューの結果で判断する。
- **紐づくIssueに`11.local`が付いていると、dispatchは`@claude`に反応しない。** 画面は依頼ボタンの代わりに理由と「Issueを開く」を出し、サーバー（`requestPullRequestFix`）も`local_session`で拒否する。**Issueがclosedのときも同じ**で、dispatchは`ISSUE_CLOSED`で黙って`skip`するため、`issue_closed`で拒否して「修正Issueを起案」を出す（計画レビューの指摘）。`issue-<番号>`以外のブランチは依頼先が無いため「修正Issueを起案」を出す。
- 「修正せずにマージへ進む」は上の確認画面（`PullRequestMergeReviewGate`）を必ず通る。マージ確認・必須チェック・本人の判断は省略しない。
