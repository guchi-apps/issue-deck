/**
 * 全体レビューの指摘ごとのユーザー判断（#4657）。**純関数だけ**を置き、DBの読み書きは
 * `release-review-decision-store.ts`が持つ。画面からも読むので`node:crypto`等に依存しない。
 *
 * 判断はAIの原判定（重大度・止める／止めない・根拠）を書き換えない。ここで決めるのは次の3つだけ:
 * - 指摘ごとに、今有効な判断はどれか（前提が変わった判断は「再確認が必要」で、無効として扱う）
 * - 修正系列が自動で直してよい指摘はどれか（「今回直す」と未判断だけ。見送り・不採用・公開後対応は直さない）
 * - 全体レビューの要確認が「止める指摘だけが原因で、その全件が有効な非修正の判断」か（`cleared`）。
 *   これはゲートの`needs_check`を合格へ読み替えるものではなく、完了系列（#4480）が人の判断を根拠に
 *   新たな修正を起案しない・自動マージを止めないために読む
 */

export const RELEASE_REVIEW_DECISION_KINDS = ["fix_now", "post_release", "defer", "reject"] as const;
export type ReleaseReviewDecisionKind = (typeof RELEASE_REVIEW_DECISION_KINDS)[number];
/** 撤回（未判断へ戻す）。履歴としては残す */
export type ReleaseReviewDecisionAction = ReleaseReviewDecisionKind | "withdrawn";

export const RELEASE_REVIEW_DECISION_LABEL: Record<ReleaseReviewDecisionAction, string> = {
  fix_now: "今回直す",
  post_release: "公開後に対応する",
  defer: "今回は見送る",
  reject: "指摘を採用しない",
  withdrawn: "判断を撤回",
};

export const RELEASE_REVIEW_DECISION_HINT: Record<ReleaseReviewDecisionKind, string> = {
  fix_now: "公開前の修正・確認対象にします。修正系列はこの指摘を直します",
  post_release: "公開後の作業として、関連Issueと実施時期を記録します。公開前の条件にはしません",
  defer: "今回は対応しません。残る影響と対象範囲を記録します（期限や修正Issueは作りません）",
  reject: "誤認・対象外・過剰な要求などの理由で、この指摘を採用しません",
};

/** 修正しない判断（自動修正・再起案の対象から外し、要確認の解除に数える） */
const NON_FIX: readonly ReleaseReviewDecisionAction[] = ["post_release", "defer", "reject"];

export function isNonFixDecision(decision: ReleaseReviewDecisionAction | null | undefined): boolean {
  return decision !== null && decision !== undefined && NON_FIX.includes(decision);
}

export function parseReleaseReviewDecisionAction(value: unknown): ReleaseReviewDecisionAction | null {
  return value === "withdrawn" || (typeof value === "string" && (RELEASE_REVIEW_DECISION_KINDS as readonly string[]).includes(value))
    ? (value as ReleaseReviewDecisionAction)
    : null;
}

/** 保存済みの判断1件（`ReleaseReviewDecision`の行から画面・判定に要る列だけ） */
export type ReleaseReviewDecisionRecord = {
  id: string;
  findingId: string;
  sequence: number;
  decision: ReleaseReviewDecisionAction;
  reason: string;
  impact: string | null;
  scope: string | null;
  followUp: { repo: string; number: number } | null;
  timing: string | null;
  prNumber: number;
  headRef: string;
  baseSha: string;
  headSha: string;
  severity: "high" | "medium" | "low";
  blocking: boolean;
  findingTitle: string;
  decidedBy: string;
  decidedAt: string;
};

/** 判断の対象になる指摘（AIの原判定のうち、判断の有効性を決めるのに要るところだけ） */
export type DecisionTargetFinding = {
  id: string;
  title: string;
  severity: "high" | "medium" | "low";
  blocking: boolean;
  /** 判断を出した後に、AIが判断の前提が変わったと報告した理由（再レビューの`premiseChanged`） */
  premiseChanged?: string | null;
};

export type FindingDecisionView = {
  findingId: string;
  /** 現在の判断（撤回後・未判断ならnull） */
  current: ReleaseReviewDecisionRecord | null;
  /** 現在の判断を今の対象に使えるか。使えなければ理由（再確認が必要） */
  stale: string | null;
  /** 古い順の履歴（撤回を含む） */
  history: ReleaseReviewDecisionRecord[];
};

