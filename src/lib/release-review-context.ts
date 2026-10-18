import { RELEASE_REVIEW_CHECKLIST_VERSION, type ReleaseReviewCheckStatus } from "@/lib/release-review-checklist";
import {
  legacyReviewFindingId,
  reviewFindingId,
  reviewFindingIdAliases,
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

/** ユーザーの判断（#4657）。再レビューのAIへ渡し、判断済みの指摘を根拠なく蒸し返させない */
export type ReleaseReviewContextDecision = {
  id: string;
  title: string;
  decision: "fix_now" | "post_release" | "defer" | "reject";
  reason: string;
  impact: string | null;
  scope: string | null;
  timing: string | null;
  followUp: string | null;
  /** 判断したときからbaseが変わった（前提の確認し直しが要る） */
  stale: boolean;
};

export type ReleaseReviewPromptContext = ReleaseReviewNormalizeContext & {
  /** ユーザーの判断（撤回されていない最新のもの） */
  decisions: ReleaseReviewContextDecision[];
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

/** 修正系列の項目の`path:line`を、ファイルと行へ分ける */
export function splitSeriesItemFile(file: string | null): { file: string | null; line: number | null } {
  const m = file?.match(/^(.*):(\d+)$/);
  return { file: m ? m[1] : (file ?? null), line: m ? Number(m[2]) : null };
}

/** 修正系列の項目（題・`path:line`のファイル）から、全体レビューの指摘IDを導出する */
export function findingIdOfSeriesItem(item: { title: string; file: string | null }): string {
  return reviewFindingId({ title: item.title, ...splitSeriesItemFile(item.file) });
}

/** 修正系列の項目が指しうる指摘ID（現行の導出と、#4766より前の旧導出）。旧IDで残る判断・結果との照合に使う */
export function findingIdsOfSeriesItem(item: { title: string; file: string | null }): string[] {
  const parts = { title: item.title, ...splitSeriesItemFile(item.file) };
  return [...new Set([reviewFindingId(parts), legacyReviewFindingId(parts)])];
}

export function buildReviewPromptContext(input: {
  current: { baseSha: string; headSha: string };
  previous: PreviousReviewRecord | null;
  histories: readonly ReleaseFixHistory[];
  decisions?: readonly ReleaseReviewContextDecision[];
}): ReleaseReviewPromptContext {
  const { previous, histories } = input;
  const decisions = [...(input.decisions ?? [])];
  // 有効な非修正の判断が付いた指摘は、前回の指摘の解消確認・未解消の再注入から外す（#4657）
  const decidedFindingIds = decisions.filter((d) => !d.stale && d.decision !== "fix_now").map((d) => d.id);
  const decision = decideReviewMode(input);
  const fixIssueByFinding: Record<string, number> = {};
  for (const history of histories) {
    for (const item of history.items) for (const id of findingIdsOfSeriesItem(item)) fixIssueByFinding[id] ??= history.issueNumber;
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
    previousFindings: (previous?.findings ?? []).filter((f) => !reviewFindingIdAliases(f).some((id) => decidedFindingIds.includes(id))),
    decidedFindingIds,
    decisions,
    checklistVersion: RELEASE_REVIEW_CHECKLIST_VERSION,
    fixPrNumbers: [...new Set(histories.flatMap((h) => (h.fixPrNumber ? [h.fixPrNumber] : [])))],
    fixHistory: [...histories],
    fixIssueByFinding,
  };
}
