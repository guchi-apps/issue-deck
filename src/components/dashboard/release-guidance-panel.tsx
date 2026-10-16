import { describeReleaseGuidance } from "@/lib/release-review-guidance";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";

export function ReleaseGuidancePanel({ verification, onOpenReview, onOpenIntegration }: { verification: ReleaseVerificationSummary; onOpenReview: () => void; onOpenIntegration: () => void }) {
  return (
    <section aria-label="今必要な対応" className="border-b bg-muted/30 p-3" data-testid="release-guidance">
      <h3 className="text-sm font-semibold">今必要な対応</h3>
      <ul className="mt-2 flex flex-col gap-2">
        {describeReleaseGuidance(verification).map((item) => (
          <li key={item.title} className="min-w-0 break-words rounded border bg-background p-2">
            <p className="text-xs font-medium">{item.kind === "attention" ? "△ " : item.kind === "waiting" ? "◷ " : "✓ "}{item.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{item.next}</p>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={onOpenReview} className="rounded border px-3 py-2 text-xs">全体レビューの結果・判断を開く</button>
        <button type="button" onClick={onOpenIntegration} className="rounded border px-3 py-2 text-xs">統合検証の詳細を開く</button>
      </div>
    </section>
  );
}