export type ReleaseReviewDecisionSummary = {
  /** 指摘IDごとの判断（判断の記録がある指摘だけ） */
  byFinding: Record<string, FindingDecisionView>;
  /** 判断はあるが今回の結果に同じIDの指摘が無いもの（解消された、または言い換えで別IDになった可能性） */
  detached: FindingDecisionView[];
  counts: {
    /** 有効な判断が無い止める指摘（再確認が必要なものを含む） */
    undecidedBlocking: number;
    fixNow: number;
    postRelease: number;
    deferred: number;
    rejected: number;
    stale: number;
  };
  /** 要確認の原因が止める指摘だけで、その全件が有効な非修正の判断か */
  cleared: boolean;
  /** 公開後に残る作業（公開後対応の判断） */
  postReleaseWork: { findingId: string; title: string; followUp: { repo: string; number: number } | null; timing: string | null }[];
  /** 次の操作の1行 */
  next: string;
};

const SEVERITY_RANK = { low: 0, medium: 1, high: 2 } as const;

/** 判断が今の対象に使えるか。使えなければ再確認が必要な理由 */
export function assessDecision(
  record: ReleaseReviewDecisionRecord,
  finding: DecisionTargetFinding | null,
  current: { baseSha: string },
): string | null {
  if (record.baseSha !== current.baseSha) {
    return `判断したときからmainが進みました（判断時 ${record.baseSha.slice(0, 7)} → 現在 ${current.baseSha.slice(0, 7)}）。前提を確認し直してください`;
  }
  if (!finding) return null;
  if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[record.severity]) {
    return `重大度が上がりました（判断時 ${record.severity} → 現在 ${finding.severity}）`;
  }
  if (!record.blocking && finding.blocking) return "判断時は止めない提案でしたが、今回はリリースを止める指摘になりました";
  if (finding.premiseChanged) return `AIが判断の前提の変化を報告しました: ${finding.premiseChanged}`;
  return null;
}

/** 記録（古い順でなくてよい）を指摘IDごとに畳み、今の結果に対する判断の要約を作る */
export function summarizeReleaseReviewDecisions(input: {
  records: readonly ReleaseReviewDecisionRecord[];
  /** 止める指摘 */
  findings: readonly DecisionTargetFinding[];
  /** 止めない改善提案 */
  suggestions: readonly DecisionTargetFinding[];
  current: { baseSha: string };
  /** 全体レビューの状態（`needs_check`以外では`cleared`にしない） */
  state: string;
  /** 未確認範囲。あれば判断では解除しない */
  unverifiedScope: string | null;
}): ReleaseReviewDecisionSummary {
  const grouped = new Map<string, ReleaseReviewDecisionRecord[]>();
  for (const r of input.records) grouped.set(r.findingId, [...(grouped.get(r.findingId) ?? []), r]);
  const all = [...input.findings, ...input.suggestions];
  const findingById = new Map(all.map((f) => [f.id, f]));

  const byFinding: Record<string, FindingDecisionView> = {};
  const detached: FindingDecisionView[] = [];
  for (const [findingId, list] of grouped) {
    const history = [...list].sort((a, b) => a.sequence - b.sequence);
    const latest = history[history.length - 1];
    const current = latest && latest.decision !== "withdrawn" ? latest : null;
    const finding = findingById.get(findingId) ?? null;
    const view: FindingDecisionView = {
      findingId,
      current,
      stale: current ? assessDecision(current, finding, input.current) : null,
      history,
    };
    if (finding) byFinding[findingId] = view;
    else if (current) detached.push(view);
  }

  const counts = { undecidedBlocking: 0, fixNow: 0, postRelease: 0, deferred: 0, rejected: 0, stale: 0 };
  const postReleaseWork: ReleaseReviewDecisionSummary["postReleaseWork"] = [];
  for (const f of all) {
    const view = byFinding[f.id];
    const valid = view?.current && !view.stale ? view.current : null;
    if (view?.current && view.stale) counts.stale += 1;
    if (!valid) {
      if (f.blocking) counts.undecidedBlocking += 1;
      continue;
    }
    if (valid.decision === "fix_now") counts.fixNow += 1;
    else if (valid.decision === "post_release") {
      counts.postRelease += 1;
      postReleaseWork.push({ findingId: f.id, title: f.title, followUp: valid.followUp, timing: valid.timing });
    } else if (valid.decision === "defer") counts.deferred += 1;
    else if (valid.decision === "reject") counts.rejected += 1;
  }

  const cleared =
    input.state === "needs_check" &&
    !input.unverifiedScope?.trim() &&
    input.findings.length > 0 &&
    input.findings.every((f) => isEffectivelyNonFix(byFinding[f.id]));

  return { byFinding, detached, counts, cleared, postReleaseWork, next: describeNext(input.state, counts, cleared, input.unverifiedScope) };
}

