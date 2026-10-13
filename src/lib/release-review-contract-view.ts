import { checkItemLabel, type ReleaseReviewCheckResult } from "@/lib/release-review-checklist";
import {
  RELEASE_REVIEW_DISCOVERY_LABEL,
  RELEASE_REVIEW_STALL_GUIDE,
  type ReleaseReviewFinding,
  type ReleaseReviewMeta,
} from "@/lib/release-review-result";

/**
 * 全体レビューの確認契約（#4559）を画面に出す文言。判定は`release-review-result.ts`が済ませた記録を読むだけで、
 * ここでは合否を変えない。**再レビューを合格の保証と読ませない**言い回しにする。
 */

export function describeReviewKind(review: ReleaseReviewMeta): { label: string; version: string } {
  const version = review.legacy ? "確認項目の記録なし（旧ランナー）" : `確認項目 v${review.checklistVersion}`;
  return { label: review.mode === "rereview" ? "再レビュー" : "初回の全体確認", version };
}

export function describeCheck(check: ReleaseReviewCheckResult, shortSha: (sha: string) => string) {
  const status =
    check.status === "confirmed" ? "確認済み" : check.status === "not_applicable" ? "非該当" : "未確認";
  const source =
    check.status === "unconfirmed"
      ? null
      : check.source === "carried_over"
        ? `前回から引き継ぎ${check.carriedFromHeadSha ? `（${shortSha(check.carriedFromHeadSha)}の結果）` : ""}`
        : "今回確認";
  return { label: checkItemLabel(check.id), status, source, evidence: check.evidence };
}

export function checkTone(check: ReleaseReviewCheckResult): "ok" | "muted" | "bad" {
  return check.status === "confirmed" ? "ok" : check.status === "not_applicable" ? "muted" : "bad";
}

/** 指摘に付けるバッジ。再発と新規、新規の発見理由、確認回数、解消されない原因を区別して出す */
export function findingTags(finding: ReleaseReviewFinding): string[] {
  const tags: string[] = [];
  if (finding.id) tags.push(finding.id);
  if (finding.status === "recurring") tags.push(`再発（${finding.occurrences ?? 2}回目）`);
  else if (finding.status === "new" && finding.discovery) {
    tags.push(`新規・${RELEASE_REVIEW_DISCOVERY_LABEL[finding.discovery]}`);
  }
  return tags;
}

export function describeStall(finding: ReleaseReviewFinding): { cause: string; next: string } | null {
  if (finding.status !== "recurring" || !finding.stallCause) return null;
  const guide = RELEASE_REVIEW_STALL_GUIDE[finding.stallCause];
  return { cause: guide.label, next: guide.next };
}

/** 未解決の阻害指摘の件数と、未確認の項目数（要約行用） */
export function countOpenItems(review: ReleaseReviewMeta | null, findings: readonly ReleaseReviewFinding[]) {
  return {
    blocking: findings.length,
    unconfirmed: review ? review.checks.filter((c) => c.status === "unconfirmed").length : 0,
    unresolvedPrevious: review ? review.previousFindings.filter((p) => p.status !== "resolved").length : 0,
  };
}
