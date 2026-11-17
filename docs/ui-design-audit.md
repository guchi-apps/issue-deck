# UIデザインの静的検出：リポジトリ全体の走査結果（#5465）

`node scripts/check-ui-design.mjs --report src` の結果（このリポジトリの`src/`。**変更はしていない**）。
検出の仕組みと除外の書き方は [ui-design-lint.md](ui-design-lint.md)。右端の「仕分け」は、
後続の是正Issue（#5464の子）で人が「装飾」か「意味あり」かを埋める欄で、ここでは空欄にしてある。

仕分けの目安は共有知識`standards/ui-design.md`の「意味を伝えている使い方は許容する」。
一覧を見た範囲では、`src/components/ui/`の影（メニュー・ダイアログ・トースト）は浮き上がる要素なので意味あり、
`notification-settings-section.tsx`の左線は状態の一件を示す通知で意味ありに寄るが、
全件を装飾か意味ありかに決めるのは是正Issueで行う。

## ルール別の件数

| ルール | 件数 |
|---|---|
| side-border | 10 |
| gradient | 4 |
| emoji-icon | 73 |
| heavy-shadow | 10 |
| 除外済み（design-ok） | 0 |

## 一覧

| ファイル:行 | ルール | 該当行 | 仕分け（装飾／意味あり） |
|---|---|---|---|
| `src/app/globals.css:263` | gradient | `background-image: linear-gradient(` | |
| `src/components/app-update-checker.tsx:84` | heavy-shadow | `<div className="fixed inset-x-4 bottom-4 z-50 flex items-center justify-between gap-3 rounded-lg border bg-foreground px` | |
| `src/components/dashboard/dependency-wait-panel.tsx:141` | emoji-icon | `<span aria-hidden>{r.satisfied === true ? "✅" : r.satisfied === false ? "⏳" : "❓"}</span>` | |
| `src/components/dashboard/fleet-repository-row.tsx:59` | side-border | `<p className="basis-full border-l-2 border-destructive/40 pl-1.5 break-words text-destructive">` | |
| `src/components/dashboard/image-annotation-dialog.tsx:842` | heavy-shadow | `className="absolute inset-x-3 top-16 mx-auto flex max-w-md flex-col gap-3 rounded-xl border border-white/15 bg-neutral-9` | |
| `src/components/dashboard/mention-textarea.tsx:562` | gradient | `<span className="absolute inset-x-0 bottom-0 truncate bg-linear-to-t from-black/80 to-transparent px-1 pt-2 pb-0.5 text-` | |
| `src/components/dashboard/mobile/mobile-screen-fab.tsx:29` | heavy-shadow | `className="relative flex size-14 items-center justify-center rounded-full border bg-background shadow-lg"` | |
| `src/components/dashboard/mobile/mobile-screen-fab.tsx:42` | heavy-shadow | `className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"` | |
| `src/components/dashboard/nightly-run-panel.tsx:311` | side-border | `className="inline-block h-2 w-3.5 shrink-0 border-l-2 border-amber-500"` | |
| `src/components/dashboard/nightly-run-panel.tsx:427` | side-border | `className="absolute inset-y-0 right-0 border-l-2 border-amber-500"` | |
| `src/components/dashboard/plan-approval-panel.tsx:259` | gradient | `<div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-b from-transparent to-muted pt-8 pb-2">` | |
| `src/components/dashboard/pull-request-merge-review.tsx:92` | emoji-icon | `✅ 記録済み{acknowledgement.recordedBy ? '（記録: ${acknowledgement.recordedBy}）' : ""}` | |
| `src/components/dashboard/question-answer-panel.tsx:339` | gradient | `<div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-b from-transparent to-muted pt-8 pb-2">` | |
| `src/components/dashboard/release-history-panel.tsx:938` | side-border | `<section className="mt-2 rounded border-l-2 border-red-500/40 pl-2">` | |
| `src/components/dashboard/scroll-to-latest-comment-button.tsx:67` | heavy-shadow | `className={cn("absolute z-10 rounded-full shadow-lg", className)}` | |
| `src/components/dashboard/settings/notification-settings-section.tsx:125` | side-border | `<p className="rounded-md border border-l-2 border-amber-300 border-l-amber-500 bg-amber-50 p-3 text-xs leading-relaxed t` | |
| `src/components/dashboard/settings/notification-settings-section.tsx:145` | side-border | `<p className="rounded-md border border-l-2 border-amber-300 border-l-amber-500 bg-amber-50 p-3 text-xs leading-relaxed t` | |
| `src/components/dashboard/settings/notification-settings-section.tsx:161` | side-border | `<p className="rounded-md border border-l-2 border-destructive/40 border-l-destructive bg-destructive/5 p-3 text-xs leadi` | |
| `src/components/dashboard/settings/notification-settings-section.tsx:169` | side-border | `<p className="rounded-md border border-l-2 border-amber-300 border-l-amber-500 bg-amber-50 p-3 text-xs leading-relaxed t` | |
| `src/components/dashboard/settings/notification-settings-section.tsx:326` | side-border | `<p className="rounded-md border border-l-2 border-destructive/40 border-l-destructive bg-destructive/5 p-3 text-xs leadi` | |
| `src/components/dashboard/settings/notification-settings-section.tsx:338` | side-border | `<p className="rounded-md border border-l-2 border-amber-300 border-l-amber-500 bg-amber-50 p-3 text-xs leading-relaxed t` | |
| `src/components/loading-screen.tsx:104` | heavy-shadow | `<div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs shadow` | |
| `src/components/ui/alert-dialog.tsx:57` | heavy-shadow | `"fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100%-2rem)] w-full max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 overfl` | |
| `src/components/ui/dropdown-menu.tsx:247` | heavy-shadow | `className={cn("z-50 min-w-[96px] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-lg bg-p` | |
| `src/components/ui/sheet.tsx:65` | heavy-shadow | `"fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg transition duration` | |
| `src/components/ui/toast.tsx:39` | heavy-shadow | `"pointer-events-auto relative flex w-full items-start gap-2 rounded-xl bg-popover p-3 text-sm text-popover-foreground ri` | |
| `src/lib/chat/investigation/reply.ts:266` | emoji-icon | `text = '${text}\n\n⚠️ 調査を途中で止めました: ${displayReason(result.stopReason)}。上の内容は、ここまでに確認できた範囲です。';` | |
| `src/lib/deploy-launch.ts:187` | emoji-icon | `"🚀 **本番デプロイ（'deploy.yml'）を起動し直しました。**",` | |
| `src/lib/deploy-launch.ts:211` | emoji-icon | `"⚠️ **本番デプロイ（'deploy.yml'）が起動しておらず、起動し直しにも失敗しました。**",` | |
| `src/lib/dispatch/plan-review-auto-reflect.ts:93` | emoji-icon | `"🔁 **計画レビューの指摘を自動で反映するよう、セッションへ修正を送りました。**",` | |
| `src/lib/dispatch/plan-review-auto-reflect.ts:270` | emoji-icon | `const lines = ["⚠️ **解消確認の後も、重大な問題または人の判断が残っています。自動の修正はここで止めました。**", ""];` | |
| `src/lib/dispatch/plan-review-kind.ts:93` | emoji-icon | `return ['🔎 **計画レビュー（${title}）を依頼しました。** ${reason}', "", marker].join("\n");` | |
| `src/lib/dispatch/plan-review-kind.ts:98` | emoji-icon | `"🛑 **計画レビューの自動実施はここまでです。** 初回レビューと解消確認の1回ずつを終えているため、自動で全体レビューを繰り返しません。",` | |
| `src/lib/dispatch/pr-review-jobs.ts:231` | emoji-icon | `'⚠️ サブPCのAIレビューが終わりましたが、最終マージ判定を自動で再開できませんでした（${describePrReviewGateState(resolvePrReviewGateState(job))}）。' +` | |
| `src/lib/dispatch/session-escalation.ts:50` | emoji-icon | `"⚠️ このIssueの実装セッションが異常終了しました。",` | |
| `src/lib/dispatch/session-escalation.ts:73` | emoji-icon | `"⏳ このIssueの実装セッションが、Claude Codeの起動確認で止まっている可能性があります。",` | |
| `src/lib/dispatch/session-escalation.ts:250` | emoji-icon | `"⚠️ このIssueの実装セッションが、ツールを呼び出そうとした形跡はあるものの、実際には",` | |
| `src/lib/dispatch/session-escalation.ts:255` | emoji-icon | `"⚠️ このIssueの実装セッションが、計画ファイルを書いたまま計画を提示せずに応答を終えています。",` | |
| `src/lib/dispatch/session-escalation.ts:260` | emoji-icon | `"⚠️ このIssueの実装セッションが、文章での問いかけで応答を終えています（'AskUserQuestion'は",` | |
| `src/lib/dispatch/session-escalation.ts:265` | emoji-icon | `"⚠️ このIssueの実装セッションが、auto modeのクラシファイアにコマンドを拒否されたまま",` | |
| `src/lib/dispatch/session-escalation.ts:270` | emoji-icon | `"⚠️ このIssueのCodexセッションが、ターンを完了しないまま止まっています。",` | |
| `src/lib/dispatch/session-escalation.ts:274` | emoji-icon | `"🔑 サブPCのClaude Codeのログインが切れています（'Login reached its time limit · Please run /login'）。",` | |
| `src/lib/dispatch/session-escalation.ts:277` | emoji-icon | `: ["⚠️ このIssueの実装セッションが、APIエラーで中断したまま止まっています。"];` | |
| `src/lib/dispatch/session-plan-request.ts:440` | emoji-icon | `lines.push("✅ **計画を承認しました**（issue-deckの画面から）。セッションは実装へ進みます。");` | |
| `src/lib/dispatch/session-plan.ts:185` | emoji-icon | `lines.push('🗒️ **計画を提示しました。** ${where}が承認を待っています。', "");` | |
| `src/lib/dispatch/session-plan.ts:190` | emoji-icon | `"🎨 **アーティファクトも更新しました。** Issue詳細の「アーティファクト」カードで今の見た目を確認できます。",` | |
| `src/lib/dispatch/session-question-request.ts:418` | emoji-icon | `lines.push("🙋 **質問に回答しました**（issue-deckの画面から）。", "");` | |
| `src/lib/dispatch/session-start.ts:53` | emoji-icon | `'🖥️ **${where}のローカルセッションで対応を開始します。**',` | |
| `src/lib/dispatch/session-wrapup.ts:98` | emoji-icon | `'⚠️ **${where}のローカルセッションが終了しましたが、このIssueには記録が残っていません。**',` | |
| `src/lib/epic-draft/report.ts:21` | emoji-icon | `'✅ 親子Issueとして起案しました（実行計画 v${outcome.planVersion}）。',` | |
| `src/lib/epic-draft/report.ts:53` | emoji-icon | `'⚠️ 親子Issueの起案は完了していません。止まった段階: ${STAGE_LABEL[outcome.stage]}（${outcome.message.slice(0, 200)}）',` | |
| `src/lib/github/code-review-close-sweep.ts:92` | emoji-icon | `'✅ 指摘${total}件がすべて対応済み（指摘から起票したIssueがすべてcloseされている）ため、このレビューIssueをcloseしました。',` | |
| `src/lib/github/comment-source.ts:123` | emoji-icon | `["🔍", "planner"],` | |
| `src/lib/github/comment-source.ts:124` | emoji-icon | `["🔧", "implementer"],` | |
| `src/lib/github/comment-source.ts:125` | emoji-icon | `["🔀", "splitter"],` | |
| `src/lib/github/conflict-check-user-clear.ts:102` | emoji-icon | `'✅ 対象PR（${pullRequestUrl}）のdevelopとのコンフリクトが解消されていることを確認したため、コンフリクト自動解消で付いていた確認待ち（\'00.check-user\'）を外しました。',` | |
| `src/lib/github/progress-sweep.ts:499` | emoji-icon | `'⚠️ developへ入っていないコミットが \'${branch}\' に残っています。',` | |
| `src/lib/github/progress-sweep.ts:518` | emoji-icon | `'✅ developへのマージが完了しました: ${pullRequestUrl}',` | |
| `src/lib/github/progress-sweep.ts:667` | emoji-icon | `'✅ 本番（\'main\'）への反映を確認し、進捗を Done へ進めました: ${pullRequestUrl}',` | |
| `src/lib/github/progress-sweep.ts:787` | emoji-icon | `? "✅ 本番（'main'）への反映を確認し、進捗を Done へ進めてIssueをcloseしました。"` | |
| `src/lib/github/progress-sweep.ts:788` | emoji-icon | `: "✅ 進捗が Done（本番反映済み）のままopenで残っていたため、Issueをcloseしました。";` | |
| `src/lib/github/progress-sweep.ts:871` | emoji-icon | `"⚠️ 本番（'main'）への反映を判定できませんでした。進捗は動かしていません。",` | |
| `src/lib/github/pull-request-review-verdict.ts:44` | emoji-icon | `const LABEL_MARKS = ["✅", "⚠️", "❌", "—", "?"] as const;` | |
| `src/lib/github/release-verification.ts:99` | emoji-icon | `{ mark: "✅", kind: "ok" },` | |
| `src/lib/github/release-verification.ts:100` | emoji-icon | `{ mark: "⚠️", kind: "needs-check" },` | |
| `src/lib/github/release-verification.ts:101` | emoji-icon | `{ mark: "❌", kind: "changes-requested" },` | |
| `src/lib/github/release-verification.ts:134` | emoji-icon | `if (cell.startsWith("⚠️")) {` | |
| `src/lib/github/release-verification.ts:135` | emoji-icon | `return { kind: "hit", label: cell.slice("⚠️".length).trim() \|\| cell };` | |
| `src/lib/github/review-acknowledgement.ts:41` | emoji-icon | `"needs-check": "⚠️",` | |
| `src/lib/github/review-acknowledgement.ts:42` | emoji-icon | `"changes-requested": "❌",` | |
| `src/lib/github/review-acknowledgement.ts:134` | emoji-icon | `return '✅ 確認済み（元の判定: ${VERDICT_LABEL[verdict]}${by}）';` | |
| `src/lib/github/review-acknowledgement.ts:181` | emoji-icon | `const acknowledged = parseAcknowledgedCell(cell.replace(/^✅\s*/, ""));` | |
| `src/lib/ios-distribution-failure.ts:141` | emoji-icon | `return '⚠️ **iOS配布がもう一度失敗しました。**` | |
| `src/lib/ios-distribution-failure.ts:150` | emoji-icon | `return '✅ **iOS配布が成功しました。** 自動でクローズします。` | |
| `src/lib/knowledge-board.ts:437` | emoji-icon | `const match = /^\s*[-*]\s*(✅\|❌)\s*(?:承認\|却下)\s*[:：]\s*(.+)$/.exec(lines[i]);` | |
| `src/lib/knowledge-board.ts:440` | emoji-icon | `const verdict = match[1] === "✅" ? "approved" : "rejected";` | |
| `src/lib/manual-step-body-check.ts:455` | emoji-icon | `"⚠️ 本文の書式が、issue-deckの手作業アシスタントが読む形から外れています。**このIssueの起票を止めるものではありません**が、直さないと下記の機能がそのIssueでは働きません。",` | |
| `src/lib/manual-step-body-check.ts:457` | emoji-icon | `...ordered.map((finding) => '- ${finding.severity === "error" ? "❌" : "⚠️"} ${finding.message}'),` | |
| `src/lib/manual-step-trouble.ts:99` | emoji-icon | `"⚠️ **手作業でつまずきました。**",` | |
| `src/lib/new-app/launch-marker.ts:203` | emoji-icon | `return '🚀 **${params.displayName}（\'${params.repositoryFullName}\'）の立ち上げも、この作業を待っています。**` | |
| `src/lib/slack/classify.ts:8` | emoji-icon | `const THANKS = /^(?:\s*(?:ありがとう(?:ございます\|ございました)?\|感謝(?:します)?\|助かり(?:ます\|ました)\|了解(?:です\|しました)?\|承知(?:しました)?\|ok(?:ay)?\|thanks?\|t` | |
| `src/lib/slack/intake.ts:242` | emoji-icon | `await reply(ctx, accepted.request, "⚠️ この返信を処理できませんでした（Issueは変更していません）。もう一度返信してください。").catch(` | |
| `src/lib/slack/intake.ts:366` | emoji-icon | `'⚠️ 完了していません。\n• 段階: ${stage}\n• 理由: ${reason}\n• 未完了: ${options.unfinished}\n• 再試行: ${options.retryable ? "できます" : "そのま` | |
| `src/lib/slack/intake.ts:511` | emoji-icon | `await reply(ctx, request, "⚠️ 会話の記録が見つからず、質問に答えられませんでした。IssueDeckのチャットから確認してください。");` | |
| `src/lib/slack/intake.ts:525` | emoji-icon | `await reply(ctx, request, "⚠️ 質問への回答に失敗しました。もう一度送ってください。");` | |
| `src/lib/slack/intake.ts:570` | emoji-icon | `await reply(ctx, request, '✅ ${label}を <https://github.com/${target.repo}/issues/${target.number}\|${target.repo}#${targe` | |
| `src/lib/slack/intake.ts:625` | emoji-icon | `await reply(ctx, request, "⚠️ 対象のリポジトリがまだ選ばれていません。選択メニューで選んでから、もう一度押してください。");` | |
| `src/lib/slack/intake.ts:635` | emoji-icon | `await reply(ctx, request, '⚠️ ${chosen} には起案できません（接続済みで権限のあるリポジトリではありません）。選び直してください。');` | |
| `src/lib/slack/intake.ts:708` | emoji-icon | `await reply(ctx, request, '✅ この投稿は既に <${existing.htmlUrl}\|${repo}#${existing.number}>（${existing.state === "OPEN" ? "ope` | |
| `src/lib/slack/intake.ts:757` | emoji-icon | `await reply(ctx, request, '⚠️ 新しいIssueは作りませんでした（既に対応中・対応済みの内容か、案にまとめる情報が足りない場合です）。\n${result.text}\n\n追加の情報をこのスレッドへ返信すると` | |
| `src/lib/slack/intake.ts:783` | emoji-icon | `'✅ 同じ内容を扱っていそうな既存のIssueがあるため、新しいIssueは作りませんでした。\n${duplicates.map((d) => '• <${d.htmlUrl}\|${repo}#${d.number} ${d.title}` | |
| `src/lib/slack/intake.ts:923` | emoji-icon | `await reply(ctx, request, "⚠️ この環境（プレビュー）では書き込みを止めています。");` | |
| `src/lib/slack/intake.ts:983` | emoji-icon | `await reply(ctx, request, "⚠️ 起案確定の完了を確認できませんでした。依頼と確認した操作は保存済みです。30分以上停止した処理は巡回が既存Issue・コメントを確認して再開します。");` | |
| `src/lib/slack/intake.ts:1092` | emoji-icon | `if (!ref) return "✅ 完了しました。";` | |
| `src/lib/slack/intake.ts:1094` | emoji-icon | `if (ref.role === "reused") return '✅ 依頼を ${link} への追記として確認しました（新しいIssueは作っていません）。';` | |
| `src/lib/slack/intake.ts:1095` | emoji-icon | `const lines = ['✅ こういう内容で起案しました。', '• 対象: ${ref.repo}'];` | |
| `src/lib/slack/intake.ts:1166` | emoji-icon | `'✅ 同じ内容を扱っていそうな既存のIssueがあるため、親子Issueは作りませんでした。\n${lines.join("\n")}\n既存を再利用する場合や別の成果として分ける場合は、その旨をこのスレッドへ返信してください。',` | |
