"use client";

import { cn } from "@/lib/utils";

/**
 * 実行キュー・ホストの様子に並ぶ行の見出し（`#1625 Issueテーブルのリンク…`）を出す（#1625）。
 *
 * **セッションの行（`dispatch-host-panel.tsx`）とジョブの行（`dispatch-queue-button.tsx`）で
 * 同じものを使う。** 見た目が同じ行なのに片方だけ押せる／押したときの挙動が違う、という状態を
 * 作らないため。
 *
 * **押せるのは`issueId`が引けている行だけ。** idはDBキャッシュのIssueから
 * タイトルと一緒に引いており（`resolveDispatchIssues`）、同期前・GitHub Appを外した
 * リポジトリでは両方とも`null`になる。その場合は従来どおり番号だけの文字列を出す
 * （押しても何も起きないリンクを出すより、リンクが無い方が分かりやすい）。
 *
 * リンク先はissue-deckの中のIssue詳細で、GitHubやRemote Controlへは飛ばさない。行の右端に
 * 並ぶアイコン（Remote Control・開発サーバー）が外へ出る導線を持っているので、そちらと
 * 役割が重ならないようにしている。
 */
export function DispatchIssueTitle({
  issueNumber,
  issueTitle,
  issueId,
  onOpenIssue,
  className,
}: {
  issueNumber: number;
  issueTitle: string | null;
  issueId: string | null;
  onOpenIssue?: (issueId: string) => void;
  className?: string;
}) {
  const label = `#${issueNumber}${issueTitle ? ` ${issueTitle}` : ""}`;
  // 幅が狭いので長いタイトルはホバーで補う（行の中で最も幅が要る要素）
  const title = issueTitle ?? undefined;

  if (!onOpenIssue || !issueId) {
    return (
      <span className={cn("block truncate font-medium", className)} title={title}>
        {label}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpenIssue(issueId)}
      title={title}
      aria-label={`${label}をissue-deckで開く`}
      className={cn(
        "block w-full truncate text-left font-medium hover:underline focus-visible:underline focus-visible:outline-none",
        className,
      )}
    >
      {label}
    </button>
  );
}
