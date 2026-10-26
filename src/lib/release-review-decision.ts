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
  /** 判断時に表示していたAIの推奨（#4676）。推奨が無かった・#4676より前の判断はnull */
  recommendation?: { decision: ReleaseReviewDecisionKind; reason: string } | null;
  /** 理由の出どころ（`ai`＝AIの理由案のまま／`ai_edited`／`manual`）。#4676より前の判断はnull */
  reasonSource?: "ai" | "ai_edited" | "manual" | null;
};

/** 判断の対象になる指摘（AIの原判定のうち、判断の有効性を決めるのに要るところだけ） */
export type DecisionTargetFinding = {
  id: string;
  title: string;
  severity: "high" | "medium" | "low";
  blocking: boolean;
  /** 判断を出した後に、AIが判断の前提が変わったと報告した理由（再レビューの`premiseChanged`） */
  premiseChanged?: string | null;
  /** 指摘の対象ファイル。mainが進んだときに、このファイルが変わったかで判断の有効性を決める（#4766） */
  file?: string | null;
  /** 同じ指摘を指しうる別のID（旧導出のIDなど。#4766）。この値で保存された判断も、この指摘の判断として読む */
  aliasIds?: readonly string[];
};

/**
 * 判断の有効性を決める現在の対象（#4766）。`baseChanges`は「判断時のbase → 現在のbase」で変わったファイル
 * （改名前のパスを含む）を判断時のbaseごとに持つ。取得できなかったbaseはnull、キーが無いbaseは未取得で、
 * **どちらも確かめられないものとして判断を無効にする**（従来の「mainが進んだら無効」と同じ側へ倒す）
 */
export type DecisionBaseContext = {
  baseSha: string;
  baseChanges?: Readonly<Record<string, readonly string[] | null>>;
};

export type FindingDecisionView = {
  findingId: string;
  /** 現在の判断（撤回後・未判断ならnull） */
  current: ReleaseReviewDecisionRecord | null;
  /** 現在の判断を今の対象に使えるか。使えなければ理由（再確認が必要） */
  stale: string | null;
  /** 古い順の履歴（撤回を含む） */
  history: ReleaseReviewDecisionRecord[];
  /** この指摘の判断として読んだ別のID（旧IDで保存された判断。#4766）。保存時の競合確認でも見る */
  aliasIds?: string[];
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

/**
 * mainが進んだあとも判断を使えるか（#4766）。**判断した指摘のファイルが、判断時のbaseから現在のbaseまでの間に
 * 変わったときだけ**無効にする（無関係なmainの前進では判断を残す）。ファイルが分からない・変更を確かめられない
 * ときは、従来どおり無効にする。使えなければ再確認が必要な理由
 */
export function assessDecisionBase(recordBaseSha: string, file: string | null | undefined, current: DecisionBaseContext): string | null {
  if (recordBaseSha === current.baseSha) return null;
  const moved = `判断したときからmainが進みました（判断時 ${recordBaseSha.slice(0, 7)} → 現在 ${current.baseSha.slice(0, 7)}）`;
  if (!file) return `${moved}。指摘の対象ファイルが分からないため、前提を確認し直してください`;
  const changed = current.baseChanges?.[recordBaseSha];
  if (!changed) return `${moved}。対象ファイルが変わったかを確かめられないため、前提を確認し直してください`;
  if (changed.includes(file)) return `${moved}。判断した指摘のファイル（${file}）がその間に変わったため、前提を確認し直してください`;
  return null;
}

/** 判断が今の対象に使えるか。使えなければ再確認が必要な理由 */
export function assessDecision(
  record: ReleaseReviewDecisionRecord,
  finding: DecisionTargetFinding | null,
  current: DecisionBaseContext,
): string | null {
  const base = assessDecisionBase(record.baseSha, finding?.file, current);
  if (base) return base;
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
  current: DecisionBaseContext;
  /** 全体レビューの状態（`needs_check`以外では`cleared`にしない） */
  state: string;
  /** 未確認範囲。あれば判断では解除しない */
  unverifiedScope: string | null;
}): ReleaseReviewDecisionSummary {
  const all = [...input.findings, ...input.suggestions];
  const findingById = new Map(all.map((f) => [f.id, f]));
  // 旧IDで保存された判断を、今の指摘のIDへ読み替える（#4766）。今の指摘のIDそのものとの一致を優先し、
  // 複数の指摘に当たる別名（題・ファイルが同じで行だけ違う指摘の現行の導出など）は使わない（別の指摘の判断で覆わない）
  const canonical = new Map<string, string>(all.map((f) => [f.id, f.id]));
  const aliasHits = new Map<string, number>();
  for (const f of all) for (const alias of new Set(f.aliasIds ?? [])) aliasHits.set(alias, (aliasHits.get(alias) ?? 0) + 1);
  for (const f of all) for (const alias of f.aliasIds ?? []) if (!canonical.has(alias) && aliasHits.get(alias) === 1) canonical.set(alias, f.id);
  const grouped = new Map<string, ReleaseReviewDecisionRecord[]>();
  for (const r of input.records) {
    const key = canonical.get(r.findingId) ?? r.findingId;
    grouped.set(key, [...(grouped.get(key) ?? []), r]);
  }

  const byFinding: Record<string, FindingDecisionView> = {};
  const detached: FindingDecisionView[] = [];
  for (const [findingId, list] of grouped) {
    // 通し番号はIDごとなので、旧IDと新IDの判断が混ざるときは判断時刻で並べる
    const history = [...list].sort((a, b) => (a.decidedAt === b.decidedAt ? a.sequence - b.sequence : a.decidedAt < b.decidedAt ? -1 : 1));
    const latest = history[history.length - 1];
    const current = latest && latest.decision !== "withdrawn" ? latest : null;
    const finding = findingById.get(findingId) ?? null;
    const view: FindingDecisionView = {
      findingId,
      current,
      stale: current ? assessDecision(current, finding, input.current) : null,
      history,
    };
    const aliasIds = [...new Set(list.map((r) => r.findingId).filter((id) => id !== findingId))];
    if (aliasIds.length > 0) view.aliasIds = aliasIds;
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
  if (counts.undecidedBlocking > 0) {
    return `未判断の止める指摘が${counts.undecidedBlocking}件あります。各指摘のAIの推奨を確認して確定するか、別の判断を選んでください`;
  }
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

/** 指摘IDのうち、有効な非修正の判断が付いているもの（読み替えた旧IDを含む） */
export function nonFixFindingIds(decisions: ReleaseReviewDecisionSummary | null): Set<string> {
  const ids = new Set<string>();
  for (const view of Object.values(decisions?.byFinding ?? {})) {
    if (!isEffectivelyNonFix(view)) continue;
    ids.add(view.findingId);
    for (const alias of view.aliasIds ?? []) ids.add(alias);
  }
  return ids;
}

/** 指摘IDのうち、有効な「今回直す」の判断が付いているもの（改善提案を修正Issueの起案対象にする条件。#5102） */
export function fixNowFindingIds(decisions: ReleaseReviewDecisionSummary | null): Set<string> {
  const ids = new Set<string>();
  for (const view of Object.values(decisions?.byFinding ?? {})) {
    if (!view.current || view.stale || view.current.decision !== "fix_now") continue;
    ids.add(view.findingId);
    for (const alias of view.aliasIds ?? []) ids.add(alias);
  }
  return ids;
}

export type DecisionInputError ={ field: string; message: string };

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
