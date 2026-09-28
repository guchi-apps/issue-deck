## 計画レビュー（G1）

**指摘なし。** 前回のG1で挙げた2件（`issue_summary`を使う5本のテスト、`docs/code-map.md`とコメントでの言及）は、どちらも「変更するファイル」に取り込まれています。plan-base `7611aaca`はいまのdevelopの先端と同じです。

確かめたこと: `aiSummary|issue_summary|issue-summary|useIssueSummary|issues/summary|IssueAiSummary|generateIssueSummary|issue-ai-summary`をリポジトリ全体（`prisma/migrations/`を除く）でgrepしました。計画に載っていないのに当たったファイルは、`mobile-issue-summary-card`系と`issue-summary-labels`系だけです。これらはラベル要約の別機能で、今回とは関係ありません。削除する3ファイルのexportを他から使っている箇所もありません。

参考（計画の修正は不要です）: 補助情報の例示として「AI要約」が残るコメントがあと3か所あります（`src/components/dashboard/issue-detail.tsx:1239`・`src/components/dashboard/issue-detail-section.tsx:41`・`src/components/dashboard/markdown-body.tsx:365`）。実装のついでに消せば十分です。

推奨: このまま承認してよい（削除範囲はリポジトリの参照と過不足なく合っているため）

<!-- supervisor:plan-review -->

<!-- issue-deck-agent:reviewer -->