function isEffectivelyNonFix(view: FindingDecisionView | undefined): boolean {
  return Boolean(view?.current && !view.stale && isNonFixDecision(view.current.decision));
}

function describeNext(
  state: string,
  counts: ReleaseReviewDecisionSummary["counts"],
  cleared: boolean,
  unverifiedScope: string | null,
): string {
  if (state !== "needs_check" && state !== "passed") return "全体レビューの結果が出てから判断できます";
  if (counts.stale > 0) return `前提が変わった判断が${counts.stale}件あります。理由を読んで判断し直してください`;
  if (counts.undecidedBlocking > 0) return `未判断の止める指摘が${counts.undecidedBlocking}件あります。各指摘の「判断」から採否と対応時期を決めてください`;
  if (counts.fixNow > 0) return `「今回直す」の指摘が${counts.fixNow}件あります。修正Issueを起案して直してから再検証します`;
  if (cleared) {
    return "止める指摘はすべて判断済みです（修正しない）。本番公開の確認へ進めます。判断の保存だけではマージしません";
  }
  if (unverifiedScope?.trim()) return "未確認範囲が残っています。判断では解除できないため、再実行または人の確認で進めます";
  return "判断が必要な指摘はありません";
}

/**
 * 修正系列が自動で直してよい止める指摘の添字（#4657）。**有効な非修正の判断が付いた指摘は外す**
 * （見送り・不採用・公開後対応を再び自動採用しない）。前提が変わった判断は無効なので外さない（未判断と同じ扱い）
 */
export function selectAutoFixIndexes(
  findings: readonly { id?: string }[],
  decisions: ReleaseReviewDecisionSummary | null,
): number[] {
  return findings.flatMap((f, index) => (f.id && decisions && isEffectivelyNonFix(decisions.byFinding[f.id]) ? [] : [index]));
}

/** 指摘IDのうち、有効な非修正の判断が付いているもの */
export function nonFixFindingIds(decisions: ReleaseReviewDecisionSummary | null): Set<string> {
  const ids = new Set<string>();
  for (const view of Object.values(decisions?.byFinding ?? {})) if (isEffectivelyNonFix(view)) ids.add(view.findingId);
  return ids;
}

export type DecisionInputError = { field: string; message: string };

/** 保存前の入力検証。種別ごとに必須の項目がある（理由はすべての判断で必須） */
export function validateDecisionInput(input: {
  decision: ReleaseReviewDecisionAction;
  reason: string;
  impact: string | null;
  scope: string | null;
  timing: string | null;
  followUp: { kind: "existing"; number: number } | { kind: "create"; title: string } | null;
}): DecisionInputError | null {
  if (!input.reason.trim()) return { field: "reason", message: "理由を入力してください" };
  if (input.reason.length > 2000) return { field: "reason", message: "理由は2000文字以内にしてください" };
  if (input.decision === "defer") {
    if (!input.impact?.trim()) return { field: "impact", message: "見送ったときに残る影響を入力してください" };
    if (!input.scope?.trim()) return { field: "scope", message: "見送る対象範囲を入力してください" };
  }
  if (input.decision === "post_release") {
    if (!input.followUp) return { field: "followUp", message: "公開後の作業を追跡するIssue（既存の番号か新規作成）を指定してください" };
    if (input.followUp.kind === "create" && !input.followUp.title.trim()) return { field: "followUp", message: "作成するIssueの題を入力してください" };
    if (!input.timing?.trim()) return { field: "timing", message: "実施時期（例: 本番公開の直後・次のリリースまで）を入力してください" };
  } else if (input.followUp) {
    return { field: "followUp", message: "関連Issueは「公開後に対応する」ときだけ指定できます" };
  }
  return null;
}
