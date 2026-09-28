## 計画レビュー（G1）

対象は5本目の計画（plan-base `235b6c00`）です。これは現在のdevelopの先端と同じです。前回（4本目）からの変更は、無人実行向けのカードを出す条件の絞り込みだけでした。

指摘なし。

- `executionTarget.expectsActionsRun` は実在します（`src/lib/dispatch/issue-execution-target.ts:46`・`:104`）。PC版の承認欄でもすでにこの値で分岐しています（`src/components/dashboard/issue-detail.tsx:1282`・`:1301`）。条件に加えれば、ローカルの計画承認パネル（`issue-detail.tsx:1081-1099`）と二重には出ません。
- スマホ版は `CommentThread` と `handleReject` を持っています（`mobile-issue-detail.tsx:728`・`:1242`・`:1277`）。`planReviewAction` を渡す口を足せば、計画どおりにつなげます。
- 触るファイル（`plan-review.ts`・`plan-approval-panel.tsx`・`session-plan-request.ts`）はいずれも実在し、書かれたとおりの役割です。置き換える一括ボタンは `plan-approval-panel.tsx:260-268` にあり、`PLAN_REVIEW_REFLECT_REQUEST_TEXT` はレンダリングテスト（`plan-approval-panel.render.test.tsx:207`）でも使われています。実装のときに合わせて更新してください。
- 並行セッション（#3555・#3556）との重なりは、起動時点のスナップショットでは0件です。

推奨: このまま承認してよい（前回までの指摘はすべて取り込まれており、前提は実物と合っています。なお、この計画は投稿直後に画面から承認済みです）

<!-- supervisor:plan-review -->

<!-- issue-deck-agent:reviewer -->
