import { RELEASE_REVIEW_CHECKLIST_VERSION, type ReleaseReviewCheckStatus } from "@/lib/release-review-checklist";
import {
  reviewFindingId,
  type ReleaseReviewContextFinding,
  type ReleaseReviewNormalizeContext,
} from "@/lib/release-review-result";

/**
 * 全体レビューの再レビューへ渡す文脈（#4559）。**純関数だけ**を置き、DBの読み出しは
 * `release-review-context-load.ts`が持つ。
 *
 * 前回の記録を使えるのは、同じ候補系列の前回の結果が「項目別の確認結果つきで完走」しており、base・確認項目の版が
 * 同じで、修正の履歴（`ReleaseFixSeries`）が辿れるときだけ。**どれか欠ければ全体確認へ戻し、旧い合格を流用しない**。
 * 指摘の対応内容・検証根拠は#4410の`ReleaseFixFinding`を読む（新しい台帳は作らない）。
 */

/** 前回の全体レビューの記録（`ReleaseVerification`の`ai_review`行から読み出したもの） */
export type PreviousReviewRecord = {
  prNumber: number;
  baseSha: string;
  headSha: string;
  state: string;
  /** 項目別の記録が無い旧ランナーの結果ではnull */
  checklistVersion: number | null;
  checkStatuses: Record<string, ReleaseReviewCheckStatus>;
  findings: ReleaseReviewContextFinding[];
  unverifiedScope: string | null;
};

/** 修正系列（#4317・#4410）の履歴。前回の指摘への対応内容・検証根拠の取得元 */
export type ReleaseFixHistory = {
  issueNumber: number;
  fixPrNumber: number | null;
  status: string;
  /** 系列が写した指摘（機密除去済み）。題・ファイルから`R-xxxxxx`を導出して前回の指摘へ突き合わせる */
  items: { title: string; file: string | null; detail: string | null }[];
  /** 内部確認の指摘。`resolution`が解消の検証根拠 */
  findings: { key: string; title: string; status: string; resolution: string | null; reopenCount: number }[];
};

export type ReleaseReviewPromptContext = ReleaseReviewNormalizeContext & {
  checklistVersion: number;
  fixPrNumbers: number[];
  fixHistory: ReleaseFixHistory[];
  /** 前回の指摘と修正系列の項目の対応（指摘ID→修正Issue番号） */
  fixIssueByFinding: Record<string, number>;
};

/** 再レビューを成立させてよいか。成立しなければ理由（全体確認へ戻す理由）を返す */
export function decideReviewMode(input: {
  current: { baseSha: string; headSha: string };
  previous: PreviousReviewRecord | null;
  histories: readonly ReleaseFixHistory[];
}): { mode: "initial" | "rereview"; reason: string | null } {
  const { current, previous, histories } = input;
  if (!previous) return { mode: "initial", reason: "前回の全体レビューの記録が無いため、対象全体を確認します" };
  if (previous.state === "failed")
    return { mode: "initial", reason: "前回の全体レビューが完走していないため、対象全体を確認します" };
  if (previous.checklistVersion === null)
    return { mode: "initial", reason: "前回の結果に項目別の確認記録が無いため、対象全体を確認します" };
  if (previous.checklistVersion !== RELEASE_REVIEW_CHECKLIST_VERSION)
    return {
      mode: "initial",
      reason: `確認項目の版が変わった（v${previous.checklistVersion}→v${RELEASE_REVIEW_CHECKLIST_VERSION}）ため、対象全体を確認します`,
    };
  if (previous.baseSha !== current.baseSha)
    return { mode: "initial", reason: "mainの先端（base）が変わったため、対象全体を確認します" };
  if (histories.length === 0)
    return { mode: "initial", reason: "修正の履歴を辿れないため、対象全体を確認します" };
  return { mode: "rereview", reason: null };
}

/** 修正系列の項目（題・`path:line`のファイル）から、全体レビューの指摘IDを導出する */
export function findingIdOfSeriesItem(item: { title: string; file: string | null }): string {
  const m = item.file?.match(/^(.*):(\d+)$/);
  return reviewFindingId({ title: item.title, file: m ? m[1] : (item.file ?? null), line: m ? Number(m[2]) : null });
}

export function buildReviewPromptContext(input: {
  current: { baseSha: string; headSha: string };
  previous: PreviousReviewRecord | null;
  histories: readonly ReleaseFixHistory[];
}): ReleaseReviewPromptContext {
  const { previous, histories } = input;
  const decision = decideReviewMode(input);
  const fixIssueByFinding: Record<string, number> = {};
  for (const history of histories) {
    for (const item of history.items) fixIssueByFinding[findingIdOfSeriesItem(item)] ??= history.issueNumber;
  }
  return {
    mode: decision.mode,
    fullReviewReason: decision.reason,
    previous: previous
      ? {
          prNumber: previous.prNumber,
          baseSha: previous.baseSha,
          headSha: previous.headSha,
          statuses: previous.checkStatuses,
          runFailed: previous.state === "failed",
        }
      : null,
    previousFindings: previous?.findings ?? [],
    checklistVersion: RELEASE_REVIEW_CHECKLIST_VERSION,
    fixPrNumbers: [...new Set(histories.flatMap((h) => (h.fixPrNumber ? [h.fixPrNumber] : [])))],
    fixHistory: [...histories],
    fixIssueByFinding,
  };
}
