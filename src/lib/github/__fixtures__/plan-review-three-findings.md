## 計画レビュー（G1）

対象は2本目の計画（計画レビュー向けに練り直したもの）です。plan-base `7611aaca` は今のdevelopの先端と同じです。触るファイルの `src/lib/github/plan-review.ts`・`session-plan-request.ts`・`plan-approval-panel.tsx`・3つのプロンプトはすべて実在し、#3521の「レビューが届いています」1行＋一括ボタンを置き換えるという前提も実物と合っています。

**1. 反映・見送りの一覧を載せた修正依頼は、2000文字の上限で400になりうる**

- **指摘**: 新しいボタンは「反映・見送りの一覧を含む修正依頼」を `decidePlan` の `revise` として送ります。この本文には上限があり、超えるとサーバー側で弾かれます。指摘の提案や根拠を引用して組み立てると、3件程度でも上限に届きます。
- **根拠**: `src/lib/dispatch/session-plan-request.ts:62`（`SESSION_PLAN_REVISION_MAX_LENGTH = 2000`）、`:128`（`parseSessionPlanRevision` は本文が上限を超えると `null` を返す）。送り先は `plan-approval-panel.tsx:120-127` の `send("revise", text)` です。
- **提案**: 組み立て関数は、指摘の見出しと判断・見送り理由だけを載せてください。本文そのものは「`supervisor:plan-review` のコメントを読め」と参照させます（既存の `PLAN_REVIEW_REFLECT_REQUEST_TEXT`（`:76`）と同じやり方です）。あわせて、上限内に収まることをテストで固定してください。

**2. 無人実行の経路の「既存の修正」は `comment-thread.tsx` の中にあり、変更するファイルに入っていない**

- **指摘**: 無人実行の承認欄の「修正」ボタンと入力欄は、`CommentThread` 内部の承認カードが持っています。入力値も内部のstate（`text`）で管理しているため、外から「選んだ内容を載せる」ことはできません。
- **根拠**: `src/components/dashboard/comment-thread.tsx:239-245`（`submitReject` が内部の `text` を `onReject` へ渡す）、`:443-466`（入力欄と「修正」ボタン）。カードを差し込める口は `planReviewAction`（`:321`・`:363`。`issue-detail.tsx:1295-1301` から渡している）だけです。
- **提案**: 次のどちらかに決め、計画に書いてください。(a) カード自身に送信ボタンを持たせ、`issue-detail.tsx` 側の `onReject` と同じハンドラを呼ぶ。(b) `comment-thread.tsx` を変更対象に加え、入力欄へ初期値を流し込む口を足す。あわせて、`mobile-issue-detail.tsx` にも同じ渡し方が要るか確認してください。

**3. プロンプト変更に伴う `templates.generated.ts` の再生成は不要**

- **指摘**: 軽微な点です。生成元は `generic-implementation-agent.md` だけで、計画レビューのプロンプトは生成物に入りません。
- **根拠**: `scripts/generate-prompt-templates.mjs:32`（`GENERIC_IMPLEMENTATION_AGENT_TEMPLATE` の1件だけ）。`src/lib/prompts/templates.generated.ts` の見出しも `:4` の1つだけです。
- **提案**: 変更するファイルから外してください。一方で、書式の指示は `scripts/prompts/codex-plan-review-supplement.md`（Codexで計画レビューを回すときの補足）には無いので、手を入れなくて構いません。

推奨: 修正のうえ承認。修正依頼文を2000文字以内に収める組み立て方と、無人実行の経路でボタンをどこに置くか（`comment-thread.tsx` を触るかどうか）の2点を計画に書き足せば進められます。

<!-- supervisor:plan-review -->

<!-- issue-deck-agent:reviewer -->
