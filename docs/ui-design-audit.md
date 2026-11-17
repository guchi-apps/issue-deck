# UIデザインの静的検出：リポジトリ全体の走査結果（#5465）

`node scripts/check-ui-design.mjs --report src` の結果（このリポジトリの`src/`。**変更はしていない**）。
検出の仕組みと除外の書き方は [ui-design-lint.md](ui-design-lint.md)。右端の「仕分け」は、
後続の是正Issue（#5464の子）で人が「装飾」か「意味あり」かを埋める欄で、ここでは空欄にしてある。

仕分けの目安は共有知識`standards/ui-design.md`の「意味を伝えている使い方は許容する」。
一覧を見た範囲では、`src/components/ui/`の影（メニュー・ダイアログ・トースト）は浮き上がる要素なので意味あり、
`notification-settings-section.tsx`の左線は状態の一件を示す通知で意味ありに寄るが、
全件を装飾か意味ありかに決めるのは是正Issueで行う。

#5508で`dashboard`配下の左端の色付き・グラデーション8件を仕分けた（下の一覧の仕分け列）。装飾は是正済みで、
意味ありは`design-ok`で検出から外した。件数は#5508の前の走査時点のもので、是正した行は現在の検出には出ない。

`emoji-icon`は#5507で対象を画面を描くコード（`.tsx`・`.jsx`・`.css`・`.html`）に絞った。
最初の走査の73件のうち71件は`src/lib/**/*.ts`のGitHubコメント・Slack返信の文面と判定マーカーで、
画面の問題ではないため外れ、画面にある2件だけが残っている。

## ルール別の件数

| ルール | 件数 |
|---|---|
| side-border | 10（是正・除外後は6） |
| gradient | 4（是正・除外後は0） |
| emoji-icon | 2 |
| heavy-shadow | 10 |
| 除外済み（design-ok） | 0（#5508の後は4） |

## 一覧

| ファイル:行 | ルール | 該当行 | 仕分け（装飾／意味あり） |
|---|---|---|---|
| `src/app/globals.css:263` | gradient | `background-image: linear-gradient(` | 意味あり（いま進行中の区間を流れる動きで示す）。`design-ok`で除外（#5508） |
| `src/components/app-update-checker.tsx:84` | heavy-shadow | `<div className="fixed inset-x-4 bottom-4 z-50 flex items-center justify-between gap-3 rounded-lg border bg-foreground px` | |
| `src/components/dashboard/dependency-wait-panel.tsx:141` | emoji-icon | `<span aria-hidden>{r.satisfied === true ? "✅" : r.satisfied === false ? "⏳" : "❓"}</span>` | |
| `src/components/dashboard/fleet-repository-row.tsx:59` | side-border | `<p className="basis-full border-l-2 border-destructive/40 pl-1.5 break-words text-destructive">` | 装飾。失敗文は赤文字で伝わるため左線を外した（#5508） |
| `src/components/dashboard/image-annotation-dialog.tsx:842` | heavy-shadow | `className="absolute inset-x-3 top-16 mx-auto flex max-w-md flex-col gap-3 rounded-xl border border-white/15 bg-neutral-9` | |
| `src/components/dashboard/mention-textarea.tsx:562` | gradient | `<span className="absolute inset-x-0 bottom-0 truncate bg-linear-to-t from-black/80 to-transparent px-1 pt-2 pb-0.5 text-` | 意味あり（画像上のファイル名の可読性）。`design-ok`で除外（#5508） |
| `src/components/dashboard/mobile/mobile-screen-fab.tsx:29` | heavy-shadow | `className="relative flex size-14 items-center justify-center rounded-full border bg-background shadow-lg"` | |
| `src/components/dashboard/mobile/mobile-screen-fab.tsx:42` | heavy-shadow | `className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"` | |
| `src/components/dashboard/nightly-run-panel.tsx:311` | side-border | `className="inline-block h-2 w-3.5 shrink-0 border-l-2 border-amber-500"` | 意味あり（下限の境界線の凡例）。`design-ok`で除外（#5508） |
| `src/components/dashboard/nightly-run-panel.tsx:427` | side-border | `className="absolute inset-y-0 right-0 border-l-2 border-amber-500"` | 意味あり（下限の位置を示す境界線）。`design-ok`で除外（#5508） |
| `src/components/dashboard/plan-approval-panel.tsx:290` | gradient | `<div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-b from-transparent to-muted pt-8 pb-2">` | 装飾。グラデーションを単色＋上罫線へ（#5508） |
| `src/components/dashboard/pull-request-merge-review.tsx:92` | emoji-icon | `✅ 記録済み{acknowledgement.recordedBy ? '（記録: ${acknowledgement.recordedBy}）' : ""}` | |
| `src/components/dashboard/question-answer-panel.tsx:339` | gradient | `<div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-b from-transparent to-muted pt-8 pb-2">` | 装飾。グラデーションを単色＋上罫線へ（#5508） |
| `src/components/dashboard/release-history-panel.tsx:938` | side-border | `<section className="mt-2 rounded border-l-2 border-red-500/40 pl-2">` | 装飾。赤い左線を上罫線へ（#5508） |
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
