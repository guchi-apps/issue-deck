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
